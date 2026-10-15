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
import {
  useIsFetching,
  useQueryClient,
  type QueryFilters,
} from '@tanstack/react-query'
import { RefreshCw, Settings2 } from 'lucide-react'
import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

import { useRefreshCooldown } from '../../hooks/use-refresh-cooldown'

const STORAGE_KEY = 'dashboard_overview_refresh_settings'
const REFRESH_INTERVALS = [10, 15, 30, 60, 120, 300]
const OVERVIEW_QUERIES: QueryFilters = {
  type: 'active',
  predicate: (query) => {
    const key = query.queryKey
    return (
      (key[0] === 'dashboard' && key[1] === 'overview') ||
      key[0] === 'status' ||
      key[0] === 'perf-metrics-summary'
    )
  },
}

interface RefreshSettings {
  enabled: boolean
  intervalSeconds: number
}

function loadRefreshSettings(): RefreshSettings {
  const defaults = { enabled: true, intervalSeconds: 30 }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const saved = JSON.parse(raw) as Partial<RefreshSettings> | null
    return {
      enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : true,
      intervalSeconds:
        typeof saved?.intervalSeconds === 'number' &&
        REFRESH_INTERVALS.includes(saved.intervalSeconds)
          ? saved.intervalSeconds
          : 30,
    }
  } catch {
    return defaults
  }
}

export function OverviewRefreshControls() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { coolingDown, startCooldown } = useRefreshCooldown()
  const fetching = useIsFetching(OVERVIEW_QUERIES) > 0
  const refreshing = fetching || coolingDown
  const [settings, setSettings] = useState(loadRefreshSettings)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(settings)
  const enabledId = useId()
  const intervalId = useId()

  const refresh = useCallback(() => {
    if (queryClient.isFetching(OVERVIEW_QUERIES)) return
    // Keep the current data visible and share any requests already in flight.
    void queryClient.refetchQueries(OVERVIEW_QUERIES, { cancelRefetch: false })
  }, [queryClient])

  useEffect(() => {
    if (!settings.enabled) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      refresh()
    }, settings.intervalSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [refresh, settings.enabled, settings.intervalSeconds])

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) setDraft(settings)
    setOpen(nextOpen)
  }

  const handleSave = () => {
    setSettings(draft)
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
    } catch {
      // Keep the selected settings for this visit when storage is unavailable.
    }
    setOpen(false)
  }

  return (
    <div className='flex shrink-0 items-center gap-1.5'>
      <Button
        type='button'
        variant='outline'
        size='icon-sm'
        onClick={() => {
          if (queryClient.isFetching(OVERVIEW_QUERIES) || !startCooldown())
            return
          refresh()
        }}
        disabled={refreshing}
        aria-label={t('Refresh overview')}
        aria-busy={refreshing}
        title={refreshing ? t('Refreshing...') : t('Refresh overview')}
      >
        <RefreshCw
          aria-hidden='true'
          className={cn(refreshing && 'animate-spin')}
        />
      </Button>
      <Dialog
        open={open}
        onOpenChange={handleOpenChange}
        trigger={
          <Button
            type='button'
            variant='outline'
            size='icon-sm'
            aria-label={t('Refresh settings')}
            title={t('Refresh settings')}
          >
            <Settings2 aria-hidden='true' />
          </Button>
        }
        title={t('Refresh settings')}
        description={t(
          'Choose whether and how often to refresh the overview automatically.'
        )}
        contentClassName='sm:max-w-sm'
        bodyClassName='grid gap-4'
        footer={
          <>
            <Button
              type='button'
              variant='outline'
              onClick={() => setOpen(false)}
            >
              {t('Cancel')}
            </Button>
            <Button type='button' onClick={handleSave}>
              {t('Save')}
            </Button>
          </>
        }
      >
        <div className='flex items-center justify-between gap-4'>
          <Label htmlFor={enabledId}>{t('Auto refresh')}</Label>
          <Switch
            id={enabledId}
            checked={draft.enabled}
            onCheckedChange={(enabled) =>
              setDraft((prev) => ({ ...prev, enabled }))
            }
          />
        </div>
        <div className='grid gap-2'>
          <Label htmlFor={intervalId}>{t('Refresh interval (seconds)')}</Label>
          <Select
            disabled={!draft.enabled}
            value={String(draft.intervalSeconds)}
            items={REFRESH_INTERVALS.map((seconds) => ({
              value: String(seconds),
              label: t('{{seconds}} seconds', { seconds }),
            }))}
            onValueChange={(value) => {
              const intervalSeconds = Number(value)
              if (REFRESH_INTERVALS.includes(intervalSeconds)) {
                setDraft((prev) => ({ ...prev, intervalSeconds }))
              }
            }}
          >
            <SelectTrigger id={intervalId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {REFRESH_INTERVALS.map((seconds) => (
                <SelectItem key={seconds} value={String(seconds)}>
                  {t('{{seconds}} seconds', { seconds })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Dialog>
    </div>
  )
}
