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
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StaggerContainer, StaggerItem } from '@/components/page-transition'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { getUserQuotaDates } from '@/features/dashboard/api'
import {
  useSummaryCardsConfig,
  type SummaryCardsVariant,
} from '@/features/dashboard/hooks/use-dashboard-config'
import type { QuotaDataItem } from '@/features/dashboard/types'
import { getUserLogStats, getUserLogTokenStat } from '@/features/usage-logs/api'
import type { LogTokenStat } from '@/features/usage-logs/types'
import { useStatus } from '@/hooks/use-status'
import { toIntlLocale } from '@/i18n/languages'
import { getCurrencyLabel, isCurrencyDisplayEnabled } from '@/lib/currency'
import { formatCompactNumber, formatNumber, formatQuota } from '@/lib/format'
import { computeTimeRange } from '@/lib/time'

import { useOverviewAccount } from '../../hooks/use-overview-account'
import { StatCard, type StatCardTone } from '../ui/stat-card'

const SUMMARY_SPARKLINE_BUCKETS = 12

// Tones follow the card itself rather than its slot, so reordering the cards in
// useSummaryCardsConfig never repaints them.
const SUMMARY_CARD_TONES: Record<string, StatCardTone> = {
  windowTokens: 'accent-1',
  usage: 'accent-2',
  requests: 'accent-3',
  lifetimeTokens: 'accent-4',
  // Keeps the palette of the spend card it replaces on the usage logs page.
  todayTokens: 'accent-2',
}

const DEFAULT_SUMMARY_CARD_TONE: StatCardTone = 'accent-4'

type SummaryWindow = 'last24h' | 'today'

const SUMMARY_WINDOWS: SummaryWindow[] = ['last24h', 'today']

const SUMMARY_WINDOW_LABEL_KEYS: Record<SummaryWindow, string> = {
  last24h: 'Last 24 hours',
  today: 'Today',
}

type SummarySparklineKey = 'usage' | 'requests' | 'tokens'

function getBucketIndex(
  timestamp: number,
  start: number,
  end: number,
  bucketCount: number
): number {
  if (end <= start) return 0
  const ratio = (timestamp - start) / (end - start)
  return Math.min(bucketCount - 1, Math.max(0, Math.floor(ratio * bucketCount)))
}

function buildSummarySparklines(
  data: QuotaDataItem[],
  start: number,
  end: number
): Record<SummarySparklineKey, number[]> {
  const usage = Array.from({ length: SUMMARY_SPARKLINE_BUCKETS }, () => 0)
  const requests = Array.from({ length: SUMMARY_SPARKLINE_BUCKETS }, () => 0)
  const tokens = Array.from({ length: SUMMARY_SPARKLINE_BUCKETS }, () => 0)

  for (const item of data) {
    const timestamp = Number(item.created_at) || start
    const index = getBucketIndex(
      timestamp,
      start,
      end,
      SUMMARY_SPARKLINE_BUCKETS
    )
    usage[index] += Number(item.quota) || 0
    requests[index] += Number(item.count) || 0
    tokens[index] += Number(item.token_used) || 0
  }

  return { usage, requests, tokens }
}

function getSummarySparkline(
  key: string,
  windowSparklines: Record<SummarySparklineKey, number[]>,
  baselineSparklines: Record<SummarySparklineKey, number[]>
): number[] | undefined {
  // Only the windowed token card follows the range switcher; the other cards
  // keep the fixed trailing-24h trend.
  if (key === 'windowTokens') return windowSparklines.tokens
  if (key === 'usage') return baselineSparklines.usage
  if (key === 'requests') return baselineSparklines.requests
  return undefined
}

function sumTokenUsed(data: QuotaDataItem[]): number {
  return data.reduce((total, item) => total + (Number(item.token_used) || 0), 0)
}

const EMPTY_TOKEN_STAT: LogTokenStat = {
  prompt_tokens: 0,
  completion_tokens: 0,
  cache_tokens: 0,
}

