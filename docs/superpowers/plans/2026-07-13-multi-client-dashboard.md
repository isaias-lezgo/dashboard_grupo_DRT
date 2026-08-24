# Multi-Client Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve several GHL sub-accounts from one deployment — a client's password resolves to their own GHL token + location id, and each client sees only their own data, enforced server-side on every request.

**Architecture:** A `DASHBOARD_CLIENTS` JSON env var holds the roster (`lib/clients.ts`, the seam). Login looks the submitted password up across the roster and HMAC-signs the matched client's id into the existing `dash_session` cookie. Each GHL-touching route re-verifies that cookie, resolves the `ClientConfig`, and runs its work inside an `AsyncLocalStorage` context; `ghlFetch` reads credentials from that context instead of `process.env`. The process-wide rate limiter is extracted into `lib/ghl-limiter.ts` and keyed by location id.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript 5.7, Node 24. `tsx` (added in Task 1) runs the verification scripts.

**Spec:** `docs/superpowers/specs/2026-07-13-multi-client-dashboard-design.md`

## Global Constraints

- **This repo has no test framework and is not adopting one.** Pure modules get verification scripts under `scripts/verify-*.ts`, run with `tsx` and asserting via `node:assert/strict`. Integration behavior is verified manually in the browser (Task 8). Do not add vitest/jest.
- **`npm install` requires `--legacy-peer-deps`** in this repo. Always pass it.
- **`lib/auth.ts` must stay Edge-safe**: Web Crypto only (`crypto.subtle`), no Node imports, no `next/*` imports. Edge middleware imports it. It must NOT import `lib/clients.ts`.
- **New files under `lib/` use relative imports** (`./auth`, not `@/lib/auth`) so `tsx` resolves them without depending on tsconfig path aliases.
- **NEVER introduce a module-level "current client" variable.** One serverless instance serves overlapping requests; that would silently serve client A's data using client B's token. `AsyncLocalStorage` exists to prevent exactly this.
- **`currentClient()` fails closed** — it throws when there is no context. It must never fall back to `process.env` or a default client.
- Client `id` must match `/^[a-z0-9-]+$/` (no dots) — the session token is dot-delimited and the id is a field in it.
- TypeScript errors are ignored by `next build` (see `next.config.mjs`), so a green build does NOT mean types are sound. Run `npx tsc --noEmit` where the plan says to.

---

## File Structure

**Create:**
- `lib/clients.ts` — the roster. Pure `parseClients()` + env-backed lazy cache + lookups. The only file that knows where client config comes from.
- `lib/ghl-context.ts` — `AsyncLocalStorage<ClientConfig>`; `withClient()` / `currentClient()`.
- `lib/ghl-limiter.ts` — per-location concurrency semaphore + token bucket + 429 cooldown, extracted out of `ghl-client.ts`.
- `lib/session.ts` — `requireClient()` (Node-only; reads the cookie, resolves the client).
- `scripts/add-client.ts` — interactive roster editor; prints the JSON blob to paste into Vercel.
- `scripts/verify-clients.ts`, `scripts/verify-auth.ts`, `scripts/verify-limiter.ts` — assertion scripts.

**Modify:**
- `lib/auth.ts` — token carries the client id; `verifyToken` returns `string | null`.
- `middleware.ts` — treat `null` from `verifyToken` as failure.
- `app/api/auth/login/route.ts` — password lookup across the roster.
- `lib/ghl-client.ts` — credentials from context; limiter calls keyed by location.
- The six GHL-touching routes — `requireClient()` + `withClient()`.
- `app/page.tsx` — logout button.
- `.env.example`, `CLAUDE.md` — env var docs.

---

### Task 1: Client roster (`lib/clients.ts`)

**Files:**
- Create: `lib/clients.ts`
- Create: `scripts/verify-clients.ts`
- Modify: `package.json` (add `tsx` devDep + `verify:clients` script)

**Interfaces:**
- Consumes: `safeEqual` from `lib/auth.ts` (already exists, unchanged).
- Produces:
  - `interface ClientConfig { id: string; name: string; locationId: string; ghlToken: string; password?: string }`
  - `parseClients(raw: string): ClientConfig[]` — pure; throws on any invalid roster.
  - `effectivePassword(c: ClientConfig): string`
  - `getClients(): ClientConfig[]` — lazy, cached, reads `process.env.DASHBOARD_CLIENTS`.
  - `getClientById(id: string): ClientConfig | null`
  - `findClientByPassword(password: string): ClientConfig | null`

- [ ] **Step 1: Install `tsx`**

```bash
npm install -D tsx --legacy-peer-deps
```

- [ ] **Step 2: Add the verify script to `package.json`**

In the `"scripts"` block, after `"lint": "eslint ."`:

```json
    "lint": "eslint .",
    "verify:clients": "tsx scripts/verify-clients.ts"
```

- [ ] **Step 3: Write the failing verification script**

Create `scripts/verify-clients.ts`:

```ts
// Verification for lib/clients.ts. Run: npm run verify:clients
import assert from "node:assert/strict";
import { parseClients, effectivePassword, findClientByPassword, getClientById } from "../lib/clients";

const VALID = JSON.stringify([
  { id: "yconia", name: "Yconia", locationId: "loc-yconia", ghlToken: "pit-a" },
  { id: "condesa", name: "Condesa", locationId: "loc-condesa", ghlToken: "pit-b", password: "custom-pw" },
]);

function throws(raw: string, needle: string, label: string) {
  assert.throws(() => parseClients(raw), (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    assert.ok(msg.includes(needle), `${label}: expected message to include "${needle}", got "${msg}"`);
    return true;
  }, label);
}

// --- parse + shape
const clients = parseClients(VALID);
assert.equal(clients.length, 2);
assert.equal(clients[0].id, "yconia");
assert.equal(clients[0].password, undefined);
assert.equal(clients[1].password, "custom-pw");

// --- password defaults to locationId, override wins
assert.equal(effectivePassword(clients[0]), "loc-yconia");
assert.equal(effectivePassword(clients[1]), "custom-pw");

// --- validation failures
throws("not json", "not valid JSON", "malformed JSON");
throws(JSON.stringify({ id: "x" }), "must be a JSON array", "not an array");
throws("[]", "no clients configured", "empty array");
throws(JSON.stringify([{ id: "a", name: "A", locationId: "l" }]), "ghlToken", "missing ghlToken");
throws(JSON.stringify([{ id: "a", name: "A", locationId: "l", ghlToken: "" }]), "ghlToken", "empty ghlToken");
throws(JSON.stringify([{ id: "A.b", name: "A", locationId: "l", ghlToken: "t" }]), "invalid id", "id with a dot");
throws(
  JSON.stringify([
    { id: "a", name: "A", locationId: "l1", ghlToken: "t" },
    { id: "a", name: "B", locationId: "l2", ghlToken: "t" },
  ]),
  "duplicate id",
  "duplicate id",
);
throws(
  JSON.stringify([
    { id: "a", name: "A", locationId: "same", ghlToken: "t" },
    { id: "b", name: "B", locationId: "same", ghlToken: "t" },
  ]),
  "shares a password",
  "password collision via identical locationId",
);
throws(
  JSON.stringify([
    { id: "a", name: "A", locationId: "l1", ghlToken: "t" },
    { id: "b", name: "B", locationId: "l2", ghlToken: "t", password: "l1" },
  ]),
  "shares a password",
  "password collision via override",
);

// --- env-backed lookups
process.env.DASHBOARD_CLIENTS = VALID;
assert.equal(getClientById("yconia")?.name, "Yconia");
assert.equal(getClientById("nope"), null);
assert.equal(findClientByPassword("loc-yconia")?.id, "yconia");
assert.equal(findClientByPassword("custom-pw")?.id, "condesa");
// the overridden client's locationId must NOT work as a password
assert.equal(findClientByPassword("loc-condesa"), null);
assert.equal(findClientByPassword("wrong"), null);
assert.equal(findClientByPassword(""), null);

console.log("✅ lib/clients.ts — all assertions passed");
```

