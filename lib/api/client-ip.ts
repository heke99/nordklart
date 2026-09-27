import { truncateIp } from '@/lib/api/truncate-ip'

/**
 * Rate-limit key for the caller's network. The first x-forwarded-for value is
 * authoritative behind Vercel and the bundled Caddy proxy. The address is
 * truncated (IPv4 /24, IPv6 /48) so rotating addresses inside one allocation,
 * notably an IPv6 /64, does not buy a fresh budget.
 */
export function clientIpKey(request: Request): string {
  const raw = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || ''
  return truncateIp(raw || undefined) ?? 'unknown'
}
