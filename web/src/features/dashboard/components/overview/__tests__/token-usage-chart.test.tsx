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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { TokenUsageChart } from '../token-usage-chart'

// VChart needs a real canvas and reads browser APIs at import time, so both the
// component and the theme manager are stubbed at the library boundary.
vi.mock('@visactor/react-vchart', () => ({ VChart: () => null }))
vi.mock('@visactor/vchart', () => ({
  ThemeManager: { setCurrentTheme: vi.fn() },
}))

const DAY_SECONDS = 86_400
const STORAGE_KEY = 'dashboard_overview_token_usage_settings'

let client: QueryClient

beforeEach(() => {
  window.localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (String(url).startsWith('/api/data')) {
      return { data: { success: true, data: [] } }
    }
    throw new Error(`Unexpected token usage request: ${url}`)
  })
})

afterEach(() => {
  cleanup()
  client.clear()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  window.localStorage.clear()
  vi.restoreAllMocks()
})

function signIn(role: number, username: string) {
  useAuthStore.getState().auth.setUser({
    id: 1,
    username,
    role,
    quota: 1_000_000,
    used_quota: 0,
    request_count: 0,
  })
}

function renderChart(queryClient: QueryClient = client) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TokenUsageChart />
    </QueryClientProvider>
  )
}

interface QuotaCall {
  url: string
  params: Record<string, unknown>
}

function quotaCalls(): QuotaCall[] {
  return vi
    .mocked(api.get)
    .mock.calls.filter((call) => String(call[0]).startsWith('/api/data'))
    .map((call) => ({
      url: String(call[0]),
      params:
        (call[1] as { params?: Record<string, unknown> } | undefined)?.params ??
        {},
    }))
}

function lastQuotaCall(): QuotaCall {
  const call = quotaCalls().at(-1)
  if (!call) throw new Error('no quota_data request recorded yet')
  return call
}

function expectRangeApproximately(days: number, start: unknown) {
  const now = Math.floor(Date.now() / 1000)
  expect(Math.abs(now - days * DAY_SECONDS - Number(start))).toBeLessThan(120)
}

