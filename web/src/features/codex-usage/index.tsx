import { useQuery } from '@tanstack/react-query'
import { Coins, Cpu, Flame, Layers, RefreshCw, Timer } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { SectionPageLayout } from '@/components/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { getCodexUsageSummary } from './api'
import type { CodexUsageSummary } from './types'

const QUERY_KEY = ['codex-usage-summary']

function formatTokens(value: number): string {
  if (!value) return '0'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function formatExact(value: number): string {
  return (value || 0).toLocaleString('zh-CN')
}

function formatThreadTime(epochSec: number): string {
  if (!epochSec) return '-'
  const d = new Date(epochSec * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function resetInText(epochSec: number): string {
  if (!epochSec) return '-'
  const diff = epochSec * 1000 - Date.now()
  if (diff <= 0) return '已重置'
  const hours = Math.floor(diff / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  return hours > 0 ? `${hours} 小时 ${minutes} 分后重置` : `${minutes} 分后重置`
}

const BAR_CLASS = 'h-full rounded-full transition-all'

function barColorClass(percent: number): string {
  if (percent >= 90) return `bg-destructive ${BAR_CLASS}`
  if (percent >= 60) return `bg-amber-500 ${BAR_CLASS}`
  return `bg-primary ${BAR_CLASS}`
}

function StatCard(props: {
  title: string
  value: string
  hint: string
  icon: ComponentType<{ className?: string }>
}) {
  const Icon = props.icon
  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
        <CardTitle className='text-sm font-medium'>{props.title}</CardTitle>
        <Icon className='text-muted-foreground h-4 w-4' />
      </CardHeader>
      <CardContent>
        <div className='text-2xl font-bold tabular-nums'>{props.value}</div>
        <p className='text-muted-foreground mt-1 text-xs'>{props.hint}</p>
      </CardContent>
    </Card>
  )
}

function QuotaWindow(props: {
  label: string
  percent: number
  resetAt: number
  windowSeconds: number
}) {
  const percent = Math.max(0, Math.min(100, props.percent || 0))
  const windowHours = props.windowSeconds
    ? Math.round(props.windowSeconds / 3600)
    : 0
  return (
    <div className='space-y-2'>
      <div className='flex items-baseline justify-between text-sm'>
        <span className='font-medium'>
          {props.label}
          {windowHours > 0 ? (
            <span className='text-muted-foreground ml-1 text-xs'>
              ({windowHours} 小时窗口)
            </span>
          ) : null}
        </span>
        <span className='font-semibold tabular-nums'>{percent}%</span>
      </div>
      <div className='bg-muted h-2 w-full overflow-hidden rounded-full'>
        <div className={barColorClass(percent)} style={{ width: `${percent}%` }} />
      </div>
      <p className='text-muted-foreground text-xs'>{resetInText(props.resetAt)}</p>
    </div>
  )
}

function LoadingState() {
  return (
    <div className='grid gap-4 md:grid-cols-4'>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className='h-28 w-full' />
      ))}
    </div>
  )
}

function MessageState(props: { children: ReactNode; padded?: boolean }) {
  return (
    <Card>
      <CardContent className={props.padded ? 'py-10 text-center' : 'py-8 text-center'}>
        <p className='text-muted-foreground text-sm'>{props.children}</p>
      </CardContent>
    </Card>
  )
}