- [ ] **Step 4: Run it and watch it fail**

```bash
npm run verify:clients
```

Expected: FAIL — `Cannot find module '../lib/clients'`.

- [ ] **Step 5: Write `lib/clients.ts`**

```ts
// lib/clients.ts
// The client roster — the seam between "where client config comes from" and
// everything downstream. Nothing outside this file knows the roster is backed by
// an env var, so swapping in a database later touches only this file.
import { safeEqual } from "./auth";

export interface ClientConfig {
  id: string;
  name: string;
  locationId: string;
  ghlToken: string;
  // Optional override. Absent = the GHL location id doubles as the password.
  // See the design doc's "Password model" for the accepted risk; this field is
  // the escape hatch that makes a single client's password rotatable.
  password?: string;
}

export function effectivePassword(c: ClientConfig): string {
  return c.password ?? c.locationId;
}

// The session token is dot-delimited and embeds the id, so ids may not contain dots.
const ID_RE = /^[a-z0-9-]+$/;
const REQUIRED = ["id", "name", "locationId", "ghlToken"] as const;

// Pure. Throws with an actionable message on any invalid roster — a half-valid
// roster in production is far worse than a loud failure at startup.
export function parseClients(raw: string): ClientConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`DASHBOARD_CLIENTS is not valid JSON: ${msg}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("DASHBOARD_CLIENTS must be a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("DASHBOARD_CLIENTS is empty — no clients configured");
  }

  const clients: ClientConfig[] = [];
  const seenIds = new Set<string>();
  const seenPasswords = new Set<string>();

  parsed.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`DASHBOARD_CLIENTS[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;

    for (const field of REQUIRED) {
      const v = e[field];
      if (typeof v !== "string" || v.trim() === "") {
        throw new Error(`DASHBOARD_CLIENTS[${i}] is missing required field "${field}"`);
      }
    }
    if (e.password !== undefined && (typeof e.password !== "string" || e.password.trim() === "")) {
      throw new Error(
        `DASHBOARD_CLIENTS[${i}] has an empty "password" — omit the field entirely to default to locationId`,
      );
    }

    const client: ClientConfig = {
      id: e.id as string,
      name: e.name as string,
      locationId: e.locationId as string,
      ghlToken: e.ghlToken as string,
      ...(e.password !== undefined ? { password: e.password as string } : {}),
    };

    if (!ID_RE.test(client.id)) {
      throw new Error(
        `DASHBOARD_CLIENTS[${i}] has an invalid id "${client.id}" — use lowercase letters, digits and hyphens only`,
      );
    }
    if (seenIds.has(client.id)) {
      throw new Error(`DASHBOARD_CLIENTS has a duplicate id "${client.id}"`);
    }
    seenIds.add(client.id);

    // Two clients with the same effective password would make the login lookup
    // ambiguous — one would silently shadow the other.
    const pw = effectivePassword(client);
    if (seenPasswords.has(pw)) {
      throw new Error(`DASHBOARD_CLIENTS: client "${client.id}" shares a password with another client`);
    }
    seenPasswords.add(pw);

    clients.push(client);
  });

  return clients;
}

// Lazy + cached. Lazy (rather than parsing at module load) so that importing this
// module in an environment without the env var doesn't throw at import time.
let cache: ClientConfig[] | null = null;

export function getClients(): ClientConfig[] {
  if (cache) return cache;
  const raw = process.env.DASHBOARD_CLIENTS;
  if (!raw) throw new Error("DASHBOARD_CLIENTS is not set");
  cache = parseClients(raw);
  return cache;
}

export function getClientById(id: string): ClientConfig | null {
  return getClients().find((c) => c.id === id) ?? null;
}

// Compares against EVERY client with no early return, so response timing doesn't
// reveal which client a wrong password nearly matched.
export function findClientByPassword(password: string): ClientConfig | null {
  if (password === "") return null;
  let match: ClientConfig | null = null;
  for (const c of getClients()) {
    if (safeEqual(password, effectivePassword(c))) match = c;
  }
  return match;
}
```

- [ ] **Step 6: Run it and watch it pass**

```bash
npm run verify:clients
```

Expected: `✅ lib/clients.ts — all assertions passed`

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json lib/clients.ts scripts/verify-clients.ts
git commit -m "feat(clients): client roster parsed from DASHBOARD_CLIENTS"
```

---

### Task 2: Session token carries the client id

**Files:**
- Modify: `lib/auth.ts:52-69` (`signToken`, `verifyToken`)
- Modify: `middleware.ts:15-18`
- Create: `scripts/verify-auth.ts`
- Modify: `package.json` (add `verify:auth` script)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `signToken(clientId: string, expiryMs: number): Promise<string>` — **signature changed**, was `signToken(expiryMs)`.
  - `verifyToken(value: string | undefined): Promise<string | null>` — **return type changed**, was `Promise<boolean>`. Returns the client id, or `null`.
  - `SESSION_COOKIE`, `SESSION_MAX_AGE_SECONDS`, `safeEqual` — unchanged.

- [ ] **Step 1: Add the verify script to `package.json`**

```json
    "verify:clients": "tsx scripts/verify-clients.ts",
    "verify:auth": "tsx scripts/verify-auth.ts"
