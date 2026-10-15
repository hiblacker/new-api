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
import type { QueryFilters } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { RefreshControls } from '@/components/refresh-controls'

/**
 * Everything the usage logs page fetches: the log list, the search-area stats,
 * the usage cards it shares with the overview page, and the site status the
 * filter options depend on.
 */
const USAGE_LOGS_QUERIES: QueryFilters = {
  type: 'active',
  predicate: (query) => {
    const key = query.queryKey
    return (
      key[0] === 'logs' ||
      key[0] === 'usage-logs-stats' ||
      (key[0] === 'dashboard' && key[1] === 'overview') ||
      key[0] === 'status'
    )
  },
}

/** Manual and automatic refresh for the usage logs page's data. */
export function UsageLogsRefreshControls() {
  const { t } = useTranslation()

  return (
    <RefreshControls
      queries={USAGE_LOGS_QUERIES}
      label={t('Refresh usage logs')}
      description={t(
        'Choose whether and how often to refresh the usage logs automatically.'
      )}
    />
  )
}
