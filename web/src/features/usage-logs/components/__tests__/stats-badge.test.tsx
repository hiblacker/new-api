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

import { CommonLogsStats } from '../common-logs-stats'
import { UsageLogsProvider } from '../usage-logs-provider'

const STATS = { quota: 15_000_000, rpm: 4, tpm: 9, token: 987_654 }

function Fixture() {
  return (
    <UsageLogsProvider>
      <CommonLogsStats />
    </UsageLogsProvider>
  )
}

beforeEach(() => {
  useAuthStore.getState().auth.setUser({
    id: 2,
    username: 'stats-user',
    role: 1,
    quota: 0,
    used_quota: 0,
    request_count: 0,
  })
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (String(url).startsWith('/api/log/self/stat')) {
      return { data: { success: true, data: STATS } }
    }
    throw new Error(`Unexpected stats request: ${url}`)
  })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState(useAuthStore.getInitialState(), true)
  vi.restoreAllMocks()
})

async function renderStats() {
  const root = createRootRoute()
  const auth = createRoute({ getParentRoute: () => root, id: '_authenticated' })
  const logs = createRoute({
    getParentRoute: () => auth,
    path: '/usage-logs/$section',
    component: Fixture,
    validateSearch: (search: Record<string, unknown>) => search,
  })
  const router = createRouter({
    routeTree: root.addChildren([auth.addChildren([logs])]),
    history: createMemoryHistory({ initialEntries: ['/usage-logs/common'] }),
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

  return screen.findByText('Tokens')
}

// The search area used to report spend, which the products that run on this
// deployment do not surface; it must report the filtered token total instead.
it('reports the filtered token total instead of a spend figure', async () => {
  await renderStats()

  expect(screen.getByText(/^987[.,\s]?654$/)).toBeInTheDocument()
  expect(screen.queryByText('Usage')).not.toBeInTheDocument()
  expect(screen.queryByText(/^[$¥€]/)).not.toBeInTheDocument()
})

it('keeps reporting the live request and token rates alongside the total', async () => {
  await renderStats()

  expect(screen.getByText('RPM')).toBeInTheDocument()
  expect(screen.getByText('4')).toBeInTheDocument()
  expect(screen.getByText('TPM')).toBeInTheDocument()
  expect(screen.getByText('9')).toBeInTheDocument()
})
