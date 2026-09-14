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