```

- [ ] **Step 2: Write the failing verification script**

Create `scripts/verify-auth.ts`:

```ts
// Verification for lib/auth.ts. Run: npm run verify:auth
import assert from "node:assert/strict";

process.env.DASHBOARD_AUTH_SECRET = "test-secret-do-not-use-in-prod";

const { signToken, verifyToken } = await import("../lib/auth");

const HOUR = 60 * 60 * 1000;

// --- round trip: the client id survives sign → verify
const token = await signToken("yconia", Date.now() + HOUR);
assert.equal(await verifyToken(token), "yconia");

// --- the token is dot-delimited: clientId.expiry.signature
assert.equal(token.split(".").length, 3, "token must have exactly 3 segments");
assert.ok(token.startsWith("yconia."), "client id must be the first segment");

// --- THE ISOLATION GUARANTEE: swapping the client id invalidates the signature.
// This is the assertion that stops client A from reading client B's data.
const [, expiry, sig] = token.split(".");
assert.equal(await verifyToken(`condesa.${expiry}.${sig}`), null, "tampered client id must be rejected");

// --- other tampering
assert.equal(await verifyToken(`yconia.${expiry}.deadbeef`), null, "bad signature rejected");
assert.equal(await verifyToken(`yconia.${Number(expiry) + 1}.${sig}`), null, "tampered expiry rejected");

// --- expiry is enforced
const expired = await signToken("yconia", Date.now() - 1000);
assert.equal(await verifyToken(expired), null, "expired token rejected");

// --- malformed input
assert.equal(await verifyToken(undefined), null);
assert.equal(await verifyToken(""), null);
assert.equal(await verifyToken("garbage"), null);
assert.equal(await verifyToken("only.two"), null);
assert.equal(await verifyToken("a.b.c.d"), null);
assert.equal(await verifyToken(`.${expiry}.${sig}`), null, "empty client id rejected");

// --- two clients get distinguishable tokens
const a = await signToken("yconia", Date.now() + HOUR);
const b = await signToken("condesa", Date.now() + HOUR);
assert.equal(await verifyToken(a), "yconia");
assert.equal(await verifyToken(b), "condesa");

console.log("✅ lib/auth.ts — all assertions passed");
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npm run verify:auth
```

Expected: FAIL — `signToken("yconia", …)` currently takes only `expiryMs`, so `verifyToken` returns `true`/`false`, not `"yconia"`. The first assertion fails with `Expected values to be strictly equal: true !== 'yconia'`.

- [ ] **Step 4: Rewrite `signToken` / `verifyToken` in `lib/auth.ts`**

Replace lines 51-69 (from the `// Token format:` comment to end of file) with:

```ts
// Token format: "<clientId>.<expiryMs>.<hmac(clientId.expiryMs)>".
// The client id is INSIDE the signed payload, so a client cannot edit their
// cookie to impersonate another client — the signature check fails. Contains no
// password and no PII.
export async function signToken(clientId: string, expiryMs: number): Promise<string> {
  const payload = `${clientId}.${expiryMs}`;
  const sig = await hmac(payload);
  return `${payload}.${sig}`;
}

// Returns the client id on success, null on any failure (missing, malformed,
// expired, or bad signature). Callers resolve the id to a ClientConfig.
export async function verifyToken(value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;

  const [clientId, expiryRaw, sig] = parts;
  if (!clientId) return null;

  const expiryMs = Number(expiryRaw);
  if (!Number.isFinite(expiryMs)) return null;
  if (Date.now() > expiryMs) return null; // expired

  const expected = await hmac(`${clientId}.${expiryMs}`);
  if (!safeEqual(sig, expected)) return null;

  return clientId;
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
npm run verify:auth
```

Expected: `✅ lib/auth.ts — all assertions passed`

- [ ] **Step 6: Update `middleware.ts` for the new return type**

Replace lines 15-18:

```ts
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const clientId = await verifyToken(token);
  if (clientId) return NextResponse.next();
  return denied(req);
```

Middleware only verifies the signature — it does not resolve the client (that would drag the roster into the Edge bundle). Routes do the resolution.

- [ ] **Step 7: Typecheck**

```bash
npx tsc --noEmit
```

Expected: errors ONLY in `app/api/auth/login/route.ts` (it still calls the old `signToken(expiryMs)`). Task 3 fixes that. No other file may error.

- [ ] **Step 8: Commit**

```bash
git add package.json lib/auth.ts middleware.ts scripts/verify-auth.ts
git commit -m "feat(auth): session token carries the client id"
```

---

### Task 3: Login resolves a client; `requireClient()` for routes

**Files:**
- Modify: `app/api/auth/login/route.ts:46-85`
- Create: `lib/session.ts`

**Interfaces:**
- Consumes: `findClientByPassword`, `getClientById`, `ClientConfig` (Task 1); `signToken`, `verifyToken`, `SESSION_COOKIE` (Task 2).
- Produces:
  - `requireClient(): Promise<ClientConfig | null>` — reads the cookie via `next/headers`, verifies it, resolves the client. **Takes no arguments** (two of the six routes are `GET()` with no request param).
  - `unauthorized(): Response` — `401 {"error":"unauthorized"}`.

- [ ] **Step 1: Create `lib/session.ts`**

```ts
// lib/session.ts
// Node-only. Kept OUT of lib/auth.ts on purpose: auth.ts is imported by Edge
// middleware and must stay pure/runtime-agnostic, and importing the roster there
// would pull it into the Edge bundle.
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifyToken } from "./auth";
import { getClientById, type ClientConfig } from "./clients";

// Re-verifies the signed cookie itself rather than trusting a header injected by
// middleware — a header would be a spoofing surface, and an HMAC verify costs
// microseconds. Returns null when the cookie is invalid OR when the id no longer
// resolves, which means removing a client from the roster instantly invalidates
// their live sessions.
export async function requireClient(): Promise<ClientConfig | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const clientId = await verifyToken(token);
  if (!clientId) return null;
  try {
    return getClientById(clientId);
  } catch (err) {
    // Roster missing/invalid — fail closed rather than serving anyone.
    console.error("[session] Could not load client roster:", err);
    return null;
  }
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
```

- [ ] **Step 2: Rewrite the login route's `POST` body**

In `app/api/auth/login/route.ts`, replace the whole `export async function POST` (lines 46-85) with:

```ts
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
```

- [ ] **Step 3: Fix the login route's imports**

Replace the import block at the top (lines 2-8):

