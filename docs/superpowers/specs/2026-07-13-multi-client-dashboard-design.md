# Multi-Client Dashboard — Design

**Date:** 2026-07-13
**Status:** Approved (pending spec review)

## Goal

Serve several GHL sub-accounts (Yconia, Plaza Bosques, Muratta, Condesa, Vaeo,
Grand Center, …) from **one deployment at one URL**, each with its own
`GHL_API_TOKEN` and `GHL_LOCATION_ID`.

A client logs in with their own password; that password **is** their identity and
resolves to their GHL credentials. Each client sees only their own data, enforced
**server-side on every request**. Today's single-tenant setup — one
`DASHBOARD_PASSWORD`, one `GHL_API_TOKEN`, one `GHL_LOCATION_ID` read from
`process.env` — becomes a per-request lookup.

This supersedes the single-password model in
`2026-06-18-shared-password-gate-design.md`; the cookie, HMAC, and middleware
machinery from that design are extended, not replaced.

## Scope decisions

- **Password = client identity.** No usernames, no client picker at login. The
  login page stays a single password box.
- **Location id doubles as the password** by default. `password` is an
  *optional* per-client override (see "Password model" for the accepted risk).
- **No agency super-user.** To inspect a client, log in with that client's
  password.
- **No `/[client]` sub-routes, no per-client subdomains.** Under
  one-session-maps-to-one-client they are redundant: the segment carries no
  information the cookie doesn't already hold, neither can perform the auth, and
  both add a path-vs-session mismatch case to handle. Deliberately deferred; the
  design does not preclude either (white-label subdomains remain a clean future
  add).
- **Roster lives in one env var**, not a database. Revisitable behind a seam
  (see `lib/clients.ts`).
- Deployment target: Vercel (Node runtime for route handlers, Edge for
  middleware).

## Password model (accepted risk)

By default a client's password **is** their `locationId`. This was chosen
deliberately, with the trade-off understood:

- A GHL location id is **not a secret**. It appears in GHL dashboard URLs, form
  and calendar embed codes, webhook payloads, and existing Make scenarios.
- It **cannot be rotated.** If it leaks, GHL will not reissue it.
- It is *not* brute-forceable (24 random chars), so the exposure is
  "already-shared identifier," not "anyone can walk in."

**Mitigation, built in from day one:** `password` is an optional field on each
client. When present it is used; when absent it falls back to `locationId`. So a
single client can be given a real, rotatable password later by adding one line to
their entry — no migration, no code change.

## Client roster — `lib/clients.ts`

The **seam** of this design. Everything downstream (session, credential context,
rate limiter) depends only on the `ClientConfig` *shape*, never on where it came
from. Moving the roster into a database later touches this file alone.

```ts
export interface ClientConfig {
  id: string          // stable slug, e.g. "yconia"
  name: string        // display name, e.g. "Yconia"
  locationId: string  // GHL location/sub-account id
  ghlToken: string    // GHL Private Integration Token
  password?: string   // optional override; defaults to locationId
}
```

Backed by a single env var, `DASHBOARD_CLIENTS`, holding a JSON array:

```json
[
  { "id": "yconia",  "name": "Yconia",  "locationId": "abc123", "ghlToken": "pit-..." },
  { "id": "condesa", "name": "Condesa", "locationId": "def456", "ghlToken": "pit-..." }
]
```

Parsed and validated **once** at module load, then cached. Validation is strict
and **fails loudly at startup** rather than half-working in production:

- malformed JSON, or not an array
- any missing/empty required field (`id`, `name`, `locationId`, `ghlToken`)
- duplicate `id`
- two clients resolving to the **same effective password** (which would make the
  login lookup ambiguous)

Exposed API:

- `getClientById(id): ClientConfig | null`
- `findClientByPassword(pw): ClientConfig | null` — compares against **every**
  client with `safeEqual` and **no early return**, so timing does not reveal
  which client a wrong password nearly matched.

**Accepted limitation:** one JSON blob is one shared failure domain — a syntax
error while adding a client breaks *every* client's login. Startup validation
plus the add-client script (below) are the mitigation.

## Adding a client — `npm run add-client`

A small Node script (`scripts/add-client.ts`). Prompts for name, location id, and
GHL token; derives the slug; validates the result against the existing roster
(dupes, missing fields, password collisions); prints the complete updated JSON
blob to paste into the Vercel env var. It does not write to Vercel — it removes
the error-prone part (hand-editing JSON in a browser textarea), not the paste.

## Session — carries the client id

