# Shared-Password Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block anyone without a shared password from loading the dashboard or reaching any `/api/*` route, enforced server-side via Next.js middleware, an HMAC-signed session cookie, and a custom login page with login rate limiting.

**Architecture:** A `middleware.ts` runs on the Edge runtime and verifies a signed `dash_session` cookie on every request except `/login`, `/api/auth/*`, and static assets — redirecting pages to `/login` and returning `401` JSON for API calls. A `/login` page POSTs the shared password to `/api/auth/login`, which constant-time-compares it to `DASHBOARD_PASSWORD`, rate-limits failed attempts per IP in memory, and on success sets the signed cookie. Token signing/verification uses Web Crypto (`crypto.subtle`) so it runs on Edge.

**Tech Stack:** Next.js 15 App Router, TypeScript, Web Crypto API, shadcn/ui (button, card, input, label), Tailwind. No test framework exists in this repo (`next.config.mjs` ignores TS build errors), so verification is **manual**: `npm run build`, `curl -i`, and browser checks.

---

## File Structure

- `lib/auth.ts` (create) — Web Crypto HMAC token sign/verify + constant-time compare. Pure, no Next imports. Used by both the login route (nodejs) and middleware (edge).
- `app/api/auth/login/route.ts` (create) — validates password, rate-limits per IP, sets cookie.
- `app/api/auth/logout/route.ts` (create) — clears cookie.
- `app/login/page.tsx` (create) — login form (client component) styled with existing shadcn/ui.
- `middleware.ts` (create, repo root) — route guard.
- `.env.local` (modify) — add `DASHBOARD_PASSWORD`, `DASHBOARD_AUTH_SECRET`.
- `.env.example` (create or modify) — document the two new vars.
- `CLAUDE.md` (modify) — document the new env vars in the Environment Variables section.

---

## Task 1: Auth helper (`lib/auth.ts`)

**Files:**
- Create: `lib/auth.ts`

- [ ] **Step 1: Write the helper**

```typescript
// lib/auth.ts
// Edge-safe auth helpers. Uses Web Crypto (crypto.subtle) so this module can be
// imported from middleware (Edge runtime) as well as Node route handlers.
// No Next.js imports here — keep it pure and runtime-agnostic.

export const SESSION_COOKIE = "dash_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

function getSecret(): string {
  const secret = process.env.DASHBOARD_AUTH_SECRET;
  if (!secret) {
    throw new Error("DASHBOARD_AUTH_SECRET is not set");
  }
  return secret;
}

// Constant-time string comparison to avoid leaking length/character timing.
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare against a fixed-length XOR accumulator. Differing lengths still
  // run the loop to the max length and fail.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  // hex-encode
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Token format: "<expiryMs>.<hmac(expiryMs)>". Contains no password or PII.
export async function signToken(expiryMs: number): Promise<string> {
  const payload = String(expiryMs);
  const sig = await hmac(payload);
  return `${payload}.${sig}`;
}

export async function verifyToken(value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot < 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expiryMs = Number(payload);
  if (!Number.isFinite(expiryMs)) return false;
  if (Date.now() > expiryMs) return false; // expired
  const expected = await hmac(payload);
  return safeEqual(sig, expected);
}
```

- [ ] **Step 2: Type-check the file compiles**

Run: `npx tsc --noEmit lib/auth.ts 2>&1 | head -20`
Expected: no errors referencing `lib/auth.ts` (it may print unrelated project-wide errors; those are pre-existing and ignored by the build per `next.config.mjs`).

- [ ] **Step 3: Commit**

```bash
git add lib/auth.ts
git commit -m "feat(auth): edge-safe HMAC token helpers"
```

---

## Task 2: Login API route with rate limiting (`app/api/auth/login/route.ts`)

