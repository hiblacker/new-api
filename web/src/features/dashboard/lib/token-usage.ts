/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import dayjs from 'dayjs'

import type { QuotaDataItem } from '@/features/dashboard/types'
import { formatChartTime, getRollingDateRange } from '@/lib/time'

/** Bucket sizes offered by the overview token usage chart. */
export type TokenUsageGranularity = 'hour' | 'day' | 'week' | 'month'

/** `custom` is only reachable through the filter dialog. */
export type TokenUsageRangeKey = '1d' | '7d' | '30d' | 'all' | 'custom'

export const TOKEN_USAGE_RANGE_PRESETS = [
  { key: '1d', days: 1, labelKey: '1 Day' },
  { key: '7d', days: 7, labelKey: '7 Days' },
  { key: '30d', days: 30, labelKey: '30 Days' },
  { key: 'all', days: null, labelKey: 'All Time' },
] as const

/**
 * Dedicated labels: the shared `Week`/`Month` strings translate to "this week"
 * and "this month" for the rankings tabs, which is wrong for a bucket size.
 */
export const TOKEN_USAGE_GRANULARITY_LABEL_KEYS: Record<
  TokenUsageGranularity,
  string
> = {
  hour: 'Per Hour',
  day: 'Per Day',
  week: 'Per Week',
  month: 'Per Month',
}

const SHORT_RANGE_GRANULARITIES: TokenUsageGranularity[] = ['hour', 'day']
const LONG_RANGE_GRANULARITIES: TokenUsageGranularity[] = [
  'day',
  'week',
  'month',
]

export interface TokenUsageSettings {
  rangeKey: TokenUsageRangeKey
  start: number
  end: number
  granularity: TokenUsageGranularity
}

const SETTINGS_STORAGE_KEY = 'dashboard_overview_token_usage_settings'

/** Models beyond this count are collapsed into the "Other" series. */
export const MAX_TOKEN_SERIES = 15
/** Guard against pathological bucket counts. */
const MAX_BUCKETS = 800
/** An unbounded ("all time") range always renders at least this much history. */
export const MIN_ALL_TIME_SPAN_MONTHS = 6

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Bucket sizes allowed for a range.
 *
 * A single day is only meaningful hourly; anything up to a month may use
 * hourly or daily buckets; longer ranges (including all time) use daily,
 * weekly or monthly buckets. `null` means "all time".
 */
export function allowedGranularities(
  rangeDays: number | null
): TokenUsageGranularity[] {
  if (rangeDays === null) return [...LONG_RANGE_GRANULARITIES]
  if (rangeDays <= 1) return ['hour']
  if (rangeDays <= 30) return [...SHORT_RANGE_GRANULARITIES]
  return [...LONG_RANGE_GRANULARITIES]
}

/** The granularity applied when the user has no valid preference yet. */
export function defaultGranularity(
  rangeDays: number | null
): TokenUsageGranularity {
  // An unbounded range spans whole years, so monthly buckets are the only
  // readable default.
  if (rangeDays === null) return 'month'
  if (rangeDays <= 1) return 'hour'
  return 'day'
}

/** Keeps a preferred granularity when the range still allows it. */
export function resolveGranularity(
  rangeDays: number | null,
  preferred?: TokenUsageGranularity
): TokenUsageGranularity {
  const allowed = allowedGranularities(rangeDays)
  if (preferred && allowed.includes(preferred)) return preferred
  return defaultGranularity(rangeDays)
}

export function rangeDaysBetween(startSec: number, endSec: number): number {
  return Math.max(1, Math.ceil((endSec - startSec) / 86_400))
}

/** Range length in days, or `null` for the unbounded "all time" range. */
export function rangeDaysFor(
  rangeKey: TokenUsageRangeKey,
  startSec: number,
  endSec: number
): number | null {
  if (rangeKey === 'all') return null
  return rangeDaysBetween(startSec, endSec)
}

function isGranularity(value: unknown): value is TokenUsageGranularity {
  return (
    value === 'hour' || value === 'day' || value === 'week' || value === 'month'
  )
}

