'use client'

import { useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Loader2, ShieldCheck, UsersRound } from 'lucide-react'
import CompanySwitcher from '@/components/dashboard/CompanySwitcher'
import { useCompany } from '@/contexts/CompanyContext'
import { cn } from '@/lib/utils'
import { switchWorkspaceContext, type WorkspaceContextType } from '@/lib/workspace/actions'

const WORKSPACE_META: Record<WorkspaceContextType, {
  href: string
  label: string
  helper: string
  icon: typeof Building2
}> = {
  company: {
    href: '/app',
    label: 'Bolagsarbetsyta',
    helper: 'Bokföring och drift',
    icon: Building2,
  },
  agency: {
    href: '/agency',
    label: 'Byråarbetsyta',
    helper: 'Kunder och granskning',
    icon: UsersRound,
  },
  platform: {
    href: '/platform',
    label: 'Platform admin',
    helper: 'Planer och systemstyrning',
    icon: ShieldCheck,
  },
}

function roleLabel(role: string | null) {
  switch (role) {
    case 'owner': return 'Bolagsägare'
    case 'admin': return 'Bolagsadmin'
    case 'accountant': return 'Redovisning'
    case 'payroll': return 'Lön'
    case 'auditor': return 'Revisor'
    case 'viewer': return 'Läsbehörighet'
    case 'member': return 'Medlem'
    default: return 'Aktiv roll'
  }
}

function WorkspaceButton({
  type,
  active,
  disabled,
  onSwitch,
}: {
  type: WorkspaceContextType
  active: boolean
  disabled?: boolean
  onSwitch: (type: WorkspaceContextType) => void
}) {
  const meta = WORKSPACE_META[type]
  const Icon = meta.icon

  return (
    <button
      type="button"
      disabled={disabled || active}
      onClick={() => onSwitch(type)}
      className={cn(
        'group flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-xs transition-all duration-200',
        active
          ? 'border-primary/25 bg-primary/10 text-primary shadow-sm'
          : 'border-transparent text-muted-foreground hover:border-border/70 hover:bg-muted/70 hover:text-foreground',
        disabled && 'cursor-wait opacity-70',
      )}
      aria-current={active ? 'page' : undefined}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{meta.label}</span>
        <span className="block truncate text-[10px] text-muted-foreground">{meta.helper}</span>
      </span>
      {disabled ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
    </button>
  )
}

/**
 * Separates the accounting company selector from the broader workspace mode.
 * Superadmins can move between platform and company context without a full UI
 * tear-down; the selected context is written to user_preferences first and the
 * route is then refreshed in a React transition.
 */
export default function WorkspaceSwitcher() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const {
    company,
    role,
    workspaceType,
    agencyId,
    canManageAgency,
    canManagePlatform,
  } = useCompany()

  const activeMeta = WORKSPACE_META[workspaceType]
  const ActiveIcon = activeMeta.icon
  const availableWorkspaces = useMemo(() => {
    const workspaces: WorkspaceContextType[] = []
    if (company) workspaces.push('company')
    if (canManageAgency) workspaces.push('agency')
    if (canManagePlatform) workspaces.push('platform')
    return workspaces
  }, [canManageAgency, canManagePlatform, company])

  const switchTo = (nextType: WorkspaceContextType) => {
    if (nextType === workspaceType || isPending) return
    startTransition(async () => {
      const result = await switchWorkspaceContext(nextType, nextType === 'agency' ? agencyId : null)
      if (!result.ok) return
      router.push(WORKSPACE_META[nextType].href)
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border bg-background/80 p-2 shadow-sm">
        <div className="mb-2 flex items-start gap-2 rounded-lg bg-muted/40 px-2 py-2">
          <ActiveIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Aktiv kontext
            </p>
            <p className="truncate text-sm font-semibold text-foreground">{activeMeta.label}</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {workspaceType === 'company' ? roleLabel(role) : activeMeta.helper}
            </p>
          </div>
        </div>
        <CompanySwitcher />
      </div>

      {availableWorkspaces.length > 1 ? (
        <div className="space-y-1.5 rounded-xl border bg-background/70 p-1.5">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Växla roll
          </p>
          {availableWorkspaces.map((type) => (
            <WorkspaceButton
              key={type}
              type={type}
              active={workspaceType === type}
              disabled={isPending}
              onSwitch={switchTo}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
