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
import { VChart } from '@visactor/react-vchart'
import { BarChart3, Filter, RotateCcw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DateTimePicker } from '@/components/datetime-picker'
import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTheme } from '@/context/theme-provider'
import { getUserQuotaDates } from '@/features/dashboard/api'
import { SectionDivider } from '@/features/dashboard/components/ui/section-divider'
import { useVChartTheme } from '@/features/dashboard/hooks/use-vchart-theme'
import { getDashboardChartColors } from '@/features/dashboard/lib/charts'
import {
  TOKEN_USAGE_GRANULARITY_LABEL_KEYS,
  TOKEN_USAGE_RANGE_PRESETS,
  allowedGranularities,
  axisStartFor,
  boundsForRangeKey,
  buildTokenUsageSeries,
  defaultTokenUsageSettings,
  loadTokenUsageSettings,
  rangeDaysBetween,
  rangeDaysFor,
  resolveGranularity,
  saveTokenUsageSettings,
  type TokenUsageGranularity,
  type TokenUsageRangeKey,
  type TokenUsageSettings,
} from '@/features/dashboard/lib/token-usage'
import { formatCompactNumber, formatNumber } from '@/lib/format'
import { VCHART_OPTION } from '@/lib/vchart'
import { useAuthStore } from '@/stores/auth-store'

const GRANULARITY_ORDER: TokenUsageGranularity[] = [
  'hour',
  'day',
  'week',
  'month',
]

/** Builds the settings a preset button applies. */
function settingsForRangeKey(
  rangeKey: TokenUsageRangeKey,
  preferred?: TokenUsageGranularity,
  custom?: { start: number; end: number }
): TokenUsageSettings {
  const bounds = boundsForRangeKey(rangeKey, custom)
  const rangeDays = rangeDaysFor(rangeKey, bounds.start, bounds.end)
  return {
    rangeKey,
    ...bounds,
    granularity: resolveGranularity(rangeDays, preferred),
  }
}

interface TokenUsageFilterDialogProps {
  settings: TokenUsageSettings
  onApply: (settings: TokenUsageSettings) => void
}

