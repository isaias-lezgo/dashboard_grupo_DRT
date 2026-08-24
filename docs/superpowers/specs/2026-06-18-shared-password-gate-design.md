# Shared-Password Gate — Design

**Date:** 2026-06-18
**Status:** Approved (pending spec review)

## Goal

Prevent anyone without a shared password from loading the dashboard or
reaching its data. Protection must be **server-side** so it covers both the
UI and every `/api/*` route — a client-only gate is insufficient because the
GHL CRM data flows through `app/api/dashboard/route.ts` and could otherwise be
fetched directly.

## Scope decisions

- **Single shared password** (one secret for the whole team). No per-user
  accounts, no audit trail, no per-user revocation. Rotating the password
  invalidates everyone.
- **No password-strength enforcement** — the operator chooses the password.
- **7-day session** before re-authentication is required.
- **In-memory login rate limiting** (no new dependencies).
- Deployment target: Vercel (public URL, HTTPS/TLS provided by platform).

## Secrets (env vars, server-only)

Added to `.env.local` and the Vercel project environment:

- `DASHBOARD_PASSWORD` — the shared password handed out to users.
- `DASHBOARD_AUTH_SECRET` — random string used to HMAC-sign the session
  cookie so it cannot be forged.

Both are read server-side only and never reach the browser bundle.

## Session cookie / token

- Cookie name: `dash_session`.
- Flags: `httpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `maxAge` = 7 days.
- Value: a signed token of the form `<expiryMs>.<HMAC-SHA256(expiryMs, SECRET)>`.
  - Contains **no password and no PII** — only an expiry timestamp.
  - `httpOnly` blocks client-side JS from reading it (mitigates XSS theft).
  - The HMAC signature prevents tampering/forgery.
- Expiry = now + 7 days; the cookie `maxAge` matches the token expiry.

## Components

1. **`lib/auth.ts`**
   - `signToken(expiryMs): Promise<string>` and
     `verifyToken(value): Promise<boolean>` implemented with **Web Crypto**
     (`crypto.subtle`), because `middleware.ts` runs on the Edge runtime where
     Node's `crypto` module is unavailable.
   - `safeEqual(a, b)` constant-time string comparison for the password check.
   - Verification fails closed if `DASHBOARD_AUTH_SECRET` is missing.

2. **`app/login/page.tsx`**
   - Small branded form: one password field + submit, styled with the existing
     shadcn/Tailwind components.
   - POSTs to `/api/auth/login`. On success, redirects to `/`. On failure,
     shows an inline error. On `429`, shows a "too many attempts, try again
     later" message.

3. **`app/api/auth/login/route.ts`**
   - Reads the submitted password and the client IP.
   - Rate-limit check first (see below). If limited → `429`.
   - Constant-time compares password to `DASHBOARD_PASSWORD`.
     - Match → clear that IP's failed-attempt counter, set the signed
       `dash_session` cookie, return `200`.
     - Mismatch → increment the IP's counter, return `401`.
   - Fails closed (`500` + server log) if env vars are missing.

4. **`app/api/auth/logout/route.ts`**
   - Clears the `dash_session` cookie. Optional but cheap; enables a future
     logout button.

5. **`middleware.ts`**
   - Matches all routes **except** `/login`, `/api/auth/*`, and Next static
     assets (`/_next/*`, favicon, etc.).
   - Verifies the `dash_session` cookie:
     - Valid → continue (existing data flow unchanged).
     - Invalid/missing on a **page** request → `302` redirect to `/login`.
     - Invalid/missing on an **`/api/*`** request → `401 JSON` (so the
       dashboard fetch fails cleanly instead of receiving an HTML redirect).
   - Fails closed (deny) and logs a clear error if env vars are missing.

## Rate limiting

- Implemented in `app/api/auth/login/route.ts` with a module-level
  `Map<ip, { count, firstAttemptMs }>`.
- Policy: **5 failed attempts within a 15-minute window** triggers a
  **15-minute lockout** (`429`) for that IP.
- A successful login clears the IP's entry.
- **Honest limitation:** on Vercel's serverless/edge runtime this state is
  per-instance and resets on cold starts, so it is a *soft* mitigation — it
  defeats casual scripted guessing but is not an airtight, distributed limiter.
  Upgrading to a durable store (Upstash/Vercel KV) was considered and
  deliberately deferred (YAGNI for a single internal tool).

## Data flow

```
request → middleware.ts → dash_session cookie valid?
   ├─ no  → page: 302 /login    |  api: 401 json
   └─ yes → continue to page / api/* (existing flow unchanged)
```

## What this protects (and what it does not)

Protects:
- Unauthenticated strangers cannot load the UI or call any API route; hitting
  `/api/dashboard` with no valid cookie returns `401` — no data leaks.
- Cookies cannot be forged (HMAC signature).
- Traffic is encrypted in transit (Vercel HTTPS).
- The GHL API token stays server-side, never in the browser.

Does **not** protect against (accepted tradeoffs):
- Anyone who legitimately has the password sees everything; revocation = rotate
  the password.
- An authenticated user can see all data in their browser network tab
  (inherent to a dashboard).
- A weak chosen password reduces brute-force resistance (strength not enforced
  per decision); rate limiting partially offsets this.
- Application-level XSS could ride an active session (mitigated by React/Next
  default escaping; avoid `dangerouslySetInnerHTML` with untrusted input).

## Error handling

- Wrong password → inline form error (`401`).
- Rate-limited → inline "too many attempts" message (`429`).
- Expired/missing/invalid cookie → redirect to `/login` (pages) or `401` (api).
- Missing env vars → fail closed (deny) with a clear server-side log.

## Testing (manual — no test framework in this repo)

1. No cookie: `/` redirects to `/login`; `GET /api/dashboard` returns `401`.
2. Correct password: logs in, cookie set, dashboard loads normally.
3. Wrong password: `401`, inline error, no cookie set.
4. Tampered/expired cookie: treated as invalid (redirect / `401`).
5. 6 rapid wrong attempts from one IP: 6th returns `429` lockout.
6. Successful login after failures: counter cleared, normal access.