function isRangeKey(value: unknown): value is TokenUsageRangeKey {
  return (
    value === '1d' ||
    value === '7d' ||
    value === '30d' ||
    value === 'all' ||
    value === 'custom'
  )
}

/** Rolling bounds for a preset. "all time" starts at the epoch. */
export function boundsForRangeKey(
  rangeKey: TokenUsageRangeKey,
  custom?: { start: number; end: number }
): { start: number; end: number } {
  if (rangeKey === 'all') return { start: 0, end: nowSeconds() }
  if (rangeKey === 'custom' && custom) return custom

  const preset = TOKEN_USAGE_RANGE_PRESETS.find((p) => p.key === rangeKey)
  const days = preset?.days ?? 30
  const { start, end } = getRollingDateRange(days)
  return {
    start: Math.floor(start.getTime() / 1000),
    end: Math.floor(end.getTime() / 1000),
  }
}

export function defaultTokenUsageSettings(): TokenUsageSettings {
  const bounds = boundsForRangeKey('7d')
  return {
    rangeKey: '7d',
    ...bounds,
    granularity: defaultGranularity(rangeDaysBetween(bounds.start, bounds.end)),
  }
}

/**
 * Restores the persisted selection. Rolling presets are re-derived from the
 * current clock so a saved "7 days" never becomes a stale fixed window.
 */
export function loadTokenUsageSettings(): TokenUsageSettings {
  const fallback = defaultTokenUsageSettings()
  if (typeof window === 'undefined') return fallback

  let parsed: Partial<TokenUsageSettings>
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return fallback
    parsed = JSON.parse(raw) as Partial<TokenUsageSettings>
  } catch {
    return fallback
  }

  if (!isRangeKey(parsed.rangeKey)) return fallback

  let bounds: { start: number; end: number }
  if (parsed.rangeKey === 'custom') {
    const start = Number(parsed.start)
    const end = Number(parsed.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return fallback
    }
    bounds = { start, end }
  } else {
    bounds = boundsForRangeKey(parsed.rangeKey)
  }

  const rangeDays = rangeDaysFor(parsed.rangeKey, bounds.start, bounds.end)

  return {
    rangeKey: parsed.rangeKey,
    ...bounds,
    granularity: resolveGranularity(
      rangeDays,
      isGranularity(parsed.granularity) ? parsed.granularity : undefined
    ),
  }
}

export function saveTokenUsageSettings(settings: TokenUsageSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* storage unavailable; keep the in-memory selection */
  }
}

function startOfWeek(timestampSec: number): number {
  const startOfDay = dayjs(timestampSec * 1000).startOf('day')
  const daysSinceMonday = (startOfDay.day() + 6) % 7
  return startOfDay.subtract(daysSinceMonday, 'day').unix()
}

/** Snaps a timestamp to the start of the bucket it belongs to. */
export function alignToBucket(
  timestampSec: number,
  granularity: TokenUsageGranularity
): number {
  switch (granularity) {
    case 'hour':
      return dayjs(timestampSec * 1000)
        .startOf('hour')
        .unix()
    case 'day':
      return dayjs(timestampSec * 1000)
        .startOf('day')
        .unix()
    case 'week':
      return startOfWeek(timestampSec)
    case 'month':
      return dayjs(timestampSec * 1000)
        .startOf('month')
        .unix()
  }
}

function nextBucket(
  timestampSec: number,
  granularity: TokenUsageGranularity
): number {
  if (granularity === 'hour') return timestampSec + 3600
  if (granularity === 'month') {
    return dayjs(timestampSec * 1000)
      .add(1, 'month')
      .startOf('month')
      .unix()
  }
  return dayjs(timestampSec * 1000)
    .add(1, granularity === 'day' ? 'day' : 'week')
    .startOf('day')
    .unix()
}

/** Axis label for a bucket start. */
export function formatBucketLabel(
  timestampSec: number,
  granularity: TokenUsageGranularity
): string {
  if (granularity === 'month') {
    return dayjs(timestampSec * 1000).format('YYYY-MM')
  }
  return formatChartTime(timestampSec, granularity)
}

