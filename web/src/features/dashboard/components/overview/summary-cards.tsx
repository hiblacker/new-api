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
import { useSummaryCardsConfig } from '@/features/dashboard/hooks/use-dashboard-config'
import type { QuotaDataItem } from '@/features/dashboard/types'
import { getUserLogStats } from '@/features/usage-logs/api'
import { useStatus } from '@/hooks/use-status'
import { getCurrencyLabel, isCurrencyDisplayEnabled } from '@/lib/currency'
import { formatNumber, formatQuota } from '@/lib/format'
import { computeTimeRange } from '@/lib/time'
import { useAuthStore } from '@/stores/auth-store'

import { StatCard } from '../ui/stat-card'

const SUMMARY_SPARKLINE_BUCKETS = 12

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

export function SummaryCards() {
  const { t } = useTranslation()
  const user = useAuthStore((state) => state.auth.user)
  const { status, loading } = useStatus()
  const [summaryWindow, setSummaryWindow] = useState<SummaryWindow>('last24h')

  const usedQuota = Number(user?.used_quota ?? 0)
  const requestCount = Number(user?.request_count ?? 0)

  // Fixed trailing 24 hours. Cards that are not driven by the window switcher
  // keep their trend based on this range so toggling never moves them.
  const baselineTimeRange = useMemo(() => computeTimeRange(1), [])

  const windowTimeRange = useMemo(() => {
    // computeTimeRange(1) covers the trailing 24 hours; a zero-day range
    // normalized to the start of day covers today (00:00:00-23:59:59).
    if (summaryWindow === 'today') {
      return computeTimeRange(0, undefined, undefined, true)
    }
    return baselineTimeRange
  }, [baselineTimeRange, summaryWindow])

  const usageTrendQuery = useQuery({
    queryKey: [
      'dashboard',
      'overview',
      'summary-sparklines',
      windowTimeRange.start_timestamp,
      windowTimeRange.end_timestamp,
    ],
    queryFn: async () =>
      getUserQuotaDates({
        start_timestamp: windowTimeRange.start_timestamp,
        end_timestamp: windowTimeRange.end_timestamp,
        default_time: 'hour',
      }),
    staleTime: 60 * 1000,
  })

  const baselineTrendQuery = useQuery({
    queryKey: [
      'dashboard',
      'overview',
      'summary-sparklines',
      baselineTimeRange.start_timestamp,
      baselineTimeRange.end_timestamp,
    ],
    queryFn: async () =>
      getUserQuotaDates({
        start_timestamp: baselineTimeRange.start_timestamp,
        end_timestamp: baselineTimeRange.end_timestamp,
        default_time: 'hour',
      }),
    staleTime: 60 * 1000,
  })

  const lifetimeTokenQuery = useQuery({
    queryKey: ['dashboard', 'overview', 'lifetime-tokens'],
    queryFn: async () => getUserLogStats(),
    staleTime: 5 * 60 * 1000,
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
        windowTimeRange.start_timestamp,
        windowTimeRange.end_timestamp
      ),
    [
      usageTrendQuery.data?.data,
      windowTimeRange.end_timestamp,
      windowTimeRange.start_timestamp,
    ]
  )

  const baselineSparklines = useMemo(
    () =>
      buildSummarySparklines(
        baselineTrendQuery.data?.data ?? [],
        baselineTimeRange.start_timestamp,
        baselineTimeRange.end_timestamp
      ),
    [
      baselineTimeRange.end_timestamp,
      baselineTimeRange.start_timestamp,
      baselineTrendQuery.data?.data,
    ]
  )

  const windowTokens = useMemo(
    () => sumTokenUsed(usageTrendQuery.data?.data ?? []),
    [usageTrendQuery.data?.data]
  )

  const windowLabel = t(SUMMARY_WINDOW_LABEL_KEYS[summaryWindow])

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

  const items = useSummaryCardsConfig({
    windowTokenDisplay: formatNumber(windowTokens),
    windowLabel,
    usedDisplay: formatQuota(usedQuota),
    requestCountDisplay: formatNumber(requestCount),
    lifetimeTokenDisplay: formatNumber(lifetimeTokenQuery.data?.data?.token),
    currencyEnabled,
    currencyLabel,
  }).map((config, index) => {
    const tones = ['accent-1', 'accent-2', 'accent-3', 'accent-4'] as const

    return {
      key: config.key,
      title: config.title,
      value: config.value,
      desc: config.description,
      icon: config.icon,
      tone: tones[index] ?? 'accent-4',
      loading:
        config.key === 'lifetimeTokens'
          ? loading || lifetimeTokenQuery.isLoading
          : loading,
      sparkline: getSummarySparkline(
        config.key,
        windowSparklines,
        baselineSparklines
      ),
      sparklineVariant: 'line' as const,
      // The window switcher belongs to the windowed token card.
      action: config.key === 'windowTokens' ? windowToggle : undefined,
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
                compactMobile
              />
            </StaggerItem>
          ))}
        </StaggerContainer>
      </div>
    </div>
  )
}