**Files:**
- Create: `app/api/auth/login/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  signToken,
  safeEqual,
} from "@/lib/auth";

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
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password || !process.env.DASHBOARD_AUTH_SECRET) {
    console.error("[auth] DASHBOARD_PASSWORD or DASHBOARD_AUTH_SECRET not set");
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

  if (!safeEqual(submitted, password)) {
    recordFailure(ip);
    return NextResponse.json({ error: "invalid_password" }, { status: 401 });
  }

  // Success: clear failures and set the signed session cookie.
  attempts.delete(ip);
  const expiryMs = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const token = await signToken(expiryMs);

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
```

- [ ] **Step 2: Commit**

```bash
git add app/api/auth/login/route.ts
git commit -m "feat(auth): login route with per-IP rate limiting"
```

---

## Task 3: Logout API route (`app/api/auth/logout/route.ts`)

**Files:**
- Create: `app/api/auth/logout/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// app/api/auth/logout/route.ts
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/auth/logout/route.ts
git commit -m "feat(auth): logout route clears session cookie"
```

---

## Task 4: Login page (`app/login/page.tsx`)

**Files:**
- Create: `app/login/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
// app/login/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace("/");
        router.refresh();
        return;
      }
      if (res.status === 429) {
        setError("Demasiados intentos. Espera unos minutos e intenta de nuevo.");
      } else {
        setError("Contraseña incorrecta.");
      }
    } catch {
      setError("Error de red. Intenta de nuevo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Dashboard protegido</CardTitle>
          <CardDescription>Ingresa la contraseña para continuar.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Contraseña</Label>
              <Input
                id="password"
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || password.length === 0}>
              {loading ? "Verificando..." : "Entrar"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/login/page.tsx
git commit -m "feat(auth): login page"
```

---

## Task 5: Middleware route guard (`middleware.ts`)

**Files:**
- Create: `middleware.ts` (repo root)

- [ ] **Step 1: Write the middleware**

```typescript
// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/lib/auth";

// Runs on every request matched by `config.matcher` below. Verifies the signed
// session cookie. Pages redirect to /login; API routes get a 401 JSON so the
// dashboard fetch fails cleanly instead of receiving an HTML redirect.
export async function middleware(req: NextRequest) {
  // Fail closed if misconfigured.
  if (!process.env.DASHBOARD_AUTH_SECRET) {
    console.error("[auth] DASHBOARD_AUTH_SECRET not set; denying all requests");
    return denied(req);
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const ok = await verifyToken(token);
  if (ok) return NextResponse.next();
  return denied(req);
}

function denied(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

// Match everything EXCEPT: the login page, the auth API routes, and Next static
// assets / favicon. Note `/login` and `/api/auth` are excluded so they stay
// reachable while unauthenticated.
export const config = {
  matcher: ["/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 2: Verify the matcher regex excludes the right paths**

Reason through it: `/login` → excluded (login alternative). `/api/auth/login` → excluded (`api/auth`). `/` → matched. `/api/dashboard` → matched. `/_next/static/...` → excluded.

- [ ] **Step 3: Commit**

```bash
git add middleware.ts
git commit -m "feat(auth): middleware guards pages and api routes"
```

---

## Task 6: Environment variables + docs

**Files:**
- Modify: `.env.local` (add the two vars — do NOT commit this file; it is gitignored)
- Create/Modify: `.env.example`
- Modify: `CLAUDE.md` (Environment Variables section)

- [ ] **Step 1: Add vars to `.env.local`**

Append (replace the values with your chosen password and a random secret):

```
DASHBOARD_PASSWORD=your-chosen-password
DASHBOARD_AUTH_SECRET=paste-a-long-random-string-here
```

Generate a secret with: `openssl rand -hex 32`

- [ ] **Step 2: Document in `.env.example`**

Add (no real values):

```
GHL_API_TOKEN=
GHL_LOCATION_ID=
DASHBOARD_PASSWORD=
DASHBOARD_AUTH_SECRET=
```

- [ ] **Step 3: Update `CLAUDE.md` Environment Variables section**

Add two bullets after the existing `GHL_*` bullets:

```markdown
- `DASHBOARD_PASSWORD` — shared password for the login gate (you choose it)
- `DASHBOARD_AUTH_SECRET` — random string used to HMAC-sign the session cookie (`openssl rand -hex 32`)
```

Also note these are read server-side in `lib/auth.ts` / `app/api/auth/login/route.ts` / `middleware.ts`.

- [ ] **Step 4: Commit (env.example + CLAUDE.md only — `.env.local` is gitignored)**

```bash
git add .env.example CLAUDE.md
git commit -m "docs: document dashboard auth env vars"
```

---

## Task 7: Build + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Production build passes**

Run: `npm run build`
Expected: build completes; `middleware.ts` compiles and is listed in the build output.

- [ ] **Step 2: Start the app**

Run: `npm run dev` (in a background terminal). Ensure `.env.local` has both new vars set.

- [ ] **Step 3: Unauthenticated page is blocked**

Run: `curl -i -s http://localhost:3000/ | head -20`
Expected: `HTTP/1.1 307` (or 308) redirect with `location: /login`.