/** Every bucket start between the range bounds, aligned to the granularity. */
export function buildTimeBuckets(
  startSec: number,
  endSec: number,
  granularity: TokenUsageGranularity
): number[] {
  const buckets: number[] = []
  let cursor = alignToBucket(startSec, granularity)

  while (cursor <= endSec && buckets.length < MAX_BUCKETS) {
    buckets.push(cursor)
    cursor = nextBucket(cursor, granularity)
  }

  return buckets
}

/**
 * Axis start for a range.
 *
 * A start of 0 means the range is unbounded ("all time"), which has no
 * meaningful lower bound: starting at the epoch would pad decades of empty
 * buckets and, once the bucket guard is hit, hide the real data entirely. Such
 * a range starts at the first bucket that actually has usage instead.
 */
export function axisStartFor(
  data: QuotaDataItem[],
  startSec: number,
  nowSec: number
): number {
  if (startSec > 0) return startSec

  const earliest = earliestTimestamp(data)
  // Even when the usage only covers a few weeks, an unbounded range always
  // shows at least half a year so the axis reads as a trend instead of a
  // single column.
  const minimumStart = dayjs(nowSec * 1000)
    .subtract(MIN_ALL_TIME_SPAN_MONTHS, 'month')
    .startOf('month')
    .unix()

  if (earliest === null) return minimumStart
  return Math.min(earliest, minimumStart)
}

function earliestTimestamp(data: QuotaDataItem[]): number | null {
  let earliest: number | null = null
  for (const item of data) {
    const timestamp = Number(item.created_at)
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue
    if (earliest === null || timestamp < earliest) earliest = timestamp
  }
  return earliest
}

export interface TokenUsageSeries {
  values: Array<{ Time: string; Model: string; Tokens: number }>
  models: string[]
  total: number
}

/**
 * Aggregates token usage per time bucket per model, ready for a stacked bar.
 */
export function buildTokenUsageSeries(
  data: QuotaDataItem[],
  startSec: number,
  endSec: number,
  granularity: TokenUsageGranularity,
  otherLabel: string
): TokenUsageSeries {
  const perBucket = new Map<number, Map<string, number>>()
  const totalsByModel = new Map<string, number>()
  let total = 0

  for (const item of data) {
    const tokens = Number(item.token_used) || 0
    if (tokens === 0) continue

    const bucket = alignToBucket(
      Number(item.created_at) || startSec,
      granularity
    )
    const model = item.model_name || 'Unknown'
    const bucketModels = perBucket.get(bucket) ?? new Map<string, number>()
    bucketModels.set(model, (bucketModels.get(model) ?? 0) + tokens)
    perBucket.set(bucket, bucketModels)

    totalsByModel.set(model, (totalsByModel.get(model) ?? 0) + tokens)
    total += tokens
  }

  const ranked = [...totalsByModel.entries()].sort((a, b) => b[1] - a[1])
  const topModels = ranked.slice(0, MAX_TOKEN_SERIES).map(([model]) => model)
  const topModelSet = new Set(topModels)
  const hasOther = ranked.length > MAX_TOKEN_SERIES
  const models = hasOther ? [...topModels, otherLabel] : topModels

  const values: TokenUsageSeries['values'] = []
  for (const bucket of buildTimeBuckets(startSec, endSec, granularity)) {
    const time = formatBucketLabel(bucket, granularity)
    const bucketModels = perBucket.get(bucket)
    const collapsed = new Map<string, number>()

    if (bucketModels) {
      for (const [model, tokens] of bucketModels) {
        const key = topModelSet.has(model) ? model : otherLabel
        collapsed.set(key, (collapsed.get(key) ?? 0) + tokens)
      }
    }

    for (const model of models) {
      values.push({
        Time: time,
        Model: model,
        Tokens: collapsed.get(model) ?? 0,
      })
    }
  }

  return { values, models, total }
}
