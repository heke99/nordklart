'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  BarChart3,
  Banknote,
  BookOpen,
  ClipboardCheck,
  FileCheck2,
  Home,
  Landmark,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Plug,
  Receipt,
  Scale,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  WalletCards,
  X,
} from 'lucide-react'
import { getBranding } from '@/lib/branding/service'
import { NORDKLART_LEGAL_NAME } from '@/lib/branding/legal-identity'
import { clearRecaptIdentity } from '@/lib/recapt'
import WorkspaceSwitcher from '@/components/dashboard/WorkspaceSwitcher'
import { useCompany } from '@/contexts/CompanyContext'
import { buildNavGroups, type NavIconKey, type NavItemSpec } from '@/lib/navigation/nav-builder'
import { purchaseHrefForFeature } from '@/lib/navigation/feature-access-routing'
import type { EntityType } from '@/types'
import { useMemo, useState } from 'react'

interface ExtensionNavItem {
  href: string
  label: string
  icon: string
}

interface DashboardNavProps {
  companyName: string
  entityType: EntityType
  uncategorizedTransactionCount?: number
  pendingOperationsCount?: number
  isSandbox?: boolean
  extensionNavItems?: ExtensionNavItem[]
  userName?: string | null
  userEmail?: string | null
  /** Enabled feature codes for the active company; null = unknown (fail open for display). */
  enabledFeatures?: string[] | null
  /** Year-end access incl. fiscal-period-bound one-time purchases. */
  hasYearEndAccess?: boolean
}

const NAV_ICONS: Record<NavIconKey, typeof LayoutDashboard> = {
  home: Home,
  pending: ClipboardCheck,
  transactions: Landmark,
  bookkeeping: BookOpen,
  invoices: Receipt,
  suppliers: WalletCards,
  reports: BarChart3,
  skatteverket: Send,
  yearEnd: FileCheck2,
  bankgiro: Banknote,
  extensions: Plug,
  automation: Sparkles,
  assistant: Sparkles,
  agency: Users,
  platform: ShieldCheck,
  settings: Settings,
  users: Users,
  pricePlans: WalletCards,
  onboarding: ClipboardCheck,
  bank: Landmark,
  api: Plug,
  operations: ClipboardCheck,
}

