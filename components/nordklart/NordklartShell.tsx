import { cn } from '@/lib/utils'

type PageShellProps = {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
}

export function NordklartPageShell({ eyebrow, title, description, actions, children }: PageShellProps) {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-8">
      <div className="nordklart-glass overflow-hidden rounded-[2rem] p-6 md:p-8">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl space-y-3">
            {eyebrow ? <div className="text-xs font-semibold uppercase tracking-[0.22em] text-primary">{eyebrow}</div> : null}
            <h1 className="text-3xl md:text-5xl">{title}</h1>
            {description ? <p className="max-w-2xl text-base leading-7 text-muted-foreground md:text-lg">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap gap-3">{actions}</div> : null}
        </div>
      </div>
      {children}
    </div>
  )
}

type StatCardProps = {
  label: string
  value: string | number
  description?: string
  tone?: 'default' | 'success' | 'warning' | 'primary'
}

export function NordklartStatCard({ label, value, description, tone = 'default' }: StatCardProps) {
  return (
    <div className="nordklart-glass rounded-3xl p-5">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={cn('mt-3 text-3xl font-semibold tabular-nums', tone === 'success' && 'text-success', tone === 'warning' && 'text-warning', tone === 'primary' && 'text-primary')}>
        {value}
      </div>
      {description ? <div className="mt-2 text-sm leading-6 text-muted-foreground">{description}</div> : null}
    </div>
  )
}

type ActionCardProps = {
  title: string
  description: string
  meta?: string
  children?: React.ReactNode
}

export function NordklartActionCard({ title, description, meta, children }: ActionCardProps) {
  return (
    <div className="rounded-3xl border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      {meta ? <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-primary">{meta}</div> : null}
      <h3 className="text-xl">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      {children ? <div className="mt-5">{children}</div> : null}
    </div>
  )
}
