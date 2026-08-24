---
name: multi-tenancy
description: How the password-as-identity multi-client machinery works — the roster seam in lib/clients.ts, the HMAC-signed dash_session cookie, requireClient() re-verifying it per route, the withClient() AsyncLocalStorage credential context, and per-location limiter keying. Use when touching lib/clients.ts, lib/auth.ts, lib/session.ts, lib/ghl-context.ts, lib/ghl-limiter.ts, middleware.ts, or app/api/auth/*.
---

# Multi-client (multi-tenancy)

> This deployment serves Grupo VAEO only, so multi-tenancy is no longer a *design*
> concern — but the machinery is live and load-bearing. The two prohibitions that guard
> it live in the root `CLAUDE.md`, not here; read them there before changing anything.

One deployment serves every client. **The password IS the client's identity.**

1. `lib/clients.ts` — the roster, parsed from `DASHBOARD_CLIENTS`. This is the
   **seam**: nothing downstream knows the roster comes from an env var, so swapping
   in a database later touches only this file.
2. Login (`app/api/auth/login/route.ts`) looks the submitted password up across the
   roster (`findClientByPassword` — constant-time, no early return) and HMAC-signs
   the matched client's id into the `dash_session` cookie:
   `<clientId>.<expiryMs>.<hmac>`. The id is inside the signed payload, so a client
   cannot edit their cookie to reach another client's data.
3. Every GHL-touching route calls `requireClient()` (`lib/session.ts`), which
   re-verifies the cookie **itself** — it deliberately does not trust a
   middleware-injected header, which would be a spoofing surface. Middleware only
   verifies the signature; resolving the client there would drag the roster into the
   Edge bundle.
4. The route runs its GHL work inside `withClient(client, ...)`
   (`lib/ghl-context.ts`, an `AsyncLocalStorage`). `ghlFetch` reads credentials via
   `currentClient()`, which is why none of its ~113 exported functions needed a
   signature change. `currentClient()` **fails closed** — it throws rather than
   falling back to a default token.
5. `lib/ghl-limiter.ts` keys the concurrency semaphore, token bucket, and 429
   cooldown **by location id**, because GHL's budget is per location. Shared, one
   client's 429 would freeze every other client's sync.

The two streaming routes (`dashboard`, `dashboard-messages`) enter the context
**inside** the `ReadableStream` `start()` callback — the stream outlives the
handler's return, so wrapping the handler would leave the pump running outside the
context.

`app/api/chat` and `app/api/analyze-report` never touch GHL (they work off data the
browser already holds), so they need no client context — only the middleware gate.

Verification scripts (no test framework in this repo): `pnpm verify:clients`,
`pnpm verify:auth`, `pnpm verify:limiter`.
