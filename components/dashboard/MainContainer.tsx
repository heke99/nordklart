'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

export function MainContainer({
  companyId,
  children,
}: {
  companyId: string | null
  children: ReactNode
}) {
  const pathname = usePathname()
  const isFullBleed = pathname.startsWith('/e/') || pathname.startsWith('/chat')

  return isFullBleed ? (
    <div key={companyId ?? ''} className="h-full pt-16 md:pt-0">{children}</div>
  ) : (
    <div
      key={companyId ?? ''}
      className="mx-auto w-full max-w-7xl px-4 py-24 md:px-8 md:py-10"
    >
      {children}
    </div>
  )
}
