import { api } from '@/lib/api'

import type { CodexUsageSummary } from './types'

/**
 * 拉取 Codex 官方订阅用量汇总。
 *
 * 数据由本机采集器定时推送（POST /api/codex-usage/sync），这里只做展示侧读取。
 */
export async function getCodexUsageSummary(
  days = 30,
  accountId = ''
): Promise<CodexUsageSummary> {
  const query = new URLSearchParams({ days: String(days) })
  if (accountId) {
    query.set('account_id', accountId)
  }
  const res = await api.get(`/api/codex-usage/summary?${query.toString()}`)
  return res.data.data as CodexUsageSummary
}
