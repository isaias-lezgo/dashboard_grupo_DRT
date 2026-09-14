# Meta Ads ① — conexión, dataset en el sync y cruce — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un botón "Conectar con Meta" que guarda el token de la empresa del cliente en Neon, un paso `meta` del sync que trae jerarquía + gasto diario por ad de la Marketing API al `DashboardPayload`, y un módulo puro que cruza ese gasto con las oportunidades por ad id.

**Architecture:** OAuth de Facebook Login for Business (usuario del sistema) en `app/api/meta/*`, token cifrado en la tabla `meta_connection`. `lib/sync.ts` gana un paso `meta` que corre después de `opportunities` (necesita la ventana de historia) y deja `metaAds` en el payload, que cae en el caché de Neon como todo lo demás. `lib/meta-attribution.ts` (puro, sin React) resuelve `adId → ad → adset → campaña`, infiere el desarrollo de cada ad y calcula costo por etapa por cohorte de creación. Sin UI de charts en esta entrega: solo la píldora del header.

**Tech Stack:** Next.js 16 App Router (Node runtime), Web Crypto (`crypto.subtle`, HMAC + AES-GCM + HKDF), `@neondatabase/serverless`, Graph API v23.0 vía `fetch`, `tsx` + `node:assert/strict` para los verify scripts, shadcn `popover`/`dialog`/`checkbox`.

**Spec:** `docs/superpowers/specs/2026-09-13-meta-ads-conexion-y-sync-design.md`

## Global Constraints

- Package manager **pnpm**; nunca `npm install`. No se agregan dependencias en este plan.
- `npx tsc --noEmit` es la compuerta real (`next build` ignora errores de TS). Debe quedar en cero errores al final de **cada** tarea.
- Los verify scripts son CJS: `async function main()` + `main().catch(...)`, **nunca** top-level `await`.
- Todas las funciones del store reciben `ClientConfig`, nunca un string (`lib/sync-store.ts` es el modelo).
- `lib/meta-client.ts` es server-only: jamás importado desde un componente con `"use client"`. Lo puro va en `lib/meta-normalize.ts` / `lib/meta-attribution.ts`, importables desde el browser.
- La base **no es una dependencia**: sin `DATABASE_URL`, sin fila, o con Postgres caído, el sync de GHL corre igual y `metaAds` es `null`.
- El token nunca viaja en un frame NDJSON, en un `console.log`, ni en la respuesta de `/api/meta/connection`.
- Toda cubeta centinela ("Sin ad id", "Sin desarrollo") es un string exportado, no un literal repetido.
- Meta = solo lectura (`ads_read`). Ninguna llamada `POST` a Graph salvo el canje del `code`.
- Rutas nuevas con `export const runtime = "nodejs"` y `requireClient()`; ninguna pasa por `withClient()` (no tocan GHL).
- Copy de la UI en español, sin "GoHighLevel"/"GHL" (regla `sanitizeBrand`).
- Commits en español con prefijo convencional (`feat(meta): …`, `docs(meta): …`), terminados con las líneas de atribución del sistema.

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `lib/meta-oauth.ts` (crear) | Puro. `signState`/`verifyState` (HMAC), `encryptToken`/`decryptToken` (AES-GCM), `buildDialogUrl`, `redirectUriFor`. |
| `scripts/verify-meta-oauth.ts` (crear) | Aserciones de lo anterior. |
| `lib/meta-connection-store.ts` (crear) | Fila `meta_connection` por `(client_id, product)`: read/write/updateSelected/delete. |
| `scripts/db-migrate.ts` (modificar) | `CREATE TABLE IF NOT EXISTS meta_connection`. |
| `scripts/verify-meta-connection-store.ts` (crear) | Roundtrip + aislamiento por cliente contra la base real si hay `DATABASE_URL`. |
| `lib/types.ts` (modificar) | `MetaAdsData`, `MetaDailyRow`, `MetaAccount`, `metaAds` en `DashboardPayload`, `reason` en `SyncWarning`. |
| `lib/meta-normalize.ts` (crear) | Puro. Extracción de `actions`, chunking por mes, normalización de la jerarquía, `historyWindow`. |
| `lib/meta-client.ts` (crear) | Server-only. `graphFetch` con reintentos, `listAdAccounts`, `debugToken`, `exchangeCode`, `listAds`, `adInsightsDaily`, `fetchMetaAds`. |
| `scripts/verify-meta.ts` (crear) | Aserciones de `meta-normalize`. |
| `lib/sync.ts` (modificar) | Paso `meta` después de `opportunities`. |
| `hooks/use-dashboard-data.ts` (modificar) | `StepKey` `"meta"`. |
| `components/dashboard/loading-screen.tsx` (modificar) | Fila "Meta Ads". |
| `components/dashboard/sync-warning-banner.tsx` (modificar) | Copy para `meta` con `reason`. |
| `app/api/dashboard/route.ts` (modificar) | `preserveMetaAds`: conservar el último `metaAds` bueno cuando el paso falla. |
| `app/api/meta/connect/route.ts`, `callback/route.ts`, `connection/route.ts`, `accounts/route.ts` (crear) | El flujo OAuth y el estado de la píldora. |
| `lib/meta-attribution.ts` (crear) | Puro. `oppAdId`, `buildMetaIndex`, `assignAdDesarrollos`, `scopeMetaDaily`, `buildCostPerStage`, `buildCampaignPerformance`. |
| `scripts/verify-meta-attribution.ts` (crear) | Aserciones del cruce. |
| `components/dashboard/meta-connection.tsx` (crear) | La píldora del header. |
| `app/page.tsx` (modificar) | Monta la píldora junto a "Actualizar". |
| `package.json` (modificar) | Scripts `verify:meta-oauth`, `verify:meta-connection-store`, `verify:meta`, `verify:meta-attribution`. |
| `.env.example`, `CLAUDE.md` (modificar) | Variables nuevas y la sección "Meta Ads". |

---

### Task 1: `lib/meta-oauth.ts` — state firmado, token cifrado, URL del diálogo

**Files:**
- Create: `lib/meta-oauth.ts`
- Create: `scripts/verify-meta-oauth.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `process.env.DASHBOARD_AUTH_SECRET` (ya existe), `safeEqual` de `lib/auth.ts`.
- Produces:
  ```ts
  export type MetaProduct = "ads" | "whatsapp"
  export interface MetaState { clientId: string; product: MetaProduct; returnTo: string; nonce: string; iat: number }
  export const STATE_MAX_AGE_MS: number            // 10 min
  export function signState(s: Omit<MetaState, "nonce" | "iat">, now?: number): Promise<string>
  export function verifyState(value: string | null | undefined, now?: number): Promise<MetaState | null>
  export function encryptToken(plain: string): Promise<Uint8Array>   // bytes para bytea
  export function decryptToken(blob: Uint8Array): Promise<string | null>
  export function buildDialogUrl(p: { appId: string; configId: string; redirectUri: string; state: string }): string
  export function redirectUriFor(requestUrl: string, publicOrigin?: string): string
  ```

- [ ] **Step 1: Escribir el verify script (falla porque el módulo no existe)**

```ts
// scripts/verify-meta-oauth.ts
// Verificación de lib/meta-oauth.ts. Correr: pnpm verify:meta-oauth
//
// El `state` del OAuth lleva el id del cliente; si se pudiera manipular, el
// callback guardaría el token de la empresa de A en la fila de B. Por eso este
// script ejercita el rechazo de un state manipulado igual que verify:auth
// ejercita la cookie.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";

process.env.DASHBOARD_AUTH_SECRET = "test-secret-do-not-use-in-prod";

import {
  signState,
  verifyState,
  encryptToken,
  decryptToken,
  buildDialogUrl,
  redirectUriFor,
  STATE_MAX_AGE_MS,
} from "../lib/meta-oauth";