Extends the existing `dash_session` cookie. Cookie name and flags are unchanged
(`httpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 7-day `maxAge`).

**Token format changes** from `<expiryMs>.<hmac(expiryMs)>` to:

```
<clientId>.<expiryMs>.<HMAC-SHA256("<clientId>.<expiryMs>", SECRET)>
```

Because `clientId` is inside the signed payload, a client editing their cookie to
name another client produces an invalid signature and is rejected. The token still
carries no password and no PII.

`lib/auth.ts` changes:

- `signToken(clientId, expiryMs): Promise<string>`
- `verifyToken(value): Promise<string | null>` — returns the **client id**
  instead of a boolean; `null` on missing/malformed/expired/bad-signature.
- `safeEqual` unchanged.
- Still **Web Crypto only** (`crypto.subtle`), so it remains importable from
  Edge middleware.

`app/api/auth/login/route.ts` changes: swap the single
`safeEqual(submitted, DASHBOARD_PASSWORD)` for
`findClientByPassword(submitted)`. On match, sign that client's id into the
cookie. Per-IP rate limiting is unchanged (5 failures / 15 min, in-memory, same
honest caveat as the original design). `DASHBOARD_PASSWORD` is removed.

`middleware.ts` changes: none structurally — it still verifies the cookie and
redirects pages to `/login` / returns `401` for `/api/*`. It now treats a `null`
return from `verifyToken` as failure. It does **not** inject a client-id header
(see below).

**New: `requireClient(req)`** — lives in a **new `lib/session.ts`**, *not* in
`lib/auth.ts`. `lib/auth.ts` is imported by Edge middleware and its header comment
keeps it deliberately pure and runtime-agnostic; importing `lib/clients.ts` there
would drag the whole roster into the Edge bundle. Middleware only needs to verify
the signature, so only routes (Node runtime) resolve the client.

Every GHL-touching route calls it. It re-verifies the signed cookie *itself* and
resolves the full `ClientConfig` via `getClientById`. It deliberately does **not**
trust a header set by middleware — that would create a spoofing surface to save
one HMAC verify (microseconds). Returns `401` if the cookie is invalid **or if the
id no longer resolves**, which means deleting a client from the roster instantly
invalidates their live sessions.

## Credentials — `lib/ghl-context.ts` (new)

`ghlFetch` (`lib/ghl-client.ts:130`) is the single funnel for every GHL call, but
it sits several layers below the route handler that knows which client is asking,
and 113 exported functions sit in between. Credentials reach it via
**`AsyncLocalStorage`** — Node's request-scoped context. Concurrent requests for
different clients on the same serverless instance get independent stores.

```ts
// lib/ghl-context.ts
const ctx = new AsyncLocalStorage<ClientConfig>()

export function withClient<T>(c: ClientConfig, fn: () => T): T {
  return ctx.run(c, fn)
}

export function currentClient(): ClientConfig {
  const c = ctx.getStore()
  if (!c) throw new Error("No GHL client context — ghlFetch called outside withClient()")
  return c // fails closed: never falls back to a wrong or default token
}
```

`lib/ghl-client.ts` change is **two lines**, at 134–135:

```diff
- const token = process.env.GHL_API_TOKEN;
- const locationId = process.env.GHL_LOCATION_ID;
+ const { ghlToken: token, locationId } = currentClient();
```

All 113 exported functions and every call site are **untouched**.

**REJECTED — a module-level `currentClient` variable set at the top of each
request.** One serverless instance handles overlapping requests, so client A's
in-flight sync would read client B's token. Silent cross-tenant data leak. Must
not be done under any circumstances.

**The streaming gotcha.** `app/api/dashboard/route.ts` returns an NDJSON
`ReadableStream` that keeps producing frames *after* the handler returns. Wrapping
the handler body in `withClient` would leave the stream pump running **outside**
the context, where `currentClient()` throws. The context must therefore be entered
**inside** the stream's `start`/pull callback, not around the handler. (It fails
loudly rather than leaking, but it would be broken.)

## Rate limiter — per client, not per process

Currently `MAX_CONCURRENT_GHL_REQUESTS`/`activeGhlRequests`/`ghlWaitQueue`, the
token bucket (`rateTokens`, `rateLastRefill`), and `cooldownUntil` are all
**process-wide** module state (`lib/ghl-client.ts:24-70`). GHL's budget is
**per location** (~100 req / 10s, confirmed via its `x-ratelimit-*` headers).

Shared across tenants this is wrong in both directions: it is needlessly
conservative (six clients have six independent budgets), and — worse — one
client's `429` sets a global `cooldownUntil` that **freezes every other client's
sync**.

Change: hold this state in a `Map<locationId, LimiterState>`, one independent
limiter per client, same constants (8 concurrent, 80 req/10s, same retry/jitter/
cooldown logic). `acquireSlot`/`releaseSlot`/`acquireRateToken` take the location
id (available from `currentClient()`).

**Note:** per-client caps mean total in-flight requests can now reach
8 × N clients. Realistically only one or two clients sync concurrently, so no
global ceiling is added (YAGNI); revisit if socket exhaustion ever appears.

## Routes

**Six routes touch GHL** and each gets the same two-line treatment —
`const client = await requireClient(req)`, then wrap the GHL work in
`withClient(client, ...)`:

- `app/api/dashboard/route.ts` (+ context inside the stream callback; and
  line 549's `process.env.GHL_LOCATION_ID` → `client.locationId`)
- `app/api/dashboard-messages/route.ts`
- `app/api/conversations/route.ts` (+ line 44's `process.env.GHL_LOCATION_ID` →
  `client.locationId`)
- `app/api/contact-notes/route.ts`
- `app/api/contact-tasks/route.ts`
- `app/api/analyze-contact/route.ts`

**Two routes do not touch GHL** — `app/api/chat/route.ts` and
`app/api/analyze-report/route.ts` never import `lib/ghl-client`; they operate on
data the browser already holds. They need no credential context, only the
existing middleware auth gate. Left unchanged.

## What does *not* change

Per-client *behavioral* differences are already handled heuristically and need no
config flags:

- `lib/opportunity-status.ts` — `isWonOpp()` loosely matches won-stage names
  ("Negocio Ganado" / "Won" / …) rather than hardcoding one account's pipeline.
- `lib/source-platform.ts` — matches custom-field labels by substring because
  clients name them differently ("Tipo de pauta", "Nombre pauta", …).
- Pautas is discovered as a GHL custom object, so accounts without one (Condesa)
  degrade to an empty list.

The dashboard/marketing/sales components, the internal type system, and the
client-side date filtering are all untouched.

## UI

Minimal. The login page keeps its single password box. The loading screen already
renders the sub-account name from the `{ type: "location", name }` stream frame,
so it shows the correct client for free. Add the client name and a logout control
to the dashboard header.

## Environment variables

| Var | Status |
|---|---|
| `DASHBOARD_CLIENTS` | **new** — JSON array of `ClientConfig` |
| `DASHBOARD_AUTH_SECRET` | unchanged — HMAC-signs the session cookie |
| `DASHBOARD_PASSWORD` | **removed** — superseded by per-client passwords |
| `GHL_API_TOKEN`, `GHL_LOCATION_ID` | **no longer read by the app**; kept in `.env.local` because `.mcp.json` uses them to point the dev MCP server at one sub-account |

`.env.example` and `CLAUDE.md` updated accordingly.

## Data flow

```
login POST (password)
  → findClientByPassword() → ClientConfig
  → cookie: clientId.expiry.hmac

request
  → middleware: verifyToken() → clientId? ─ no ─→ page: 302 /login | api: 401
                                            └ yes ─→ continue
  → route: requireClient(req) → verify cookie → getClientById() → ClientConfig
  → withClient(client, () => ...)
      → ghlFetch → currentClient() → { ghlToken, locationId }
                 → limiter keyed by locationId
      → GHL API
```

## Error handling

- Wrong password (matches no client) → `401`, inline error. Indistinguishable
  from any other wrong password; reveals nothing about the roster.
- Rate-limited login → `429` (unchanged policy).
- `DASHBOARD_CLIENTS` missing or invalid → fail closed: middleware denies, login
  returns `500` with a clear server log.
- Session valid but client removed from roster → `401` / redirect to `/login`.
- `ghlFetch` called with no context → throws immediately. Fails closed; never
  falls back to a default token.
- GHL `429` for one client → that client's cooldown only; other clients unaffected.

## Security properties

Protects:

- A client cannot reach another client's data. The client id is HMAC-signed into
  the cookie, and every GHL-touching route re-verifies it server-side.
- Credentials never reach the browser; `lib/ghl-client.ts` stays server-only.
- Cross-tenant leakage via shared mutable state is structurally prevented by
  `AsyncLocalStorage` (and by explicitly rejecting a module-level current-client
  variable).

Does **not** protect against (accepted):

- Anyone holding a client's password *is* that client — same trust model as the
  current single-password gate, repeated per client.
- The default password (the location id) is semi-public and non-rotatable; see
  "Password model." The optional `password` field is the escape hatch.
- A syntax error in the `DASHBOARD_CLIENTS` blob takes down all logins.

## Testing (manual — no test framework in this repo)

1. Log in as client A → dashboard shows A's location name, A's contacts/opps.
2. Log out, log in as client B → shows B's data. No bleed from A.
3. Tamper: while logged in as A, edit the cookie's `clientId` to B → rejected
   (bad signature) → redirected to `/login`.
4. Wrong password (matching no client) → `401`, inline error.
5. Concurrently trigger a full sync for A and B (two browsers) → both complete
   with correct, non-interleaved data; neither throttles the other into failure.
6. Remove a client from `DASHBOARD_CLIENTS`, redeploy → that client's existing
   session is rejected on next request.
7. Malformed `DASHBOARD_CLIENTS` → app fails closed with a clear log, not silent
   partial behavior.
8. Optional `password` override on one client → that client logs in with the new
   password; their location id no longer works; other clients unaffected.
9. `npm run add-client` → rejects a duplicate id and a password collision; emits
   valid JSON otherwise.
