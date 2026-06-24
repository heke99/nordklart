import { requirePlatformRole } from '@/lib/auth/platform'

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformRole()
  return children
}