async function main() {
  const now = 1_800_000_000_000;

  // --- state: ida y vuelta
  const state = await signState({ clientId: "drt", product: "ads", returnTo: "/" }, now);
  const back = await verifyState(state, now + 1000);
  assert.ok(back, "un state recién firmado verifica");
  assert.equal(back.clientId, "drt");
  assert.equal(back.product, "ads");
  assert.equal(back.returnTo, "/");
  assert.equal(back.iat, now);
  assert.equal(typeof back.nonce, "string");
  assert.ok(back.nonce.length >= 16, "el nonce tiene entropía");

  // --- dos firmas del mismo input difieren (nonce), y ambas verifican
  const state2 = await signState({ clientId: "drt", product: "ads", returnTo: "/" }, now);
  assert.notEqual(state, state2);
  assert.ok(await verifyState(state2, now));

  // --- LA GARANTÍA DE AISLAMIENTO: cambiar el clientId dentro del payload invalida la firma
  const [payloadB64, sig] = state.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  const forged = Buffer.from(JSON.stringify({ ...payload, clientId: "otro" }), "utf8").toString("base64url");
  assert.equal(await verifyState(`${forged}.${sig}`, now), null, "state con clientId ajeno se rechaza");

  // --- firma alterada
  assert.equal(await verifyState(`${payloadB64}.deadbeef`, now), null);
  // --- formatos rotos
  assert.equal(await verifyState(undefined, now), null);
  assert.equal(await verifyState("", now), null);
  assert.equal(await verifyState("sin.punto.extra.x", now), null);
  assert.equal(await verifyState("no-es-base64.sig", now), null);
  // --- expirado
  assert.equal(await verifyState(state, now + STATE_MAX_AGE_MS + 1), null, "state viejo se rechaza");
  assert.ok(await verifyState(state, now + STATE_MAX_AGE_MS - 1), "justo antes del límite sigue válido");
  // --- del futuro (reloj adelantado del emisor): se rechaza también
  assert.equal(await verifyState(state, now - 60_000), null);

  // --- token: ida y vuelta con bytes
  const blob = await encryptToken("EAAB-token-de-prueba-ñ");
  assert.ok(blob instanceof Uint8Array);
  assert.ok(blob.length > 12 + 16, "iv + tag + cuerpo");
  assert.equal(await decryptToken(blob), "EAAB-token-de-prueba-ñ");
  // --- dos cifrados del mismo texto difieren (iv aleatorio)
  const blob2 = await encryptToken("EAAB-token-de-prueba-ñ");
  assert.notDeepEqual(Buffer.from(blob), Buffer.from(blob2));
  // --- un bit alterado no descifra (GCM autentica)
  const tampered = new Uint8Array(blob);
  tampered[tampered.length - 1] ^= 0x01;
  assert.equal(await decryptToken(tampered), null);
  // --- blob corto
  assert.equal(await decryptToken(new Uint8Array(5)), null);
  // --- otra llave no descifra
  process.env.DASHBOARD_AUTH_SECRET = "otra-llave";
  assert.equal(await decryptToken(blob), null);
  process.env.DASHBOARD_AUTH_SECRET = "test-secret-do-not-use-in-prod";

  // --- URL del diálogo: config_id, sin scope
  const url = new URL(
    buildDialogUrl({
      appId: "123",
      configId: "456",
      redirectUri: "https://drt.lezgosuite.com/api/meta/callback",
      state: "abc.def",
    })
  );
  assert.equal(url.origin + url.pathname, "https://www.facebook.com/v23.0/dialog/oauth");
  assert.equal(url.searchParams.get("client_id"), "123");
  assert.equal(url.searchParams.get("config_id"), "456");
  assert.equal(url.searchParams.get("redirect_uri"), "https://drt.lezgosuite.com/api/meta/callback");
  assert.equal(url.searchParams.get("state"), "abc.def");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), null, "con Login for Business el scope lo define la configuración");

  // --- redirect_uri: el origen público manda; si no hay, el de la petición
  assert.equal(
    redirectUriFor("http://localhost:3000/api/meta/connect?x=1", "https://drt.lezgosuite.com"),
    "https://drt.lezgosuite.com/api/meta/callback"
  );
  assert.equal(
    redirectUriFor("http://localhost:3000/api/meta/connect", undefined),
    "http://localhost:3000/api/meta/callback"
  );
  assert.equal(
    redirectUriFor("https://drt-psi.vercel.app/api/meta/callback?code=1", ""),
    "https://drt-psi.vercel.app/api/meta/callback"
  );

  console.log("✅ verify:meta-oauth OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Agregar el script y correrlo para ver que falla**

En `package.json`, después de `"verify:sync-store"`:
```json
    "verify:meta-oauth": "tsx scripts/verify-meta-oauth.ts",
```
Run: `pnpm verify:meta-oauth`
Expected: FAIL con `Cannot find module '../lib/meta-oauth'`.

- [ ] **Step 3: Implementar `lib/meta-oauth.ts`**

```ts
// lib/meta-oauth.ts
// Lo puro del flujo OAuth con Meta: el `state` firmado que viaja al diálogo y
// regresa en el callback, el cifrado del token en reposo, y la URL del diálogo.
//
// Sin imports de Next ni de la base: se prueba con pnpm verify:meta-oauth y lo
// usan las rutas de app/api/meta/*. Web Crypto (crypto.subtle) igual que
// lib/auth.ts, así que corre en Node y en Edge sin cambios.
//
// El `state` lleva el id del cliente DENTRO del payload firmado, por la misma
// razón que la cookie de sesión: si se pudiera editar, el callback guardaría el
// token de la empresa de A en la fila de B.
import { safeEqual } from "./auth";

export type MetaProduct = "ads" | "whatsapp";

export interface MetaState {
  clientId: string;
  product: MetaProduct;
  /** Ruta relativa a la que regresar tras el callback (siempre empieza con "/"). */
  returnTo: string;
  nonce: string;
  iat: number;
}

/** Cuánto puede tardar el usuario en el diálogo de Meta antes de que el state caduque. */
export const STATE_MAX_AGE_MS = 10 * 60 * 1000;

export const GRAPH_VERSION = "v23.0";

function getSecret(): string {
  const secret = process.env.DASHBOARD_AUTH_SECRET;
  if (!secret) throw new Error("DASHBOARD_AUTH_SECRET is not set");
  return secret;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return new Uint8Array(Buffer.from(s, "base64url"));
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toBase64Url(new Uint8Array(sig));
}

// Formato: "<base64url(json)>.<hmac(base64url(json))>".
export async function signState(
  s: Omit<MetaState, "nonce" | "iat">,
  now: number = Date.now()
): Promise<string> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const full: MetaState = { ...s, nonce, iat: now };
  const payload = toBase64Url(enc.encode(JSON.stringify(full)));
  return `${payload}.${await hmac(payload)}`;
}

// null ante cualquier falla: formato, firma, edad, o un iat del futuro.
export async function verifyState(
  value: string | null | undefined,
  now: number = Date.now()
): Promise<MetaState | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const bytes = fromBase64Url(payload);
  if (!bytes || !sig) return null;
  if (!safeEqual(sig, await hmac(payload))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const s = parsed as Partial<MetaState>;
  if (typeof s.clientId !== "string" || !s.clientId) return null;
  if (s.product !== "ads" && s.product !== "whatsapp") return null;
  if (typeof s.returnTo !== "string" || !s.returnTo.startsWith("/")) return null;
  if (typeof s.nonce !== "string" || typeof s.iat !== "number") return null;
  if (s.iat > now) return null;
  if (now - s.iat > STATE_MAX_AGE_MS) return null;
  return s as MetaState;
}

// Llave AES-256 derivada del secreto de sesión con HKDF. Una llave distinta por
// uso ("meta-token") para que el secreto compartido no se reutilice crudo.
async function aesKey(): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(getSecret()), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("lezgo-paneles"), info: enc.encode("meta-token") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const IV_BYTES = 12;

// Salida: iv (12 bytes) ‖ ciphertext+tag. Se guarda tal cual en un bytea.
export async function encryptToken(plain: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(plain));
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return out;
}

// null si el blob está corto, alterado, o cifrado con otra llave. GCM autentica,
// así que no hay forma de obtener basura "plausible".
export async function decryptToken(blob: Uint8Array): Promise<string | null> {
  if (blob.length <= IV_BYTES + 16) return null;
  try {
    const iv = blob.slice(0, IV_BYTES);
    const ct = blob.slice(IV_BYTES);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(), ct);
    return dec.decode(pt);
  } catch {
    return null;
  }
}

// Con Facebook Login for Business NO se manda `scope`: los permisos los define
// la configuración (config_id) creada en el panel de la app.
export function buildDialogUrl(p: {
  appId: string;
  configId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", p.appId);
  url.searchParams.set("config_id", p.configId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("state", p.state);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

// El redirect_uri tiene que coincidir EXACTAMENTE con uno registrado en la app.
// META_PUBLIC_ORIGIN lo fija en producción (detrás de un alias de Vercel el Host
// puede ser cualquiera de los cuatro); sin él, el origen de la petición sirve
// para localhost. Nunca se deriva de Origin/Referer, que el cliente controla.
export function redirectUriFor(requestUrl: string, publicOrigin?: string): string {
  const origin = publicOrigin?.trim() || new URL(requestUrl).origin;
  return `${origin}/api/meta/callback`;
}
```

- [ ] **Step 4: Correr el verify**

Run: `pnpm verify:meta-oauth`
Expected: `✅ verify:meta-oauth OK`

- [ ] **Step 5: tsc y commit**

Run: `npx tsc --noEmit`
Expected: sin salida.

```bash
git add lib/meta-oauth.ts scripts/verify-meta-oauth.ts package.json
git commit -m "feat(meta): state firmado, cifrado del token y URL del diálogo OAuth"
```

---

### Task 2: tabla `meta_connection` + `lib/meta-connection-store.ts`

**Files:**
- Modify: `scripts/db-migrate.ts`
- Create: `lib/meta-connection-store.ts`
- Create: `scripts/verify-meta-connection-store.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `getSql`, `isDbConfigured` de `lib/db.ts`; `encryptToken`, `decryptToken`, `MetaProduct` de `lib/meta-oauth.ts`; `ClientConfig`.
- Produces:
  ```ts
  export interface MetaAccountInfo { id: string; name: string; currency: string; timezone: string; status: number }
  export interface MetaConnection {
    product: MetaProduct
    tokenKind: "system_user" | "user"
    tokenExpiresAt: string | null
    businessId: string | null
    connectedBy: string | null
    availableAccounts: MetaAccountInfo[]
    selectedAccounts: string[]
    connectedAt: string
    updatedAt: string
  }
  /** `token: null` = hay fila pero el blob no descifra (secreto rotado): hay que reconectar. */
  export interface MetaConnectionWithToken extends MetaConnection { token: string | null }
  export function readMetaConnection(client, product): Promise<MetaConnection | null>
  export function readMetaConnectionWithToken(client, product): Promise<MetaConnectionWithToken | null>
  export function writeMetaConnection(client, product, input: { token; tokenKind; tokenExpiresAt; businessId; connectedBy; availableAccounts; selectedAccounts }): Promise<void>
  export function updateSelectedAccounts(client, product, ids: string[]): Promise<boolean>  // false si algún id no está en available
  export function deleteMetaConnection(client, product): Promise<void>
  ```

- [ ] **Step 1: Agregar la tabla a la migración**

En `scripts/db-migrate.ts`, después del `CREATE TABLE IF NOT EXISTS project_sync (...)`:

```ts
  // La conexión con Meta por cliente y producto ("ads" hoy, "whatsapp" después).
  // A diferencia de project_sync, esta fila NO es desechable: si se borra hay que
  // volver a apretar "Conectar con Meta".
  await sql`
    CREATE TABLE IF NOT EXISTS meta_connection (
      client_id           text        NOT NULL,
      product             text        NOT NULL,
      token_encrypted     bytea       NOT NULL,
      token_kind          text        NOT NULL,
      token_expires_at    timestamptz,
      business_id         text,
      connected_by        text,
      available_accounts  jsonb       NOT NULL,
      selected_accounts   jsonb       NOT NULL,
      connected_at        timestamptz NOT NULL,
      updated_at          timestamptz NOT NULL,
      PRIMARY KEY (client_id, product)
    )
  `;
```

Y en el reporte final, tras el `for` de `project_sync`:

```ts
  const metaRows = await sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'meta_connection'
     ORDER BY ordinal_position
  `;
  console.log("✅ meta_connection lista:");
  for (const r of metaRows) console.log(`   ${r.column_name} ${r.data_type}`);
```

- [ ] **Step 2: Escribir el verify script**

```ts
// scripts/verify-meta-connection-store.ts
// Verificación de lib/meta-connection-store.ts. Correr: pnpm verify:meta-connection-store
//
// La fila está indexada por (cliente, producto). Leer la fila de otro cliente
// conectaría el panel de A con la pauta de B, así que el aislamiento se prueba
// contra la base real cuando hay DATABASE_URL (el script la inyecta desde
// .env.local); sin ella solo corre la parte pura y lo dice.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";

if (!process.env.DASHBOARD_AUTH_SECRET) {
  process.env.DASHBOARD_AUTH_SECRET = "test-secret-do-not-use-in-prod";
}

import { isDbConfigured, getSql } from "../lib/db";
import {
  readMetaConnection,
  readMetaConnectionWithToken,
  writeMetaConnection,
  updateSelectedAccounts,
  deleteMetaConnection,
} from "../lib/meta-connection-store";
import type { ClientConfig } from "../lib/clients";

const A: ClientConfig = { id: "__verify_meta_a", name: "A", locationId: "loc-a", ghlToken: "pit-a" };
const B: ClientConfig = { id: "__verify_meta_b", name: "B", locationId: "loc-b", ghlToken: "pit-b" };

const accounts = [
  { id: "act_1", name: "Cañadas", currency: "MXN", timezone: "America/Mexico_City", status: 1 },
  { id: "act_2", name: "Atria", currency: "MXN", timezone: "America/Mexico_City", status: 1 },
];

async function main() {
  if (!isDbConfigured()) {
    console.log("⚠️  Sin DATABASE_URL: se omite el roundtrip contra Postgres.");
    // Sin base, las lecturas devuelven null y las escrituras no truenan.
    assert.equal(await readMetaConnection(A, "ads"), null);
    assert.equal(await updateSelectedAccounts(A, "ads", ["act_1"]), false);
    await deleteMetaConnection(A, "ads");
    console.log("✅ verify:meta-connection-store OK (solo parte pura)");
    return;
  }

  const sql = getSql();
  await sql`DELETE FROM meta_connection WHERE client_id IN (${A.id}, ${B.id})`;

  // --- vacío
  assert.equal(await readMetaConnection(A, "ads"), null);

  // --- escribir y leer sin token
  await writeMetaConnection(A, "ads", {
    token: "EAAB-secreto-a",
    tokenKind: "system_user",
    tokenExpiresAt: null,
    businessId: "biz-a",
    connectedBy: "Admin A",
    availableAccounts: accounts,
    selectedAccounts: ["act_1", "act_2"],
  });
  const a = await readMetaConnection(A, "ads");
  assert.ok(a);
  assert.equal(a.tokenKind, "system_user");
  assert.equal(a.tokenExpiresAt, null);
  assert.equal(a.businessId, "biz-a");
  assert.equal(a.connectedBy, "Admin A");
  assert.deepEqual(a.availableAccounts, accounts);
  assert.deepEqual(a.selectedAccounts, ["act_1", "act_2"]);
  assert.equal("token" in a, false, "la lectura normal NO trae el token");

  // --- el token se cifra en reposo
  const raw = await sql`SELECT token_encrypted FROM meta_connection WHERE client_id = ${A.id}`;
  const stored = Buffer.from(raw[0].token_encrypted);
  assert.ok(!stored.toString("utf8").includes("EAAB-secreto-a"), "el token no se guarda en claro");

  // --- y se descifra al pedirlo explícitamente
  const withToken = await readMetaConnectionWithToken(A, "ads");
  assert.equal(withToken?.token, "EAAB-secreto-a");

  // --- secreto rotado: la fila sigue, el token no descifra → token: null, NO null entero.
  // El sync lo reporta como "token_unreadable"; la píldora sigue diciendo
  // "conectado" porque la fila existe, y el banner es el que pide reconectar.
  const secret = process.env.DASHBOARD_AUTH_SECRET;
  process.env.DASHBOARD_AUTH_SECRET = "otro-secreto";
  const rotated = await readMetaConnectionWithToken(A, "ads");
  assert.ok(rotated, "la fila se sigue leyendo");
  assert.equal(rotated.token, null, "el token no descifra con otro secreto");
  process.env.DASHBOARD_AUTH_SECRET = secret;

  // --- AISLAMIENTO: B no ve la fila de A; otro producto tampoco
  assert.equal(await readMetaConnection(B, "ads"), null);
  assert.equal(await readMetaConnection(A, "whatsapp"), null);

  // --- selección: solo ids disponibles
  assert.equal(await updateSelectedAccounts(A, "ads", ["act_2"]), true);
  assert.deepEqual((await readMetaConnection(A, "ads"))?.selectedAccounts, ["act_2"]);
  assert.equal(await updateSelectedAccounts(A, "ads", ["act_2", "act_999"]), false);
  assert.deepEqual((await readMetaConnection(A, "ads"))?.selectedAccounts, ["act_2"], "un id inválido no cambia nada");
  assert.equal(await updateSelectedAccounts(A, "ads", []), false, "la selección vacía se rechaza");

  // --- reconectar sobrescribe (misma llave)
  await writeMetaConnection(A, "ads", {
    token: "EAAB-secreto-a2",
    tokenKind: "user",
    tokenExpiresAt: "2026-11-12T00:00:00.000Z",
    businessId: null,
    connectedBy: null,
    availableAccounts: [accounts[0]],
    selectedAccounts: ["act_1"],
  });
  const a2 = await readMetaConnectionWithToken(A, "ads");
  assert.equal(a2?.token, "EAAB-secreto-a2");
  assert.equal(a2?.tokenKind, "user");
  assert.equal(a2?.tokenExpiresAt, "2026-11-12T00:00:00.000Z");
  assert.equal(a2?.connectedAt, a.connectedAt, "connected_at se conserva al reconectar");

  // --- borrar
  await deleteMetaConnection(A, "ads");
  assert.equal(await readMetaConnection(A, "ads"), null);

  await sql`DELETE FROM meta_connection WHERE client_id IN (${A.id}, ${B.id})`;
  console.log("✅ verify:meta-connection-store OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

En `package.json`:
```json
    "verify:meta-connection-store": "tsx --env-file-if-exists=.env.local scripts/verify-meta-connection-store.ts",
```

Run: `pnpm verify:meta-connection-store`
Expected: FAIL con `Cannot find module '../lib/meta-connection-store'`.

- [ ] **Step 3: Implementar el store**

```ts
// lib/meta-connection-store.ts
// La conexión con Meta de cada cliente: una fila por (client_id, product) con el
// token cifrado, la empresa que conectó y qué cuentas publicitarias eligió.
//
// A diferencia de project_sync, esta fila NO es desechable: si se borra hay que
// volver a apretar "Conectar con Meta". Es el único estado del sistema que no se
// rellena solo, y por eso el DELETE pide confirmación en la UI.
//
// Todas las funciones reciben el ClientConfig, nunca un string suelto — leer la
// fila equivocada conectaría el panel de A con la pauta de B, la misma clase de
// fuga que lib/ghl-context.ts existe para evitar.
//
// Sin DATABASE_URL: lecturas devuelven null, escrituras no hacen nada y lo
// registran. La base sigue sin ser una dependencia del panel.
import { getSql, isDbConfigured } from "./db";
import { encryptToken, decryptToken, type MetaProduct } from "./meta-oauth";
import type { ClientConfig } from "./clients";

export interface MetaAccountInfo {
  /** Con prefijo, tal como lo da Graph: "act_123". */
  id: string;
  name: string;
  currency: string;
  timezone: string;
  /** account_status de Graph: 1 activa, 2 deshabilitada, 3 sin pagar, … */
  status: number;
}

export interface MetaConnection {
  product: MetaProduct;
  tokenKind: "system_user" | "user";
  /** ISO, o null para un token de usuario del sistema (no caduca). */
  tokenExpiresAt: string | null;
  businessId: string | null;
  connectedBy: string | null;
  availableAccounts: MetaAccountInfo[];
  selectedAccounts: string[];
  connectedAt: string;
  updatedAt: string;
}

export interface MetaConnectionWithToken extends MetaConnection {
  /**
   * null cuando la fila existe pero el blob no descifra (DASHBOARD_AUTH_SECRET
   * rotado). Se distingue de "no hay fila" a propósito: el sync lo reporta como
   * error `token_unreadable` en vez de callar como si nadie hubiera conectado.
   */
  token: string | null;
}

interface Row {
  product: string;
  token_encrypted: Uint8Array | Buffer;
  token_kind: string;
  token_expires_at: string | Date | null;
  business_id: string | null;
  connected_by: string | null;
  available_accounts: MetaAccountInfo[];
  selected_accounts: string[];
  connected_at: string | Date;
  updated_at: string | Date;
}

function iso(v: string | Date): string {
  return new Date(v).toISOString();
}

function fromRow(r: Row): MetaConnection {
  return {
    product: r.product as MetaProduct,
    tokenKind: r.token_kind === "user" ? "user" : "system_user",
    tokenExpiresAt: r.token_expires_at ? iso(r.token_expires_at) : null,
    businessId: r.business_id,
    connectedBy: r.connected_by,
    availableAccounts: r.available_accounts ?? [],
    selectedAccounts: r.selected_accounts ?? [],
    connectedAt: iso(r.connected_at),
    updatedAt: iso(r.updated_at),
  };
}

async function readRow(client: ClientConfig, product: MetaProduct): Promise<Row | null> {
  if (!isDbConfigured()) return null;
  const rows = (await getSql()`
    SELECT product, token_encrypted, token_kind, token_expires_at, business_id,
           connected_by, available_accounts, selected_accounts, connected_at, updated_at
      FROM meta_connection
     WHERE client_id = ${client.id} AND product = ${product}
  `) as Row[];
  return rows[0] ?? null;
}

export async function readMetaConnection(
  client: ClientConfig,
  product: MetaProduct
): Promise<MetaConnection | null> {
  const row = await readRow(client, product);
  return row ? fromRow(row) : null;
}

// Separada a propósito: el token solo lo pide el sync. La píldora y las rutas de
// estado usan readMetaConnection y no pueden filtrarlo por accidente.
export async function readMetaConnectionWithToken(
  client: ClientConfig,
  product: MetaProduct
): Promise<MetaConnectionWithToken | null> {
  const row = await readRow(client, product);
  if (!row) return null;
  // null si el blob no descifra (secreto rotado). NO se colapsa a "sin fila":
  // el sync debe reportarlo como error, no callar.
  const token = await decryptToken(new Uint8Array(row.token_encrypted));
  return { ...fromRow(row), token };
}

export async function writeMetaConnection(
  client: ClientConfig,
  product: MetaProduct,
  input: {
    token: string;
    tokenKind: "system_user" | "user";
    tokenExpiresAt: string | null;
    businessId: string | null;
    connectedBy: string | null;
    availableAccounts: MetaAccountInfo[];
    selectedAccounts: string[];
  }
): Promise<void> {
  if (!isDbConfigured()) {
    console.error("[meta] writeMetaConnection sin DATABASE_URL: no hay dónde guardar el token");
    return;
  }
  const blob = Buffer.from(await encryptToken(input.token));
  await getSql()`
    INSERT INTO meta_connection (
      client_id, product, token_encrypted, token_kind, token_expires_at, business_id,
      connected_by, available_accounts, selected_accounts, connected_at, updated_at
    ) VALUES (
      ${client.id}, ${product}, ${blob}, ${input.tokenKind}, ${input.tokenExpiresAt},
      ${input.businessId}, ${input.connectedBy},
      ${JSON.stringify(input.availableAccounts)}::jsonb, ${JSON.stringify(input.selectedAccounts)}::jsonb,
      now(), now()
    )
    ON CONFLICT (client_id, product) DO UPDATE
       SET token_encrypted    = EXCLUDED.token_encrypted,
           token_kind         = EXCLUDED.token_kind,
           token_expires_at   = EXCLUDED.token_expires_at,
           business_id        = EXCLUDED.business_id,
           connected_by       = EXCLUDED.connected_by,
           available_accounts = EXCLUDED.available_accounts,
           selected_accounts  = EXCLUDED.selected_accounts,
           updated_at         = now()
  `;
}

// false si la selección está vacía o trae un id que la empresa no compartió. La
// validación va contra la fila, no contra lo que mande el browser.
export async function updateSelectedAccounts(
  client: ClientConfig,
  product: MetaProduct,
  ids: string[]
): Promise<boolean> {
  if (ids.length === 0) return false;
  const row = await readRow(client, product);
  if (!row) return false;
  const available = new Set((row.available_accounts ?? []).map((a) => a.id));
  if (!ids.every((id) => available.has(id))) return false;
  await getSql()`
    UPDATE meta_connection
       SET selected_accounts = ${JSON.stringify(ids)}::jsonb, updated_at = now()
     WHERE client_id = ${client.id} AND product = ${product}
  `;
  return true;
}

export async function deleteMetaConnection(client: ClientConfig, product: MetaProduct): Promise<void> {
  if (!isDbConfigured()) return;
  await getSql()`
    DELETE FROM meta_connection WHERE client_id = ${client.id} AND product = ${product}
  `;
}
```

- [ ] **Step 4: Migrar y correr el verify**

Run: `pnpm db:migrate`
Expected: imprime `✅ meta_connection lista:` con las 11 columnas.

Run: `pnpm verify:meta-connection-store`
Expected: `✅ verify:meta-connection-store OK`. (Sin `DATABASE_URL` en `.env.local`: `OK (solo parte pura)`; en ese caso correr `vercel env pull .env.local` y repetir.)

- [ ] **Step 5: tsc y commit**

Run: `npx tsc --noEmit`
Expected: sin salida.

```bash
git add scripts/db-migrate.ts lib/meta-connection-store.ts scripts/verify-meta-connection-store.ts package.json
git commit -m "feat(meta): tabla meta_connection y su store por cliente y producto"
```

---

### Task 3: tipos del dataset + `lib/meta-normalize.ts` (puro)

**Files:**
- Modify: `lib/types.ts` (después de `export interface Pauta {...}` y dentro de `SyncWarning` / `DashboardPayload`)
- Create: `lib/meta-normalize.ts`
- Create: `scripts/verify-meta.ts`
- Modify: `package.json`

**Interfaces:**
- Produces (en `lib/types.ts`):
  ```ts
  export interface MetaAccount { id: string; name: string; currency: string; timezone: string }
  export interface MetaCampaign { id: string; name: string; objective?: string; accountId: string }
  export interface MetaAdset { id: string; name: string; campaignId: string }
  export interface MetaAd { id: string; name: string; adsetId: string; status?: string }
  export interface MetaDailyRow { adId: string; date: string; spend: number; impressions: number; reach: number; clicks: number; linkClicks: number; leadsForm: number; leadsMsg: number }
  export interface MetaAdsData { accounts; campaigns; adsets; ads; daily; window: { since: string; until: string }; failedAccounts: { id: string; reason: string }[] }
  // SyncWarning gana `reason?: string`; DashboardPayload gana `metaAds?: MetaAdsData | null`
  ```
- Produces (en `lib/meta-normalize.ts`):
  ```ts
  export interface RawInsightRow { ad_id: string; date_start: string; spend?: string; impressions?: string; reach?: string; clicks?: string; inline_link_clicks?: string; actions?: { action_type: string; value: string }[] }
  export interface RawAd { id: string; name: string; effective_status?: string; adset?: { id: string; name: string }; campaign?: { id: string; name: string; objective?: string } }
  export function normalizeInsightRow(r: RawInsightRow): MetaDailyRow
  export function normalizeAds(accountId: string, ads: RawAd[]): { campaigns: MetaCampaign[]; adsets: MetaAdset[]; ads: MetaAd[] }
  export function monthChunks(since: string, until: string): { since: string; until: string }[]
  export function historyWindow(opps: { createdAt: string; adId?: string }[], today: string): { since: string; until: string }
  export function mergeMetaAds(parts: { account: MetaAccount; hierarchy: ReturnType<typeof normalizeAds>; daily: MetaDailyRow[] }[], failed: { id: string; reason: string }[], window): MetaAdsData
  export const LEAD_FORM_ACTION = "lead"
  export const LEAD_MSG_ACTION = "onsite_conversion.messaging_conversation_started_7d"
  export const MAX_HISTORY_MONTHS = 24
  ```

- [ ] **Step 1: Agregar los tipos a `lib/types.ts`**

Después de `export interface Pauta { ... }`:

```ts
// ── Meta Ads ─────────────────────────────────────────────────────────────────
// El dataset de la Marketing API, normalizado en tablas con ids de padre (no
// anidado): el cruce es por adId y los charts agrupan hacia arriba. Ver
// docs/superpowers/specs/2026-09-13-meta-ads-conexion-y-sync-design.md.

export interface MetaAccount {
  /** "act_123", como lo da Graph. */
  id: string
  name: string
  /** ISO 4217. No se convierte: cuentas con monedas distintas se muestran aparte. */
  currency: string
  timezone: string
}

export interface MetaCampaign {
  id: string
  name: string
  objective?: string
  accountId: string
}

export interface MetaAdset {
  id: string
  name: string
  campaignId: string
}

export interface MetaAd {
  id: string
  name: string
  adsetId: string
  status?: string
}

/** Un ad, un día. Meta omite los días sin gasto, así que no hay filas en cero. */
export interface MetaDailyRow {
  adId: string
  /** YYYY-MM-DD en la zona horaria de la cuenta. */
  date: string
  spend: number
  impressions: number
  reach: number
  clicks: number
  linkClicks: number
  /** action_type "lead": formularios → source "Pauta Formulario". */
  leadsForm: number
  /** action_type "onsite_conversion.messaging_conversation_started_7d": WhatsApp → "Pauta WhatsApp". */
  leadsMsg: number
}

export interface MetaAdsData {
  accounts: MetaAccount[]
  campaigns: MetaCampaign[]
  adsets: MetaAdset[]
  ads: MetaAd[]
  daily: MetaDailyRow[]
  /** YYYY-MM-DD ambos; lo que se pidió, no lo que vino. */
  window: { since: string; until: string }
  /** Cuentas que fallaron en este sync. Vacío = todas bien. */
  failedAccounts: { id: string; reason: string }[]
}
```

En `SyncWarning`, después de `expected?: number`:
```ts
  /** Motivo específico cuando lo hay (p. ej. `token_revoked` en `meta`). */
  reason?: string
```

En `DashboardPayload`, después de `pautas: Pauta[]`:
```ts
  /**
   * Gasto y jerarquía de Meta Ads. `null` = sin conexión (no es un error);
   * ausente = frame de un deploy anterior. Ver "Meta Ads" en CLAUDE.md.
   */
  metaAds?: MetaAdsData | null
```

- [ ] **Step 2: Escribir el verify script**

```ts
// scripts/verify-meta.ts
// Verificación de lib/meta-normalize.ts. Correr: pnpm verify:meta
//
// La parte pura de la integración con Meta: de `actions` solo salen dos
// contadores, la ventana se parte por mes calendario, y la jerarquía se
// normaliza en tablas planas. Un bug aquí es un costo por lead equivocado.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import {
  normalizeInsightRow,
  normalizeAds,
  monthChunks,
  historyWindow,
  mergeMetaAds,
  MAX_HISTORY_MONTHS,
} from "../lib/meta-normalize";

