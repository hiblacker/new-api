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
import { beforeEach, describe, expect, it } from 'vitest'

import type { QuotaDataItem } from '@/features/dashboard/types'

import {
  MAX_TOKEN_SERIES,
  MIN_ALL_TIME_SPAN_MONTHS,
  alignToBucket,
  allowedGranularities,
  axisStartFor,
  buildTimeBuckets,
  buildTokenUsageSeries,
  boundsForRangeKey,
  defaultGranularity,
  defaultTokenUsageSettings,
  formatBucketLabel,
  loadTokenUsageSettings,
  resolveGranularity,
  saveTokenUsageSettings,
} from '../token-usage'

const STORAGE_KEY = 'dashboard_overview_token_usage_settings'

const DAY_SECONDS = 86_400
const HOUR_SECONDS = 3600

/** Local midnight, so bucket alignment is timezone independent. */
function localMidnight(year: number, month: number, day: number): number {
  return Math.floor(new Date(year, month - 1, day).getTime() / 1000)
}

describe('allowedGranularities', () => {
  it('only allows hourly buckets for a single day range', () => {
    expect(allowedGranularities(1)).toEqual(['hour'])
  })

  it('allows hourly and daily buckets for ranges up to 30 days', () => {
    expect(allowedGranularities(7)).toEqual(['hour', 'day'])
    expect(allowedGranularities(30)).toEqual(['hour', 'day'])
  })

  it('allows daily, weekly and monthly buckets for longer ranges', () => {
    expect(allowedGranularities(31)).toEqual(['day', 'week', 'month'])
    expect(allowedGranularities(365)).toEqual(['day', 'week', 'month'])
  })

  it('treats all time like a long range', () => {
    expect(allowedGranularities(null)).toEqual(['day', 'week', 'month'])
  })
})

describe('resolveGranularity', () => {
  it('falls back to the range default when the preference is not allowed', () => {
    // A 1 day range cannot be aggregated by day.
    expect(resolveGranularity(1, 'day')).toBe('hour')
    // A 7 day range cannot be aggregated by month.
    expect(resolveGranularity(7, 'month')).toBe('day')
  })

  it('keeps an allowed preference', () => {
    expect(resolveGranularity(7, 'hour')).toBe('hour')
    expect(resolveGranularity(null, 'month')).toBe('month')
    expect(resolveGranularity(90, 'week')).toBe('week')
  })

  it('defaults to hour for one day, day for a month and month for all time', () => {
    expect(defaultGranularity(1)).toBe('hour')
    expect(defaultGranularity(7)).toBe('day')
    expect(defaultGranularity(30)).toBe('day')
    // "All time" spans years, so monthly buckets are the readable default.
    expect(defaultGranularity(null)).toBe('month')
  })
})

describe('axisStartFor', () => {
  const now = localMidnight(2026, 9, 17)

  it('keeps an explicit range start', () => {
    const start = localMidnight(2026, 3, 1)
    expect(axisStartFor([], start, now)).toBe(start)
  })

  it('shows at least half a year when the usage is newer than that', () => {
    const data: QuotaDataItem[] = [
      { created_at: localMidnight(2026, 9, 1), model_name: 'a', token_used: 1 },
    ]

    // Usage only covers September, but the axis still reaches back to March.
    expect(axisStartFor(data, 0, now)).toBe(localMidnight(2026, 3, 1))
  })

  it('reaches further back when the usage is older than half a year', () => {
    const data: QuotaDataItem[] = [
      {
        created_at: localMidnight(2025, 1, 15),
        model_name: 'a',
        token_used: 1,
      },
    ]

    expect(axisStartFor(data, 0, now)).toBe(localMidnight(2025, 1, 15))
  })

  it('falls back to half a year when an unbounded range has no data', () => {
    expect(axisStartFor([], 0, now)).toBe(localMidnight(2026, 3, 1))
  })

  it('yields at least six monthly buckets for all time', () => {
    const data: QuotaDataItem[] = [
      { created_at: now, model_name: 'a', token_used: 5 },
    ]
    const series = buildTokenUsageSeries(
      data,
      axisStartFor(data, 0, now),
      now,
      'month',
      'Other'
    )

    expect(series.values.length).toBeGreaterThanOrEqual(
      MIN_ALL_TIME_SPAN_MONTHS
    )
  })
})

