import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { checkDurableRateLimit } from "@/lib/auth/rate-limit-durable";
import { createServiceClient } from "@/lib/supabase/server";

function getIp(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = body.email?.trim().toLowerCase();
  const ip = getIp(request);

  const limited = await checkDurableRateLimit({
    prefix: "auth:forgot-password",
    identifier: ip,
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
  });

  if (!limited.ok) return limited.response!;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: true });
  }

  // A second limit per address, so rotating IPs cannot flood one inbox. It
  // answers exactly like a successful request so it reveals nothing.
  const perAddress = await checkDurableRateLimit({
    prefix: "auth:forgot-password:email",
    identifier: email,
    maxRequests: 3,
    windowMs: 60 * 60 * 1000,
  });
  if (!perAddress.ok) return NextResponse.json({ ok: true });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } },
  );

  const redirectTo = `${new URL(request.url).origin}/auth/callback?flow=recovery&next=/reset-password`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });

  try {
    await createServiceClient()
      .from("auth_audit_events")
      .insert({
        event_type: error
          ? "password_reset_request_failed"
          : "password_reset_requested",
        email,
        ip_address: ip === "unknown" ? null : ip,
        user_agent: request.headers.get("user-agent"),
        status: error ? "failed" : "accepted",
        metadata: error ? { reason: error.message } : {},
      });
  } catch {
    // Audit must never leak account existence or break the neutral response.
  }

  return NextResponse.json({ ok: true });
}
