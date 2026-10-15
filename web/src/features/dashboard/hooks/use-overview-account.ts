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
import { useQuery } from '@tanstack/react-query'

import { getUserProfile } from '@/features/profile/api'
import { useAuthStore } from '@/stores/auth-store'

export function useOverviewAccount() {
  const user = useAuthStore((state) => state.auth.user)
  useQuery({
    queryKey: ['dashboard', 'overview', 'account', user?.id],
    queryFn: async () => {
      const result = await getUserProfile()
      const auth = useAuthStore.getState().auth
      // Refresh only overview counters, and ignore responses for a past user.
      if (result.success && result.data && auth.user?.id === result.data.id) {
        auth.setUser({
          ...auth.user,
          quota: result.data.quota,
          used_quota: result.data.used_quota,
          request_count: result.data.request_count,
        })
      }
      return result
    },
    enabled: Boolean(user),
    staleTime: 60 * 1000,
  })

  return user
}
