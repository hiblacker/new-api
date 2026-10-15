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
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { UsageLogs } from '../index'

const STORAGE_KEY = 'dashboard_refresh_settings'
const EMPTY_PAGE = { items: [], total: 0 }

let statTokens: number

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date(2026, 9, 15, 12))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  window.localStorage.clear()
  useAuthStore.getState().auth.setUser({
    id: 2,
    username: 'logs-user',
    role: 1,
    quota: 0,
    used_quota: 12_345,
    request_count: 6,
  })
  statTokens = 111

  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    const target = String(url)
    if (target.startsWith('/api/log/self/stat')) {
      // The search area asks with page_size=1; the usage cards ask for the
      // all-time total without any parameters, which stays fixed here.
      const isSearchStats = target.includes('page_size=1')
      return {
        data: {
          success: true,
          data: { rpm: 4, tpm: 9, token: isSearchStats ? statTokens : 111 },
        },
      }
    }
    if (target.startsWith('/api/log/self')) {
      return { data: { success: true, data: EMPTY_PAGE } }
    }
    if (target.startsWith('/api/data')) {
      return { data: { success: true, data: [] } }
    }
    if (target === '/api/user/self') {
      return {
        data: { success: true, data: useAuthStore.getState().auth.user },
      }
    }
    if (target === '/api/status') {
      return { data: { data: { display_in_currency: false } } }
    }
    throw new Error(`Unexpected usage logs request: ${target}`)
  })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function renderLogsPage() {
  const root = createRootRoute()
  const auth = createRoute({ getParentRoute: () => root, id: '_authenticated' })
  const logs = createRoute({
    getParentRoute: () => auth,
    path: '/usage-logs/$section',
    component: UsageLogs,
    validateSearch: (search: Record<string, unknown>) => search,
  })
  const router = createRouter({
    routeTree: root.addChildren([auth.addChildren([logs])]),
    history: createMemoryHistory({ initialEntries: ['/usage-logs/common'] }),
  })

  const result = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await screen.findByText('Total Tokens')
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Refresh usage logs' })
    ).toBeEnabled()
  )
  return result
}

function requested(urlPrefix: string): boolean {
  return vi
    .mocked(api.get)
    .mock.calls.some(([url]) => String(url).startsWith(urlPrefix))
}

async function advanceTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
}

describe('usage logs refresh', () => {
  it('refreshes the logs, the search stats and the shared usage cards', async () => {
    await renderLogsPage()
    vi.mocked(api.get).mockClear()
    statTokens = 222

    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage logs' }))

    await waitFor(() => expect(requested('/api/log/self?')).toBe(true))
    expect(requested('/api/log/self/stat?')).toBe(true)
    expect(requested('/api/data/self')).toBe(true)
    // The refreshed statistics reach the search area.
    expect(await screen.findByText('222')).toBeInTheDocument()
  })

  it('refreshes automatically after 30 seconds by default', async () => {
    await renderLogsPage()
    vi.mocked(api.get).mockClear()

    await advanceTime(29_999)
    expect(api.get).not.toHaveBeenCalled()

    await advanceTime(1)
    expect(requested('/api/log/self?')).toBe(true)
    expect(requested('/api/log/self/stat?')).toBe(true)
  })

  it('keeps auto refresh off across visits and still allows a manual refresh', async () => {
    const user = userEvent.setup()
    const first = await renderLogsPage()

    await user.click(screen.getByRole('button', { name: 'Refresh settings' }))
    const enabled = screen.getByRole('switch', { name: 'Auto refresh' })
    expect(enabled).toBeChecked()
    await user.click(enabled)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // The preference is shared with the overview page's control.
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    ).toMatchObject({ enabled: false })

    first.unmount()
    await renderLogsPage()
    vi.mocked(api.get).mockClear()
    await advanceTime(60_000)
    expect(api.get).not.toHaveBeenCalled()

    statTokens = 333
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage logs' }))
    expect(await screen.findByText('333')).toBeInTheDocument()
  })
})