```ts
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  signToken,
} from "@/lib/auth";
import { findClientByPassword, type ClientConfig } from "@/lib/clients";
```

`safeEqual` is no longer imported here — `findClientByPassword` does the constant-time comparison now.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean, no errors.

- [ ] **Step 5: Commit**

```bash
git add app/api/auth/login/route.ts lib/session.ts
git commit -m "feat(auth): password resolves to a client; add requireClient()"
```

---

### Task 4: Credential context — `AsyncLocalStorage` through to `ghlFetch`

This task must land whole: `ghlFetch` stops reading `process.env`, so every GHL-touching route must supply context in the same commit or the app is broken.

**Files:**
- Create: `lib/ghl-context.ts`
- Modify: `lib/ghl-client.ts:130-142`
- Modify: `app/api/dashboard/route.ts` (285-291, 549, 569)
- Modify: `app/api/dashboard-messages/route.ts` (14-17)
- Modify: `app/api/conversations/route.ts` (1, 33-60)
- Modify: `app/api/contact-notes/route.ts` (6)
- Modify: `app/api/contact-tasks/route.ts` (6)
- Modify: `app/api/analyze-contact/route.ts` (250)

**Interfaces:**
- Consumes: `ClientConfig` (Task 1); `requireClient`, `unauthorized` (Task 3).
- Produces:
  - `withClient<T>(client: ClientConfig, fn: () => T): T`
  - `currentClient(): ClientConfig` — throws if called outside `withClient`.

- [ ] **Step 1: Create `lib/ghl-context.ts`**

```ts
// lib/ghl-context.ts
// Request-scoped GHL credentials.
//
// ghlFetch is the single funnel for every GHL call, but it sits several layers
// below the route handler that knows WHICH client is asking, with ~113 exported
// functions in between. AsyncLocalStorage carries the client down that call chain
// without changing a single one of those signatures. Concurrent requests for
// different clients on the same instance get independent stores.
//
// NEVER replace this with a module-level "current client" variable: one instance
// serves overlapping requests, so that would silently serve client A's dashboard
// using client B's token.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ClientConfig } from "./clients";

const ctx = new AsyncLocalStorage<ClientConfig>();

export function withClient<T>(client: ClientConfig, fn: () => T): T {
  return ctx.run(client, fn);
}

// Fails closed. There is deliberately no fallback to process.env or a default
// client — serving the wrong tenant's data is far worse than a 500.
export function currentClient(): ClientConfig {
  const client = ctx.getStore();
  if (!client) {
    throw new Error(
      "No GHL client context — ghlFetch() was called outside withClient(). " +
        "Wrap the route's GHL work in withClient(client, ...).",
    );
  }
  return client;
}
```

- [ ] **Step 2: Read credentials from the context in `ghlFetch`**

In `lib/ghl-client.ts`, add to the imports at the top of the file:

```ts
import { currentClient } from "./ghl-context";
```

Then replace lines 134-142 (the env reads and their guards) with:

```ts
  const { ghlToken: token, locationId } = currentClient();
```

The two `if (!token)` / `if (!locationId)` throws are deleted — `currentClient()` already fails closed, and the roster guarantees both fields are non-empty.

- [ ] **Step 3: Wire `app/api/dashboard/route.ts` (streaming)**

Add imports at the top:

```ts
import { requireClient, unauthorized } from "@/lib/session";
import { withClient } from "@/lib/ghl-context";
```

Add the runtime directive near the top of the file (AsyncLocalStorage needs Node):

```ts
export const runtime = "nodejs";
```

Change the handler at line 285. **The context is entered INSIDE `start()`, not around the handler** — the stream keeps producing frames after `GET()` returns, so wrapping the handler would leave the pump running outside the context, where `currentClient()` throws.

```ts
export async function GET() {
  // Resolve the client in the request scope — cookies() is not available inside
  // the stream callback.
  const client = await requireClient();
  if (!client) return unauthorized();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      await withClient(client, async () => {
        // ...the ENTIRE existing body of start() goes here, unchanged...
      });
    },
  });
```

Keep the existing `try / catch / finally { controller.close() }` intact inside the `withClient` callback.

- [ ] **Step 4: Use the client's location id in the data frame**

`app/api/dashboard/route.ts:549`:

```ts
          locationId: client.locationId,
```

- [ ] **Step 5: Wire `app/api/dashboard-messages/route.ts` (streaming)**

Same shape as Step 3 — imports, `export const runtime = "nodejs"`, then:

```ts
export async function GET() {
  const client = await requireClient();
  if (!client) return unauthorized();

  const stream = new ReadableStream({
    async start(controller) {
      await withClient(client, async () => {
        // ...existing body of start(), unchanged...
      });
    },
  });
```

- [ ] **Step 6: Wire `app/api/conversations/route.ts`**

Add imports and `export const runtime = "nodejs";`. Replace the `GET` handler (lines 33-60) with:

```ts
export async function GET(request: Request) {
  const client = await requireClient();
  if (!client) return unauthorized();

  const { searchParams } = new URL(request.url);

  const contactIds = (searchParams.get("contactIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const rawLimit = parseInt(searchParams.get("messageLimit") ?? "100", 10);
  const messageLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;

  const locationId = client.locationId;

  if (contactIds.length === 0) {
    return Response.json({ threads: [], locationId });
  }

  return withClient(client, async () => {
    const threads: Array<{ contactId: string; messages: Message[]; hasMore: boolean }> = [];

    for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
      const batch = contactIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map((id) => fetchThread(id, messageLimit)));
      threads.push(...results);
    }

    return Response.json({ threads, locationId });
  });
}
```

- [ ] **Step 7: Wire the three remaining routes**

For `app/api/contact-notes/route.ts`, `app/api/contact-tasks/route.ts` (both `GET(request: Request)`, both already have `runtime = "nodejs"`) and `app/api/analyze-contact/route.ts` (`POST(req: Request)`; add `export const runtime = "nodejs";`):

Add to each file's imports:

```ts
import { requireClient, unauthorized } from "@/lib/session";
import { withClient } from "@/lib/ghl-context";
```

Then in each handler, insert at the very top:

```ts
  const client = await requireClient();
  if (!client) return unauthorized();
```

and wrap the remainder of the handler body in `return withClient(client, async () => { ... })`, preserving the existing logic verbatim.

- [ ] **Step 8: Confirm no GHL call site was missed**

```bash
grep -rn "process.env.GHL_" app lib --include=*.ts
```

Expected: **no output.** The app no longer reads those env vars anywhere.

```bash
grep -rln "@/lib/ghl-client" app/api
```

