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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useSystemConfigStore } from '@/stores/system-config-store'

import { SummaryCards } from '../summary-cards'

// Two hourly buckets whose token totals must be summed for the window card.
// Values are large enough that an abbreviated format would add a unit suffix.
const WINDOW_ROWS = [
  { created_at: 1_700_000_000, token_used: 120_000, quota: 10, count: 1 },
  { created_at: 1_700_003_600, token_used: 340_000, quota: 20, count: 2 },
]

const LIFETIME_TOKENS = 1_234_567

let client: QueryClient

beforeEach(() => {
  window.localStorage.clear()
  useSystemConfigStore.setState(useSystemConfigStore.getInitialState(), true)
  useAuthStore.getState().auth.setUser({
    id: 1,
    username: 'summary-user',
    role: 1,
    quota: 1_000_000,
    used_quota: 12_345,
    request_count: 678,
  })
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/data/self') {
      return { data: { success: true, data: WINDOW_ROWS } }
    }
    if (url.startsWith('/api/log/self/stat')) {
      return {
        data: {
          success: true,
          data: { quota: 0, rpm: 0, tpm: 0, token: LIFETIME_TOKENS },
        },
      }
    }
    if (url === '/api/status') {
      return { data: { data: { display_in_currency: false } } }
    }
    throw new Error(`Unexpected summary cards request: ${url}`)
  })
})

afterEach(() => {
  cleanup()
  client.clear()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  useSystemConfigStore.setState(useSystemConfigStore.getInitialState(), true)
  window.localStorage.clear()
  vi.restoreAllMocks()
})

function renderSummaryCards() {
  return render(
    <QueryClientProvider client={client}>
      <SummaryCards />
    </QueryClientProvider>
  )
}

function windowStartTimestamps(): (number | undefined)[] {
  return vi
    .mocked(api.get)
    .mock.calls.filter((call) => String(call[0]) === '/api/data/self')
    .map((call) => {
      const config = call[1] as
        | { params?: { start_timestamp?: number } }
        | undefined
      return config?.params?.start_timestamp
    })
}

function todayStart(expectedNow: number): number {
  const date = new Date(expectedNow * 1000)
  date.setHours(0, 0, 0, 0)
  return Math.floor(date.getTime() / 1000)
}

/**
 * The trend line drawn inside a card, located through its title. `group` is the
 * stable Tailwind marker on the StatCard root; the sparkline is the last svg in
 * the card and its second path is the line (the first one is the fill).
 */
function sparklinePathFor(title: string): string | null {
  const root = screen.getByText(title).closest('.group')
  if (!root) return null

  const sparkline = [...root.querySelectorAll('svg')].at(-1)
  if (!sparkline) return null

  // The first path is the area fill, the second one is the trend line.
  return (
    [...sparkline.querySelectorAll('path')].at(1)?.getAttribute('d') ?? null
  )
}

describe('overview summary cards', () => {
  it('renders the token, usage and request cards without the removed credit panel', async () => {
    renderSummaryCards()

    expect(await screen.findByText('Token Usage')).toBeInTheDocument()
    expect(screen.getByText('Historical Usage')).toBeInTheDocument()
    expect(screen.getByText('Request Count')).toBeInTheDocument()
    expect(screen.getByText('Total Tokens')).toBeInTheDocument()

    expect(screen.queryByText('Credit remaining')).not.toBeInTheDocument()
    expect(screen.queryByText('Runway')).not.toBeInTheDocument()
  })

  it('leaves the other cards trends untouched when the switcher moves', async () => {
    const user = userEvent.setup()
    const now = Math.floor(Date.now() / 1000)
    const today = todayStart(now)

    vi.mocked(api.get).mockImplementation(async (_url, config) => {
      const start =
        (config as { params?: { start_timestamp?: number } } | undefined)
          ?.params?.start_timestamp ?? 0
      const isToday = Math.abs(start - today) < 120
      return {
        data: {
          success: true,
          data: isToday
            ? [{ created_at: now, token_used: 999, quota: 1, count: 9 }]
            : [
                {
                  created_at: now - 20 * 3600,
                  token_used: 1,
                  quota: 5,
                  count: 1,
                },
                {
                  created_at: now - 10 * 3600,
                  token_used: 2,
                  quota: 5,
                  count: 2,
                },
                { created_at: now, token_used: 3, quota: 5, count: 3 },
              ],
        },
      }
    })

    renderSummaryCards()

    // Wait for the trailing-24h window to land (1 + 2 + 3 tokens) so the
    // captured trend is real data rather than the empty placeholder line.
    expect(await screen.findByText('6')).toBeInTheDocument()
    const before = sparklinePathFor('Request Count')
    expect(before).toBeTruthy()

    await user.click(await screen.findByRole('button', { name: 'Today' }))

    // Wait for the today window to actually land (the token card shows the
    // today-only total) before checking the other cards.
    expect(await screen.findByText('999')).toBeInTheDocument()

    // Only the windowed token card follows the switcher, so the request card
    // keeps drawing the very same trailing-24h trend.
    expect(sparklinePathFor('Request Count')).toBe(before)
  })

  it('sums the window token usage across hourly buckets', async () => {
    renderSummaryCards()

    // 120000 + 340000 from the two buckets, rendered as a full grouped number.
    expect(await screen.findByText(/^460[.,\s]?000$/)).toBeInTheDocument()
  })

  it('shows the all-time token total from the log statistics endpoint', async () => {
    renderSummaryCards()

    // Full digits, never an abbreviated unit such as "1.2M".
    expect(
      await screen.findByText(/^1[.,\s]?234[.,\s]?567$/)
    ).toBeInTheDocument()
  })

  it('defaults to the last 24 hours and switches the window to today on click', async () => {
    const user = userEvent.setup()
    renderSummaryCards()

    const last24h = await screen.findByRole('button', {
      name: 'Last 24 hours',
    })
    const today = screen.getByRole('button', { name: 'Today' })
    expect(last24h).toHaveAttribute('aria-pressed', 'true')
    expect(today).toHaveAttribute('aria-pressed', 'false')

    await user.click(today)

    expect(today).toHaveAttribute('aria-pressed', 'true')
    expect(last24h).toHaveAttribute('aria-pressed', 'false')

    // Today must be requested as local midnight -> end of day, not a trailing 24h window.
    const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)
    await waitFor(() => {
      expect(windowStartTimestamps()).toContain(todayStart)
    })
  })

  it('requests the trailing 24 hour window by default', async () => {
    renderSummaryCards()

    const expectedStart = Math.floor(Date.now() / 1000) - 23 * 3600
    await waitFor(() => {
      const starts = windowStartTimestamps().filter(
        (value): value is number => value !== undefined
      )
      expect(starts.length).toBeGreaterThan(0)
      expect(Math.abs(starts[0] - expectedStart)).toBeLessThan(120)
    })
  })
})
