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
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VChart } from '@visactor/react-vchart'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'
import { useSystemConfigStore } from '@/stores/system-config-store'

import { OverviewDashboard } from '../overview-dashboard'

vi.mock('@visactor/react-vchart', () => ({ VChart: vi.fn(() => null) }))
vi.mock('@visactor/vchart', () => ({
  ThemeManager: { setCurrentTheme: vi.fn() },
}))

const STORAGE_KEY = 'dashboard_overview_refresh_settings'
let client: QueryClient
let requestCount: number
let tokenCount: number
let failUsage: boolean

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date(2026, 9, 15, 12))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  window.localStorage.clear()
  useSystemConfigStore.setState(useSystemConfigStore.getInitialState(), true)
  useAuthStore.getState().auth.setUser({
    id: 1,
    username: 'overview-admin',
    role: 10,
    quota: 1_000_000,
    used_quota: 1000,
    request_count: 123,
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  requestCount = 123
  tokenCount = 456
  failUsage = false
  vi.mocked(VChart).mockClear()
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    switch (url) {
      case '/api/user/self':
        return {
          data: {
            success: true,
            data: {
              ...useAuthStore.getState().auth.user,
              request_count: requestCount,
            },
          },
        }
      case '/api/token/?p=1&size=10':
        return {
          data: {
            success: true,
            data: {
              items: [{ id: 1, name: 'App key', key: 'masked', status: 1 }],
            },
          },
        }
      case '/api/user/models':
        return { data: { success: true, data: ['test-model'] } }
      case '/api/status':
        return {
          data: {
            data: {
              api_info_enabled: false,
              announcements_enabled: false,
              faq_enabled: false,
              uptime_kuma_enabled: true,
              display_in_currency: false,
            },
          },
        }
      case '/api/data':
      case '/api/data/self':
        if (failUsage) throw new Error('Usage unavailable')
        return {
          data: {
            success: true,
            data: [
              {
                created_at: Math.floor(Date.now() / 1000),
                model_name: 'test-model',
                token_used: tokenCount,
                quota: 10,
                count: 1,
              },
            ],
          },
        }
      case '/api/log/self/stat?':
        return { data: { success: true, data: { token: 789 } } }
      case '/api/perf-metrics/summary':
        return { data: { success: true, data: { models: [] } } }
      case '/api/uptime/status':
        return { data: { success: true, data: [] } }
      default:
        throw new Error(`Unexpected overview request: ${url}`)
    }
  })
})

afterEach(() => {
  cleanup()
  client.clear()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  useSystemConfigStore.setState(useSystemConfigStore.getInitialState(), true)
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function renderOverview() {
  const router = createRouter({
    routeTree: createRootRoute({ component: OverviewDashboard }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  const result = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await screen.findByText('Token Usage by Model')
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Refresh overview' })
    ).toBeEnabled()
  )
  return result
}

async function advanceTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Refresh overview' })
    ).toBeEnabled()
  )
}