describe('overview token usage chart', () => {
  it('defaults to a seven day window aggregated by day', async () => {
    signIn(1, 'plain-user')
    renderChart()

    await waitFor(() => expect(quotaCalls().length).toBeGreaterThan(0))

    const call = lastQuotaCall()
    expect(call.url).toBe('/api/data/self')
    expect(call.params.default_time).toBe('day')
    expectRangeApproximately(7, call.params.start_timestamp)
  })

  it('scopes the admin query to the signed in user', async () => {
    signIn(10, 'admin-user')
    renderChart()

    await waitFor(() => expect(quotaCalls().length).toBeGreaterThan(0))

    const call = lastQuotaCall()
    // The admin endpoint aggregates every user unless a username is supplied.
    expect(call.url).toBe('/api/data')
    expect(call.params.username).toBe('admin-user')
  })

  it('requests the picked preset range', async () => {
    const user = userEvent.setup()
    signIn(1, 'plain-user')
    renderChart()

    await waitFor(() => expect(quotaCalls().length).toBeGreaterThan(0))
    await user.click(screen.getByRole('button', { name: '30 Days' }))

    await waitFor(() =>
      expectRangeApproximately(30, lastQuotaCall().params.start_timestamp)
    )
  })

  it('restores the picked preset after a remount', async () => {
    const first = userEvent.setup()
    signIn(1, 'plain-user')
    const view = renderChart()

    await waitFor(() => expect(quotaCalls().length).toBeGreaterThan(0))
    await first.click(screen.getByRole('button', { name: '30 Days' }))
    await waitFor(() =>
      expect(window.localStorage.getItem(STORAGE_KEY)).toContain('30d')
    )

    view.unmount()
    vi.mocked(api.get).mockClear()
    // A page refresh starts from an empty query cache.
    renderChart(
      new QueryClient({ defaultOptions: { queries: { retry: false } } })
    )

    await waitFor(() =>
      expectRangeApproximately(30, lastQuotaCall().params.start_timestamp)
    )
  })

  it('resets to each preset default granularity instead of carrying one over', async () => {
    const user = userEvent.setup()
    signIn(10, 'admin-user')
    renderChart()

    await waitFor(() => expect(quotaCalls().length).toBeGreaterThan(0))

    // Read the granularity back from the dialog, which is where the applied
    // selection is surfaced (a cached range issues no new request).
    const readDialogGranularity = async (): Promise<string | null> => {
      await user.click(screen.getByRole('button', { name: 'Filter' }))
      const dialog = await screen.findByRole('dialog')
      const value = within(dialog).getByText(
        /^(Per Hour|Per Day|Per Week|Per Month)$/,
        {
          selector: '[data-slot="select-value"]',
        }
      )
      const label = value.textContent
      await user.click(
        within(dialog).getByRole('button', { name: 'Apply Filters' })
      )
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      )
      return label
    }

    await user.click(screen.getByRole('button', { name: '1 Day' }))
    expect(await readDialogGranularity()).toBe('Per Hour')

    // Picking 7 Days must fall back to daily, not stay hourly.
    await user.click(screen.getByRole('button', { name: '7 Days' }))
    expect(await readDialogGranularity()).toBe('Per Day')

    // ...and 30 Days stays daily too.
    await user.click(screen.getByRole('button', { name: '30 Days' }))
    expect(await readDialogGranularity()).toBe('Per Day')
  })

  it('requests all time monthly from an unbounded start', async () => {
    const user = userEvent.setup()
    signIn(10, 'admin-user')
    renderChart()

    await waitFor(() => expect(quotaCalls().length).toBeGreaterThan(0))
    await user.click(screen.getByRole('button', { name: 'All Time' }))

    await waitFor(() => {
      const call = lastQuotaCall()
      expect(call.params.default_time).toBe('month')
      expect(call.params.start_timestamp).toBe(0)
    })
  })

  it('shows the translated granularity label in the filter dialog', async () => {
    const user = userEvent.setup()
    signIn(1, 'plain-user')
    renderChart()

    await waitFor(() => expect(quotaCalls().length).toBeGreaterThan(0))
    await user.click(screen.getByRole('button', { name: 'Filter' }))

    // The trigger must render the label, never the raw option value.
    const trigger = await screen.findByText('Per Day', {
      selector: '[data-slot="select-value"]',
    })
    expect(trigger).toBeInTheDocument()
    expect(screen.queryByText('day')).not.toBeInTheDocument()
  })

  it('shows the active granularity in the chart header', async () => {
    const user = userEvent.setup()
    signIn(1, 'plain-user')
    renderChart()

    await waitFor(() => expect(quotaCalls().length).toBeGreaterThan(0))
    // Default range is 7 days, aggregated per day, labelled with its prefix.
    expect(await screen.findByText(/Granularity:/)).toBeInTheDocument()
    expect(screen.getByText(/Per Day/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '1 Day' }))
    expect(await screen.findByText(/Per Hour/)).toBeInTheDocument()
  })

  it('shows the summed token total of the returned range', async () => {
    signIn(1, 'plain-user')
    vi.mocked(api.get).mockImplementation(async (url) => {
      if (String(url).startsWith('/api/data')) {
        return {
          data: {
            success: true,
            data: [
              {
                created_at: Math.floor(Date.now() / 1000),
                model_name: 'alpha',
                token_used: 1_200,
              },
              {
                created_at: Math.floor(Date.now() / 1000),
                model_name: 'beta',
                token_used: 300,
              },
            ],
          },
        }
      }
      throw new Error(`Unexpected token usage request: ${url}`)
    })

    renderChart()

    expect(await screen.findByText(/Total: 1[.,\s]?500/)).toBeInTheDocument()
  })
})
