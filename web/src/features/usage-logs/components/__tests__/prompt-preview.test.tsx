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
import { render, screen } from '@testing-library/react'
import i18next from 'i18next'
import { beforeAll, describe, expect, test } from 'vitest'

import type { UsageLog } from '../../data/schema'
import type { LogOtherData } from '../../types'
import { DetailsDialog } from '../dialogs/details-dialog'

const i18nKeys = {
  'Log Details': 'Log Details',
  Consume: 'Consume',
  'User Prompt': 'User Prompt',
  'Prompt truncated (original {{chars}} characters)':
    'Prompt truncated (original {{chars}} characters)',
}

function makeLog(other: LogOtherData): UsageLog {
  return {
    id: 1,
    user_id: 1,
    created_at: 1,
    type: 2,
    content: '',
    username: 'user',
    token_name: 'token',
    model_name: 'gpt-4o',
    quota: 5000,
    prompt_tokens: 100,
    completion_tokens: 50,
    use_time: 1,
    is_stream: false,
    channel: 1,
    channel_name: '',
    token_id: 1,
    group: 'default',
    ip: '',
    other: JSON.stringify(other),
    request_id: 'req-1',
    upstream_request_id: '',
  }
}

function renderDetails(other: LogOtherData) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const freshAt = Date.now() + 60_000
  queryClient.setQueryData(['status'], {}, { updatedAt: freshAt })
  queryClient.setQueryData(
    ['pricing'],
    { data: [], vendors: [] },
    { updatedAt: freshAt }
  )

  render(
    <QueryClientProvider client={queryClient}>
      <DetailsDialog
        log={makeLog(other)}
        isAdmin
        isRoot={false}
        open
        onOpenChange={() => undefined}
      />
    </QueryClientProvider>
  )
  return queryClient
}

describe('usage log prompt preview', () => {
  beforeAll(() => {
    i18next.addResourceBundle('en', 'translation', i18nKeys)
  })

  test('renders the stored prompt preview', () => {
    const queryClient = renderDetails({
      admin_info: { prompt_preview: '帮我写个快速排序', prompt_chars: 8 },
    })

    expect(screen.getByText('User Prompt')).toBeInTheDocument()
    expect(screen.getAllByText('帮我写个快速排序').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Prompt truncated/)).toBeNull()
    queryClient.clear()
  })

  test('flags the preview as truncated when the original was longer', () => {
    const queryClient = renderDetails({
      admin_info: { prompt_preview: '帮我写个快速排序…', prompt_chars: 1200 },
    })

    expect(
      screen.getByText('Prompt truncated (original 1200 characters)')
    ).toBeInTheDocument()
    queryClient.clear()
  })

  test('renders nothing when the log has no prompt preview', () => {
    const queryClient = renderDetails({ group_ratio: 1 })

    expect(screen.queryByText('User Prompt')).toBeNull()
    queryClient.clear()
  })
})
