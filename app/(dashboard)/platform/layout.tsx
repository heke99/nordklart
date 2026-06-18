import { requirePlatformAdmin } from '@/lib/auth/platform'

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin()
  return children
}
