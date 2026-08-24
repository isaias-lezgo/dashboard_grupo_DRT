// app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  signToken,
} from "@/lib/auth";
import { findClientByPassword, type ClientConfig } from "@/lib/clients";

export const runtime = "nodejs";

// In-memory per-IP rate limiter. NOTE: on Vercel this state is per-instance and
// resets on cold starts, so it is a soft mitigation against scripted guessing,
// not an airtight distributed limiter (see design doc).
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const attempts = new Map<string, { count: number; firstMs: number }>();

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

// Returns true if the IP is currently locked out.
function isLimited(ip: string): boolean {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstMs > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.firstMs > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstMs: now });
  } else {
    rec.count += 1;
  }
}

export async function POST(req: Request) {
  if (!process.env.DASHBOARD_CLIENTS || !process.env.DASHBOARD_AUTH_SECRET) {
    console.error("[auth] DASHBOARD_CLIENTS or DASHBOARD_AUTH_SECRET not set");
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const ip = clientIp(req);
  if (isLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let submitted = "";
  try {
    const body = (await req.json()) as { password?: string };
    submitted = body.password ?? "";
  } catch {
    submitted = "";
  }

  // The password IS the client's identity. findClientByPassword compares against
  // every client with no early return, so timing reveals nothing about the roster.
  let client: ClientConfig | null = null;
  try {
    client = findClientByPassword(submitted);
  } catch (err) {
    // A malformed roster must not look like a wrong password.
    console.error("[auth] Invalid DASHBOARD_CLIENTS:", err);
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  if (!client) {
    recordFailure(ip);
    return NextResponse.json({ error: "invalid_password" }, { status: 401 });
  }

  // Success: clear failures and set the signed session cookie for THIS client.
  attempts.delete(ip);
  const expiryMs = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const token = await signToken(client.id, expiryMs);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
