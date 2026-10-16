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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import { UsageLogs } from '../index'

const LOG_STATS = { quota: 15_000_000, rpm: 4, tpm: 9, token: 987_654 }
const EMPTY_PAGE = { items: [], total: 0 }

beforeEach(() => {
  window.localStorage.clear()
  // Admin role: a regular user never sees the removed scope switcher, so only
  // an admin session can prove it is gone.
  useAuthStore.getState().auth.setUser({
    id: 2,
    username: 'logs-user',
    role: 10,
    quota: 0,
    used_quota: 12_345,
    request_count: 6,
  })

  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    const target = String(url)
    if (target.startsWith('/api/log/self/stat')) {
      return { data: { success: true, data: LOG_STATS } }
    }
    if (target.startsWith('/api/log/self')) {
      return { data: { success: true, data: EMPTY_PAGE } }
    }
    if (target.startsWith('/api/log/stat')) {
      return { data: { success: true, data: LOG_STATS } }
    }
    if (target.startsWith('/api/log')) {
      return { data: { success: true, data: EMPTY_PAGE } }
    }
    if (target.startsWith('/api/data')) {
      return { data: { success: true, data: [] } }
    }
    if (target.startsWith('/api/task') || target.startsWith('/api/mj')) {
      return { data: { success: true, data: EMPTY_PAGE } }
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
})

async function renderLogsPage(section: 'common' | 'task') {
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
    history: createMemoryHistory({
      initialEntries: [`/usage-logs/${section}`],
    }),
  })

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

it('shows the overview cards without a page header or scope switcher on common logs', async () => {
  await renderLogsPage('common')

  expect(await screen.findByText('Total Tokens')).toBeInTheDocument()
  // The spend card is part of the shared set, exactly as on the overview page.
  expect(screen.getByText('Historical Usage')).toBeInTheDocument()

  expect(
    screen.queryByRole('heading', { name: 'Common Logs' })
  ).not.toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument()
  expect(
    screen.queryByRole('tab', { name: 'Only Mine' })
  ).not.toBeInTheDocument()
  // The cards sit straight on the page, without the panel frame.
  expect(screen.queryByText('Usage at a glance')).not.toBeInTheDocument()
})

it('keeps the page header on the task sections', async () => {
  await renderLogsPage('task')

  expect(
    await screen.findByRole('heading', { name: 'Task Logs' })
  ).toBeInTheDocument()
  expect(screen.queryByText('Total Tokens')).not.toBeInTheDocument()
})