- [ ] **Step 4: Unauthenticated API is blocked**

Run: `curl -i -s http://localhost:3000/api/dashboard | head -20`
Expected: `HTTP/1.1 401` and body `{"error":"unauthorized"}`. **No CRM data in the body.**

- [ ] **Step 5: Wrong password rejected**

Run: `curl -i -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"password":"wrong"}'`
Expected: `HTTP/1.1 401` and `{"error":"invalid_password"}`. No `set-cookie` header.

- [ ] **Step 6: Rate limit triggers**

Run the Step 5 command 6 times quickly.
Expected: the 6th response is `HTTP/1.1 429` with `{"error":"rate_limited"}`.

- [ ] **Step 7: Correct password logs in (save the cookie)**

Run: `curl -i -s -c /tmp/dash_cookie.txt -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"password":"your-chosen-password"}'`
Expected: `HTTP/1.1 200`, `{"ok":true}`, and a `set-cookie: dash_session=...; HttpOnly; Secure; ...` header. (Note: with `secure: true` the cookie is set over HTTP on localhost by curl but browsers require HTTPS in production — fine on Vercel.)

- [ ] **Step 8: Authenticated API works with the cookie**

Run: `curl -i -s -b /tmp/dash_cookie.txt http://localhost:3000/api/dashboard | head -5`
Expected: NOT a 401 (begins streaming the NDJSON dashboard data).

> If Step 7's `secure: true` cookie isn't sent back by curl over plain HTTP, verify Steps 7–8 in a browser at `http://localhost:3000/login` instead: enter the password, confirm redirect to `/` and that the dashboard loads.

- [ ] **Step 9: Browser smoke test**

In a browser: visit `http://localhost:3000/` → redirected to `/login`. Enter the wrong password → inline error. Enter the correct password → lands on the dashboard and data loads. Reload → stays logged in (cookie persists).

- [ ] **Step 10: Final commit (if any tweaks were needed during verification)**

```bash
git add -A
git commit -m "fix(auth): verification adjustments" || echo "nothing to commit"
```

---

## Notes for the implementer

- **`secure: true` on the cookie**: required in production (Vercel = HTTPS). On localhost over plain HTTP, browsers will still store it for `localhost` specifically, but `curl` may not echo it back — prefer the browser checks (Step 9) as the source of truth.
- **Edge runtime**: `lib/auth.ts` must not import any Node-only module. It only uses Web Crypto and `process.env`, both available on Edge.
- **Do not commit `.env.local`** — it is gitignored. Only `.env.example` and `CLAUDE.md` get committed in Task 6.
- **Rotating access**: change `DASHBOARD_PASSWORD` (and redeploy) to revoke everyone. Changing `DASHBOARD_AUTH_SECRET` invalidates all existing sessions immediately.