Expected: exactly the six routes — `dashboard`, `dashboard-messages`, `conversations`, `contact-notes`, `contact-tasks`, `analyze-contact`. Every one must now also import `withClient`. (`chat` and `analyze-report` must NOT appear — they never touch GHL.)

- [ ] **Step 9: Typecheck and build**

```bash
npx tsc --noEmit && npm run build
```

Expected: both clean.

- [ ] **Step 10: Commit**

```bash
git add lib/ghl-context.ts lib/ghl-client.ts app/api
git commit -m "feat(ghl): per-request client credentials via AsyncLocalStorage"
```

---

### Task 5: Per-client rate limiter (`lib/ghl-limiter.ts`)

Today the semaphore, token bucket and `cooldownUntil` are process-wide module state, but GHL's budget is **per location**. Shared across tenants, one client's 429 sets a cooldown that freezes every other client's sync. Extracting the limiter also trims a 900-line file that has grown unwieldy.

**Files:**
- Create: `lib/ghl-limiter.ts`
- Modify: `lib/ghl-client.ts` (delete lines 15-111; update the call sites in `ghlFetch`)
- Create: `scripts/verify-limiter.ts`
- Modify: `package.json` (add `verify:limiter`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `acquireSlot(locationId: string): Promise<void>`
  - `releaseSlot(locationId: string): void`
  - `acquireRateToken(locationId: string): Promise<void>`
  - `noteRateLimitHeaders(locationId: string, response: Response): void`
  - `note429(locationId: string, cooldownMs: number): void`
  - `RATE_LIMIT_INTERVAL_MS: number`
  - `__resetLimiters(): void` (verification hook only)
  - `__peek(locationId: string): { active: number; cooldownUntil: number }` (verification hook only)

- [ ] **Step 1: Add the verify script to `package.json`**

```json
    "verify:auth": "tsx scripts/verify-auth.ts",
    "verify:limiter": "tsx scripts/verify-limiter.ts"
```

- [ ] **Step 2: Write the failing verification script**

Create `scripts/verify-limiter.ts`:

```ts
// Verification for lib/ghl-limiter.ts. Run: npm run verify:limiter
import assert from "node:assert/strict";
import {
  acquireSlot,
  releaseSlot,
  note429,
  __resetLimiters,
  __peek,
} from "../lib/ghl-limiter";

__resetLimiters();

const A = "loc-yconia";
const B = "loc-condesa";

// --- limiters are independent per location
await acquireSlot(A);
await acquireSlot(A);
assert.equal(__peek(A).active, 2, "A has 2 in flight");
assert.equal(__peek(B).active, 0, "B is untouched by A's traffic");
releaseSlot(A);
releaseSlot(A);
assert.equal(__peek(A).active, 0);

// --- THE ISOLATION GUARANTEE: a 429 for one client must NOT freeze the others.
// This is the bug the old process-wide cooldownUntil would have caused.
note429(A, 10_000);
assert.ok(__peek(A).cooldownUntil > Date.now(), "A is cooling down");
assert.equal(__peek(B).cooldownUntil, 0, "B must NOT be cooling down");

// --- A's concurrency cap must not starve B: saturate A, then B still admits.
__resetLimiters();
for (let i = 0; i < 8; i++) await acquireSlot(A); // 8 = MAX_CONCURRENT
assert.equal(__peek(A).active, 8, "A is at its cap");

let bAdmitted = false;
await Promise.race([
  acquireSlot(B).then(() => {
    bAdmitted = true;
  }),
  new Promise((r) => setTimeout(r, 250)),
]);
assert.ok(bAdmitted, "B must be admitted immediately even while A is saturated");

// --- a 9th request for A queues rather than over-admitting
let aOverAdmitted = false;
void acquireSlot(A).then(() => {
  aOverAdmitted = true;
});
await new Promise((r) => setTimeout(r, 100));
assert.equal(aOverAdmitted, false, "A's 9th request must queue");
assert.equal(__peek(A).active, 8, "A must never exceed its cap");

// --- releasing hands the slot to the waiter
releaseSlot(A);
await new Promise((r) => setTimeout(r, 50));
assert.ok(aOverAdmitted, "the queued request must be admitted on release");
assert.equal(__peek(A).active, 8, "active count stays pinned at the cap on handoff");

console.log("✅ lib/ghl-limiter.ts — all assertions passed");
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npm run verify:limiter
```

Expected: FAIL — `Cannot find module '../lib/ghl-limiter'`.

- [ ] **Step 4: Create `lib/ghl-limiter.ts`**

This is the code currently at `lib/ghl-client.ts:15-111`, with every piece of module-level state moved into a per-location `LimiterState`. The tuning constants and the comments explaining them are preserved verbatim.

```ts
// lib/ghl-limiter.ts
// Per-LOCATION concurrency + request-rate limiting for GHL.
//
// GHL's budget is per location (~100 requests / 10s — confirmed via the
// x-ratelimit-max / x-ratelimit-interval-milliseconds headers it returns on every
// call), so this state MUST be keyed by location. It used to be process-wide
// module state, which in a multi-client deployment was wrong in both directions:
// it needlessly serialized clients that have independent budgets, and — worse —
// one client's 429 set a global cooldown that froze every other client's sync.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Tunable. GHL's burst limit is ~100 requests / 10s, so 8 concurrent leaves
// comfortable headroom.
const MAX_CONCURRENT_GHL_REQUESTS = 8;

// The concurrency cap bounds in-flight requests but NOT the request *rate*, and
// those are different things. GHL answers in ~60ms, so 8 concurrent requests fire
// at >100/s — ~10x over budget — which is what produced 429 storms when fanning
// out over ~700 contacts. This token bucket paces the rate. We target 80/10s to
// leave headroom for the burst allowance and any other consumer of the same token
// (e.g. the GHL MCP). A small bucket capacity smooths emission: worst-case
// requests in any 10s window = capacity + rate*10s = 8 + 80 = 88, under 100.
const RATE_LIMIT_MAX = 80;
export const RATE_LIMIT_INTERVAL_MS = 10_000;
const RATE_REFILL_PER_MS = RATE_LIMIT_MAX / RATE_LIMIT_INTERVAL_MS;
const RATE_BUCKET_CAPACITY = MAX_CONCURRENT_GHL_REQUESTS;

interface LimiterState {
  active: number;
  queue: Array<() => void>;
  tokens: number;
  lastRefill: number;
  // Hard floor for THIS location: when GHL pushes back with 429 (or reports a
  // near-empty budget) nothing for this client starts until this timestamp.
  // Other clients are unaffected.
  cooldownUntil: number;
}

const limiters = new Map<string, LimiterState>();

function getState(locationId: string): LimiterState {
  let state = limiters.get(locationId);
  if (!state) {
    state = {
      active: 0,
      queue: [],
      tokens: RATE_BUCKET_CAPACITY,
      lastRefill: Date.now(),
      cooldownUntil: 0,
    };
    limiters.set(locationId, state);
  }
  return state;
}

export function acquireSlot(locationId: string): Promise<void> {
  const s = getState(locationId);
  if (s.active < MAX_CONCURRENT_GHL_REQUESTS) {
    s.active++;
    return Promise.resolve();
  }
  // At capacity — wait until a slot is handed off directly (active count stays
  // pinned at the max while the slot transfers, so we never over-admit).
  return new Promise<void>((resolve) => s.queue.push(resolve));
}

export function releaseSlot(locationId: string): void {
  const s = getState(locationId);
  const next = s.queue.shift();
  if (next) {
    next(); // hand the slot straight to the next waiter; active count unchanged
  } else {
    s.active--;
  }
}

function refillRateTokens(s: LimiterState): void {
  const now = Date.now();
  s.tokens = Math.min(RATE_BUCKET_CAPACITY, s.tokens + (now - s.lastRefill) * RATE_REFILL_PER_MS);
  s.lastRefill = now;
}

// Block until a request for this location may start: honor any active cooldown,
// then wait for a rate-limiter token. Called before EVERY HTTP attempt (including
// retries), so 429 backoff is paced too — not just the initial request.
export async function acquireRateToken(locationId: string): Promise<void> {
  const s = getState(locationId);
  for (;;) {
    const now = Date.now();
    if (now < s.cooldownUntil) {
      await sleep(s.cooldownUntil - now);
      continue;
    }
    refillRateTokens(s);
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return;
    }
    await sleep(Math.ceil((1 - s.tokens) / RATE_REFILL_PER_MS));
  }
}

// Read GHL's rate headers off a response. When the remaining budget for the
// current window is nearly spent, coast (set a short cooldown for THIS location
// until the window resets) so we glide under the limit instead of tripping a 429.
export function noteRateLimitHeaders(locationId: string, response: Response): void {
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  if (Number.isFinite(remaining) && remaining <= 2) {
    const interval =
      Number(response.headers.get("x-ratelimit-interval-milliseconds")) || RATE_LIMIT_INTERVAL_MS;
    const s = getState(locationId);
    s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + interval);
  }
}

// A 429 means we (or another consumer of this token) overran the window. Set a
// cooldown for this location so every pending request for THIS client backs off
// together — and no other client is affected.
export function note429(locationId: string, cooldownMs: number): void {
  const s = getState(locationId);
  s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + cooldownMs);
}

// --- verification hooks (scripts/verify-limiter.ts) ---
export function __resetLimiters(): void {
  limiters.clear();
}

export function __peek(locationId: string): { active: number; cooldownUntil: number } {
  const s = getState(locationId);
  return { active: s.active, cooldownUntil: s.cooldownUntil };
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
npm run verify:limiter
```

Expected: `✅ lib/ghl-limiter.ts — all assertions passed`

- [ ] **Step 6: Delete the old limiter from `lib/ghl-client.ts`**

Delete lines **15-111** — everything from the `// ---- Global concurrency limiter ----` banner through the end of `noteRateLimitHeaders`. That removes: `MAX_CONCURRENT_GHL_REQUESTS`, `activeGhlRequests`, `ghlWaitQueue`, `acquireSlot`, `releaseSlot`, all the `RATE_*` constants, `rateTokens`, `rateLastRefill`, `cooldownUntil`, `refillRateTokens`, `acquireRateToken`, `noteRateLimitHeaders`.

**Keep line 13** (`const sleep = ...`) — the retry backoff in `ghlFetch` still uses it.

Add the import at the top:

```ts
import {
  acquireSlot,
  releaseSlot,
  acquireRateToken,
  noteRateLimitHeaders,
  note429,
  RATE_LIMIT_INTERVAL_MS,
} from "./ghl-limiter";
```

- [ ] **Step 7: Key `ghlFetch`'s limiter calls by location**

`locationId` is already in scope from Task 4's `currentClient()` destructure. Update the four call sites:

```ts
  await acquireSlot(locationId);
```

```ts
      await acquireRateToken(locationId);
```

```ts
      noteRateLimitHeaders(locationId, response);
```

And in the 429 branch, replace the direct `cooldownUntil` assignment:

```ts
        if (response.status === 429) {
          const interval =
            Number(response.headers.get("x-ratelimit-interval-milliseconds")) ||
            RATE_LIMIT_INTERVAL_MS;
          const cool = retryAfter > 0 ? retryAfter * 1000 : interval;
          note429(locationId, cool + jitter());
          console.warn(
            `[GHL] 429 for ${locationId} — cooldown ~${cool}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          continue; // acquireRateToken() at the top of the loop waits out the cooldown
        }