describe('month buckets', () => {
  it('aligns to the first day of the month', () => {
    const midMonth = localMidnight(2026, 3, 18) + 5 * HOUR_SECONDS
    expect(alignToBucket(midMonth, 'month')).toBe(localMidnight(2026, 3, 1))
  })

  it('emits one bucket per month', () => {
    const start = localMidnight(2026, 1, 15)
    const end = localMidnight(2026, 4, 10)
    const buckets = buildTimeBuckets(start, end, 'month')

    expect(buckets).toHaveLength(4)
    expect(buckets[0]).toBe(localMidnight(2026, 1, 1))
    expect(formatBucketLabel(buckets[0], 'month')).toBe('2026-01')
  })

  it('rolls a December bucket over into the next January', () => {
    const december = localMidnight(2026, 12, 20)
    expect(buildTimeBuckets(december, december, 'month')).toEqual([
      localMidnight(2026, 12, 1),
    ])
  })
})

describe('alignToBucket', () => {
  it('snaps hourly timestamps to the start of the hour', () => {
    const timestamp = localMidnight(2026, 1, 15) + 10 * HOUR_SECONDS + 1234
    expect(alignToBucket(timestamp, 'hour')).toBe(
      localMidnight(2026, 1, 15) + 10 * HOUR_SECONDS
    )
  })

  it('snaps daily timestamps to local midnight', () => {
    const timestamp = localMidnight(2026, 1, 15) + 23 * HOUR_SECONDS
    expect(alignToBucket(timestamp, 'day')).toBe(localMidnight(2026, 1, 15))
  })

  it('snaps weekly timestamps to the preceding Monday', () => {
    // 2026-01-15 is a Thursday; its week starts Monday 2026-01-12.
    const monday = localMidnight(2026, 1, 12)
    const thursday = localMidnight(2026, 1, 15) + 12 * HOUR_SECONDS
    const sunday = localMidnight(2026, 1, 18) + 23 * HOUR_SECONDS

    expect(alignToBucket(thursday, 'week')).toBe(monday)
    // Sunday still belongs to the week that began the previous Monday.
    expect(alignToBucket(sunday, 'week')).toBe(monday)
  })
})

describe('buildTimeBuckets', () => {
  it('emits one bucket per day across a multi day range', () => {
    const start = localMidnight(2026, 1, 12)
    const end = start + 3 * DAY_SECONDS - 1
    expect(buildTimeBuckets(start, end, 'day')).toHaveLength(3)
  })

  it('emits one bucket per hour across an hourly range', () => {
    const start = localMidnight(2026, 1, 12)
    const end = start + 3 * HOUR_SECONDS - 1
    expect(buildTimeBuckets(start, end, 'hour')).toHaveLength(3)
  })

  it('collapses four weeks into four weekly buckets', () => {
    const start = localMidnight(2026, 1, 12)
    const end = start + 28 * DAY_SECONDS - 1
    expect(buildTimeBuckets(start, end, 'week')).toHaveLength(4)
  })
})

