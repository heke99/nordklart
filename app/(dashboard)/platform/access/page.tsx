import Link from 'next/link'
import { KeyRound, ShieldCheck, UserRoundCog } from 'lucide-react'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { createServiceClient } from '@/lib/supabase/server'
import { NordklartPageShell } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { revokePlatformRoleAction, setPlatformRoleAction } from './actions'

export const dynamic = 'force-dynamic'

type ProfileRow = { id: string; full_name: string | null; email: string | null }
type RoleRow = { user_id: string; role: 'platform_admin' | 'platform_support' | 'platform_auditor'; granted_at: string; revoked_at: string | null; note: string | null }
const date = (value: string | null) => value ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '–'
const roleLabel: Record<RoleRow['role'], string> = { platform_admin: 'Superadmin', platform_support: 'Plattform support', platform_auditor: 'Plattform granskare' }

export default async function PlatformAccessPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  await requirePlatformAdmin()
  const service = createServiceClient()
  const query = await searchParams
  const [{ data: profiles }, { data: roles }] = await Promise.all([
    service.from('profiles').select('id,full_name,email').order('full_name', { ascending: true }).limit(500),
    service.from('platform_roles').select('user_id,role,granted_at,revoked_at,note').order('granted_at', { ascending: false }).limit(500),
  ])
  const profileRows = (profiles ?? []) as ProfileRow[]
  const roleRows = (roles ?? []) as RoleRow[]
  const profileById = new Map(profileRows.map((profile) => [profile.id, profile]))
  const activeRoles = roleRows.filter((role) => !role.revoked_at)

  return <NordklartPageShell eyebrow="Superadmin · plattformsbehörighet" title="Plattformsteam och behörigheter" description="Superadmin styr den globala plattformen. Complimentary Full Access hanteras separat i Planer, priser och åtkomst och ger aldrig plattformsåtkomst." actions={<Button asChild variant="secondary"><Link href="/platform">Till plattform</Link></Button>}>
    {query.notice ? <div className="rounded-2xl border border-success/30 bg-success/10 px-5 py-4 text-sm text-success">{query.notice}</div> : null}
    {query.error ? <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">{query.error}</div> : null}
    <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
      <section className="rounded-3xl border bg-card p-6 shadow-sm"><div className="flex items-start gap-3"><ShieldCheck className="mt-1 h-6 w-6 text-primary" /><div><h2 className="text-xl font-semibold">Tilldela plattformsroll</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">En person har högst en aktiv global roll. Superadmin styr priser, Stripe, grants och alla kommersiella inställningar.</p></div></div><form action={setPlatformRoleAction} className="mt-5 space-y-4"><label className="block text-sm font-medium">Person<select required name="user_id" className="mt-1 h-10 w-full rounded-lg border bg-background px-3">{profileRows.map((profile) => <option key={profile.id} value={profile.id}>{profile.full_name || profile.email || profile.id}{profile.email && profile.full_name ? ` · ${profile.email}` : ''}</option>)}</select></label><label className="block text-sm font-medium">Roll<select required name="role" defaultValue="platform_support" className="mt-1 h-10 w-full rounded-lg border bg-background px-3"><option value="platform_admin">Superadmin</option><option value="platform_support">Plattform support</option><option value="platform_auditor">Plattform granskare</option></select></label><label className="block text-sm font-medium">Intern anteckning<textarea name="note" rows={3} maxLength={1000} className="mt-1 w-full rounded-lg border bg-background px-3 py-2" placeholder="Varför rollen behövs" /></label><Button type="submit"><UserRoundCog className="mr-2 h-4 w-4" />Spara plattformsroll</Button></form></section>
      <section className="rounded-3xl border bg-card p-6 shadow-sm"><div className="flex items-start gap-3"><KeyRound className="mt-1 h-6 w-6 text-primary" /><div><h2 className="text-xl font-semibold">Aktiva roller</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Återkallelse kräver en intern orsak. Systemet stoppar återkallelse av den sista aktiva superadminrollen.</p></div></div><div className="mt-5 space-y-3">{activeRoles.map((role) => { const profile = profileById.get(role.user_id); return <div key={role.user_id} className="rounded-2xl border bg-background/60 p-4"><div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div><div className="flex items-center gap-2"><span className="font-medium">{profile?.full_name || profile?.email || role.user_id}</span><Badge variant={role.role === 'platform_admin' ? 'success' : 'secondary'}>{roleLabel[role.role]}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{profile?.email ?? role.user_id} · tilldelad {date(role.granted_at)}</p>{role.note ? <p className="mt-2 text-sm text-muted-foreground">{role.note}</p> : null}</div><form action={revokePlatformRoleAction} className="flex flex-wrap gap-2"><input type="hidden" name="user_id" value={role.user_id} /><input required name="note" placeholder="Orsak" className="h-9 rounded-lg border bg-card px-3 text-sm" /><Button type="submit" size="sm" variant="outline">Återkalla</Button></form></div></div> })}{activeRoles.length === 0 ? <p className="text-sm text-muted-foreground">Ingen aktiv plattformsroll hittades.</p> : null}</div></section>
    </div>
  </NordklartPageShell>
}