function initials(name: string | null, email: string | null) {
  const source = name?.trim() || email?.trim() || 'N'
  return source.slice(0, 1).toUpperCase()
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

function NavLink({ item, pathname, disabled, onClick }: {
  item: NavItemSpec
  pathname: string
  disabled?: boolean
  onClick?: () => void
}) {
  const active = isActive(pathname, item.href)
  const Icon = NAV_ICONS[item.icon] ?? LayoutDashboard

  // Locked features stay visible but link to the upgrade path so the CTA is
  // one click away — never a dead item, never silent access to unpaid tools.
  if (item.locked) {
    return (
      <Link
        href={purchaseHrefForFeature(item.feature ?? '', item.href)}
        onClick={onClick}
        title="Tjänsten är inte aktiv — välj rätt plan eller tillägg"
      >
        <span className="group flex items-center justify-between rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground/70 transition-all hover:bg-accent/60 hover:text-accent-foreground">
          <span className="flex min-w-0 items-center gap-3">
            <Icon className="h-4 w-4 shrink-0 opacity-60" />
            <span className="truncate">{item.label}</span>
          </span>
          <span className="ml-3 flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden="true" />
            Aktivera
          </span>
        </span>
      </Link>
    )
  }

  const content = (
    <span className={cn(
      'group flex items-center justify-between rounded-xl px-3 py-2 text-sm font-medium transition-all',
      active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      disabled && 'pointer-events-none opacity-45',
    )}>
      <span className="flex min-w-0 items-center gap-3">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{item.label}</span>
      </span>
      {typeof item.badge === 'number' && item.badge > 0 ? (
        <span className={cn('ml-3 rounded-full px-2 py-0.5 text-xs', active ? 'bg-primary-foreground/20' : 'bg-primary/10 text-primary')}>
          {item.badge}
        </span>
      ) : null}
    </span>
  )

  return disabled ? content : <Link href={item.href} onClick={onClick}>{content}</Link>
}

export default function DashboardNav({
  uncategorizedTransactionCount = 0,
  pendingOperationsCount = 0,
  isSandbox = false,
  userName = null,
  userEmail = null,
  enabledFeatures = null,
  hasYearEndAccess = false,
}: DashboardNavProps) {
  const pathname = usePathname()
  const {
    company,
    canManageAgency,
    canManagePlatform,
    workspaceType,
  } = useCompany()
  const [open, setOpen] = useState(false)
  const branding = getBranding()
  const hasCompany = Boolean(company)

  const groups = useMemo(
    () =>
      buildNavGroups({
        workspaceType,
        hasCompany,
        canManageAgency,
        canManagePlatform,
        enabledFeatures: enabledFeatures ? new Set(enabledFeatures) : null,
        hasYearEndAccess,
        isSandbox,
        badges: {
          pendingOperations: pendingOperationsCount,
          uncategorizedTransactions: uncategorizedTransactionCount,
        },
      }),
    [workspaceType, hasCompany, canManageAgency, canManagePlatform, enabledFeatures, hasYearEndAccess, isSandbox, pendingOperationsCount, uncategorizedTransactionCount],
  )

  const logout = async () => {
    clearRecaptIdentity()
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      // Use a hard navigation so App Router/RSC caches cannot reuse the old
      // authenticated tree after the session cookies have been cleared.
      window.location.assign(isSandbox ? '/sandbox' : '/login')
    }
  }

  const Sidebar = (
    <aside className="flex h-full w-72 flex-col border-r border-border/70 bg-card/85 px-4 py-5 shadow-sm backdrop-blur-xl md:w-64">
      <div className="mb-5 flex items-center justify-between gap-3">
        <Link href="/app" className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Scale className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <div className="font-display text-xl font-semibold tracking-tight nordklart-gradient-text">{branding.appName}</div>
            <div className="text-xs text-muted-foreground">En tjänst från {NORDKLART_LEGAL_NAME}</div>
          </div>
        </Link>
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpen(false)} aria-label="Stäng meny">
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="mb-5 rounded-2xl border bg-background/70 p-2">
        <WorkspaceSwitcher />
      </div>

      <nav className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-1">
        {groups.map((group) => (
          <section key={group.label} className="space-y-2">
            <div className="px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{group.label}</div>
            <div className="space-y-1">
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  disabled={item.requiresCompany && !hasCompany}
                  onClick={() => setOpen(false)}
                />
              ))}
            </div>
          </section>
        ))}
      </nav>

      <div className="mt-5 rounded-2xl border bg-background/70 p-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {initials(userName, userEmail)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{userName || 'Inloggad användare'}</div>
            <div className="truncate text-xs text-muted-foreground">{userEmail || 'Nordklart'}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={logout} aria-label="Logga ut">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </aside>
  )

  return (
    <>
      <div className="fixed left-0 top-0 z-40 hidden h-screen md:block">{Sidebar}</div>
      <div className="fixed inset-x-0 top-0 z-40 border-b bg-card/90 px-4 py-3 backdrop-blur-xl md:hidden">
        <div className="flex items-center justify-between">
          <Link href="/app" className="flex items-center gap-2 font-display text-xl font-semibold nordklart-gradient-text">
            <Scale className="h-5 w-5 text-primary" />
            {branding.appName}
          </Link>
          <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Öppna meny">
            <Menu className="h-5 w-5" />
          </Button>
        </div>
      </div>
      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button aria-label="Stäng meny" className="absolute inset-0 bg-foreground/20 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="relative h-full animate-slide-up">{Sidebar}</div>
        </div>
      ) : null}
    </>
  )
}