describe('buildTokenUsageSeries', () => {
  it('sums token usage per model within each bucket', () => {
    const start = localMidnight(2026, 1, 12)
    const end = start + 2 * DAY_SECONDS - 1
    const data: QuotaDataItem[] = [
      {
        created_at: start + 1 * HOUR_SECONDS,
        model_name: 'alpha',
        token_used: 100,
      },
      {
        created_at: start + 2 * HOUR_SECONDS,
        model_name: 'alpha',
        token_used: 50,
      },
      {
        created_at: start + 3 * HOUR_SECONDS,
        model_name: 'beta',
        token_used: 30,
      },
      {
        created_at: start + DAY_SECONDS + HOUR_SECONDS,
        model_name: 'beta',
        token_used: 20,
      },
    ]

    const series = buildTokenUsageSeries(data, start, end, 'day', 'Other')
    const width = series.models.length
    const firstBucket = series.values.slice(0, width)
    const secondBucket = series.values.slice(width, width * 2)

    // alpha totals 150, beta 50, so alpha ranks first.
    expect(series.models).toEqual(['alpha', 'beta'])
    expect(series.total).toBe(200)
    expect(firstBucket).toEqual([
      { Time: expect.any(String), Model: 'alpha', Tokens: 150 },
      { Time: expect.any(String), Model: 'beta', Tokens: 30 },
    ])
    expect(secondBucket).toEqual([
      { Time: expect.any(String), Model: 'alpha', Tokens: 0 },
      { Time: expect.any(String), Model: 'beta', Tokens: 20 },
    ])
  })

  it('keeps buckets with no usage so the time axis stays continuous', () => {
    const start = localMidnight(2026, 1, 12)
    const end = start + 5 * DAY_SECONDS - 1
    const data: QuotaDataItem[] = [
      { created_at: start + HOUR_SECONDS, model_name: 'alpha', token_used: 10 },
    ]

    const series = buildTokenUsageSeries(data, start, end, 'day', 'Other')
    expect(series.values).toHaveLength(5)
    expect(series.values.filter((item) => item.Tokens === 0)).toHaveLength(4)
  })

  it('collapses models beyond the series limit into the Other bucket', () => {
    const start = localMidnight(2026, 1, 12)
    const end = start + DAY_SECONDS - 1
    const data: QuotaDataItem[] = Array.from(
      { length: MAX_TOKEN_SERIES + 3 },
      (_, index) => ({
        created_at: start + HOUR_SECONDS,
        model_name: `model-${String(index).padStart(2, '0')}`,
        token_used: (MAX_TOKEN_SERIES + 3 - index) * 10,
      })
    )

    const series = buildTokenUsageSeries(data, start, end, 'day', 'Other')
    const expectedOther = data
      .slice(MAX_TOKEN_SERIES)
      .reduce((sum, item) => sum + (item.token_used ?? 0), 0)
    const otherTotal = series.values
      .filter((item) => item.Model === 'Other')
      .reduce((sum, item) => sum + item.Tokens, 0)

    expect(series.models).toHaveLength(MAX_TOKEN_SERIES + 1)
    expect(series.models.at(-1)).toBe('Other')
    expect(otherTotal).toBe(expectedOther)
    expect(series.total).toBe(
      data.reduce((sum, item) => sum + (item.token_used ?? 0), 0)
    )
  })
})

describe('persisted settings', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to a seven day range aggregated by day', () => {
    const settings = defaultTokenUsageSettings()
    expect(settings.rangeKey).toBe('7d')
    expect(settings.granularity).toBe('day')
  })

  it('round trips a selection through local storage', () => {
    const bounds = boundsForRangeKey('30d')
    saveTokenUsageSettings({
      rangeKey: '30d',
      ...bounds,
      granularity: 'hour',
    })

    const restored = loadTokenUsageSettings()
    expect(restored.rangeKey).toBe('30d')
    expect(restored.granularity).toBe('hour')
    // Rolling presets are re-derived, so the stored window stays current.
    expect(restored.end).toBeGreaterThan(0)
  })

  it('re-derives rolling ranges instead of trusting stored timestamps', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        rangeKey: '7d',
        start: 1,
        end: 2,
        granularity: 'day',
      })
    )

    const restored = loadTokenUsageSettings()
    const expected = boundsForRangeKey('7d')
    expect(Math.abs(restored.start - expected.start)).toBeLessThan(120)
    expect(Math.abs(restored.end - expected.end)).toBeLessThan(120)
  })

  it('falls back to the default when the stored granularity is not allowed', () => {
    const bounds = boundsForRangeKey('1d')
    window.localStorage.setItem(
      STORAGE_KEY,
      // A single day cannot be aggregated by month.
      JSON.stringify({ rangeKey: '1d', ...bounds, granularity: 'month' })
    )

    expect(loadTokenUsageSettings().granularity).toBe('hour')
  })

  it('falls back to the default when the stored payload is unusable', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')
    expect(loadTokenUsageSettings().rangeKey).toBe('7d')

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ rangeKey: 'custom', start: 500, end: 100 })
    )
    expect(loadTokenUsageSettings().rangeKey).toBe('7d')
  })
})
