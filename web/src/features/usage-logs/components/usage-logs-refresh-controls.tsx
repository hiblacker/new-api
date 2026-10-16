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
 * Query key prefixes for everything the usage logs page renders. Both the manual
 * button and the auto refresh timer move all of them together, so the four
 * usage cards at the top of the page stay in step with the list below.
 *
 * - The four cards this page shares with the overview page live under
 *   `dashboard/overview/*`: `account` feeds "Historical Usage" and
 *   "Request Count", `summary-sparklines` feeds "Token Usage" (plus its
 *   sparkline) and `lifetime-tokens` feeds "Total Tokens".
 * - `logs` / `usage-logs-stats` are the log list and the search-area statistics.
 * - `status` is the site status the filter options and the currency label read.
 *
 * They are listed individually rather than as one broad `dashboard` prefix so
 * that adding an unrelated overview query cannot silently join the refresh.
 */
const USAGE_LOGS_QUERY_PREFIXES = [
  ['logs'],
  ['usage-logs-stats'],
  ['dashboard', 'overview', 'account'],
  ['dashboard', 'overview', 'summary-sparklines'],
  ['dashboard', 'overview', 'lifetime-tokens'],
  ['status'],
] as const

const USAGE_LOGS_QUERIES: QueryFilters = {
  type: 'active',
  predicate: (query) =>
    USAGE_LOGS_QUERY_PREFIXES.some((prefix) =>
      prefix.every((segment, index) => query.queryKey[index] === segment)
    ),
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