/**
 * The caption of the today-token card: "Input: 1.2K / Output: 300 / Cache: 12K".
 *
 * Every figure reuses the compact conversion of the dashboard stat cards, so a
 * long token total stays readable instead of unrolling into full digit runs.
 */
function buildTokenBreakdown(
  stat: LogTokenStat,
  locale: string | undefined,
  t: (key: string) => string
): string {
  const entries: Array<[string, number]> = [
    [t('Input'), stat.prompt_tokens],
    [t('Output'), stat.completion_tokens],
    [t('Cache'), stat.cache_tokens],
  ]

  return entries
    .map(([label, value]) => `${label}: ${formatCompactNumber(value, locale)}`)
    .join(' / ')
}

interface SummaryCardsProps {
  /**
   * `logs` swaps the spend card for the today-token card so the usage logs page
   * never renders a currency figure.
   */
  variant?: SummaryCardsVariant
}

export function SummaryCards(props: SummaryCardsProps = {}) {
  const variant = props.variant ?? 'overview'
  const { t, i18n } = useTranslation()
  const user = useOverviewAccount()
  const { status, loading } = useStatus()
  const [summaryWindow, setSummaryWindow] = useState<SummaryWindow>('today')

  const usedQuota = Number(user?.used_quota ?? 0)
  const requestCount = Number(user?.request_count ?? 0)

  const usageTrendQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'summary-sparklines', summaryWindow],
    queryFn: async () => {
      const timeRange =
        summaryWindow === 'today'
          ? computeTimeRange(0, undefined, undefined, true)
          : computeTimeRange(1)
      const result = await getUserQuotaDates({
        ...timeRange,
        default_time: 'hour',
      })
      return { ...result, timeRange }
    },
    staleTime: 60 * 1000,
  })

  // Other cards always use the trailing-24h trend, even when tokens show today.
  const baselineTrendQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'summary-sparklines', 'last24h'],
    queryFn: async () => {
      const timeRange = computeTimeRange(1)
      const result = await getUserQuotaDates({
        ...timeRange,
        default_time: 'hour',
      })
      return { ...result, timeRange }
    },
    staleTime: 60 * 1000,
  })

  const lifetimeTokenQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'lifetime-tokens'],
    queryFn: async () => getUserLogStats(),
    staleTime: 5 * 60 * 1000,
  })

  // Only the usage logs page renders the today-token card, so the overview page
  // never pays for this per-log scan.
  const todayTokenQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'today-token-breakdown'],
    queryFn: async () => {
      const timeRange = computeTimeRange(0, undefined, undefined, true)
      const result = await getUserLogTokenStat({
        start_timestamp: timeRange.start_timestamp,
        end_timestamp: timeRange.end_timestamp,
      })
      return result.success && result.data ? result.data : EMPTY_TOKEN_STAT
    },
    enabled: variant === 'logs',
    staleTime: 60 * 1000,
  })

  const currencyEnabledFromStore = isCurrencyDisplayEnabled()
  const statusCurrencyFlag =
    typeof status?.display_in_currency === 'boolean'
      ? Boolean(status.display_in_currency)
      : undefined
  const currencyEnabled =
    statusCurrencyFlag !== undefined
      ? statusCurrencyFlag
      : currencyEnabledFromStore
  const currencyLabel = currencyEnabled ? getCurrencyLabel() : 'Tokens'

  const windowSparklines = useMemo(
    () =>
      buildSummarySparklines(
        usageTrendQuery.data?.data ?? [],
        usageTrendQuery.data?.timeRange.start_timestamp ?? 0,
        usageTrendQuery.data?.timeRange.end_timestamp ?? 0
      ),
    [usageTrendQuery.data]
  )

  const baselineSparklines = useMemo(
    () =>
      buildSummarySparklines(
        baselineTrendQuery.data?.data ?? [],
        baselineTrendQuery.data?.timeRange.start_timestamp ?? 0,
        baselineTrendQuery.data?.timeRange.end_timestamp ?? 0
      ),
    [baselineTrendQuery.data]
  )

  const windowTokens = useMemo(
    () => sumTokenUsed(usageTrendQuery.data?.data ?? []),
    [usageTrendQuery.data?.data]
  )

  const windowLabel = t(SUMMARY_WINDOW_LABEL_KEYS[summaryWindow])
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const lifetimeTokens = Number(lifetimeTokenQuery.data?.data?.token) || 0
  const todayTokens = todayTokenQuery.data ?? EMPTY_TOKEN_STAT
  const todayTokenTotal =
    todayTokens.prompt_tokens + todayTokens.completion_tokens

  const windowToggle = (
    <ToggleGroup
      value={[summaryWindow]}
      onValueChange={(value) => {
        const nextWindow = value.find((item) => item !== summaryWindow)
        if (nextWindow) setSummaryWindow(nextWindow as SummaryWindow)
      }}
      aria-label={t('Time range')}
      variant='outline'
      size='sm'
    >
      {SUMMARY_WINDOWS.map((windowKey) => (
        <ToggleGroupItem key={windowKey} value={windowKey}>
          {t(SUMMARY_WINDOW_LABEL_KEYS[windowKey])}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )

  // Cards backed by their own request keep the skeleton until it settles.
  const cardQueryLoading: Record<string, boolean> = {
    lifetimeTokens: lifetimeTokenQuery.isLoading,
    todayTokens: todayTokenQuery.isLoading,
  }

  const items = useSummaryCardsConfig({
    windowTokenDisplay: formatNumber(windowTokens),
    windowLabel,
    usedDisplay: formatQuota(usedQuota),
    requestCountDisplay: formatNumber(requestCount),
    lifetimeTokenDisplay: formatNumber(lifetimeTokens),
    currencyEnabled,
    currencyLabel,
    variant,
    todayTokenDisplay: formatNumber(todayTokenTotal),
    todayTokenBreakdown: buildTokenBreakdown(todayTokens, locale, t),
  }).map((config) => {
    return {
      key: config.key,
      title: config.title,
      value: config.value,
      desc: config.description,
      icon: config.icon,
      tone: SUMMARY_CARD_TONES[config.key] ?? DEFAULT_SUMMARY_CARD_TONE,
      loading: loading || (cardQueryLoading[config.key] ?? false),
      sparkline: getSummarySparkline(
        config.key,
        windowSparklines,
        baselineSparklines
      ),
      sparklineVariant: 'line' as const,
      // The window switcher belongs to the windowed token card.
      action: config.key === 'windowTokens' ? windowToggle : undefined,
      // Abbreviated all-time total beside the title; the full grouped figure
      // stays as the card value below.
      titleValue:
        config.key === 'lifetimeTokens' && lifetimeTokens > 0
          ? formatCompactNumber(lifetimeTokens, locale)
          : undefined,
    }
  })

  return (
    <div className='bg-card overflow-hidden rounded-2xl border shadow-xs'>
      <div className='flex flex-col gap-2.5 p-3 sm:gap-3 sm:p-5'>
        <div className='flex flex-col gap-1'>
          <h3 className='text-sm font-semibold sm:text-base'>
            {t('Usage at a glance')}
          </h3>
          <p className='text-muted-foreground text-xs sm:text-sm'>
            {t('Monitor token usage and request volume')}
          </p>
        </div>
        <StaggerContainer className='grid grid-cols-2 gap-1.5 sm:gap-3 xl:grid-cols-4'>
          {items.map((it) => (
            <StaggerItem
              key={it.key}
              className='bg-background/60 rounded-lg border px-2 py-1.5 sm:rounded-xl sm:p-3'
            >
              <StatCard
                title={it.title}
                value={it.value}
                description={it.desc}
                icon={it.icon}
                tone={it.tone}
                sparkline={it.sparkline}
                sparklineVariant={it.sparklineVariant}
                loading={it.loading}
                action={it.action}
                titleValue={it.titleValue}
                compactMobile
              />
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </div>
  )
}