```

Finally, find the `finally` block that calls `releaseSlot()` (it pairs with the `acquireSlot` at old line 186) and pass the location:

```ts
  } finally {
    releaseSlot(locationId);
  }
```

- [ ] **Step 8: Confirm no limiter state is left in `ghl-client.ts`**

```bash
grep -n "cooldownUntil\|rateTokens\|activeGhlRequests\|ghlWaitQueue" lib/ghl-client.ts
```

Expected: **no output.**

- [ ] **Step 9: Typecheck, build, re-verify**

```bash
npx tsc --noEmit && npm run build && npm run verify:limiter
```

Expected: all clean.

- [ ] **Step 10: Commit**

```bash
git add lib/ghl-limiter.ts lib/ghl-client.ts scripts/verify-limiter.ts package.json
git commit -m "fix(ghl): per-location rate limiter so one client's 429 can't freeze the rest"
```

---

### Task 6: `npm run add-client`

**Files:**
- Create: `scripts/add-client.ts`
- Modify: `package.json` (add `add-client` script)

**Interfaces:**
- Consumes: `parseClients`, `ClientConfig` (Task 1) — reuses the *same* validator the app uses, so the script can never accept a roster the app would reject.
- Produces: nothing importable.

- [ ] **Step 1: Add the script to `package.json`**

```json
    "verify:limiter": "tsx scripts/verify-limiter.ts",
    "add-client": "tsx scripts/add-client.ts"
