import { createFileRoute, redirect } from '@tanstack/react-router'

import { CodexUsage } from '@/features/codex-usage'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/_authenticated/codex-usage/')({
  beforeLoad: () => {
    const { auth } = useAuthStore.getState()
    const role = auth.user?.role ?? ROLE.GUEST

    // 后端接口用 AdminAuth 保护，前端同样只放管理员进入
    if (role < ROLE.ADMIN) {
      throw redirect({ to: '/403' })
    }
  },
  component: CodexUsage,
})