async function main() {
  // --- actions: solo lead y messaging; el resto se ignora; números como strings
  const row = normalizeInsightRow({
    ad_id: "120247808685340416",
    date_start: "2026-09-01",
    spend: "123.45",
    impressions: "1000",
    reach: "800",
    clicks: "40",
    inline_link_clicks: "35",
    actions: [
      { action_type: "lead", value: "3" },
      { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "5" },
      { action_type: "link_click", value: "35" },
      { action_type: "post_engagement", value: "90" },
    ],
  });
  assert.deepEqual(row, {
    adId: "120247808685340416",
    date: "2026-09-01",
    spend: 123.45,
    impressions: 1000,
    reach: 800,
    clicks: 40,
    linkClicks: 35,
    leadsForm: 3,
    leadsMsg: 5,
  });

  // --- campos ausentes → 0, nunca NaN
  const bare = normalizeInsightRow({ ad_id: "1", date_start: "2026-09-02" });
  assert.equal(bare.spend, 0);
  assert.equal(bare.leadsForm, 0);
  assert.equal(bare.leadsMsg, 0);
  assert.equal(bare.linkClicks, 0);

  // --- jerarquía: tablas planas, sin duplicar padres, con accountId en la campaña
  const h = normalizeAds("act_1", [
    { id: "a1", name: "Ad 1", effective_status: "ACTIVE", adset: { id: "s1", name: "Set 1" }, campaign: { id: "c1", name: "Camp 1", objective: "OUTCOME_LEADS" } },
    { id: "a2", name: "Ad 2", effective_status: "PAUSED", adset: { id: "s1", name: "Set 1" }, campaign: { id: "c1", name: "Camp 1", objective: "OUTCOME_LEADS" } },
    { id: "a3", name: "Ad 3", adset: { id: "s2", name: "Set 2" }, campaign: { id: "c2", name: "Camp 2" } },
  ]);
  assert.deepEqual(h.campaigns, [
    { id: "c1", name: "Camp 1", objective: "OUTCOME_LEADS", accountId: "act_1" },
    { id: "c2", name: "Camp 2", objective: undefined, accountId: "act_1" },
  ]);
  assert.deepEqual(h.adsets, [
    { id: "s1", name: "Set 1", campaignId: "c1" },
    { id: "s2", name: "Set 2", campaignId: "c2" },
  ]);
  assert.deepEqual(h.ads, [
    { id: "a1", name: "Ad 1", adsetId: "s1", status: "ACTIVE" },
    { id: "a2", name: "Ad 2", adsetId: "s1", status: "PAUSED" },
    { id: "a3", name: "Ad 3", adsetId: "s2", status: undefined },
  ]);
  // --- un ad sin adset/campaign (borrados) se conserva con padres vacíos
  const orphan = normalizeAds("act_1", [{ id: "a9", name: "Huérfano" }]);
  assert.deepEqual(orphan.ads, [{ id: "a9", name: "Huérfano", adsetId: "", status: undefined }]);
  assert.deepEqual(orphan.adsets, []);

  // --- chunks por mes calendario, con bordes
  assert.deepEqual(monthChunks("2026-07-15", "2026-09-13"), [
    { since: "2026-07-15", until: "2026-07-31" },
    { since: "2026-08-01", until: "2026-08-31" },
    { since: "2026-09-01", until: "2026-09-13" },
  ]);
  assert.deepEqual(monthChunks("2026-09-01", "2026-09-01"), [{ since: "2026-09-01", until: "2026-09-01" }]);
  assert.deepEqual(monthChunks("2026-02-01", "2026-03-01"), [
    { since: "2026-02-01", until: "2026-02-28" },
    { since: "2026-03-01", until: "2026-03-01" },
  ]);
  assert.deepEqual(monthChunks("2026-09-13", "2026-09-01"), [], "ventana invertida = nada");

  // --- ventana de historia: desde el primer día del mes de la opp más vieja con adId
  const w = historyWindow(
    [
      { createdAt: "2025-11-20T10:00:00.000Z", adId: undefined },
      { createdAt: "2026-01-17T10:00:00.000Z", adId: "1" },
      { createdAt: "2026-03-02T10:00:00.000Z", adId: "2" },
    ],
    "2026-09-13"
  );
  assert.deepEqual(w, { since: "2026-01-01", until: "2026-09-13" });
  // --- tope de 24 meses
  const old = historyWindow([{ createdAt: "2020-01-01T00:00:00.000Z", adId: "1" }], "2026-09-13");
  assert.equal(old.since, "2024-09-01", `tope de ${MAX_HISTORY_MONTHS} meses`);
  // --- sin oportunidades con adId: solo el mes actual
  assert.deepEqual(historyWindow([], "2026-09-13"), { since: "2026-09-01", until: "2026-09-13" });

  // --- merge: concatena, marca fallidas, conserva la ventana
  const merged = mergeMetaAds(
    [
      { account: { id: "act_1", name: "Uno", currency: "MXN", timezone: "America/Mexico_City" }, hierarchy: h, daily: [row] },
      { account: { id: "act_2", name: "Dos", currency: "MXN", timezone: "America/Mexico_City" }, hierarchy: orphan, daily: [bare] },
    ],
    [{ id: "act_3", reason: "permission" }],
    { since: "2026-01-01", until: "2026-09-13" }
  );
  assert.equal(merged.accounts.length, 2);
  assert.equal(merged.campaigns.length, 2);
  assert.equal(merged.ads.length, 4);
  assert.equal(merged.daily.length, 2);
  assert.deepEqual(merged.failedAccounts, [{ id: "act_3", reason: "permission" }]);
  assert.deepEqual(merged.window, { since: "2026-01-01", until: "2026-09-13" });

  console.log("✅ verify:meta OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`package.json`:
```json
    "verify:meta": "tsx scripts/verify-meta.ts",
```

Run: `pnpm verify:meta`
Expected: FAIL con `Cannot find module '../lib/meta-normalize'`.

- [ ] **Step 3: Implementar `lib/meta-normalize.ts`**

```ts
// lib/meta-normalize.ts
// Lo puro de la integración con Meta Ads: de la respuesta cruda de Graph a las
// tablas de MetaAdsData, la ventana de historia y su partición por mes. Sin
// fetch, sin Next: lo prueba pnpm verify:meta y lo importa lib/meta-client.ts.
import type {
  MetaAccount,
  MetaAd,
  MetaAdset,
  MetaAdsData,
  MetaCampaign,
  MetaDailyRow,
} from "./types";

/** action_type de un lead por formulario ("Pauta Formulario"). */
export const LEAD_FORM_ACTION = "lead";
/** action_type de una conversación iniciada desde un anuncio de WhatsApp ("Pauta WhatsApp"). */
export const LEAD_MSG_ACTION = "onsite_conversion.messaging_conversation_started_7d";
/** Hasta dónde atrás se pide gasto, aunque haya oportunidades más viejas. */
export const MAX_HISTORY_MONTHS = 24;

export interface RawInsightRow {
  ad_id: string;
  date_start: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: { action_type: string; value: string }[];
}

export interface RawAd {
  id: string;
  name: string;
  effective_status?: string;
  adset?: { id: string; name: string };
  campaign?: { id: string; name: string; objective?: string };
}

function num(v: string | number | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function action(r: RawInsightRow, type: string): number {
  return num(r.actions?.find((a) => a.action_type === type)?.value);
}

export function normalizeInsightRow(r: RawInsightRow): MetaDailyRow {
  return {
    adId: String(r.ad_id),
    date: r.date_start,
    spend: num(r.spend),
    impressions: num(r.impressions),
    reach: num(r.reach),
    clicks: num(r.clicks),
    linkClicks: num(r.inline_link_clicks),
    leadsForm: action(r, LEAD_FORM_ACTION),
    leadsMsg: action(r, LEAD_MSG_ACTION),
  };
}

// Tablas planas con ids de padre. Un ad cuyo adset o campaña ya no existe (Meta
// los devuelve sin esos objetos) se conserva con padre vacío: su gasto histórico
// sigue siendo real.
export function normalizeAds(
  accountId: string,
  raw: RawAd[]
): { campaigns: MetaCampaign[]; adsets: MetaAdset[]; ads: MetaAd[] } {
  const campaigns = new Map<string, MetaCampaign>();
  const adsets = new Map<string, MetaAdset>();
  const ads: MetaAd[] = [];
  for (const a of raw) {
    if (a.campaign && !campaigns.has(a.campaign.id)) {
      campaigns.set(a.campaign.id, {
        id: a.campaign.id,
        name: a.campaign.name,
        objective: a.campaign.objective,
        accountId,
      });
    }
    if (a.adset && !adsets.has(a.adset.id)) {
      adsets.set(a.adset.id, { id: a.adset.id, name: a.adset.name, campaignId: a.campaign?.id ?? "" });
    }
    ads.push({ id: String(a.id), name: a.name, adsetId: a.adset?.id ?? "", status: a.effective_status });
  }
  return { campaigns: [...campaigns.values()], adsets: [...adsets.values()], ads };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Meta se ahoga con rangos largos a nivel ad; un mes calendario por petición es
// el tamaño que cabe sin volverse un job asíncrono.
export function monthChunks(since: string, until: string): { since: string; until: string }[] {
  if (since > until) return [];
  const out: { since: string; until: string }[] = [];
  let [y, m] = since.split("-").map(Number);
  let cursor = since;
  while (cursor <= until) {
    const end = ymd(y, m, lastDayOfMonth(y, m));
    out.push({ since: cursor, until: end < until ? end : until });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    cursor = ymd(y, m, 1);
  }
  return out;
}

// Desde el primer día del mes de la oportunidad más antigua con adId, con tope de
// MAX_HISTORY_MONTHS. Sin oportunidades con adId: solo el mes en curso. `today`
// es YYYY-MM-DD ya en la zona horaria del panel; este módulo no sabe de zonas.
export function historyWindow(
  opps: { createdAt: string; adId?: string }[],
  today: string
): { since: string; until: string } {
  const [ty, tm] = today.split("-").map(Number);
  let earliest: string | null = null;
  for (const o of opps) {
    if (!o.adId) continue;
    const d = o.createdAt.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (earliest === null || d < earliest) earliest = d;
  }
  let since = ymd(ty, tm, 1);
  if (earliest) {
    const [ey, em] = earliest.split("-").map(Number);
    since = ymd(ey, em, 1);
  }
  // Tope: MAX_HISTORY_MONTHS meses atrás, primer día de ese mes.
  let fy = ty;
  let fm = tm - MAX_HISTORY_MONTHS;
  while (fm <= 0) {
    fm += 12;
    fy -= 1;
  }
  const floor = ymd(fy, fm, 1);
  if (since < floor) since = floor;
  return { since, until: today };
}

export function mergeMetaAds(
  parts: {
    account: MetaAccount;
    hierarchy: { campaigns: MetaCampaign[]; adsets: MetaAdset[]; ads: MetaAd[] };
    daily: MetaDailyRow[];
  }[],
  failed: { id: string; reason: string }[],
  window: { since: string; until: string }
): MetaAdsData {
  return {
    accounts: parts.map((p) => p.account),
    campaigns: parts.flatMap((p) => p.hierarchy.campaigns),
    adsets: parts.flatMap((p) => p.hierarchy.adsets),
    ads: parts.flatMap((p) => p.hierarchy.ads),
    daily: parts.flatMap((p) => p.daily),
    window,
    failedAccounts: failed,
  };
}
```

- [ ] **Step 4: Correr el verify y tsc**

Run: `pnpm verify:meta`
Expected: `✅ verify:meta OK`

Run: `npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 5: Commit**

```bash
git add lib/types.ts lib/meta-normalize.ts scripts/verify-meta.ts package.json
git commit -m "feat(meta): tipos del dataset de Meta Ads y normalización pura"
```

---

### Task 4: `lib/meta-client.ts` — Graph API (server-only)

**Files:**
- Create: `lib/meta-client.ts`

**Interfaces:**
- Consumes: `GRAPH_VERSION` de `lib/meta-oauth.ts`; todo `lib/meta-normalize.ts`; `MetaAccountInfo` de `lib/meta-connection-store.ts`.
- Produces:
  ```ts
  export class MetaApiError extends Error { code: number; subcode?: number; status: number; readonly isTokenInvalid: boolean }
  export function exchangeCode(p: { code: string; redirectUri: string }): Promise<{ accessToken: string }>
  export function debugToken(token: string): Promise<{ type: string; expiresAt: string | null; isValid: boolean }>
  export function fetchMe(token: string): Promise<{ id: string; name: string }>
  export function listAdAccounts(token: string): Promise<MetaAccountInfo[]>
  export function fetchMetaAds(p: { token: string; accounts: MetaAccountInfo[]; window: { since: string; until: string }; onProgress?: (adsSoFar: number) => void }): Promise<MetaAdsData>
  ```
  `fetchMetaAds` lanza `MetaApiError` con `isTokenInvalid` solo cuando el token está revocado (código 190); cualquier otra falla de UNA cuenta se registra en `failedAccounts` y no tumba las demás.

No hay verify script para este archivo (habla con la red); se prueba en la Task 5 contra la API real. Todo lo que se pudo hacer puro ya vive en `meta-normalize.ts`.

- [ ] **Step 1: Implementar el cliente**

```ts
// lib/meta-client.ts
// Cliente de la Marketing API de Meta (Graph). Server-only: nunca lo importes
// desde un componente — el token vive aquí y en el sync, y en ningún otro lado.
// Mismo estatus que lib/ghl-client.ts.
//
// Solo lectura (ads_read). La única llamada que no es GET es el canje del `code`
// del OAuth, y esa tampoco escribe nada en Meta.
import { GRAPH_VERSION } from "./meta-oauth";
import {
  monthChunks,
  mergeMetaAds,
  normalizeAds,
  normalizeInsightRow,
  type RawAd,
  type RawInsightRow,
} from "./meta-normalize";
import type { MetaAccountInfo } from "./meta-connection-store";
import type { MetaAdsData, MetaDailyRow } from "./types";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Códigos de throttling de Graph que vale la pena reintentar. 190 (token
// inválido/revocado) NO está aquí a propósito: es terminal.
const RETRYABLE_CODES = new Set([4, 17, 32, 613, 80004]);
const MAX_ATTEMPTS = 3;
const ACCOUNT_CONCURRENCY = 2;

export class MetaApiError extends Error {
  code: number;
  subcode?: number;
  status: number;
  constructor(message: string, status: number, code: number, subcode?: number) {
    super(message);
    this.name = "MetaApiError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
  /** Token revocado, caducado o de otra app: hay que reconectar, no reintentar. */
  get isTokenInvalid(): boolean {
    return this.code === 190 || this.code === 102;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// GET con reintento en throttling y 5xx. El token va en el query string porque
// así lo espera Graph; nunca en un log — por eso los errores citan la ruta y el
// código, no la URL completa.
async function graphGet<T>(path: string, params: Record<string, string>, token?: string): Promise<T> {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (token) url.searchParams.set("access_token", token);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (err) {
      lastErr = err;
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return (await res.json()) as T;

    const body = (await res.json().catch(() => ({}))) as GraphErrorBody;
    const code = body.error?.code ?? 0;
    const err = new MetaApiError(
      `Graph ${path} → ${res.status} (code ${code}): ${body.error?.message ?? res.statusText}`,
      res.status,
      code,
      body.error?.error_subcode
    );
    if (err.isTokenInvalid) throw err;
    const retryable = RETRYABLE_CODES.has(code) || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) throw err;
    lastErr = err;
    await sleep(2000 * 2 ** (attempt - 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Graph ${path} failed`);
}

// Sigue `paging.next` hasta agotar. Graph ya incluye el token en `next`.
async function graphGetAll<T>(path: string, params: Record<string, string>, token: string): Promise<T[]> {
  const out: T[] = [];
  let page = await graphGet<{ data: T[]; paging?: { next?: string } }>(path, params, token);
  out.push(...page.data);
  while (page.paging?.next) {
    const next = new URL(page.paging.next);
    const nextParams: Record<string, string> = {};
    next.searchParams.forEach((v, k) => {
      if (k !== "access_token") nextParams[k] = v;
    });
    page = await graphGet(next.pathname.replace(`/${GRAPH_VERSION}/`, ""), nextParams, token);
    out.push(...page.data);
  }
  return out;
}

// ── OAuth ───────────────────────────────────────────────────────────────────

export async function exchangeCode(p: { code: string; redirectUri: string }): Promise<{ accessToken: string }> {
  const body = await graphGet<{ access_token: string }>("oauth/access_token", {
    client_id: requireEnv("META_APP_ID"),
    client_secret: requireEnv("META_APP_SECRET"),
    redirect_uri: p.redirectUri,
    code: p.code,
  });
  if (!body.access_token) throw new Error("Graph oauth/access_token: sin access_token");
  return { accessToken: body.access_token };
}

// Qué clase de token nos dieron y cuándo caduca. `expires_at: 0` = nunca, que es
// lo que devuelve un token de usuario del sistema.
export async function debugToken(token: string): Promise<{ type: string; expiresAt: string | null; isValid: boolean }> {
  const appToken = `${requireEnv("META_APP_ID")}|${requireEnv("META_APP_SECRET")}`;
  const body = await graphGet<{ data: { type?: string; expires_at?: number; is_valid?: boolean } }>(
    "debug_token",
    { input_token: token, access_token: appToken }
  );
  const d = body.data ?? {};
  return {
    type: (d.type ?? "").toUpperCase(),
    expiresAt: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,
    isValid: d.is_valid !== false,
  };
}

export async function fetchMe(token: string): Promise<{ id: string; name: string }> {
  const me = await graphGet<{ id: string; name?: string }>("me", { fields: "id,name" }, token);
  return { id: me.id, name: me.name ?? "" };
}

export async function listAdAccounts(token: string): Promise<MetaAccountInfo[]> {
  const rows = await graphGetAll<{
    id: string;
    name?: string;
    account_status?: number;
    currency?: string;
    timezone_name?: string;
  }>("me/adaccounts", { fields: "id,name,account_status,currency,timezone_name", limit: "100" }, token);
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? r.id,
    currency: r.currency ?? "",
    timezone: r.timezone_name ?? "",
    status: r.account_status ?? 0,
  }));
}

// ── Dataset ─────────────────────────────────────────────────────────────────

async function listAds(token: string, accountId: string): Promise<RawAd[]> {
  return graphGetAll<RawAd>(
    `${accountId}/ads`,
    { fields: "id,name,effective_status,adset{id,name},campaign{id,name,objective}", limit: "500" },
    token
  );
}

async function adInsightsDaily(
  token: string,
  accountId: string,
  since: string,
  until: string
): Promise<MetaDailyRow[]> {
  const rows = await graphGetAll<RawInsightRow>(
    `${accountId}/insights`,
    {
      level: "ad",
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      fields: "ad_id,date_start,spend,impressions,reach,clicks,inline_link_clicks,actions",
      limit: "500",
    },
    token
  );
  return rows.map(normalizeInsightRow);
}

// Una cuenta completa: jerarquía + gasto diario por mes. Las excepciones suben
// al llamador, que decide si es la cuenta o el token lo que falló.
async function fetchAccount(
  token: string,
  account: MetaAccountInfo,
  window: { since: string; until: string },
  onAds: (n: number) => void
) {
  const ads = await listAds(token, account.id);
  onAds(ads.length);
  const daily: MetaDailyRow[] = [];
  for (const chunk of monthChunks(window.since, window.until)) {
    daily.push(...(await adInsightsDaily(token, account.id, chunk.since, chunk.until)));
  }
  return {
    account: { id: account.id, name: account.name, currency: account.currency, timezone: account.timezone },
    hierarchy: normalizeAds(account.id, ads),
    daily,
  };
}

/**
 * Trae el dataset completo de las cuentas dadas. Concurrencia 2 entre cuentas.
 * Una cuenta que falla queda en `failedAccounts` y las demás siguen; un token
 * revocado (190) aborta todo con MetaApiError.isTokenInvalid — no tiene sentido
 * seguir pidiendo con un token muerto.
 */
export async function fetchMetaAds(p: {
  token: string;
  accounts: MetaAccountInfo[];
  window: { since: string; until: string };
  onProgress?: (adsSoFar: number) => void;
}): Promise<MetaAdsData> {
  const parts: Awaited<ReturnType<typeof fetchAccount>>[] = [];
  const failed: { id: string; reason: string }[] = [];
  let adsSoFar = 0;
  const queue = [...p.accounts];

  const worker = async () => {
    for (let acc = queue.shift(); acc; acc = queue.shift()) {
      try {
        parts.push(
          await fetchAccount(p.token, acc, p.window, (n) => {
            adsSoFar += n;
            p.onProgress?.(adsSoFar);
          })
        );
      } catch (err) {
        if (err instanceof MetaApiError && err.isTokenInvalid) throw err;
        // Solo el mensaje: un TypeError de fetch trae la URL (con el token) en
        // `cause`, y eso no puede aterrizar en un log.
        console.error(`[meta] cuenta ${acc.id} falló:`, err instanceof Error ? err.message : String(err));
        failed.push({
          id: acc.id,
          reason: err instanceof MetaApiError ? `code_${err.code}` : "network",
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ACCOUNT_CONCURRENCY, queue.length) }, worker));

  // Orden estable por id: el orden de llegada depende de la concurrencia y
  // repintaría los charts entre syncs.
  parts.sort((a, b) => a.account.id.localeCompare(b.account.id));
  return mergeMetaAds(parts, failed, p.window);
}
```

- [ ] **Step 2: tsc y commit**

Run: `npx tsc --noEmit`
Expected: sin salida.

```bash
git add lib/meta-client.ts
git commit -m "feat(meta): cliente de la Marketing API con reintentos y tolerancia por cuenta"
```

---

### Task 5: rutas `app/api/meta/*` — el flujo OAuth y el estado

**Files:**
- Create: `app/api/meta/connect/route.ts`
- Create: `app/api/meta/callback/route.ts`
- Create: `app/api/meta/connection/route.ts`
- Create: `app/api/meta/accounts/route.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `requireClient`, `unauthorized` (`lib/session.ts`); `signState`, `verifyState`, `buildDialogUrl`, `redirectUriFor` (`lib/meta-oauth.ts`); `exchangeCode`, `debugToken`, `fetchMe`, `listAdAccounts`, `MetaApiError` (`lib/meta-client.ts`); el store completo.
- Produces (contrato HTTP que consume la píldora en Task 8):
  - `GET /api/meta/connect` → 302 al diálogo **y deja la cookie `meta_oauth` (httpOnly, SameSite=Lax, 10 min) con el `nonce` del state**; 409 `{ error: "preview" }` en preview; 503 `{ error: "not_configured" }` sin env; 503 `{ error: "no_db" }` sin `DATABASE_URL`.
  - `GET /api/meta/callback?code&state` → 302 a `/?meta=connected` o `/?meta=error&reason=<state_invalid|denied|token_exchange|token_invalid|no_accounts|db>`. **Exige que `state.nonce` coincida con la cookie `meta_oauth`** y la borra. Sin eso, alguien que conozca la contraseña del panel (≈ el locationId) podría iniciar el flujo con SU Meta y mandarle al cliente la URL del callback: `state` válido, `code` válido, y el panel de DRT quedaría conectado a una cuenta ajena. La cookie ata el callback al navegador que empezó el flujo.
  - `GET /api/meta/connection` → `{ connected: false, reason?: "not_configured" | "no_db" | "preview" }` o `{ connected: true, connectedBy, connectedAt, tokenKind, tokenExpiresAt, accounts: (MetaAccountInfo & { selected: boolean })[] }`.
  - `POST /api/meta/accounts` `{ ids: string[] }` → 204, o 400 `{ error: "invalid_selection" }`.
  - `DELETE /api/meta/connection` → 204.

- [ ] **Step 1: Documentar las variables en `.env.example`**

Agregar al final:
```
# Meta Ads (app "Paneles Lezgo Suite" — de Lezgo, no del cliente)
META_APP_ID=
META_APP_SECRET=
META_LOGIN_CONFIG_ID=1047096268324910
# Opcional: fija el origen del redirect_uri en producción (https://drt.lezgosuite.com)
META_PUBLIC_ORIGIN=
```

- [ ] **Step 2: `connect`**

```ts
// app/api/meta/connect/route.ts
// Arranca el OAuth con Meta: firma un state con el id del cliente y redirige al
// diálogo de Facebook Login for Business. Detrás de requireClient() para que el
// state solo pueda llevar el id de quien está logueado.
import { requireClient, unauthorized } from "@/lib/session";
import { isDbConfigured } from "@/lib/db";
import { buildDialogUrl, redirectUriFor, signState } from "@/lib/meta-oauth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const client = await requireClient();
  if (!client) return unauthorized();

  // Un preview de Vercel tiene URL aleatoria y no se puede registrar en la app.
  if (process.env.VERCEL_ENV === "preview") {
    return Response.json({ error: "preview" }, { status: 409 });
  }
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET || !process.env.META_LOGIN_CONFIG_ID) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  // Sin base no hay dónde guardar el token; mejor decirlo antes de mandar a
  // nadie al diálogo.
  if (!isDbConfigured()) {
    return Response.json({ error: "no_db" }, { status: 503 });
  }

  const state = await signState({ clientId: client.id, product: "ads", returnTo: "/" });
  const url = buildDialogUrl({
    appId: process.env.META_APP_ID,
    configId: process.env.META_LOGIN_CONFIG_ID,
    redirectUri: redirectUriFor(req.url, process.env.META_PUBLIC_ORIGIN),
    state,
  });
  // La cookie ata el callback a ESTE navegador: el callback exige que el nonce
  // del state coincida con ella. Sin esto, un state válido en manos ajenas
  // bastaría para conectar el panel a una cuenta de Meta que no es del cliente.
  const nonce = (await verifyState(state))!.nonce;
  const secure = new URL(req.url).protocol === "https:";
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Set-Cookie": `${OAUTH_COOKIE}=${nonce}; Path=/api/meta/callback; HttpOnly; SameSite=Lax; Max-Age=${STATE_MAX_AGE_MS / 1000}${secure ? "; Secure" : ""}`,
    },
  });
}
```
(Import adicional en `connect`: `verifyState`, `STATE_MAX_AGE_MS` y `OAUTH_COOKIE` de `@/lib/meta-oauth`. Agregar a `lib/meta-oauth.ts`, junto a `STATE_MAX_AGE_MS`: `export const OAUTH_COOKIE = "meta_oauth";`.)

- [ ] **Step 3: `callback`**

```ts
// app/api/meta/callback/route.ts
// El regreso del diálogo de Meta. Verifica el state, canjea el code, averigua qué
// clase de token es, lista las cuentas concedidas y guarda la fila. Cualquier
// falla regresa al panel con ?meta=error&reason=… y NO deja nada guardado.
import { cookies } from "next/headers";
import { requireClient, unauthorized } from "@/lib/session";
import { verifyState, redirectUriFor, OAUTH_COOKIE } from "@/lib/meta-oauth";
import { safeEqual } from "@/lib/auth";
import { exchangeCode, debugToken, fetchMe, listAdAccounts, MetaApiError } from "@/lib/meta-client";
import { writeMetaConnection } from "@/lib/meta-connection-store";

export const runtime = "nodejs";

type Reason = "state_invalid" | "denied" | "token_exchange" | "token_invalid" | "no_accounts" | "db";

// Siempre a "/", nunca a algo que venga en la petición: sin open redirect. La
// cookie del nonce se borra en todos los caminos — es de un solo uso.
function back(req: Request, params: Record<string, string>): Response {
  const url = new URL("/", req.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": `${OAUTH_COOKIE}=; Path=/api/meta/callback; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}

export async function GET(req: Request) {
  const client = await requireClient();
  if (!client) return unauthorized();

  const q = new URL(req.url).searchParams;
  const fail = (reason: Reason) => back(req, { meta: "error", reason });

  const state = await verifyState(q.get("state"));
  // El state tiene que ser del cliente logueado: un state ajeno (aunque esté
  // bien firmado) guardaría el token en la fila de otro.
  if (!state || state.clientId !== client.id || state.product !== "ads") return fail("state_invalid");
  // …y del navegador que empezó el flujo: el nonce de la cookie que dejó
  // /connect tiene que ser el mismo del state.
  const nonceCookie = (await cookies()).get(OAUTH_COOKIE)?.value ?? "";
  if (!nonceCookie || !safeEqual(nonceCookie, state.nonce)) return fail("state_invalid");

  if (q.get("error") || !q.get("code")) return fail("denied");

  let token: string;
  try {
    token = (await exchangeCode({
      code: q.get("code")!,
      redirectUri: redirectUriFor(req.url, process.env.META_PUBLIC_ORIGIN),
    })).accessToken;
  } catch (err) {
    console.error("[meta] canje del code falló:", err);
    return fail("token_exchange");
  }

  try {
    const info = await debugToken(token);
    if (!info.isValid) return fail("token_invalid");
    const [me, accounts] = await Promise.all([fetchMe(token), listAdAccounts(token)]);
    if (accounts.length === 0) return fail("no_accounts");

    await writeMetaConnection(client, "ads", {
      token,
      tokenKind: info.type === "SYSTEM_USER" || info.expiresAt === null ? "system_user" : "user",
      tokenExpiresAt: info.expiresAt,
      businessId: null,
      connectedBy: me.name || null,
      availableAccounts: accounts,
      selectedAccounts: accounts.map((a) => a.id),
    });
  } catch (err) {
    console.error("[meta] no se pudo completar la conexión:", err);
    if (err instanceof MetaApiError) return fail(err.isTokenInvalid ? "token_invalid" : "token_exchange");
    return fail("db");
  }

  return back(req, { meta: "connected" });
}
```

- [ ] **Step 4: `connection` (GET estado, DELETE desconectar)**

```ts
// app/api/meta/connection/route.ts
// Estado de la conexión para la píldora del header. Nunca devuelve el token.
import { requireClient, unauthorized } from "@/lib/session";
import { isDbConfigured } from "@/lib/db";
import { readMetaConnection, deleteMetaConnection } from "@/lib/meta-connection-store";

export const runtime = "nodejs";

export async function GET() {
  const client = await requireClient();
  if (!client) return unauthorized();

  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET || !process.env.META_LOGIN_CONFIG_ID) {
    return Response.json({ connected: false, reason: "not_configured" });
  }
  if (!isDbConfigured()) return Response.json({ connected: false, reason: "no_db" });

  let conn;
  try {
    conn = await readMetaConnection(client, "ads");
  } catch (err) {
    console.error("[meta] no se pudo leer la conexión:", err);
    return Response.json({ connected: false, reason: "no_db" });
  }
  if (!conn) {
    return Response.json({
      connected: false,
      reason: process.env.VERCEL_ENV === "preview" ? "preview" : undefined,
    });
  }
  const selected = new Set(conn.selectedAccounts);
  return Response.json({
    connected: true,
    connectedBy: conn.connectedBy,
    connectedAt: conn.connectedAt,
    tokenKind: conn.tokenKind,
    tokenExpiresAt: conn.tokenExpiresAt,
    accounts: conn.availableAccounts.map((a) => ({ ...a, selected: selected.has(a.id) })),
  });
}

export async function DELETE() {
  const client = await requireClient();
  if (!client) return unauthorized();
  try {
    await deleteMetaConnection(client, "ads");
  } catch (err) {
    console.error("[meta] no se pudo desconectar:", err);
    return Response.json({ error: "db" }, { status: 503 });
  }
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 5: `accounts`**

```ts
// app/api/meta/accounts/route.ts
// Qué cuentas de las concedidas entran al panel. La validación real (que cada id
// esté en available_accounts) vive en el store, no aquí.
import { requireClient, unauthorized } from "@/lib/session";
import { updateSelectedAccounts } from "@/lib/meta-connection-store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const client = await requireClient();
  if (!client) return unauthorized();

  let ids: unknown;
  try {
    ids = (await req.json())?.ids;
  } catch {
    return Response.json({ error: "invalid_selection" }, { status: 400 });
  }
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
    return Response.json({ error: "invalid_selection" }, { status: 400 });
  }
  let ok: boolean;
  try {
    ok = await updateSelectedAccounts(client, "ads", ids as string[]);
  } catch (err) {
    console.error("[meta] no se pudo guardar la selección:", err);
    return Response.json({ error: "db" }, { status: 503 });
  }
  if (!ok) return Response.json({ error: "invalid_selection" }, { status: 400 });
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 6: Probar contra la app de Meta**

Con `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID` y `DATABASE_URL` en `.env.local`:

Run: `npx tsc --noEmit` → sin salida.
Run: `pnpm dev`, iniciar sesión, y en el navegador:
1. `curl -i --cookie "dash_session=<cookie>" http://localhost:3000/api/meta/connection` → `{"connected":false}`.
2. Abrir `http://localhost:3000/api/meta/connect` → redirige a `facebook.com/.../dialog/oauth?...config_id=1047096268324910`.
   - Si la app publicada rechaza `localhost` como redirect_uri, la prueba de callback se hace en `drt-psi.vercel.app` tras desplegar (spec, decisión 3). Anotar el resultado en el commit.
3. Tras autorizar, la URL termina en `/?meta=connected`, y `GET /api/meta/connection` devuelve `connected: true` con las cuentas.
4. `curl -X POST -H 'content-type: application/json' -d '{"ids":["act_999"]}' …/api/meta/accounts` → 400.
4b. Fijación: copiar la URL completa del callback (con `code` y `state`) desde la barra del navegador ANTES de que cargue, y abrirla en una ventana de incógnito logueada como el mismo cliente pero sin la cookie `meta_oauth` → `/?meta=error&reason=state_invalid`, y `GET /api/meta/connection` sigue en `connected:false`.
5. `psql`/Neon console: `SELECT client_id, product, token_kind, jsonb_array_length(selected_accounts) FROM meta_connection` — el token no aparece en claro.

- [ ] **Step 7: Commit**

```bash
git add app/api/meta .env.example
git commit -m "feat(meta): rutas de conexión OAuth, estado y selección de cuentas"
```

---

### Task 6: el paso `meta` en el sync + loading + banner + conservar el último bueno

**Files:**
- Modify: `lib/sync.ts` (imports; después del `Promise.all` de datasets; `warnings`; `return`)
- Modify: `hooks/use-dashboard-data.ts:11-40` (`StepKey`, `INITIAL_STEPS`)
- Modify: `components/dashboard/loading-screen.tsx:26-40` (`STEP_ROWS` y el mapa inicial)
- Modify: `components/dashboard/sync-warning-banner.tsx` (`DATASET_COPY`, `describe`)
- Modify: `app/api/dashboard/route.ts` (`preserveMetaAds`)

**Interfaces:**
- Consumes: `readMetaConnectionWithToken` (Task 2), `fetchMetaAds`, `MetaApiError` (Task 4), `historyWindow` (Task 3), `PANEL_TIME_ZONE` de `lib/task-backlog.ts`, `readSync`.
- Produces: `DashboardPayload.metaAds` poblado o `null`; warning `{ key: "meta", kind: "error", reason: "token_revoked" | "token_unreadable" | "failed" }` o `{ key: "meta", kind: "partial", loaded, reason: "act_1,act_2" }`.

- [ ] **Step 1: El paso en `lib/sync.ts`**

Imports nuevos al inicio del archivo:
```ts
import { readMetaConnectionWithToken } from "@/lib/meta-connection-store";
import { fetchMetaAds, MetaApiError } from "@/lib/meta-client";
import { historyWindow } from "@/lib/meta-normalize";
import { oppAdId } from "@/lib/meta-attribution";
import { PANEL_TIME_ZONE } from "@/lib/task-backlog";
import type { MetaAdsData } from "@/lib/types";
```
(`MetaAdsData` se agrega al `import type { ... } from "@/lib/types"` existente. `oppAdId` viene de Task 7 — si se ejecuta Task 6 antes que Task 7, crear `lib/meta-attribution.ts` solo con `oppAdId` tal como está en Task 7 y el resto después.)

**Después** del bloque que construye `const opportunities: Opportunity[] = opportunitiesRaw.map(...)` (las oportunidades ya transformadas, con `adId` y `customFieldsResolved` resueltos) y del enriquecimiento `if (!opp.adId) opp.adId = contact.adId;`, insertar:

```ts
    // ── Meta Ads ──────────────────────────────────────────────────────────
    // Corre DESPUÉS del transform de opportunities porque la ventana de historia
    // sale de la oportunidad más antigua con ad id, y oppAdId() necesita las
    // oportunidades ya normalizadas (attribution + custom field). Sin conexión
    // no se emite el paso: eso no es un error, es que nadie ha apretado
    // "Conectar con Meta".
    const metaStep = (status: "loading" | "done" | "partial" | "error", count?: number) =>
      send({ type: "step", key: "meta", status, ...(count !== undefined ? { count } : {}) });

    let metaAds: MetaAdsData | null = null;
    let metaWarning: SyncWarning | null = null;
    // El token solo se descifra aquí y nunca sale de este bloque.
    const metaConn = await readMetaConnectionWithToken(client, "ads").catch((err) => {
      console.error("[meta] no se pudo leer la conexión, se sincroniza sin Meta:", err);
      return null;
    });
    if (metaConn && metaConn.token === null) {
      // Hay fila pero el blob no descifra (DASHBOARD_AUTH_SECRET rotado). Callar
      // aquí dejaría la píldora en "conectado" y el gasto congelado sin aviso.
      metaStep("error", 0);
      metaWarning = { key: "meta", kind: "error", loaded: 0, reason: "token_unreadable" };
    } else if (metaConn) {
      metaStep("loading", 0);
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: PANEL_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const selected = new Set(metaConn.selectedAccounts);
      try {
        metaAds = await fetchMetaAds({
          token: metaConn.token,
          accounts: metaConn.availableAccounts.filter((a) => selected.has(a.id)),
          window: historyWindow(
            opportunities.map((o) => ({ createdAt: o.createdAt, adId: oppAdId(o) ?? undefined })),
            today
          ),
          onProgress: (n) => metaStep("loading", n),
        });
        if (metaAds.failedAccounts.length > 0) {
          metaStep("partial", metaAds.ads.length);
          metaWarning = {
            key: "meta",
            kind: "partial",
            loaded: metaAds.ads.length,
            reason: metaAds.failedAccounts.map((f) => f.id).join(","),
          };
        } else {
          metaStep("done", metaAds.ads.length);
        }
      } catch (err) {
        console.error("[meta] el sync de Meta Ads falló:", err);
        metaStep("error", 0);
        metaAds = null;
        metaWarning = {
          key: "meta",
          kind: "error",
          loaded: 0,
          reason: err instanceof MetaApiError && err.isTokenInvalid ? "token_revoked" : "failed",
        };
      }
    }
```

Justo antes del `return { ... }` final (la construcción de `warnings` queda donde está, más arriba; es un `const` de array y `push` funciona):
```ts
    if (metaWarning) warnings.push(metaWarning);
```

En el `return { ... }` final, después de `pautas,`:
```ts
      metaAds,
```

- [ ] **Step 2: `StepKey` en el hook**

`hooks/use-dashboard-data.ts`: agregar `| "meta"` al final de `StepKey` y `meta: { status: "pending" },` al final de `INITIAL_STEPS`.

- [ ] **Step 3: Fila en la pantalla de carga**

`components/dashboard/loading-screen.tsx`: en `STEP_ROWS`, después de `{ key: "tasks", label: "Tareas" }`:
```ts
  { key: "meta", label: "Meta Ads" },
```
y en el mapa inicial de pasos del mismo archivo (línea ~39, junto a `pautas: { status: "pending" }`), `meta: { status: "pending" },`. Verificar que la fila en `pending` se pinte igual que las otras — cuando no hay conexión se queda en `pending` todo el sync, y eso es correcto: la barra determinada cuenta `done`/`partial`/`error`, así que revisar que el denominador de la barra **excluya** `meta` cuando sigue `pending` al recibir `data`. Si la barra se calcula como `completados / STEP_ROWS.length`, cambiar el denominador a `STEP_ROWS.filter(r => steps[r.key].status !== "pending" || r.key !== "meta").length`.

- [ ] **Step 4: Copy del banner**

`components/dashboard/sync-warning-banner.tsx`, en `DATASET_COPY` después de `tasks`:
```ts
  meta: {
    name: "los datos de Meta Ads",
    impact: "El gasto y el costo por resultado no se actualizaron; se muestra el último sync bueno.",
  },
```
Y en `describe(w)`, antes del `if (w.kind === "error")`:
```ts
  if (w.key === "meta") {
    if (w.reason === "token_revoked" || w.reason === "token_unreadable") {
      return "Meta desconectado: la empresa revocó el acceso o el token dejó de ser válido. Reconecta desde la píldora \"Meta\" del encabezado; mientras tanto se muestra el último gasto sincronizado."
    }
    if (w.kind === "partial") {
      return `Meta Ads: no respondieron las cuentas ${w.reason ?? ""}. El gasto de esas cuentas falta en este sync.`.replace("  ", " ")
    }
    return "Meta Ads no respondió. Se muestra el último gasto sincronizado."
  }
```
`SyncWarning` en el banner viene de `@/hooks/use-dashboard-data`; confirmar que ese re-export apunte al tipo de `lib/types.ts` (ya lo hace: el hook re-exporta `SyncWarning`). Si no, importar de `@/lib/types`.

- [ ] **Step 5: Conservar el último `metaAds` bueno en la ruta**

`app/api/dashboard/route.ts`: import `readSync` ya existe. Agregar después de `saveQuietly`:

```ts
// Si el paso de Meta falló (token revocado, Meta caído), el payload trae
// metaAds: null y un warning `meta`. Antes de mostrarlo o guardarlo, se rescata
// el metaAds del último caché bueno: un gasto de hace una hora le gana a ningún
// gasto, y el banner ya explica que no se actualizó.
async function preserveMetaAds(client: ClientConfig, payload: DashboardPayload): Promise<DashboardPayload> {
  const failed = payload.warnings?.some((w) => w.key === "meta" && w.kind === "error");
  if (!failed || payload.metaAds || !isDbConfigured()) return payload;
  try {
    const prev = await readSync(client);
    if (prev?.payload.metaAds) return { ...payload, metaAds: prev.payload.metaAds };
  } catch (err) {
    console.error("[meta] no se pudo rescatar el último metaAds:", err);
  }
  return payload;
}
```

Y usarlo en los dos caminos:
- En el stream: `const payload = await preserveMetaAds(client, await syncProject(client, send));`
- En `refreshInBackground`: `const payload = await preserveMetaAds(client, await syncProject(client));`

- [ ] **Step 6: Probar**

Run: `npx tsc --noEmit` → sin salida.
Run: `pnpm verify:sync-store` → sigue OK (el payload de prueba no trae `metaAds`; es opcional).

Con la conexión hecha en Task 5 y `pnpm dev`:
1. Abrir `http://localhost:3000/api/dashboard?fresh=1` con la cookie (o el botón **Actualizar**) y ver en el NDJSON un frame `{"type":"step","key":"meta","status":"loading",...}` seguido de `done` con `count` > 0.
2. En el frame `data`, `metaAds.accounts.length` = cuentas seleccionadas, `metaAds.daily.length` > 0, `metaAds.window.since` = primer día del mes de la opp más vieja con adId.
3. **Cuadrar**: elegir una campaña en el Administrador de anuncios de DRT, un mes completo, y comparar su gasto con `sum(daily.spend)` filtrando `ads` por `adsetId → campaignId`. Deben coincidir al centavo (Meta reporta en la moneda de la cuenta).
4. Borrar la fila (`DELETE /api/meta/connection`) y repetir `?fresh=1`: ningún frame `step` con `key: "meta"`, `metaAds: null`, sin warning.
5. Simular secreto rotado: `UPDATE meta_connection SET token_encrypted = '\x00'::bytea WHERE client_id = 'drt'` (no descifra → `token: null` → paso `error`, warning `token_unreadable`, y el banner pide reconectar). Para el 190 real, editar temporalmente el token en el store con uno inválido cifrado (`await encryptToken("EAAB-basura")` desde un script `tsx -e`), correr `?fresh=1`: paso `error`, warning `token_revoked`, y el `data` conserva el `metaAds` del caché anterior. Restaurar reconectando.
6. Postgres caído: `DATABASE_URL=postgres://invalid pnpm dev` → el panel carga sin Meta y sin banner.

- [ ] **Step 7: Commit**

```bash
git add lib/sync.ts hooks/use-dashboard-data.ts components/dashboard/loading-screen.tsx components/dashboard/sync-warning-banner.tsx app/api/dashboard/route.ts
git commit -m "feat(meta): paso meta en el sync, fila de carga, banner y rescate del último gasto bueno"
```

---

### Task 7: `lib/meta-attribution.ts` — el cruce (puro)

**Files:**
- Create: `lib/meta-attribution.ts`
- Create: `scripts/verify-meta-attribution.ts`
- Modify: `lib/pauta.ts` (`PAID_SOCIAL_SOURCES`)
- Modify: `package.json`

**Contexto medido (2026-09-13, producción, 14 280 oportunidades):**
- El ad id vive en `attributions[].utmAdId` (8 948) y en el custom field **`ID Pauta`** (7 992; existe también `ID de Pauta`, casi vacío). Alguno de los dos: 8 986. En 30 casos difieren.
- El objeto Pauta **no** trae ad id, pero trae `nombre_de_la_pauta` (94 %), que son **nombres de ad** de Meta ("Cañadas by El Mirador" × 2 064) — el mismo valor que `attributions[].adName` y el custom field `Nombre Pauta` de la oportunidad. Ese nombre es el segundo nivel de atribución.
- Palmyra y Zanda recibieron **1 559 y 1 433 oportunidades por CSV** el 28-31 de agosto (`attributions[].medium === "csv_import"`, sin `source`, sin ad id). No son leads de pauta y no pueden entrar al costo por lead.

**Interfaces:**
- Consumes: `MetaAdsData`, `Opportunity`, `Pauta`, `Pipeline` (`lib/types.ts`); `desarrolloOf`, `NO_DESARROLLO`, `PANEL_SCOPES`, `resolvePipelineId`, `PanelId` (`lib/panel-scope.ts`); `isWonOpp` (`lib/opportunity-status.ts`); `isDePauta`, `resolveCampaignName`, `buildPautaNameByContact`, `HasKey` (`lib/pauta.ts`); `PANEL_TIME_ZONE` (`lib/task-backlog.ts`).
- Produces:
  ```ts
  export const NO_AD_ID = "Sin ad id"
  export const UNKNOWN_AD = "Ad no conectado"
  export type StageKey = "contactado" | "cita" | "visita" | "apartado" | "venta"
  export const STAGE_TARGETS: { key: StageKey; label: string; minIndex: number }[]
  export function oppAdId(opp: Opportunity): string | null
  export interface MetaIndex { byAd: Map<string, { ad; adset?; campaign?; account? }>; dailyByAd: Map<string, MetaDailyRow[]>; byName: Map<string, Set<string>> /* nombre plegado → campaignIds */ }
  export function buildMetaIndex(meta: MetaAdsData): MetaIndex
  export function buildPautaContacts(pautas: Pauta[]): Set<string>
  export type LeadAttribution =
    | { kind: "exact"; adId: string; campaignId: string | null }
    | { kind: "byName"; name: string; campaignId: string }
    | { kind: "unknownAd"; adId: string }
    | { kind: "noAdId" }
    | { kind: "notPauta" }
  export interface AttributionContext { index: MetaIndex; pautaContacts: HasKey; pautaNameByContact: Map<string, string> }
  export function classifyLead(opp: Opportunity, ctx: AttributionContext): LeadAttribution
  export function assignAdDesarrollos(meta, index, allOpportunities, pipelines): { byAd: Map<string, string>; mixed: string[] }
  export function scopeMetaDaily(meta, desarrolloByAd: Map<string, string>, panel: PanelId, pipelines): MetaDailyRow[]
  export function localDay(iso: string, timeZone?: string): string
  export function stageIndexOf(stage: string | undefined): number | null
  export function reachedStage(opp: Opportunity, target: { key: StageKey; minIndex: number }): boolean
  export interface CostPerStage { spendByCurrency; mixedCurrency; leadsCrm; leadsExact; leadsByName; leadsMeta; noAdId; unknownAdLeads; notPauta; stages: { key; label; reached; costPerResult: number | null; oppIds: string[] }[] }
  export function buildCostPerStage(p: CostInput): CostPerStage
  export interface CampaignPerformanceRow { campaignId; name; accountId; currency; spend; impressions; clicks; cpm; ctr; leadsMeta; leadsCrm; leadsByName; reached: Record<StageKey, number>; cpl; costPerApartado; costPerVenta; adIds: string[] }
  export function buildCampaignPerformance(p: CostInput): CampaignPerformanceRow[]
  // CostInput = { opportunities; daily; ctx: AttributionContext; accounts; range: { start; end } | null }
  ```

- [ ] **Step 1: Escribir el verify script** (ad ids numéricos en el fixture: `oppAdId` exige dígitos, como los ids reales de Meta)

```ts
// scripts/verify-meta-attribution.ts
// Verificación de lib/meta-attribution.ts. Correr: pnpm verify:meta-attribution
//
// Aquí se decide cuánto costó cada venta. La llave es el ad id; a falta de id,
// el nombre del ad cuando es inequívoco; y una oportunidad que no es de pauta
// (orgánica, referida, importada por CSV) nunca entra al costo. Un bug aquí es
// un costo por venta que el cliente cree y que es falso.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import {
  NO_AD_ID,
  oppAdId,
  buildMetaIndex,
  buildPautaContacts,
  classifyLead,
  assignAdDesarrollos,
  scopeMetaDaily,
  localDay,
  stageIndexOf,
  reachedStage,
  buildCostPerStage,
  buildCampaignPerformance,
  STAGE_TARGETS,
  type AttributionContext,
} from "../lib/meta-attribution";
import { buildPautaNameByContact } from "../lib/pauta";
import { NO_DESARROLLO } from "../lib/panel-scope";
import type { MetaAdsData, Opportunity, Pauta, Pipeline } from "../lib/types";

const STAGES = [
  "00. Recibido", "01. Contactado", "02. Lead en Seguimiento", "03. Lead Calificado",
  "04. Cita Programada", "05. Visita al Desarrollo", "06. Negociación", "07. Apartado",
  "08. Venta", "Inversión Futura", "Negocio perdido",
];
const pipelines: Pipeline[] = [
  { id: "p-can", name: "Cañadas", stages: STAGES },
  { id: "p-atr", name: "Atria", stages: STAGES },
  { id: "p-pal", name: "Palmyra", stages: STAGES },
];

function opp(p: Partial<Opportunity> & { id: string }): Opportunity {
  return {
    name: p.id, pipelineId: "p-can", pipelineStageId: "x", status: "open",
    createdAt: "2026-08-10T15:00:00.000Z", contactId: "c-" + p.id, value: 0,
    stage: "00. Recibido", pipelineName: "Cañadas", source: "Pauta WhatsApp",
    ...p,
  };
}

const meta: MetaAdsData = {
  accounts: [
    { id: "act_1", name: "Uno", currency: "MXN", timezone: "America/Mexico_City" },
    { id: "act_2", name: "Dos", currency: "USD", timezone: "America/Mexico_City" },
  ],
  campaigns: [
    { id: "c1", name: "IW - Cañadas - Agosto", accountId: "act_1" },
    { id: "c2", name: "IW - Atria - Agosto", accountId: "act_1" },
    { id: "c3", name: "Branding genérico", accountId: "act_2" },
  ],
  adsets: [
    { id: "s1", name: "Set", campaignId: "c1" },
    { id: "s2", name: "Set", campaignId: "c2" },
    { id: "s3", name: "Set", campaignId: "c3" },
  ],
  ads: [
    { id: "101", name: "Cañadas by El Mirador", adsetId: "s1" },
    { id: "102", name: "Cañadas by El Mirador", adsetId: "s1" },   // mismo nombre, misma campaña → inequívoco
    { id: "201", name: "Atria lofts", adsetId: "s2" },
    { id: "301", name: "Terrenos desde $1.2 M", adsetId: "s3" },
    { id: "302", name: "Atria lofts", adsetId: "s3" },             // "Atria lofts" en DOS campañas → ambiguo
  ],
  daily: [
    { adId: "101", date: "2026-08-01", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 0, leadsMsg: 4 },
    { adId: "101", date: "2026-08-15", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 0, leadsMsg: 2 },
    { adId: "201", date: "2026-08-15", spend: 50, impressions: 500, reach: 400, clicks: 10, linkClicks: 8, leadsForm: 1, leadsMsg: 0 },
    { adId: "301", date: "2026-08-20", spend: 30, impressions: 300, reach: 200, clicks: 3, linkClicks: 3, leadsForm: 0, leadsMsg: 0 },
    { adId: "101", date: "2026-09-01", spend: 999, impressions: 1, reach: 1, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 },
  ],
  window: { since: "2026-08-01", until: "2026-09-13" },
  failedAccounts: [],
};

const pautas: Pauta[] = [
  { id: "P1", tipo: "Mensaje WhatsApp", nombrePauta: "Cañadas by El Mirador", createdAt: "2026-08-02T00:00:00.000Z", contactId: "c-11" },
  { id: "P2", tipo: "Formulario", nombrePauta: "Atria lofts", createdAt: "2026-08-02T00:00:00.000Z", contactId: "c-12" },
  { id: "P3", tipo: "Formulario", nombrePauta: "Sin nombre", createdAt: "2026-08-02T00:00:00.000Z", contactId: "c-13" },
];

async function main() {
  // --- llave: attribution manda, custom field "ID Pauta" / "ID de Pauta" como fallback
  assert.equal(oppAdId(opp({ id: "o", adId: "120247808685340416" })), "120247808685340416");
  assert.equal(oppAdId(opp({ id: "o", customFieldsResolved: { "ID Pauta": " 1202478 " } })), "1202478");
  assert.equal(oppAdId(opp({ id: "o", customFieldsResolved: { "ID de Pauta": "77" } })), "77");
  assert.equal(oppAdId(opp({ id: "o", customFieldsResolved: { "id pauta": "78" } })), "78", "nombre del campo insensible a mayúsculas");
  assert.equal(oppAdId(opp({ id: "o", adId: "1", customFieldsResolved: { "ID Pauta": "2" } })), "1", "cuando difieren, manda la attribution nativa");
  assert.equal(oppAdId(opp({ id: "o", customFieldsResolved: { "URL Pauta": "https://fb.me/x", "Nombre Pauta": "x" } })), null, "URL y nombre no son ids");
  assert.equal(oppAdId(opp({ id: "o", adId: "abc" })), null, "un id sin dígitos no es un ad id");
  assert.equal(oppAdId(opp({ id: "o" })), null);
  assert.equal(NO_AD_ID, "Sin ad id");

  // --- índice: jerarquía y nombres plegados → campañas
  const index = buildMetaIndex(meta);
  assert.equal(index.byAd.get("101")?.campaign?.id, "c1");
  assert.equal(index.byAd.get("101")?.account?.currency, "MXN");
  assert.equal(index.dailyByAd.get("101")?.length, 3);
  assert.deepEqual([...index.byName.get("canadas by el mirador")!], ["c1"]);
  assert.deepEqual([...index.byName.get("atria lofts")!].sort(), ["c2", "c3"]);
  assert.deepEqual([...index.byName.get("iw - canadas - agosto")!], ["c1"], "los nombres de campaña también se indexan");

  // --- clasificación de un lead
  const ctx: AttributionContext = {
    index,
    pautaContacts: buildPautaContacts(pautas),
    pautaNameByContact: buildPautaNameByContact(pautas),
  };
  assert.deepEqual(classifyLead(opp({ id: "1", adId: "101" }), ctx), { kind: "exact", adId: "101", campaignId: "c1" });
  assert.deepEqual(classifyLead(opp({ id: "9", adId: "9999" }), ctx), { kind: "unknownAd", adId: "9999" });
  // sin id, con nombre en el custom field de la oportunidad → campaña única
  assert.deepEqual(
    classifyLead(opp({ id: "11", customFieldsResolved: { "Nombre Pauta": "Cañadas by El Mirador" } }), ctx),
    { kind: "byName", name: "Cañadas by El Mirador", campaignId: "c1" }
  );
  // sin id ni custom field, pero el contacto tiene registro Pauta con nombre → campaña única
  assert.deepEqual(classifyLead(opp({ id: "11", contactId: "c-11", source: undefined }), ctx), {
    kind: "byName", name: "Cañadas by El Mirador", campaignId: "c1",
  });
  // nombre ambiguo (dos campañas) → NO se atribuye; queda como pauta sin id
  assert.deepEqual(classifyLead(opp({ id: "12", contactId: "c-12" }), ctx), { kind: "noAdId" });
  // nombre "Sin nombre" del Make → no cuenta como nombre
  assert.deepEqual(classifyLead(opp({ id: "13", contactId: "c-13" }), ctx), { kind: "noAdId" });
  // de pauta por source, sin id ni nombre
  assert.deepEqual(classifyLead(opp({ id: "8", source: "Pauta Formulario" }), ctx), { kind: "noAdId" });
  // orgánico: sin señal de pauta
  assert.deepEqual(classifyLead(opp({ id: "r", source: "Referido" }), ctx), { kind: "notPauta" });
  // importado por CSV: nunca es de pauta, aunque el pipeline sea de un desarrollo
  assert.deepEqual(classifyLead(opp({ id: "csv", source: undefined, attributionMedium: "csv_import", pipelineId: "p-pal" }), ctx), { kind: "notPauta" });
  assert.deepEqual(classifyLead(opp({ id: "csv2", adId: "101", attributionMedium: "csv_import" }), ctx), { kind: "notPauta" }, "csv_import gana incluso con ad id");

  // --- desarrollo por moda de leads, por nombre, sin desarrollo, y mixtos
  const opps = [
    opp({ id: "1", adId: "101", pipelineId: "p-can" }),
    opp({ id: "2", adId: "101", pipelineId: "p-can" }),
    opp({ id: "3", adId: "101", pipelineId: "p-atr" }),
    opp({ id: "4", adId: "101", pipelineId: "p-can", stage: "05. Visita al Desarrollo" }),
    opp({ id: "5", adId: "101", pipelineId: "p-can", stage: "07. Apartado", status: "lost" }),
    opp({ id: "6", adId: "101", pipelineId: "p-can", stage: "08. Venta" }),
    opp({ id: "7", adId: "201", pipelineId: "p-atr", createdAt: "2026-08-15T05:30:00.000Z" }),
    opp({ id: "8", pipelineId: "p-can", source: "Pauta Formulario" }),
    opp({ id: "9", adId: "9999", pipelineId: "p-can" }),
    opp({ id: "10", adId: "101", pipelineId: "p-can", createdAt: "2026-07-31T23:30:00.000Z" }),
    opp({ id: "11", contactId: "c-11", pipelineId: "p-can", source: undefined, stage: "04. Cita Programada" }),
    opp({ id: "r", pipelineId: "p-can", source: "Referido" }),
    opp({ id: "csv", pipelineId: "p-pal", source: undefined, attributionMedium: "csv_import" }),
  ];
  const { byAd: desarrolloByAd, mixed } = assignAdDesarrollos(meta, index, opps, pipelines);
  assert.equal(desarrolloByAd.get("101"), "Cañadas", "moda: 6 en Cañadas vs 1 en Atria");
  assert.deepEqual(mixed, ["101"], "a1 tiene leads en más de un desarrollo");
  assert.equal(desarrolloByAd.get("201"), "Atria");
  assert.equal(desarrolloByAd.get("301"), NO_DESARROLLO, "sin leads y sin nombre de desarrollo");
  assert.equal(desarrolloByAd.get("102"), "Cañadas", "sin leads, pero la campaña dice Cañadas");
  assert.equal(desarrolloByAd.get("302"), "Atria", "la campaña es 'Branding genérico', pero el nombre del AD dice Atria");
  // un desarrollo que NO está en PANEL_SCOPES pero sí en los pipelines también se detecta por nombre
  const withSeventh: Pipeline[] = [...pipelines, { id: "p-7", name: "Nuevo Bosque", stages: STAGES }];
  const metaNoLeads = { ...meta, ads: [{ id: "701", name: "Nuevo Bosque lotes", adsetId: "s1" }], daily: [] };
  const r2 = assignAdDesarrollos(metaNoLeads, buildMetaIndex(metaNoLeads), [], withSeventh);
  assert.equal(r2.byAd.get("701"), "Nuevo Bosque");

  // --- scope por panel: GENERAL devuelve la misma referencia; el fallback por nombre y el scope coinciden
  assert.equal(scopeMetaDaily(meta, desarrolloByAd, "general", pipelines), meta.daily);
  const canDaily = scopeMetaDaily(meta, desarrolloByAd, "canadas", pipelines);
  assert.deepEqual(canDaily.map((d) => d.adId), ["101", "101", "101"]);
  assert.deepEqual(scopeMetaDaily(meta, desarrolloByAd, "palmyra", pipelines), []);

  // --- día local: 2026-07-31T23:30Z es 31 de julio en CDMX (UTC-6); 2026-08-15T05:30Z es 14 de agosto
  assert.equal(localDay("2026-07-31T23:30:00.000Z"), "2026-07-31");
  assert.equal(localDay("2026-08-15T05:30:00.000Z"), "2026-08-14");
  assert.equal(localDay("no-es-fecha"), "");

  // --- etapas
  assert.equal(stageIndexOf("05. Visita al Desarrollo"), 5);
  assert.equal(stageIndexOf("Negocio perdido"), null);
  assert.equal(stageIndexOf(undefined), null);
  const venta = STAGE_TARGETS.find((t) => t.key === "venta")!;
  const visita = STAGE_TARGETS.find((t) => t.key === "visita")!;
  assert.equal(reachedStage(opp({ id: "x", stage: "07. Apartado", status: "lost" }), visita), true, "una perdida en Apartado sí alcanzó Visita");
  assert.equal(reachedStage(opp({ id: "x", stage: "07. Apartado", status: "lost" }), venta), false);
  assert.equal(reachedStage(opp({ id: "x", stage: "02. Lead en Seguimiento", status: "won" }), venta), true, "status won cuenta como Venta aunque la etapa no");
  assert.equal(reachedStage(opp({ id: "x", stage: "Negocio perdido" }), visita), false);

  // --- costo por etapa, agosto, GENERAL
  const range = { start: "2026-08-01", end: "2026-08-31" };
  const cost = buildCostPerStage({ opportunities: opps, daily: meta.daily, ctx, accounts: meta.accounts, range });
  assert.deepEqual(cost.spendByCurrency, { MXN: 250, USD: 30 });
  assert.equal(cost.mixedCurrency, true);
  // exactos en agosto (día local): 1,2,3,4,5,6 (a1) + 7 (a2, 14 ago) = 7; la 10 es 31 de julio
  assert.equal(cost.leadsExact, 7);
  assert.equal(cost.leadsByName, 1, "la 11, por el registro Pauta del contacto");
  assert.equal(cost.leadsCrm, 8, "exactos + por nombre");
  assert.equal(cost.leadsMeta, 7, "4+2 msg + 1 form");
  assert.equal(cost.noAdId, 1, "la 8: de pauta, sin id ni nombre");
  assert.equal(cost.unknownAdLeads, 1, "la 9");
  assert.equal(cost.notPauta, 2, "referido + csv_import; nunca entran al costo");
  const byKey = Object.fromEntries(cost.stages.map((s) => [s.key, s]));
  assert.equal(byKey.contactado.reached, 4, "4 (05), 5 (07), 6 (08), 11 (04)");
  assert.equal(byKey.cita.reached, 4);
  assert.equal(byKey.visita.reached, 3);
  assert.equal(byKey.apartado.reached, 2);
  assert.equal(byKey.venta.reached, 1);
  assert.deepEqual(byKey.venta.oppIds, ["6"]);
  assert.equal(byKey.venta.costPerResult, null, "con moneda mixta no hay costo consolidado");

  // --- una sola moneda: costo = gasto / alcanzaron; sin alcanzaron → null
  const mxnDaily = meta.daily.filter((d) => d.adId !== "301");
  const costMxn = buildCostPerStage({ opportunities: opps, daily: mxnDaily, ctx, accounts: meta.accounts, range });
  assert.equal(costMxn.mixedCurrency, false);
  assert.equal(costMxn.stages.find((s) => s.key === "venta")?.costPerResult, 250);
  assert.equal(costMxn.stages.find((s) => s.key === "apartado")?.costPerResult, 125);
  const nadie = buildCostPerStage({ opportunities: [opp({ id: "solo", adId: "101" })], daily: mxnDaily, ctx, accounts: meta.accounts, range });
  assert.equal(nadie.stages.find((s) => s.key === "venta")?.costPerResult, null, "sin ventas → null, nunca ∞");

  // --- sin rango = toda la ventana
  const all = buildCostPerStage({ opportunities: opps, daily: meta.daily, ctx, accounts: meta.accounts, range: null });
  assert.deepEqual(all.spendByCurrency, { MXN: 1249, USD: 30 });
  assert.equal(all.leadsExact, 8, "la 10 (julio) entra");

  // --- rendimiento por campaña, agosto
  const rows = buildCampaignPerformance({ opportunities: opps, daily: meta.daily, ctx, accounts: meta.accounts, range });
  assert.deepEqual(rows.map((r) => r.campaignId), ["c1", "c2", "c3"], "por gasto desc");
  const c1 = rows[0];
  assert.equal(c1.spend, 200);
  assert.equal(c1.currency, "MXN");
  assert.equal(c1.leadsMeta, 6);
  assert.equal(c1.leadsCrm, 7, "6 exactos + la 11 por nombre");
  assert.equal(c1.leadsByName, 1);
  assert.equal(c1.reached.venta, 1);
  assert.equal(c1.cpl, 200 / 7);
  assert.equal(c1.costPerVenta, 200);
  assert.equal(c1.cpm, 100, "200 / 2000 impresiones × 1000");
  assert.equal(c1.ctr, 0.05, "100 clics / 2000 impresiones");
  const c3 = rows[2];
  assert.equal(c3.leadsCrm, 0);
  assert.equal(c3.cpl, null, "gasto sin leads: null, y la UI lo pinta en rojizo");
  assert.deepEqual(c3.adIds, ["301"]);

  console.log("✅ verify:meta-attribution OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`package.json`:
```json
    "verify:meta-attribution": "tsx scripts/verify-meta-attribution.ts",
```

Run: `pnpm verify:meta-attribution`
Expected: FAIL con `Cannot find module '../lib/meta-attribution'`.

- [ ] **Step 2: `isDePauta` debe reconocer `source: "Pauta …"`**

Hoy `isPaidTraffic` en `lib/pauta.ts` busca "meta"/"facebook"/… en `source`, así que **"Pauta WhatsApp" / "Pauta Formulario" — el 85 % de DRT — no cuentan como tráfico pagado** y `isDePauta` depende solo de la relación con el objeto Pauta (que un ~2 % no tiene). Es un hueco de la fuente de verdad, no del cruce, así que se corrige ahí — nunca se re-inlinea en `meta-attribution.ts`.

En `lib/pauta.ts`, cambiar:
```ts
export const PAID_SOCIAL_SOURCES = ["meta", "facebook", "instagram", "tiktok", "fb", "snapchat", "pinterest"]
```
por:
```ts
// "pauta": Grupo DRT escribe el source como "Pauta WhatsApp" / "Pauta Formulario"
// / "Pauta" (~85 % de sus oportunidades). Sin esta entrada, isDePauta dependía
// solo de la relación con el objeto Pauta, que un ~2 % de los leads no tiene.
export const PAID_SOCIAL_SOURCES = ["meta", "facebook", "instagram", "tiktok", "fb", "snapchat", "pinterest", "pauta"]
```
Efecto colateral deseado: el asistente (`lib/ai-tools.ts`, único otro consumidor de `isDePauta` en este fork) también cuenta esos leads como de pauta. (`origen-de-lead-criteria.tsx`, que CLAUDE.md menciona, ya no existe en este repo — corregir esa línea en Task 9.)

- [ ] **Step 3: Implementar `lib/meta-attribution.ts`**

```ts
// lib/meta-attribution.ts
// El cruce entre el gasto de Meta y las oportunidades del CRM. Puro: sin React,
// sin fetch. Lo prueba pnpm verify:meta-attribution y lo montan las cards de
// costo (entrega ②) y la pestaña PAUTA (entrega ③).
//
// Tres niveles de atribución de un lead, en orden, y nunca mezclados:
//   exact   — el AD ID (attributions[].utmAdId, o el custom field "ID Pauta").
//   byName  — sin id, el NOMBRE del ad (custom field "Nombre Pauta" de la opp,
//             o el registro Pauta del contacto) cuando ese nombre vive en UNA
//             sola campaña de Meta. Se cuenta aparte: es inferencia, no dato.
//   noAdId  — de pauta (isDePauta) pero sin nada que lo ate a un anuncio.
// Lo que no es de pauta (orgánico, referido, importado por CSV) es notPauta y
// jamás entra al costo por lead. Medido 2026-09-13: Palmyra y Zanda recibieron
// ~3 000 oportunidades por CSV el 28-31 de agosto; sin esta cubeta el costo por
// lead de agosto habría sido una mentira.
//
// El costo por etapa es por COHORTE DE CREACIÓN: gasto de la ventana ÷ leads
// creados en la ventana que alcanzaron la etapa. Con un ciclo de meses, el costo
// por venta de un periodo reciente siempre es alto; la UI lo dice en vez de fingir.
//
// No reparte gasto entre desarrollos, no convierte moneda y no toca lib/pauta.ts:
// isDePauta sigue siendo "es de pauta"; esto es "cuánto costó".
import type {
  MetaAccount,
  MetaAd,
  MetaAdset,
  MetaAdsData,
  MetaCampaign,
  MetaDailyRow,
  Opportunity,
  Pauta,
  Pipeline,
} from "./types";
import { desarrolloOf, NO_DESARROLLO, PANEL_SCOPES, resolvePipelineId, type PanelId } from "./panel-scope";
import { isWonOpp } from "./opportunity-status";
import { isDePauta, resolveCampaignName, SIN_NOMBRE_CAMPAIGN, type HasKey } from "./pauta";
import { PANEL_TIME_ZONE } from "./task-backlog";

/** Oportunidad de pauta sin ad id capturado: hueco de captura, en rojizo. */
export const NO_AD_ID = "Sin ad id";
/** Oportunidad con ad id que no está en ninguna cuenta conectada. */
export const UNKNOWN_AD = "Ad no conectado";

export type StageKey = "contactado" | "cita" | "visita" | "apartado" | "venta";

/** Las cinco etapas del embudo que se cobran, por su prefijo numérico en DRT. */
export const STAGE_TARGETS: { key: StageKey; label: string; minIndex: number }[] = [
  { key: "contactado", label: "Contactado", minIndex: 1 },
  { key: "cita", label: "Cita", minIndex: 4 },
  { key: "visita", label: "Visita", minIndex: 5 },
  { key: "apartado", label: "Apartado", minIndex: 7 },
  { key: "venta", label: "Venta", minIndex: 8 },
];

// ── Llave ───────────────────────────────────────────────────────────────────

function normalizeAdId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? s : null;
}

// "ID Pauta" (el poblado en DRT) e "ID de Pauta" (existe, casi vacío). Nunca
// "URL Pauta" ni "Nombre Pauta".
const AD_ID_FIELD = /^id\s*(de\s*)?pauta$/i;

// La attribution nativa manda: es lo que GHL recibió del click-to-WhatsApp; el
// custom field es una copia que escribe Make. Difieren en ~0.3 % de los casos.
export function oppAdId(opp: Opportunity): string | null {
  const own = normalizeAdId(opp.adId);
  if (own) return own;
  const cf = opp.customFieldsResolved;
  if (!cf) return null;
  for (const [name, val] of Object.entries(cf)) {
    if (!AD_ID_FIELD.test(name.trim())) continue;
    const id = normalizeAdId(Array.isArray(val) ? val[0] : val);
    if (id) return id;
  }
  return null;
}

// ── Índice ──────────────────────────────────────────────────────────────────

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface MetaIndex {
  byAd: Map<string, { ad: MetaAd; adset?: MetaAdset; campaign?: MetaCampaign; account?: MetaAccount }>;
  dailyByAd: Map<string, MetaDailyRow[]>;
  /** Nombre plegado (de ad o de campaña) → campañas donde aparece. Base del nivel byName. */
  byName: Map<string, Set<string>>;
}

export function buildMetaIndex(meta: MetaAdsData): MetaIndex {
  const accounts = new Map(meta.accounts.map((a) => [a.id, a]));
  const campaigns = new Map(meta.campaigns.map((c) => [c.id, c]));
  const adsets = new Map(meta.adsets.map((s) => [s.id, s]));
  const byAd: MetaIndex["byAd"] = new Map();
  const byName: MetaIndex["byName"] = new Map();
  const addName = (name: string, campaignId: string | undefined) => {
    if (!campaignId) return;
    const k = fold(name);
    if (!k) return;
    const set = byName.get(k) ?? new Set<string>();
    set.add(campaignId);
    byName.set(k, set);
  };
  for (const ad of meta.ads) {
    const adset = adsets.get(ad.adsetId);
    const campaign = adset ? campaigns.get(adset.campaignId) : undefined;
    const account = campaign ? accounts.get(campaign.accountId) : undefined;
    byAd.set(ad.id, { ad, adset, campaign, account });
    addName(ad.name, campaign?.id);
  }
  for (const c of meta.campaigns) addName(c.name, c.id);
  const dailyByAd = new Map<string, MetaDailyRow[]>();
  for (const d of meta.daily) {
    const arr = dailyByAd.get(d.adId) ?? [];
    arr.push(d);
    dailyByAd.set(d.adId, arr);
  }
  return { byAd, dailyByAd, byName };
}

/** contactIds con al menos un registro Pauta — la mitad "objeto" de isDePauta. */
export function buildPautaContacts(pautas: Pauta[]): Set<string> {
  const s = new Set<string>();
  for (const p of pautas) if (p.contactId) s.add(p.contactId);
  return s;
}

// ── Clasificación de un lead ────────────────────────────────────────────────

export type LeadAttribution =
  | { kind: "exact"; adId: string; campaignId: string | null }
  | { kind: "byName"; name: string; campaignId: string }
  | { kind: "unknownAd"; adId: string }
  | { kind: "noAdId" }
  | { kind: "notPauta" };

export interface AttributionContext {
  index: MetaIndex;
  pautaContacts: HasKey;
  /** buildPautaNameByContact(allPautas), de lib/pauta.ts. */
  pautaNameByContact: Map<string, string>;
}

// Una importación masiva no es un lead de pauta aunque traiga ad id copiado.
function isImported(opp: Opportunity): boolean {
  return (opp.attributionMedium ?? "").toLowerCase() === "csv_import";
}

export function classifyLead(opp: Opportunity, ctx: AttributionContext): LeadAttribution {
  if (isImported(opp)) return { kind: "notPauta" };
  const adId = oppAdId(opp);
  if (adId) {
    const hit = ctx.index.byAd.get(adId);
    return hit ? { kind: "exact", adId, campaignId: hit.campaign?.id ?? null } : { kind: "unknownAd", adId };
  }
  // Sin id: el nombre del ad, si es inequívoco. resolveCampaignName ya recorre
  // utmCampaign → "Nombre Pauta" → utmContent → registro Pauta del contacto.
  const name = resolveCampaignName(opp, ctx.pautaNameByContact);
  if (name && name !== SIN_NOMBRE_CAMPAIGN) {
    const campaigns = ctx.index.byName.get(fold(name));
    if (campaigns && campaigns.size === 1) {
      return { kind: "byName", name, campaignId: [...campaigns][0] };
    }
  }
  return isDePauta(opp, ctx.pautaContacts) || !!name ? { kind: "noAdId" } : { kind: "notPauta" };
}

// ── Desarrollo de cada ad ───────────────────────────────────────────────────

// 1) la moda de los pipelines de sus leads (sobre el set SIN filtrar); 2) el
// nombre de un desarrollo en campaña → adset → ad; 3) Sin desarrollo. El gasto
// no se reparte: un ad es de UN desarrollo. `mixed` lista los ads con leads en
// más de un desarrollo, para que la UI lo diga en vez de callarlo.
//
// El fallback por nombre devuelve el nombre REAL del pipeline (el mismo string
// que desarrolloOf), no la etiqueta de PANEL_SCOPES: scopeMetaDaily compara
// contra el pipeline, y una etiqueta distinta haría desaparecer esos ads del tab.
export function assignAdDesarrollos(
  meta: MetaAdsData,
  index: MetaIndex,
  allOpportunities: Opportunity[],
  pipelines: Pipeline[] | undefined
): { byAd: Map<string, string>; mixed: string[] } {
  const votes = new Map<string, Map<string, number>>();
  for (const o of allOpportunities) {
    if (isImported(o)) continue;
    const adId = oppAdId(o);
    if (!adId || !index.byAd.has(adId)) continue;
    const d = desarrolloOf(o, pipelines);
    if (d === NO_DESARROLLO) continue;
    const m = votes.get(adId) ?? new Map<string, number>();
    m.set(d, (m.get(d) ?? 0) + 1);
    votes.set(adId, m);
  }

  // Agujas para el fallback por nombre: el nombre de cada pipeline (así un
  // séptimo desarrollo aparece sin tocar PANEL_SCOPES) más las etiquetas de
  // PANEL_SCOPES resueltas a su pipeline real. El valor siempre es el string que
  // devolvería desarrolloOf, para que scopeMetaDaily lo encuentre.
  const needles = new Map<string, string>();
  for (const p of pipelines ?? []) {
    const name = p.name?.trim();
    if (name) needles.set(fold(name), name);
  }
  for (const panel of Object.keys(PANEL_SCOPES) as PanelId[]) {
    const scope = PANEL_SCOPES[panel];
    if (scope.pipelineId === null) continue;
    const pipelineId = resolvePipelineId(pipelines, panel);
    const real = pipelines?.find((x) => x.id === pipelineId)?.name?.trim();
    const k = fold(scope.label);
    if (!needles.has(k)) needles.set(k, real || scope.label);
  }
  // Las agujas más largas primero: "cañadas by el mirador" antes que "cañadas".
  const labels = [...needles.entries()]
    .map(([folded, name]) => ({ folded, name }))
    .sort((a, b) => b.folded.length - a.folded.length);

  const byAd = new Map<string, string>();
  const mixed: string[] = [];
  for (const ad of meta.ads) {
    const v = votes.get(ad.id);
    if (v && v.size > 0) {
      if (v.size > 1) mixed.push(ad.id);
      let best = "";
      let bestN = -1;
      for (const [d, n] of v) {
        if (n > bestN || (n === bestN && d.localeCompare(best, "es") < 0)) {
          best = d;
          bestN = n;
        }
      }
      byAd.set(ad.id, best);
      continue;
    }
    const entry = index.byAd.get(ad.id);
    const haystack = fold([entry?.campaign?.name, entry?.adset?.name, ad.name].filter(Boolean).join(" | "));
    const hit = labels.find((l) => haystack.includes(l.folded));
    byAd.set(ad.id, hit ? hit.name : NO_DESARROLLO);
  }
  return { byAd, mixed };
}

// Misma convención que scopeOpportunities: GENERAL devuelve el array original.
export function scopeMetaDaily(
  meta: MetaAdsData,
  desarrolloByAd: Map<string, string>,
  panel: PanelId,
  pipelines: Pipeline[] | undefined
): MetaDailyRow[] {
  if (panel === "general") return meta.daily;
  const pipelineId = resolvePipelineId(pipelines, panel);
  const name = pipelines?.find((p) => p.id === pipelineId)?.name?.trim() || PANEL_SCOPES[panel].label;
  return meta.daily.filter((d) => desarrolloByAd.get(d.adId) === name);
}

// ── Cohorte y etapas ────────────────────────────────────────────────────────

export function localDay(iso: string, timeZone: string = PANEL_TIME_ZONE): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// "05. Visita al Desarrollo" → 5. Los side buckets no tienen prefijo → null.
export function stageIndexOf(stage: string | undefined): number | null {
  const m = /^\s*(\d{1,2})\s*\./.exec(stage ?? "");
  return m ? Number(m[1]) : null;
}

export function reachedStage(opp: Opportunity, target: { key: StageKey; minIndex: number }): boolean {
  if (target.key === "venta" && isWonOpp(opp)) return true;
  const idx = stageIndexOf(opp.stage);
  return idx !== null && idx >= target.minIndex;
}

function inRange(day: string, range: { start: string; end: string } | null): boolean {
  if (!range) return true;
  return day >= range.start && day <= range.end;
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

interface CostInput {
  opportunities: Opportunity[];
  daily: MetaDailyRow[];
  ctx: AttributionContext;
  accounts: MetaAccount[];
  /** YYYY-MM-DD inclusivo, en la zona horaria del panel; null = toda la ventana. */
  range: { start: string; end: string } | null;
}

export interface CostPerStage {
  spendByCurrency: Record<string, number>;
  mixedCurrency: boolean;
  /** exact + byName: los que entran a la cohorte. */
  leadsCrm: number;
  leadsExact: number;
  leadsByName: number;
  leadsMeta: number;
  /** De pauta, sin ad id ni nombre resoluble. */
  noAdId: number;
  /** Con ad id que no está en ninguna cuenta conectada. */
  unknownAdLeads: number;
  /** Orgánicos, referidos, importados: fuera del costo por definición. */
  notPauta: number;
  stages: { key: StageKey; label: string; reached: number; costPerResult: number | null; oppIds: string[] }[];
}

function currencyOfAd(index: MetaIndex, adId: string): string {
  return index.byAd.get(adId)?.account?.currency || "";
}

export function buildCostPerStage(p: CostInput): CostPerStage {
  const spendByCurrency: Record<string, number> = {};
  let leadsMeta = 0;
  for (const d of p.daily) {
    if (!inRange(d.date, p.range)) continue;
    const cur = currencyOfAd(p.ctx.index, d.adId);
    spendByCurrency[cur] = (spendByCurrency[cur] ?? 0) + d.spend;
    leadsMeta += d.leadsForm + d.leadsMsg;
  }
  const currencies = Object.keys(spendByCurrency);
  const mixedCurrency = currencies.length > 1;
  const totalSpend = mixedCurrency ? null : (spendByCurrency[currencies[0] ?? ""] ?? 0);

  let leadsExact = 0;
  let leadsByName = 0;
  let noAdId = 0;
  let unknownAdLeads = 0;
  let notPauta = 0;
  const cohort: Opportunity[] = [];
  for (const o of p.opportunities) {
    if (!inRange(localDay(o.createdAt), p.range)) continue;
    const a = classifyLead(o, p.ctx);
    switch (a.kind) {
      case "exact":
        leadsExact++;
        cohort.push(o);
        break;
      case "byName":
        leadsByName++;
        cohort.push(o);
        break;
      case "unknownAd":
        unknownAdLeads++;
        break;
      case "noAdId":
        noAdId++;
        break;
      case "notPauta":
        notPauta++;
        break;
    }
  }

  const stages = STAGE_TARGETS.map((t) => {
    const hit = cohort.filter((o) => reachedStage(o, t));
    return {
      key: t.key,
      label: t.label,
      reached: hit.length,
      costPerResult: totalSpend === null ? null : ratio(totalSpend, hit.length),
      oppIds: hit.map((o) => o.id),
    };
  });

  return {
    spendByCurrency,
    mixedCurrency,
    leadsCrm: leadsExact + leadsByName,
    leadsExact,
    leadsByName,
    leadsMeta,
    noAdId,
    unknownAdLeads,
    notPauta,
    stages,
  };
}

// ── Por campaña ─────────────────────────────────────────────────────────────

export interface CampaignPerformanceRow {
  campaignId: string;
  name: string;
  accountId: string;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  cpm: number | null;
  ctr: number | null;
  leadsMeta: number;
  /** exact + byName. */
  leadsCrm: number;
  leadsByName: number;
  reached: Record<StageKey, number>;
  cpl: number | null;
  costPerApartado: number | null;
  costPerVenta: number | null;
  adIds: string[];
}

export function buildCampaignPerformance(p: CostInput): CampaignPerformanceRow[] {
  const rows = new Map<string, CampaignPerformanceRow>();
  const rowFor = (campaignId: string): CampaignPerformanceRow => {
    let r = rows.get(campaignId);
    if (!r) {
      const c = [...p.ctx.index.byAd.values()].find((e) => e.campaign?.id === campaignId);
      r = {
        campaignId,
        name: c?.campaign?.name ?? campaignId,
        accountId: c?.campaign?.accountId ?? "",
        currency: c?.account?.currency ?? "",
        spend: 0,
        impressions: 0,
        clicks: 0,
        cpm: null,
        ctr: null,
        leadsMeta: 0,
        leadsCrm: 0,
        leadsByName: 0,
        reached: { contactado: 0, cita: 0, visita: 0, apartado: 0, venta: 0 },
        cpl: null,
        costPerApartado: null,
        costPerVenta: null,
        adIds: [],
      };
      rows.set(campaignId, r);
    }
    return r;
  };

  for (const d of p.daily) {
    if (!inRange(d.date, p.range)) continue;
    const cid = p.ctx.index.byAd.get(d.adId)?.campaign?.id;
    if (!cid) continue;
    const r = rowFor(cid);
    r.spend += d.spend;
    r.impressions += d.impressions;
    r.clicks += d.clicks;
    r.leadsMeta += d.leadsForm + d.leadsMsg;
    if (!r.adIds.includes(d.adId)) r.adIds.push(d.adId);
  }

  for (const o of p.opportunities) {
    if (!inRange(localDay(o.createdAt), p.range)) continue;
    const a = classifyLead(o, p.ctx);
    if (a.kind !== "exact" && a.kind !== "byName") continue;
    if (!a.campaignId || !rows.has(a.campaignId)) continue;
    const r = rows.get(a.campaignId)!;
    r.leadsCrm++;
    if (a.kind === "byName") r.leadsByName++;
    for (const t of STAGE_TARGETS) if (reachedStage(o, t)) r.reached[t.key]++;
  }

  for (const r of rows.values()) {
    r.cpm = r.impressions > 0 ? (r.spend / r.impressions) * 1000 : null;
    r.ctr = ratio(r.clicks, r.impressions);
    r.cpl = ratio(r.spend, r.leadsCrm);
    r.costPerApartado = ratio(r.spend, r.reached.apartado);
    r.costPerVenta = ratio(r.spend, r.reached.venta);
  }

  return [...rows.values()].sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name, "es"));
}
```

- [ ] **Step 4: Correr el verify y tsc**

Run: `pnpm verify:meta-attribution`
Expected: `✅ verify:meta-attribution OK`

Run: `npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 5: Commit**

```bash
git add lib/meta-attribution.ts scripts/verify-meta-attribution.ts lib/pauta.ts package.json
git commit -m "feat(meta): cruce por ad id con fallback por nombre, cohorte clasificada y desarrollo por ad"
```

---

### Task 8: `components/dashboard/meta-connection.tsx` — la píldora del header

**Files:**
- Create: `components/dashboard/meta-connection.tsx`
- Modify: `app/page.tsx` (junto al botón "Actualizar", ~línea 431)

**Interfaces:**
- Consumes: el contrato HTTP de Task 5; `SyncWarning[]` del payload (`data.warnings`); `refresh()` de `useDashboardData`.
- Produces: `<MetaConnectionPill warnings={data?.warnings ?? []} onConnected={() => refresh()} />`.

- [ ] **Step 1: Implementar el componente**

```tsx
// components/dashboard/meta-connection.tsx
// La píldora "Meta" del header: conectar, ver cuántas cuentas hay, elegir cuáles
// entran al panel, reconectar o desconectar. Es el ÚNICO lugar de la UI que
// sabe del OAuth; las cards de costo (entrega ②) solo miran data.metaAds.
"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Check, ChevronDown, Loader2, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { SyncWarning } from "@/lib/types"

interface AccountRow {
  id: string
  name: string
  currency: string
  status: number
  selected: boolean
}

type ConnectionState =
  | { connected: false; reason?: "not_configured" | "no_db" | "preview" }
  | {
      connected: true
      connectedBy: string | null
      connectedAt: string
      tokenKind: "system_user" | "user"
      tokenExpiresAt: string | null
      accounts: AccountRow[]
    }

const ERROR_COPY: Record<string, string> = {
  state_invalid: "La conexión expiró. Inténtalo de nuevo.",
  denied: "Conexión cancelada.",
  token_exchange: "Meta no aceptó la autorización. Inténtalo de nuevo.",
  token_invalid: "Meta devolvió un token inválido. Inténtalo de nuevo.",
  no_accounts: "Esa empresa no compartió cuentas publicitarias.",
  db: "No se pudo guardar la conexión.",
}

const DISABLED_COPY: Record<NonNullable<Extract<ConnectionState, { connected: false }>["reason"]>, string> = {
  not_configured: "Meta no configurado",
  no_db: "Requiere base de datos",
  preview: "Conecta desde producción",
}

export function MetaConnectionPill({
  warnings,
  onConnected,
}: {
  warnings: SyncWarning[]
  onConnected: () => void
}) {
  const [state, setState] = useState<ConnectionState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/meta/connection")
      if (res.ok) setState((await res.json()) as ConnectionState)
    } catch {
      /* la píldora simplemente no aparece */
    }
  }, [])

  // Al montar, y al regresar del callback (?meta=connected | error).
  useEffect(() => {
    void load()
    const url = new URL(window.location.href)
    const meta = url.searchParams.get("meta")
    if (!meta) return
    const reason = url.searchParams.get("reason") ?? ""
    url.searchParams.delete("meta")
    url.searchParams.delete("reason")
    window.history.replaceState(null, "", url.toString())
    if (meta === "connected") {
      setNotice("Meta conectado")
      onConnected()
    } else {
      setNotice(ERROR_COPY[reason] ?? "No se pudo conectar con Meta.")
    }
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
    // onConnected cambia de identidad en cada render de page.tsx; solo interesa al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const revoked = warnings.some(
    (w) => w.key === "meta" && (w.reason === "token_revoked" || w.reason === "token_unreadable")
  )

  const openDialog = () => {
    if (!state?.connected) return
    setDraft(state.accounts.filter((a) => a.selected).map((a) => a.id))
    setDialogOpen(true)
  }

  const saveAccounts = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/meta/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: draft }),
      })
      if (res.ok) {
        setDialogOpen(false)
        await load()
        onConnected()
      } else {
        setNotice("Elige al menos una cuenta.")
      }
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async () => {
    if (!window.confirm("¿Desconectar Meta? El gasto dejará de actualizarse. Esto no revoca el acceso en Meta; eso se hace desde el Business Manager.")) return
    await fetch("/api/meta/connection", { method: "DELETE" })
    await load()
    onConnected()
  }

  if (!state) return null

  const pillClass = "h-8 gap-1.5 rounded-lg border-white/20 bg-white/10 text-xs font-medium text-white hover:bg-white/15"

  if (!state.connected) {
    const disabled = state.reason ? DISABLED_COPY[state.reason] : null
    return (
      <div className="flex items-center gap-2">
        {notice && <span className="text-xs text-white/80">{notice}</span>}
        <Button variant="outline" size="sm" className={pillClass} disabled={!!disabled} asChild={!disabled}>
          {disabled ? (
            <span>{disabled}</span>
          ) : (
            <a href="/api/meta/connect">Conectar con Meta</a>
          )}
        </Button>
      </div>
    )
  }

  const selected = state.accounts.filter((a) => a.selected)

  return (
    <div className="flex items-center gap-2">
      {notice && <span className="text-xs text-white/80">{notice}</span>}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={`${pillClass} ${revoked ? "border-red-400/60 text-red-200" : ""}`}
          >
            {revoked ? <AlertTriangle className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
            {revoked ? "Meta desconectado" : `Meta · ${selected.length} ${selected.length === 1 ? "cuenta" : "cuentas"}`}
            <ChevronDown className="h-3 w-3 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-2 text-sm">
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {state.connectedBy ? `Conectado por ${state.connectedBy}` : "Conectado"} ·{" "}
            {new Date(state.connectedAt).toLocaleDateString("es-MX")}
          </p>
          {revoked && (
            <p className="px-2 py-1 text-xs text-red-600 dark:text-red-400">
              La empresa revocó el acceso o el token dejó de ser válido.
            </p>
          )}
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={openDialog}>
            Cambiar cuentas
          </Button>
          <Button variant="ghost" size="sm" className="w-full justify-start" asChild>
            <a href="/api/meta/connect">Reconectar</a>
          </Button>
          <Button variant="ghost" size="sm" className="w-full justify-start text-red-600" onClick={disconnect}>
            <Unplug className="mr-1.5 h-3.5 w-3.5" /> Desconectar
          </Button>
        </PopoverContent>
      </Popover>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cuentas publicitarias</DialogTitle>
            <DialogDescription>
              De las cuentas que la empresa compartió, elige cuáles entran al panel. Para compartir
              más cuentas, vuelve a conectar.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {state.accounts.map((a) => (
              <label key={a.id} className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={draft.includes(a.id)}
                  onCheckedChange={(v) =>
                    setDraft((d) => (v ? [...d, a.id] : d.filter((x) => x !== a.id)))
                  }
                />
                <span className="flex-1 truncate">{a.name}</span>
                <span className="text-xs text-muted-foreground">
                  {a.id} · {a.currency}
                  {a.status !== 1 ? " · inactiva" : ""}
                </span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveAccounts} disabled={saving || draft.length === 0}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Guardar y sincronizar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

- [ ] **Step 2: Montar en `app/page.tsx`**

Import:
```ts
import { MetaConnectionPill } from "@/components/dashboard/meta-connection"
```
Justo **antes** del `<Button ... onClick={() => refresh()}>` de "Actualizar" (línea ~431):
```tsx
            <MetaConnectionPill warnings={data?.warnings ?? []} onConnected={() => refresh()} />
```

- [ ] **Step 3: Probar en el navegador**

Run: `npx tsc --noEmit` → sin salida. Run: `pnpm dev`.
1. Sin fila: la píldora dice **Conectar con Meta** y enlaza a `/api/meta/connect`.
2. Con fila: **Meta · N cuentas**; el popover muestra quién conectó; "Cambiar cuentas" abre el diálogo con checkboxes; desmarcar todas deshabilita Guardar; guardar una dispara el sync (`RefreshCw` gira) y el conteo cambia.
3. Con warning `token_revoked` (simulado como en Task 6, paso 6.5): píldora roja **Meta desconectado**.
4. Desconectar → confirm → vuelve a "Conectar con Meta".
5. Abrir `/?meta=error&reason=no_accounts` → aviso "Esa empresa no compartió cuentas publicitarias." que desaparece y limpia la URL.
6. Ancho móvil (~400px): la píldora no rompe el header (si estorba, esconder el texto con `hidden sm:inline` como hace "Actualizar").

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/meta-connection.tsx app/page.tsx
git commit -m "feat(meta): píldora de conexión con Meta en el encabezado"
```

---

### Task 9: documentación — CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (Commands, Environment Variables, nueva subsección en Architecture, tabla de "Shared domain rules")

- [ ] **Step 1: Commands**

En el bloque de `pnpm verify:*`, después de `verify:sync-store`:
```
pnpm verify:meta-oauth   # lib/meta-oauth.ts — state firmado, cifrado del token, URL del diálogo
pnpm verify:meta-connection-store # lib/meta-connection-store.ts — fila por (cliente, producto); usa la base si hay DATABASE_URL
pnpm verify:meta         # lib/meta-normalize.ts — actions, chunks por mes, ventana de historia
pnpm verify:meta-attribution # lib/meta-attribution.ts — llave por ad id, desarrollo por ad, costo por etapa
```
Y en la línea de `pnpm db:migrate`: `# crea project_sync y meta_connection — idempotente…`.

- [ ] **Step 2: Environment Variables**

Después del bloque "Optional (the sync cache…)":
```
Optional (Meta Ads — see "Meta Ads" below):
- `META_APP_ID` / `META_APP_SECRET` / `META_LOGIN_CONFIG_ID` — the Lezgo Meta app
  (`Paneles Lezgo Suite`, app id `1432292882099074`, Login for Business config
  `1047096268324910`). **Lezgo's, not the client's** — never in `DASHBOARD_CLIENTS`.
  Absent = the "Conectar con Meta" button is disabled and the sync skips Meta.
- `META_PUBLIC_ORIGIN` — optional; pins the OAuth `redirect_uri` origin in
  production (`https://drt.lezgosuite.com`). Without it the request origin is used
  (fine for localhost).
```

- [ ] **Step 3: Nueva subsección `### Meta Ads` en Architecture**, después de "Caché de sincronización (Neon Postgres)":

```markdown
### Meta Ads

Spec: `docs/superpowers/specs/2026-09-13-meta-ads-conexion-y-sync-design.md`. Entrega ①
(conexión + dataset + cruce) está implementada; ② (card "Inversión en pauta" por tab) y
③ (pestaña PAUTA) tienen spec pendiente.

- **La llave es el ad id.** Cada oportunidad de pauta trae `utmAdId` (→ `opp.adId`) y el
  custom field `ID de Pauta`, que es el id del anuncio en la Marketing API tal cual.
  `oppAdId()` en `lib/meta-attribution.ts` es la única función que lo lee; nunca cruces
  por nombre cuando hay id.
- **La conexión es un botón** (`meta-connection.tsx` → `app/api/meta/*`): OAuth de
  Facebook Login for Business con configuración de **usuario del sistema**, así que el
  token no caduca y lo que se conecta es la empresa del cliente. El token vive cifrado
  (AES-GCM, llave derivada de `DASHBOARD_AUTH_SECRET`) en `meta_connection`, una fila
  por `(client_id, product)`. **Esa fila no es desechable**: si se borra hay que
  reconectar. `product` existe para que WhatsApp entre después en la misma app.
- **El `state` del OAuth lleva el `clientId` firmado** y el callback exige que sea el
  del cliente logueado — misma garantía que la cookie. `verify:meta-oauth` lo asserta.
- **`metaAds` es un dataset más del sync** (`lib/sync.ts`, paso `meta`), que corre
  DESPUÉS de `opportunities` porque la ventana de historia sale de la oportunidad más
  antigua con ad id. Cae en el caché de Neon como todo. **Sin conexión el paso no se
  emite y `metaAds` es `null`** — no es un error ni levanta banner. Con token revocado
  (código 190) el paso es `error` con `reason: "token_revoked"`, y la ruta rescata el
  `metaAds` del último caché bueno (`preserveMetaAds`) para no borrar el gasto en
  pantalla.
- **Cada sync re-trae la ventana completa** (desde el mes de la opp más vieja con ad id,
  tope 24 meses, por meses calendario). Sin merge incremental: Meta corrige cifras
  hacia atrás y el caché no guarda historia.
- **De `actions` solo salen dos contadores**: `lead` (formularios) y
  `onsite_conversion.messaging_conversation_started_7d` (WhatsApp) — los dos `source`
  de DRT. `leadsMeta` vs `leadsCrm` es una reconciliación, no un duplicado.
- **Tres niveles de atribución de un lead, nunca mezclados** (`classifyLead`): `exact`
  por ad id (`opp.adId` de la attribution nativa manda; el custom field **`ID Pauta`** —
  así se llama el poblado, `ID de Pauta` existe casi vacío — es el fallback); `byName`
  cuando no hay id pero el nombre del ad (`Nombre Pauta` de la opp o `nombre_de_la_pauta`
  del registro Pauta del contacto) vive en UNA sola campaña de Meta; `noAdId` si es de
  pauta y no hay nada; `notPauta` para orgánicos, referidos e **importados por CSV**
  (`attributions[].medium === "csv_import"`, que gana incluso con ad id). Solo los dos
  primeros entran al costo. Medido 2026-09-13: 63 % con ad id; el objeto Pauta no trae
  ad id pero sí `nombre_de_la_pauta` (94 %), `desarrollo` y `formulario` al 100 %.
- **Palmyra y Zanda ya no están en cero: ~1 559 y ~1 433 oportunidades cargadas por CSV
  el 28-31 de agosto de 2026**, sin `source` ni ad id. Son base de datos, no leads de
  pauta; la cubeta `notPauta` existe para que no se cuelen al costo por lead. La tabla
  de "Six developments" arriba quedó vieja en ese renglón.
- **El desarrollo de un ad se infiere** (`assignAdDesarrollos`): moda de los pipelines de
  sus leads (los importados no votan), luego el nombre de un pipeline o etiqueta de
  `PANEL_SCOPES` en campaña/adset/ad (agujas largas primero), luego `Sin desarrollo`.
  Devuelve `mixed` (ads con leads en más de un desarrollo) para que la UI lo diga. **El
  gasto no se reparte** entre desarrollos ni se convierte de moneda (`mixedCurrency`
  apaga los costos consolidados). El valor siempre es el nombre real del pipeline —
  el mismo string de `desarrolloOf` — para que `scopeMetaDaily` lo encuentre.
- **`isDePauta` ahora reconoce `source: "Pauta …"`** (`"pauta"` en `PAID_SOCIAL_SOURCES`):
  antes dependía solo de la relación con el objeto Pauta. `origen-de-lead-criteria.tsx`
  ya no existe en este fork; la línea de arriba que lo menciona es herencia del panel
  compartido.
- **El callback OAuth exige la cookie `meta_oauth`** con el nonce del `state`: sin ella,
  quien conozca la contraseña del panel podría iniciar el flujo con su propio Meta y
  fijarle al cliente una conexión ajena. Y si `DASHBOARD_AUTH_SECRET` rota, el token deja
  de descifrar: el paso `meta` reporta `error` con `reason: "token_unreadable"` (no
  calla), y el banner pide reconectar.
- **Costo por etapa = cohorte de creación**: gasto de la ventana ÷ oportunidades
  creadas en la ventana (día local CDMX) que alcanzaron la etapa; "alcanzó" es el
  prefijo numérico de la etapa actual ≥ el objetivo (una perdida en `05.` sí alcanzó
  Visita), Venta también cuenta `isWonOpp`. Sin alcanzados → `null`, nunca `$0`.
- `lib/meta-client.ts` es **server-only** como `ghl-client.ts`. Lo puro está en
  `meta-normalize.ts` y `meta-attribution.ts`.
- **Localhost no puede completar el OAuth** (la app publicada rechaza `http://localhost`):
  se conecta una vez desde producción y el dev local lee la misma fila de Neon.
  Previews de Vercel tampoco (`?error=preview`). Si hace falta iterar las rutas OAuth en
  local, crear la **app de prueba** hija en Meta y poner sus credenciales en `.env.local`.
```

- [ ] **Step 4: Tabla de módulos**

En "Shared domain rules", agregar filas:
```
| `lib/meta-normalize.ts` | de la respuesta cruda de Graph a `MetaAdsData`; ventana de historia y chunks por mes |
| `lib/meta-attribution.ts` | la llave por ad id, el desarrollo de cada ad, el costo por etapa por cohorte y el rendimiento por campaña |
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(meta): sección Meta Ads en CLAUDE.md, comandos y variables"
```

---

## Self-review

**Revisión 2026-09-13 (doble chequeo pedido por el usuario: fugas, seguridad, cruce entre desarrollos, fallback sin ad id).** Cambios que produjo, ya integrados arriba:

1. `oppAdId` hacía match exacto con "id de pauta"; el campo poblado es **`ID Pauta`**. Ahora `/^id\s*(de\s*)?pauta$/i`, y la attribution nativa manda cuando difieren (30 casos medidos).
2. Nuevo nivel **`byName`** (nombre del ad → campaña única) y clasificación explícita de la cohorte (`exact | byName | unknownAd | noAdId | notPauta`), con `csv_import` como `notPauta` incondicional. Motivado por los ~3 000 registros importados a Palmyra/Zanda el 28-31 de agosto.
3. `isDePauta` no reconocía `source: "Pauta …"`; se agrega `"pauta"` a `PAID_SOCIAL_SOURCES` en la fuente de verdad.
4. **Fijación de conexión**: cookie `meta_oauth` con el nonce, exigida en el callback.
5. **Secreto rotado**: `readMetaConnectionWithToken` devuelve `token: null` en vez de `null`; el sync emite `error` / `token_unreadable`; banner y píldora lo tratan como "reconectar".
6. Logs de fallo de cuenta imprimen solo `err.message` (un `TypeError` de fetch trae la URL con token en `cause`).
7. `assignAdDesarrollos` devuelve `{ byAd, mixed }`, resuelve el fallback por nombre al **nombre real del pipeline** (mismo string que `desarrolloOf`, para que `scopeMetaDaily` coincida) y usa los pipelines cargados como agujas (un séptimo desarrollo funciona sin tocar `PANEL_SCOPES`); los importados no votan.
8. El bloque `meta` del sync se movió **después del transform** para usar `oppAdId` sobre oportunidades normalizadas.
9. `origen-de-lead-criteria.tsx` no existe en este fork; se quitó de los archivos a tocar y se corrige la mención en CLAUDE.md.

Revisado y sin cambios: el token no viaja en frames ni en `/api/meta/connection`; `graphGetAll` quita `access_token` del `paging.next`; `MetaApiError` cita ruta y código, no URL; HMAC del state y llave AES salen del mismo secreto por HKDF con `info` distinto; `back()` solo redirige a `/`; toda ruta pasa por `requireClient()`; la tabla se indexa por `client.id`; `preserveMetaAds` lee la fila del mismo cliente. Limitación conocida que se documenta en ②: `daily.date` está en la zona horaria de la **cuenta publicitaria**; si una cuenta no está en `America/Mexico_City`, el corte diario contra `createdAt` se desfasa hasta un día (`MetaAccount.timezone` lo expone para avisarlo).

**Spec coverage.**
- Conexión OAuth (usuario del sistema, `config_id`, sin scope) → Task 1 + 5. ✔
- `meta_connection` con `product`, token cifrado, `token_kind`/`token_expires_at`, `available`/`selected`, `connected_at` conservado al reconectar → Task 2. ✔
- Rutas `connect`/`callback`/`connection`/`accounts`/`DELETE`, códigos de error, preview 409, sin env 503, cookie de nonce → Task 5. ✔
- `business_id`: la columna existe; el callback lo deja en `null` porque `/me` de un token de usuario del sistema no lo expone directo y no hay consumidor en ①. WhatsApp lo llenará. ✔ (desviación menor, consciente)
- Cliente Graph: tres llamadas, chunk mensual, concurrencia 2, reintentos en 4/17/32/613/80004 y 5xx, 190 terminal, cuenta fallida aislada → Task 4. ✔
- Ventana de historia (mes de la opp más vieja con ad id, tope 24 m, hoy en CDMX) → Task 3 + 6. ✔
- Payload `metaAds`, tablas planas, `failedAccounts`, `SyncWarning.reason` → Task 3. ✔
- Paso `meta` después del transform, no emitido sin conexión, `partial`/`error`/`token_unreadable`, rescate del último bueno, token nunca en frames → Task 6. ✔
- Loading row + banner copy → Task 6. ✔
- Cruce: llave, índice con `byName`, `classifyLead`, desarrollo por moda/nombre/`Sin desarrollo` + `mixed`, `scopeMetaDaily` con misma referencia en GENERAL, cohorte con día local, `reachedStage`, `null` sin división, `unknownAdLeads`/`noAdId`/`notPauta`, moneda mixta, `buildCampaignPerformance` ordenado por gasto → Task 7. ✔ (La agrupación por familia con `groupCampaignsByFamily` la hace la UI de ③ sobre estas filas.)
- Píldora: conectar / N cuentas / cambiar / reconectar / desconectar / revocado o ilegible en rojo / avisos de `?meta=` / deshabilitada en preview, sin env, sin base → Task 8. ✔
- Env vars y docs → Task 5 (`.env.example`) + Task 9 (`CLAUDE.md`). ✔
- Verify scripts: `meta-oauth`, `meta-connection-store`, `meta`, `meta-attribution` → Tasks 1, 2, 3, 7. ✔
- Prueba contra realidad (cuadrar gasto con el Administrador de anuncios, fijación sin cookie, secreto rotado, Postgres caído) → Task 5 paso 6 y Task 6 paso 6. ✔

**Placeholder scan.** Sin TBD/TODO. Cada paso de código trae el código. El único "si X entonces Y" abierto es el denominador de la barra de progreso en Task 6 paso 3, que depende de cómo esté calculado hoy en `loading-screen.tsx`; el paso dice exactamente qué hacer en cada caso.

**Type consistency.** `MetaProduct` se define en `meta-oauth.ts` y lo importan el store y las rutas. `MetaAccountInfo` (store, con `status`) ≠ `MetaAccount` (payload, sin `status`): `fetchAccount` en Task 4 hace la proyección explícita. `SyncWarning` con `reason` se define en `lib/types.ts` y el hook lo re-exporta. `StageKey`/`STAGE_TARGETS`/`AttributionContext`/`classifyLead` se usan con los mismos nombres en Task 7 y en su verify. `readMetaConnectionWithToken` (token `string | null`) es lo que llama el sync; `readMetaConnection` lo que llama la ruta de estado. `CostInput.ctx` reemplaza al antiguo `index` en `buildCostPerStage` y `buildCampaignPerformance`.