function TokenUsageFilterDialog(props: TokenUsageFilterDialogProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(props.settings)

  // Re-seed the draft from the applied settings on every open so a cancelled
  // edit never leaks into the next one.
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setDraft(props.settings)
    setOpen(nextOpen)
  }

  const draftDays = rangeDaysFor(draft.rangeKey, draft.start, draft.end)
  const allowed = allowedGranularities(draftDays)

  const selectPreset = (rangeKey: TokenUsageRangeKey) => {
    setDraft(settingsForRangeKey(rangeKey))
  }

  const updateCustomBound = (bound: 'start' | 'end', date: Date) => {
    setDraft((prev) => {
      const seconds = Math.floor(date.getTime() / 1000)
      const next = { ...prev, rangeKey: 'custom' as const, [bound]: seconds }
      if (next.end <= next.start) return prev
      return {
        ...next,
        granularity: resolveGranularity(
          rangeDaysBetween(next.start, next.end),
          prev.granularity
        ),
      }
    })
  }

  const handleApply = () => {
    props.onApply(draft)
    setOpen(false)
  }

  const handleReset = () => {
    setDraft(defaultTokenUsageSettings())
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      trigger={
        <Button variant='outline' size='sm'>
          <Filter className='mr-2 h-4 w-4' />
          {t('Filter')}
        </Button>
      }
      title={t('Token Usage Filters')}
      description={t(
        'Choose the time range and how usage is aggregated into buckets.'
      )}
      contentClassName='max-sm:h-dvh max-sm:w-screen max-sm:max-w-none max-sm:rounded-none max-sm:p-4 sm:max-w-lg'
      contentHeight='min(48vh, 460px)'
      footerClassName='grid grid-cols-2 gap-2 sm:flex'
      footer={
        <>
          <Button onClick={handleReset} variant='outline' type='button'>
            <RotateCcw className='mr-2 h-4 w-4' />
            {t('Reset')}
          </Button>
          <Button onClick={handleApply} type='button'>
            <Search className='mr-2 h-4 w-4' />
            {t('Apply Filters')}
          </Button>
        </>
      }
    >
      <ScrollArea className='h-full pr-3 sm:pr-4'>
        <div className='grid gap-2.5 py-2'>
          <div className='grid gap-2'>
            <Label className='flex items-center gap-2'>
              {t('Quick Range')}
            </Label>
            <div className='grid grid-cols-2 gap-2 sm:flex'>
              {TOKEN_USAGE_RANGE_PRESETS.map((preset) => (
                <Button
                  key={preset.key}
                  type='button'
                  size='sm'
                  variant={
                    draft.rangeKey === preset.key ? 'default' : 'outline'
                  }
                  onClick={() => selectPreset(preset.key)}
                  className='flex-1'
                >
                  {t(preset.labelKey)}
                </Button>
              ))}
            </div>
          </div>

          <SectionDivider label={t('Custom Time Range')} />

          <div className='grid gap-2.5'>
            <div className='grid gap-2'>
              <Label>{t('Start Time')}</Label>
              <DateTimePicker
                value={new Date(draft.start * 1000)}
                onChange={(date) => {
                  if (date) updateCustomBound('start', date)
                }}
                placeholder={t('Select start time')}
              />
            </div>
            <div className='grid gap-2'>
              <Label>{t('End Time')}</Label>
              <DateTimePicker
                value={new Date(draft.end * 1000)}
                onChange={(date) => {
                  if (date) updateCustomBound('end', date)
                }}
                placeholder={t('Select end time')}
              />
            </div>
          </div>

          <SectionDivider label={t('Chart Settings')} />

          <div className='grid gap-2'>
            <Label>{t('Time Granularity')}</Label>
            <Select
              items={GRANULARITY_ORDER.map((option) => ({
                value: option,
                label: t(TOKEN_USAGE_GRANULARITY_LABEL_KEYS[option]),
              }))}
              value={draft.granularity}
              onValueChange={(value) =>
                setDraft((prev) => ({
                  ...prev,
                  granularity: value as TokenUsageGranularity,
                }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {GRANULARITY_ORDER.map((option) => (
                    <SelectItem
                      key={option}
                      value={option}
                      disabled={!allowed.includes(option)}
                    >
                      {t(TOKEN_USAGE_GRANULARITY_LABEL_KEYS[option])}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      </ScrollArea>
    </Dialog>
  )
}

export function TokenUsageChart() {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const themeReady = useVChartTheme()
  const user = useAuthStore((state) => state.auth.user)
  const isAdmin = !!(user?.role && user.role >= 10)
  const selfUsername = user?.username ?? ''

  const [settings, setSettings] = useState<TokenUsageSettings>(() => {
    const stored = loadTokenUsageSettings()
    // "All time" needs the uncapped admin endpoint, so regular users fall back.
    if (!isAdmin && stored.rangeKey === 'all') {
      return settingsForRangeKey('30d', stored.granularity)
    }
    return stored
  })

  const applySettings = (next: TokenUsageSettings) => {
    setSettings(next)
    saveTokenUsageSettings(next)
  }

  // Picking a preset applies that preset's documented default granularity
  // (day for 7/30 days, month for all time) rather than carrying over whatever
  // the previously selected range used.
  const applyPreset = (rangeKey: TokenUsageRangeKey) => {
    applySettings(settingsForRangeKey(rangeKey))
  }

  const usageQuery = useQuery({
    queryKey: [
      'dashboard',
      'overview',
      'token-usage-chart',
      settings.rangeKey,
      settings.start,
      settings.end,
      settings.granularity,
      isAdmin ? selfUsername : '',
    ],
    queryFn: async () =>
      getUserQuotaDates(
        {
          start_timestamp: settings.start,
          end_timestamp: settings.end,
          default_time: settings.granularity,
          // The admin endpoint aggregates every user unless a username is
          // given, and this overview is a personal view.
          ...(isAdmin && selfUsername ? { username: selfUsername } : {}),
        },
        isAdmin
      ),
    staleTime: 60 * 1000,
  })

  const series = useMemo(() => {
    const rows = usageQuery.data?.data ?? []
    return buildTokenUsageSeries(
      rows,
      axisStartFor(rows, settings.start, settings.end),
      settings.end,
      settings.granularity,
      t('Other')
    )
  }, [
    settings.end,
    settings.granularity,
    settings.start,
    t,
    usageQuery.data?.data,
  ])

  const spec = useMemo(() => {
    if (series.models.length === 0) return null

    return {
      type: 'bar',
      data: [{ id: 'tokenUsageByModel', values: series.values }],
      xField: 'Time',
      yField: 'Tokens',
      seriesField: 'Model',
      stack: true,
      legends: { visible: true, selectMode: 'single' },
      color: {
        type: 'ordinal',
        domain: series.models,
        range: getDashboardChartColors(series.models.length),
      },
      bar: {
        state: {
          hover: { stroke: '#000', lineWidth: 1 },
        },
      },
      axes: [
        {
          orient: 'bottom',
          type: 'band',
          label: { autoHide: true, autoLimit: true },
        },
        {
          orient: 'left',
          type: 'linear',
          label: {
            formatMethod: (value: number) => formatCompactNumber(value),
          },
        },
      ],
      tooltip: {
        mark: {
          content: [
            {
              key: (datum: Record<string, unknown>) => datum?.Model,
              value: (datum: Record<string, unknown>) =>
                formatNumber(Number(datum?.Tokens) || 0),
            },
          ],
        },
        dimension: {
          content: [
            {
              key: (datum: Record<string, unknown>) => datum?.Model,
              value: (datum: Record<string, unknown>) =>
                Number(datum?.Tokens) || 0,
            },
          ],
          updateContent: (array: Array<Record<string, unknown>>) => {
            const sorted = [...array].sort(
              (a, b) => (Number(b.value) || 0) - (Number(a.value) || 0)
            )
            return sorted.map((item) => ({
              ...item,
              value: formatNumber(Number(item.value) || 0),
            }))
          },
        },
      },
      background: { fill: 'transparent' },
      animation: true,
    }
  }, [series])

  const chartKey = [
    settings.rangeKey,
    settings.granularity,
    settings.start,
    settings.end,
    usageQuery.isLoading ? 'loading' : 'ready',
    series.models.length,
    resolvedTheme,
  ].join('-')

  return (
    <div className='bg-card overflow-hidden rounded-2xl border shadow-xs'>
      <div className='flex flex-col gap-2.5 border-b px-3 py-2.5 sm:px-5 sm:py-3'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex min-w-0 items-center gap-2'>
            <IconBadge tone='chart-4' size='sm'>
              <BarChart3 />
            </IconBadge>
            <div className='min-w-0'>
              <div className='truncate text-sm font-semibold'>
                {t('Token Usage by Model')}
              </div>
              <div className='text-muted-foreground truncate text-xs'>
                {t('Total:')} {formatNumber(series.total)}
                <span className='text-muted-foreground/70 ml-4'>
                  {t('Granularity:')}{' '}
                  {t(TOKEN_USAGE_GRANULARITY_LABEL_KEYS[settings.granularity])}
                </span>
              </div>
            </div>
          </div>

          <div className='flex flex-wrap items-center gap-1.5'>
            {TOKEN_USAGE_RANGE_PRESETS.filter(
              (preset) => preset.key !== 'all' || isAdmin
            ).map((preset) => (
              <Button
                key={preset.key}
                type='button'
                size='sm'
                variant={
                  settings.rangeKey === preset.key ? 'default' : 'outline'
                }
                onClick={() => applyPreset(preset.key)}
              >
                {t(preset.labelKey)}
              </Button>
            ))}
            <TokenUsageFilterDialog
              settings={settings}
              onApply={applySettings}
            />
          </div>
        </div>
      </div>

      <div className='h-[320px] p-1.5 sm:h-80 sm:p-2'>
        {themeReady && spec && (
          <VChart
            key={chartKey}
            spec={{
              ...spec,
              theme: resolvedTheme === 'dark' ? 'dark' : 'light',
              background: 'transparent',
            }}
            option={VCHART_OPTION}
          />
        )}
      </div>
    </div>
  )
}
