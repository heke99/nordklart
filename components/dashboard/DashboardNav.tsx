'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
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
import { clearRecaptIdentity } from '@/lib/recapt'
import WorkspaceSwitcher from '@/components/dashboard/WorkspaceSwitcher'
import { useCompany } from '@/contexts/CompanyContext'
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
}

type NavItem = {
  href: string
  label: string
  icon: typeof LayoutDashboard
  badge?: number
  requiresCompany?: boolean
}

type NavGroup = { label: string; items: NavItem[] }

function initials(name: string | null, email: string | null) {
  const source = name?.trim() || email?.trim() || 'N'
  return source.slice(0, 1).toUpperCase()
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

function NavLink({ item, pathname, disabled, onClick }: {
  item: NavItem
  pathname: string
  disabled?: boolean
  onClick?: () => void
}) {
  const active = isActive(pathname, item.href)
  const Icon = item.icon
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
}: DashboardNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const {
    company,
    canManageAgency,
    canManagePlatform,
    workspaceType,
  } = useCompany()
  const [open, setOpen] = useState(false)
  const branding = getBranding()
  const hasCompany = Boolean(company)

  const groups = useMemo<NavGroup[]>(() => {
    if (workspaceType === 'platform') {
      return [
        {
          label: 'Plattform',
          items: [
            { href: '/platform', label: 'Översikt', icon: Home },
            { href: '/platform/price-plans', label: 'Prisplaner', icon: WalletCards },
            { href: '/platform/onboarding', label: 'Onboarding', icon: ClipboardCheck },
            { href: '/platform/bank-automation', label: 'Bankautomation', icon: Landmark },
            { href: '/platform/year-end', label: 'Bokslut', icon: FileCheck2 },
            { href: '/platform/skatteverket', label: 'Skatteverket', icon: Send },
            { href: '/platform/bankgiro', label: 'Bankgiro', icon: Banknote },
            { href: '/platform/api-webhooks', label: 'API & webhooks', icon: Plug },
          ],
        },
      ]
    }

    if (workspaceType === 'agency') {
      return [
        {
          label: 'Byrå',
          items: [
            { href: '/agency', label: 'Byråöversikt', icon: Home },
            { href: '/agency/clients', label: 'Kunder', icon: Users },
            { href: '/pending', label: 'Att granska', icon: ClipboardCheck, badge: pendingOperationsCount, requiresCompany: true },
            { href: '/deadlines', label: 'Deadlines', icon: FileCheck2, requiresCompany: true },
            { href: '/year-end', label: 'Bokslut', icon: FileCheck2, requiresCompany: true },
            { href: '/reports', label: 'Rapporter', icon: BarChart3, requiresCompany: true },
          ],
        },
        {
          label: 'Inställningar',
          items: [
            { href: '/settings/team', label: 'Team', icon: Users, requiresCompany: true },
            { href: '/settings', label: 'Inställningar', icon: Settings },
          ],
        },
      ]
    }

    return [
      {
        label: 'Arbetsyta',
        items: [
          { href: '/app', label: 'Översikt', icon: Home, requiresCompany: true },
          { href: '/pending', label: 'Att göra', icon: ClipboardCheck, badge: pendingOperationsCount, requiresCompany: true },
          { href: '/transactions', label: 'Bank & transaktioner', icon: Landmark, badge: uncategorizedTransactionCount, requiresCompany: true },
          { href: '/bookkeeping', label: 'Bokföring', icon: BookOpen, requiresCompany: true },
          { href: '/invoices', label: 'Fakturor', icon: Receipt, requiresCompany: true },
          { href: '/supplier-invoices', label: 'Leverantörer', icon: WalletCards, requiresCompany: true },
        ],
      },
      {
        label: 'Ekonomi',
        items: [
          { href: '/reports', label: 'Rapporter', icon: BarChart3, requiresCompany: true },
          { href: '/skatteverket', label: 'Moms & skatt', icon: Send, requiresCompany: true },
          { href: '/year-end', label: 'Bokslut', icon: FileCheck2, requiresCompany: true },
          { href: '/payments/bankgiro', label: 'Bankgiro', icon: Banknote, requiresCompany: true },
          { href: '/extensions', label: 'Integrationer', icon: Plug, requiresCompany: true },
        ],
      },
      {
        label: 'Inställningar',
        items: [
          { href: '/bank-automation', label: 'Automatisering', icon: Sparkles, requiresCompany: true },
          { href: '/chat', label: 'Bokföringsassistent', icon: Sparkles, requiresCompany: true },
          ...(canManageAgency ? [{ href: '/agency', label: 'Redovisningsbyrå', icon: Users } as NavItem] : []),
          ...(canManagePlatform ? [{ href: '/platform', label: 'Plattform', icon: ShieldCheck } as NavItem] : []),
          { href: '/settings', label: 'Inställningar', icon: Settings },
        ],
      },
    ]
  }, [workspaceType, canManageAgency, canManagePlatform, pendingOperationsCount, uncategorizedTransactionCount])

  const logout = async () => {
    clearRecaptIdentity()
    await supabase.auth.signOut()
    router.push(isSandbox ? '/sandbox' : '/login')
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
            <div className="text-xs text-muted-foreground">Bokföring utan friktion</div>
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