```

- [ ] **Step 2: Write `scripts/add-client.ts`**

```ts
// scripts/add-client.ts — add a client to the DASHBOARD_CLIENTS roster.
// Run: npm run add-client
//
// Reuses the app's own parseClients() validator, so this can never emit a roster
// the app would reject at startup. It prints the blob; you paste it into Vercel.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseClients, type ClientConfig } from "../lib/clients";

const rl = createInterface({ input: stdin, output: stdout });

async function ask(question: string): Promise<string> {
  for (;;) {
    const answer = (await rl.question(question)).trim();
    if (answer) return answer;
    console.log("  ↳ required.");
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents: "Yconia Café" → "yconia-cafe"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Start from the current roster if one is present, otherwise from empty.
const existingRaw = process.env.DASHBOARD_CLIENTS;
let clients: ClientConfig[] = [];
if (existingRaw) {
  try {
    clients = parseClients(existingRaw);
    console.log(`\nCurrent roster (${clients.length}): ${clients.map((c) => c.id).join(", ")}\n`);
  } catch (err) {
    console.error(`\n⚠️  DASHBOARD_CLIENTS is currently INVALID: ${err instanceof Error ? err.message : err}`);
    console.error("Fix it before adding a client, or the whole roster stays broken.\n");
    process.exit(1);
  }
} else {
  console.log("\nNo DASHBOARD_CLIENTS in this environment — starting a new roster.\n");
}

const name = await ask("Client name (e.g. Plaza Bosques): ");
const suggestedId = slugify(name);
const idAnswer = (await rl.question(`Client id [${suggestedId}]: `)).trim();
const id = idAnswer || suggestedId;
const locationId = await ask("GHL location id: ");
const ghlToken = await ask("GHL Private Integration Token (pit-...): ");
const password = (
  await rl.question("Password [blank = use the location id]: ")
).trim();

rl.close();

const next: ClientConfig = {
  id,
  name,
  locationId,
  ghlToken,
  ...(password ? { password } : {}),
};

const blob = JSON.stringify([...clients, next]);

// Validate the RESULT, not just the input — this is what catches duplicate ids
// and password collisions with clients already in the roster.
try {
  parseClients(blob);
} catch (err) {
  console.error(`\n❌ Rejected: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}

console.log(`\n✅ Valid. Set DASHBOARD_CLIENTS to:\n`);
console.log(blob);
console.log(
  `\nPaste that into Vercel → Settings → Environment Variables → DASHBOARD_CLIENTS,` +
    `\nthen redeploy. ${next.name} logs in with: ${password || locationId}\n`,
);
```

- [ ] **Step 3: Verify it rejects a duplicate id**

```bash
DASHBOARD_CLIENTS='[{"id":"yconia","name":"Yconia","locationId":"loc-a","ghlToken":"pit-a"}]' npm run add-client
```

Answer: name `Yconia`, id `yconia` (accept the suggestion), location id `loc-b`, token `pit-b`, blank password.
Expected: `❌ Rejected: DASHBOARD_CLIENTS has a duplicate id "yconia"` and exit code 1.

- [ ] **Step 4: Verify it rejects a password collision**

```bash
DASHBOARD_CLIENTS='[{"id":"yconia","name":"Yconia","locationId":"loc-a","ghlToken":"pit-a"}]' npm run add-client
```

Answer: name `Condesa`, accept id `condesa`, location id `loc-a` (**the same location id as Yconia**), token `pit-b`, blank password.
Expected: `❌ Rejected: DASHBOARD_CLIENTS: client "condesa" shares a password with another client`.

- [ ] **Step 5: Verify the happy path**

```bash
DASHBOARD_CLIENTS='[{"id":"yconia","name":"Yconia","locationId":"loc-a","ghlToken":"pit-a"}]' npm run add-client
```

Answer: name `Plaza Bosques`, accept id `plaza-bosques`, location id `loc-b`, token `pit-b`, blank password.
Expected: `✅ Valid.` followed by a two-client JSON array, and the line `Plaza Bosques logs in with: loc-b`.

- [ ] **Step 6: Commit**

```bash
git add scripts/add-client.ts package.json
git commit -m "feat(scripts): npm run add-client to safely extend the roster"
```

---

### Task 7: Logout button + documentation

The client name already renders in the header (`app/page.tsx:118-125`) from the `locationName` stream frame, so it shows the right client with no change. Only a logout control is missing — without it there's no way to switch clients short of clearing cookies.

**Files:**
- Modify: `app/page.tsx` (imports; header actions after the theme toggle at ~line 192-206)
- Modify: `.env.example`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `POST /api/auth/logout` (already exists, unchanged).
- Produces: nothing importable.

- [ ] **Step 1: Import the logout icon in `app/page.tsx`**

Add `LogOut` to the existing `lucide-react` import (the one that already brings in `RefreshCw`, `AlertCircle`, `Users`, `Target`, `ClipboardList`, `Loader2`).

- [ ] **Step 2: Add the logout button**

In `app/page.tsx`, immediately **after** the theme-toggle `<Button>` (the one with `aria-label="Cambiar tema"`, which closes around line 206), add:

```tsx
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" })
                window.location.href = "/login"
              }}
              aria-label="Cerrar sesión"
            >
              <LogOut className="h-4 w-4" />
            </Button>
```

A full page load (rather than a router push) is deliberate: it drops all client-side dashboard state, so the next client's data can't be seen behind the previous client's cached React tree.

- [ ] **Step 3: Verify it in the browser**

```bash
npm run dev
```

Log in, click the logout icon in the header. Expected: redirected to `/login`; pressing Back does not restore the dashboard (middleware bounces you, because the cookie is gone).

- [ ] **Step 4: Update `.env.example`**

Replace the whole file:

```bash
# GoHighLevel — used ONLY by the dev MCP server (.mcp.json), not by the app.
# The app reads its GHL credentials per-client from DASHBOARD_CLIENTS below.
GHL_API_TOKEN=
GHL_LOCATION_ID=

# Dashboard auth (server-side only, never exposed to the browser).
#
# DASHBOARD_CLIENTS: JSON array — one entry per client. Each client logs in with
#   their own password, which resolves to their own GHL token + location.
#   `password` is OPTIONAL: omit it and the client's locationId doubles as the
#   password. Add it to give one client a real, rotatable password.
#   Use `npm run add-client` to extend this safely.
#
#   [{"id":"yconia","name":"Yconia","locationId":"abc123","ghlToken":"pit-..."}]
#
# DASHBOARD_AUTH_SECRET: random string to sign the session cookie (openssl rand -hex 32).
DASHBOARD_CLIENTS=
DASHBOARD_AUTH_SECRET=
```

- [ ] **Step 5: Update `CLAUDE.md`**

Replace the `## Environment Variables` section with:

```markdown
## Environment Variables

Required vars in `.env.local`:
- `DASHBOARD_CLIENTS` — JSON array of clients, one per GHL sub-account:
  `[{"id","name","locationId","ghlToken","password"?}]`. `password` is optional and
  defaults to the client's `locationId`. Use `npm run add-client` to extend it safely.
- `DASHBOARD_AUTH_SECRET` — random string used to HMAC-sign the session cookie
  (`openssl rand -hex 32`)
- `GHL_API_TOKEN` / `GHL_LOCATION_ID` — **not read by the app.** Kept only so the
  dev GHL MCP server (`.mcp.json`) can point at one sub-account.

All are server-side only. `DASHBOARD_CLIENTS` is read in `lib/clients.ts`;
`DASHBOARD_AUTH_SECRET` in `lib/auth.ts`, `app/api/auth/login/route.ts`, and
`middleware.ts`. None ever reach the browser.
```

Then, in the **Architecture** section, add this subsection immediately after `### Data flow`:

```markdown
### Multi-client (multi-tenancy)

One deployment serves every client. **The password IS the client's identity.**

1. `lib/clients.ts` — the roster, parsed from `DASHBOARD_CLIENTS`. The **seam**:
   nothing downstream knows the roster comes from an env var, so swapping in a
   database later touches only this file.
2. Login (`app/api/auth/login/route.ts`) looks the submitted password up across the
   roster (`findClientByPassword`, constant-time, no early return) and HMAC-signs
   the matched client's id into the `dash_session` cookie:
   `<clientId>.<expiryMs>.<hmac>`. The id is inside the signed payload, so a client
   cannot edit their cookie to reach another client's data.
3. Every GHL-touching route calls `requireClient()` (`lib/session.ts`), which
   re-verifies the cookie **itself** — it deliberately does not trust a
   middleware-injected header, which would be a spoofing surface.
4. The route runs its GHL work inside `withClient(client, ...)`
   (`lib/ghl-context.ts`, an `AsyncLocalStorage`). `ghlFetch` reads credentials via
   `currentClient()`, so none of its ~113 exported functions needed a signature
   change. `currentClient()` **fails closed** — it throws rather than falling back
   to a default token.
5. `lib/ghl-limiter.ts` keys the concurrency semaphore, token bucket, and 429
   cooldown **by location id**, because GHL's budget is per location. Shared, one
   client's 429 would freeze every other client's sync.

**NEVER** replace the AsyncLocalStorage context with a module-level "current
client" variable: one serverless instance serves overlapping requests, so that
would silently serve client A's dashboard using client B's token.

The two streaming routes (`dashboard`, `dashboard-messages`) enter the context
**inside** the `ReadableStream` `start()` callback — the stream outlives the
handler's return, so wrapping the handler would leave the pump running outside the
context.

`app/api/chat` and `app/api/analyze-report` never touch GHL (they work off data the
browser already holds), so they need no client context — only the middleware gate.
```

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx .env.example CLAUDE.md
git commit -m "feat(ui): logout button; docs: multi-client env + architecture"
```

---

### Task 8: End-to-end verification against real GHL data

Everything up to here is verified in isolation. This task proves the *whole* thing — the parts that only break when two real clients are live at once.

**Files:** none (verification only).

- [ ] **Step 1: Build a two-client roster in `.env.local`**

Use two real sub-accounts. Get their location ids and Private Integration Tokens from GHL (or `mcp__ghl-mcp__locations_get-location`).

```bash
DASHBOARD_CLIENTS='[{"id":"yconia","name":"Yconia","locationId":"<REAL_LOC_A>","ghlToken":"<REAL_TOKEN_A>"},{"id":"condesa","name":"Condesa","locationId":"<REAL_LOC_B>","ghlToken":"<REAL_TOKEN_B>"}]'
DASHBOARD_AUTH_SECRET=<existing value, or: openssl rand -hex 32>
```

Keep `GHL_API_TOKEN` / `GHL_LOCATION_ID` in the file — the MCP server still uses them.

- [ ] **Step 2: Client A loads its own data**

```bash
npm run dev
```

Log in with client A's location id as the password. Expected: loading screen names **Yconia**; the header shows **Yconia**; contact/opportunity counts match that sub-account.

- [ ] **Step 3: Client B loads its own data — no bleed**

Click logout. Log in with client B's location id. Expected: header shows **Condesa**, with Condesa's counts. **No Yconia data anywhere**, including after a hard refresh.

- [ ] **Step 4: Cookie tampering is rejected (the isolation guarantee)**

While logged in as Condesa, open DevTools → Application → Cookies, and edit `dash_session`, changing only the first segment from `condesa` to `yconia`. Reload.

Expected: redirected to `/login` — the HMAC covers the client id, so the edit invalidates the signature. **If this shows Yconia's data, STOP: the isolation is broken.** Re-check `verifyToken` (Task 2).

- [ ] **Step 5: Wrong password reveals nothing**

At `/login`, submit a password matching no client. Expected: the same generic "invalid password" error as any wrong password — nothing that distinguishes "no such client" from "wrong password for a real client."

- [ ] **Step 6: Concurrent syncs don't interfere**

Open two browsers (or a normal + private window). Log into Yconia in one, Condesa in the other. Hit **Actualizar** in both at the same time.

Expected: both complete with their own correct data. Neither stalls waiting on the other, and a 429 in one browser's server log does not stall the other's sync. (This is what the per-location limiter buys — the old shared `cooldownUntil` would have frozen both.)

- [ ] **Step 7: A removed client's session dies immediately**

With Condesa logged in and loaded, remove Condesa from `DASHBOARD_CLIENTS` in `.env.local` and restart the dev server. Reload the browser.

Expected: bounced to `/login` — the cookie still verifies, but the id no longer resolves, so `requireClient()` returns null.

- [ ] **Step 8: A malformed roster fails closed**

Set `DASHBOARD_CLIENTS='[{"id":"broken"'` (truncated JSON) and restart.

Expected: `/login` returns `server_misconfigured` (500) with a clear server-side log naming the JSON error. It must **not** silently let anyone in, and must not fall back to `GHL_API_TOKEN`.

- [ ] **Step 9: Restore a good roster and confirm green**

```bash
npm run verify:clients && npm run verify:auth && npm run verify:limiter && npx tsc --noEmit && npm run build
```

Expected: all pass.

- [ ] **Step 10: Commit any fixes discovered**

```bash
git add -A
git commit -m "fix(multi-client): address issues found in end-to-end verification"
```

(If nothing needed fixing, skip the commit.)