function CodexUsageBody(props: {
  summary: CodexUsageSummary
}) {
  const summary = props.summary
  const daily = summary.daily
  const maxDaily = daily.reduce((m, d) => Math.max(m, d.tokens_used), 0)

  return (
    <div className='space-y-4'>
      <div className='grid gap-4 md:grid-cols-4'>
        <StatCard
          title='今日消耗'
          value={formatTokens(summary.today_tokens)}
          hint={`${formatExact(summary.today_tokens)} tokens / ${summary.today_threads} 个会话`}
          icon={Flame}
        />
        <StatCard
          title='近 30 天'
          value={formatTokens(summary.recent_tokens)}
          hint='按线程最后更新时间统计'
          icon={Coins}
        />
        <StatCard
          title='累计消耗'
          value={formatTokens(summary.total_tokens)}
          hint={`${formatExact(summary.total_tokens)} tokens`}
          icon={Layers}
        />
        <StatCard
          title='累计会话'
          value={formatExact(summary.total_threads)}
          hint='官方订阅账号下的 Codex 线程数'
          icon={Cpu}
        />
      </div>

      <Card>
        <CardHeader className='pb-3'>
          <CardTitle className='flex items-center gap-2 text-base'>
            官方额度
            {summary.snapshot?.plan_type ? (
              <Badge variant='outline'>
                {summary.snapshot.plan_type.toUpperCase()}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            {summary.snapshot
              ? `来自 ChatGPT 官方用量接口，采集于 ${formatThreadTime(summary.snapshot.captured_at)}`
              : '暂无额度快照，采集器下次上报后会出现'}
          </CardDescription>
        </CardHeader>
        <CardContent className='space-y-5'>
          {summary.snapshot ? (
            <div className='grid gap-6 md:grid-cols-2'>
              <QuotaWindow
                label='主窗口'
                percent={summary.snapshot.primary_used_percent}
                resetAt={summary.snapshot.primary_reset_at}
                windowSeconds={summary.snapshot.primary_window_seconds}
              />
              <QuotaWindow
                label='次窗口'
                percent={summary.snapshot.secondary_used_percent}
                resetAt={summary.snapshot.secondary_reset_at}
                windowSeconds={summary.snapshot.secondary_window_seconds}
              />
            </div>
          ) : (
            <p className='text-muted-foreground text-sm'>—</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className='pb-3'>
          <CardTitle className='flex items-center gap-2 text-base'>
            <Timer className='h-4 w-4' />
            按天用量
          </CardTitle>
          <CardDescription>最近 30 天，每日 token 消耗</CardDescription>
        </CardHeader>
        <CardContent>
          {daily.length === 0 ? (
            <p className='text-muted-foreground text-sm'>暂无数据</p>
          ) : (
            <div className='space-y-1.5'>
              {daily.slice(-30).map((d) => (
                <div key={d.day} className='flex items-center gap-3 text-xs'>
                  <span className='text-muted-foreground w-16 shrink-0 tabular-nums'>
                    {d.day.slice(5)}
                  </span>
                  <div className='bg-muted h-3 flex-1 overflow-hidden rounded'>
                    <div
                      className='bg-primary h-full rounded'
                      style={{
                        width: `${maxDaily ? Math.max(2, (d.tokens_used / maxDaily) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <span className='w-16 shrink-0 text-right tabular-nums'>
                    {formatTokens(d.tokens_used)}
                  </span>
                  <span className='text-muted-foreground w-10 shrink-0 text-right'>
                    {d.threads} 个
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className='grid gap-4 lg:grid-cols-2'>
        <Card>
          <CardHeader className='pb-3'>
            <CardTitle className='text-base'>按模型</CardTitle>
            <CardDescription>官方订阅账号下的模型分布</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型</TableHead>
                  <TableHead className='text-right'>会话</TableHead>
                  <TableHead className='text-right'>Tokens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.models.map((m) => (
                  <TableRow key={m.model}>
                    <TableCell className='font-mono text-xs'>{m.model}</TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {m.threads}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {formatExact(m.tokens_used)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className='pb-3'>
            <CardTitle className='text-base'>会话明细</CardTitle>
            <CardDescription>按最后更新时间倒序，最多 200 条</CardDescription>
          </CardHeader>
          <CardContent className='max-h-[420px] overflow-auto'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className='w-24'>时间</TableHead>
                  <TableHead>标题</TableHead>
                  <TableHead className='w-20 text-right'>Tokens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.threads.map((th) => (
                  <TableRow key={th.thread_id}>
                    <TableCell className='text-muted-foreground text-xs tabular-nums'>
                      {formatThreadTime(th.thread_updated_at)}
                    </TableCell>
                    <TableCell className='max-w-[220px] truncate text-xs'>
                      {th.title || '(无标题)'}
                    </TableCell>
                    <TableCell className='text-right text-xs tabular-nums'>
                      {formatExact(th.tokens_used)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function CodexUsageContent(props: {
  isLoading: boolean
  error: Error | null
  summary: CodexUsageSummary | undefined
}) {
  if (props.isLoading) {
    return <LoadingState />
  }
  if (props.error) {
    return <MessageState>读取失败：{props.error.message}</MessageState>
  }
  if (!props.summary || props.summary.total_threads === 0) {
    return (
      <MessageState padded>
        还没有采集到数据。请确认采集脚本已在运行，并且 new-api 已收到首次同步。
      </MessageState>
    )
  }
  return <CodexUsageBody summary={props.summary} />
}

export function CodexUsage() {
  const { t } = useTranslation()
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => getCodexUsageSummary(30),
    refetchInterval: 5 * 60 * 1000,
  })

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Codex Usage')}</SectionPageLayout.Title>
      <SectionPageLayout.Actions>
        <Button
          variant='outline'
          size='sm'
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw
            className={isFetching ? 'mr-1 h-4 w-4 animate-spin' : 'mr-1 h-4 w-4'}
          />
          刷新
        </Button>
      </SectionPageLayout.Actions>
      <SectionPageLayout.Content>
        <CodexUsageContent
          isLoading={isLoading}
          error={error as Error | null}
          summary={data}
        />
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
