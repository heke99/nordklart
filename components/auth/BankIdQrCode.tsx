'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import QRCode from 'qrcode'

interface BankIdQrCodeProps {
  qrStartToken: string
  qrStartSecret: string
  /**
   * How old the BankID order already was when the browser received these
   * tokens, measured on the server. Defaults to 0 (treat arrival as t=0),
   * which is what a caller that cannot report the age should do.
   */
  orderAgeMs?: number
}

/**
 * Animated BankID QR code.
 *
 * The payload is `bankid.{qrStartToken}.{time}.{hmac_sha256(qrStartSecret, time)}`
 * where `time` is **whole seconds since the BankID order was created** — a
 * server-side fact that BankID re-derives from its own copy of the order when
 * the app scans the code. If our `time` does not match theirs the app rejects
 * the scan.
 *
 * This used to be a counter incremented once per `setInterval` tick, which is
 * not the same quantity at all:
 *
 *   - it started at 0 when the component mounted, ignoring the time the order
 *     had already existed while the start response travelled to the browser;
 *   - `setInterval(…, 1000)` is throttled to roughly once per minute in a
 *     background tab, so switching away and back left the counter tens of
 *     seconds behind wall clock and every subsequent scan failed;
 *   - the increment happened after an awaited HMAC, so a slow device drifted
 *     further behind on every tick.
 *
 * So the elapsed time is now derived from the clock against an anchor, and the
 * interval only decides how often we redraw. A throttled tab now produces a
 * stale *picture* — which the next tick fixes — instead of a wrong one.
 */
export function BankIdQrCode({ qrStartToken, qrStartSecret, orderAgeMs = 0 }: BankIdQrCodeProps) {
  const [svgData, setSvgData] = useState<string>('')
  const anchorRef = useRef(0)
  const tokenRef = useRef(qrStartToken)
  const secretRef = useRef(qrStartSecret)

  // Re-anchor when the order rotates (TIC regenerates orders roughly every 25s
  // and hands back fresh tokens on poll).
  useEffect(() => {
    tokenRef.current = qrStartToken
    secretRef.current = qrStartSecret
    anchorRef.current = Date.now() - Math.max(0, orderAgeMs)
  }, [qrStartToken, qrStartSecret, orderAgeMs])

  const generateQr = useCallback(async () => {
    const token = tokenRef.current
    const secret = secretRef.current
    // Re-read the clock at draw time, not at schedule time.
    const time = Math.max(0, Math.floor((Date.now() - anchorRef.current) / 1000))

    try {
      // Compute HMAC-SHA256 using Web Crypto API
      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      )
      const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(time.toString()))
      const qrAuthCode = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      const qrData = `bankid.${token}.${time}.${qrAuthCode}`

      const svg = await QRCode.toString(qrData, {
        type: 'svg',
        margin: 1,
        width: 200,
        color: { dark: '#141414', light: '#ffffff' },
      })
      setSvgData(svg)
    } catch {
      // Silently fail — next tick will retry
    }
  }, [])

  useEffect(() => {
    // The anchor effect above runs before this one on mount, so the first draw
    // already has it.
    generateQr()
    const interval = setInterval(generateQr, 1000)
    return () => clearInterval(interval)
  }, [generateQr])

  if (!svgData) {
    return (
      <div className="flex h-[200px] w-[200px] items-center justify-center rounded-lg border bg-white">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div
      className="inline-flex rounded-lg border bg-white p-2"
      dangerouslySetInnerHTML={{ __html: svgData }}
    />
  )
}