describe('overview refresh', () => {
  it.each([
    ['Refresh overview', false],
    ['Refresh', false],
    ['Refresh overview', true],
    ['Refresh', true],
  ] as const)(
    'keeps %s busy for exactly two seconds after a fast response (failure: %s)',
    async (buttonName, failed) => {
      await renderOverview()
      vi.useFakeTimers({
        toFake: [
          'Date',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      })
      const refresh = screen.getByRole('button', { name: buttonName })
      expect(refresh).toHaveTextContent(/^$/)
      expect(refresh).toHaveAttribute('aria-busy', 'false')
      expect(refresh.querySelector('svg')).not.toHaveClass('animate-spin')
      vi.mocked(api.get).mockClear()
      tokenCount = 654
      failUsage = failed

      fireEvent.click(refresh)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(refresh).toBeDisabled()
      expect(refresh).toHaveAttribute('aria-busy', 'true')
      expect(refresh.querySelector('svg')).toHaveClass('animate-spin')
      expect(
        screen.getByText(failed ? /Total: 456/ : /Total: 654/)
      ).toBeInTheDocument()
      if (buttonName === 'Refresh') {
        expect(api.get).toHaveBeenCalledTimes(1)
        expect(api.get).toHaveBeenCalledWith('/api/data', {
          params: expect.objectContaining({ username: 'overview-admin' }),
        })
      }
      const requestsAfterClick = vi.mocked(api.get).mock.calls.length

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1999)
      })
      expect(refresh).toBeDisabled()
      fireEvent.click(refresh)
      expect(api.get).toHaveBeenCalledTimes(requestsAfterClick)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(refresh).toBeEnabled()
      expect(refresh).toHaveAttribute('aria-busy', 'false')
      expect(refresh.querySelector('svg')).not.toHaveClass('animate-spin')
      fireEvent.click(refresh)
      expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(
        requestsAfterClick
      )
    }
  )

  it.each(['Refresh overview', 'Refresh'])(
    'keeps %s busy past two seconds until the slowest request completes',
    async (buttonName) => {
      await renderOverview()
      vi.useFakeTimers({
        toFake: [
          'Date',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      })
      const refresh = screen.getByRole('button', { name: buttonName })
      let finishRequest: (() => void) | undefined
      const pending = new Promise<void>((resolve) => {
        finishRequest = resolve
      })
      const respond = vi.mocked(api.get).getMockImplementation()
      if (!respond) throw new Error('Missing overview API fixture')
      vi.mocked(api.get).mockImplementation(async (...args) => {
        if (args[0] === '/api/data') await pending
        return respond(...args)
      })
      vi.mocked(api.get).mockClear()
      tokenCount = 654

      fireEvent.click(refresh)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(refresh).toBeDisabled()
      expect(refresh).toHaveAttribute('aria-busy', 'true')
      expect(refresh.querySelector('svg')).toHaveClass('animate-spin')
      expect(screen.getByText(/Total: 456/)).toBeInTheDocument()
      const requestsAfterClick = vi.mocked(api.get).mock.calls.length
      fireEvent.click(refresh)
      expect(api.get).toHaveBeenCalledTimes(requestsAfterClick)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
        finishRequest?.()
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(refresh).toBeEnabled()
      expect(refresh).toHaveAttribute('aria-busy', 'false')
      expect(refresh.querySelector('svg')).not.toHaveClass('animate-spin')
      expect(screen.getByText(/Total: 654/)).toBeInTheDocument()
    }
  )

  it('refreshes all visible overview data after 30 seconds by default', async () => {
    await renderOverview()
    vi.mocked(api.get).mockClear()
    requestCount = 321
    tokenCount = 654

    await advanceTime(29_999)
    expect(api.get).not.toHaveBeenCalled()
    await advanceTime(1)

    for (const endpoint of [
      '/api/user/self',
      '/api/data/self',
      '/api/data',
      '/api/log/self/stat?',
      '/api/status',
      '/api/uptime/status',
      '/api/perf-metrics/summary',
    ]) {
      expect(
        vi.mocked(api.get).mock.calls.some(([url]) => url === endpoint)
      ).toBe(true)
    }
    expect(await screen.findByText('321')).toBeInTheDocument()
    expect(await screen.findByText('654')).toBeInTheDocument()
    expect(screen.getByText(/Total: 654/)).toBeInTheDocument()
    expect(vi.mocked(VChart).mock.calls.at(-1)?.[0].spec).toEqual(
      expect.objectContaining({
        data: [
          {
            id: 'tokenUsageByModel',
            values: expect.arrayContaining([
              expect.objectContaining({ Model: 'test-model', Tokens: 654 }),
            ]),
          },
        ],
      })
    )
  })

  it('saves disabled auto refresh across visits and still supports manual refresh', async () => {
    const user = userEvent.setup()
    const first = await renderOverview()
    await user.click(screen.getByRole('button', { name: 'Refresh settings' }))
    const enabled = screen.getByRole('switch', { name: 'Auto refresh' })
    expect(enabled).toBeChecked()
    expect(
      screen.getByRole('combobox', { name: 'Refresh interval (seconds)' })
    ).toHaveTextContent('30 seconds')
    await user.click(enabled)
    expect(
      screen.getByRole('combobox', { name: 'Refresh interval (seconds)' })
    ).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    first.unmount()
    await renderOverview()
    vi.mocked(api.get).mockClear()
    await advanceTime(60_000)
    expect(api.get).not.toHaveBeenCalled()

    tokenCount = 654
    await user.click(screen.getByRole('button', { name: 'Refresh overview' }))
    expect(await screen.findByText('654')).toBeInTheDocument()
    expect(screen.getByText(/Total: 654/)).toBeInTheDocument()
    expect(vi.mocked(VChart).mock.calls.at(-1)?.[0].spec).toEqual(
      expect.objectContaining({
        data: [
          {
            id: 'tokenUsageByModel',
            values: expect.arrayContaining([
              expect.objectContaining({ Model: 'test-model', Tokens: 654 }),
            ]),
          },
        ],
      })
    )
    await user.click(screen.getByRole('button', { name: 'Refresh settings' }))
    expect(
      screen.getByRole('switch', { name: 'Auto refresh' })
    ).not.toBeChecked()
  })

  it('applies the chosen interval and discards cancelled edits', async () => {
    const user = userEvent.setup()
    await renderOverview()
    await user.click(screen.getByRole('button', { name: 'Refresh settings' }))
    await user.click(
      screen.getByRole('combobox', { name: 'Refresh interval (seconds)' })
    )
    await user.click(screen.getByRole('option', { name: '60 seconds' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    vi.mocked(api.get).mockClear()
    await advanceTime(30_000)
    expect(api.get).not.toHaveBeenCalled()
    await advanceTime(30_000)
    expect(api.get).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Refresh settings' }))
    await user.click(screen.getByRole('switch', { name: 'Auto refresh' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Refresh settings' }))
    expect(screen.getByRole('switch', { name: 'Auto refresh' })).toBeChecked()
    expect(
      screen.getByRole('combobox', { name: 'Refresh interval (seconds)' })
    ).toHaveTextContent('60 seconds')
  })

  it('refreshes today and rolling ranges with the current clock after midnight', async () => {
    vi.setSystemTime(new Date(2026, 9, 15, 23, 59, 50))
    await renderOverview()
    vi.mocked(api.get).mockClear()
    await advanceTime(30_000)
    expect(api.get).toHaveBeenCalledWith('/api/data/self', {
      params: {
        start_timestamp: new Date(2026, 9, 16).getTime() / 1000,
        end_timestamp: new Date(2026, 9, 16, 23, 59, 59).getTime() / 1000,
        default_time: 'hour',
      },
    })
    expect(api.get).toHaveBeenCalledWith('/api/data', {
      params: expect.objectContaining({
        end_timestamp: new Date(2026, 9, 16, 0, 0, 20).getTime() / 1000,
      }),
    })
  })

  it('keeps a custom chart range fixed when refreshed', async () => {
    window.localStorage.setItem(
      'dashboard_overview_token_usage_settings',
      JSON.stringify({
        rangeKey: 'custom',
        start: 1_700_000_000,
        end: 1_700_086_400,
        granularity: 'hour',
      })
    )
    await renderOverview()
    vi.mocked(api.get).mockClear()
    await advanceTime(30_000)
    expect(api.get).toHaveBeenCalledWith('/api/data', {
      params: {
        start_timestamp: 1_700_000_000,
        end_timestamp: 1_700_086_400,
        default_time: 'hour',
        username: 'overview-admin',
      },
    })
  })

  it('pauses polling in hidden tabs and stops after leaving the page', async () => {
    const view = await renderOverview()
    vi.mocked(api.get).mockClear()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await advanceTime(30_000)
    expect(api.get).not.toHaveBeenCalled()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await advanceTime(30_000)
    expect(api.get).toHaveBeenCalled()
    view.unmount()
    vi.mocked(api.get).mockClear()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(api.get).not.toHaveBeenCalled()
  })

  it('retains the previous data on failure and recovers on the next refresh', async () => {
    await renderOverview()
    failUsage = true
    await advanceTime(30_000)
    expect(screen.getByText('456')).toBeInTheDocument()
    failUsage = false
    tokenCount = 654
    await advanceTime(30_000)
    expect(await screen.findByText('654')).toBeInTheDocument()
  })

  it.each(['{', 'null', '{"enabled":"yes","intervalSeconds":0}'])(
    'falls back to 30 seconds for invalid saved settings: %s',
    async (saved) => {
      window.localStorage.setItem(STORAGE_KEY, saved)
      await renderOverview()
      vi.mocked(api.get).mockClear()
      await advanceTime(30_000)
      expect(api.get).toHaveBeenCalled()
    }
  )
})
