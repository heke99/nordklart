/**
 * Origin for links the server puts into e-mails and redirects. The configured
 * NEXT_PUBLIC_APP_URL wins: the request's own origin comes from the Host
 * header, which a client can forge on deployments that do not overwrite it.
 * The request origin is only a fallback for local development.
 */
export function appOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.APP_URL?.trim()
  if (configured && !configured.startsWith('__')) {
    try {
      return new URL(configured).origin
    } catch {
      // A malformed configuration must not make a browser-provided origin trusted.
    }
  }
  return new URL(request.url).origin
}
