export interface CodexUsageThread {
  id: number
  thread_id: string
  account_id: string
  model: string
  tokens_used: number
  title: string
  source: string
  originator: string
  thread_created_at: number
  thread_updated_at: number
  synced_at: number
}

export interface CodexUsageSnapshot {
  id: number
  account_id: string
  plan_type: string
  email: string
  allowed: boolean
  limit_reached: boolean
  primary_used_percent: number
  primary_window_seconds: number
  primary_reset_at: number
  secondary_used_percent: number
  secondary_window_seconds: number
  secondary_reset_at: number
  credits_balance: number
  captured_at: number
}

export interface CodexUsageDayStat {
  day: string
  threads: number
  tokens_used: number
}

export interface CodexUsageModelStat {
  model: string
  threads: number
  tokens_used: number
}

export interface CodexUsageSummary {
  account_id: string
  total_tokens: number
  total_threads: number
  today_tokens: number
  today_threads: number
  recent_tokens: number
  daily: CodexUsageDayStat[]
  models: CodexUsageModelStat[]
  threads: CodexUsageThread[]
  snapshot: CodexUsageSnapshot | null
  synced_at: number
}
