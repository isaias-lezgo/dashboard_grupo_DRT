// lib/sync-store.ts
// El caché: una fila por cliente con el payload completo del dashboard, gzipeado.
//
// El caché es DESECHABLE por diseño. Se sobrescribe entero en cada sync y guarda
// solo el presente, nunca historia — si se borra la tabla, se rellena sola desde
// GHL y no se pierde nada. Esa propiedad es lo que lo mantiene en UNA tabla en vez
// de un esquema, y también lo que evita acumular datos personales históricos.
//
// bytea + gzip en vez de jsonb: nunca consultamos dentro del payload, lo mandamos
// entero. El JSON de este panel comprime ~10x.
import { gzipSync, gunzipSync } from "node:zlib";
import { getSql } from "./db";
import type { ClientConfig } from "./clients";
import type { DashboardPayload } from "./types";

// Cuánto puede envejecer un payload antes de que una visita dispare el refresco
// en segundo plano.
export const FRESH_WINDOW_MS = 15 * 60 * 1000;

// Cuánto puede correr un sync con el candado tomado antes de que otra petición
// pueda quitárselo. Se auto-sana: una función que muere a medio sync no debe
// congelar al cliente para siempre.
const LOCK_TIMEOUT_MINUTES = 10;

export function isStale(syncedAt: string | Date, now: Date = new Date()): boolean {
  const then = syncedAt instanceof Date ? syncedAt : new Date(syncedAt);
  const age = now.getTime() - then.getTime();
  // Una edad negativa significa que el reloj puso synced_at en el futuro.
  // Trátalo como fresco: resincronizar en cada visita sería peor que confiar en
  // la fila.
  if (age < 0) return false;
  return age >= FRESH_WINDOW_MS;
}

// Todas estas funciones reciben el ClientConfig, nunca un string suelto. Leer la
// fila equivocada renderizaría el dashboard de A con datos de B — la misma clase
// de fuga que lib/ghl-context.ts existe para evitar — así que la firma exige un
// cliente ya resuelto por requireClient() para poder llamarlas siquiera.

/**
 * Qué caché de ese cliente. `dashboard` es el payload del sync principal;
 * `conversation-activity` es el mapa contacto → último saliente de la matriz
 * "Oportunidades sin atención"; `meta-shortlinks` es fb.me → post de Meta
 * (lib/sync.ts). Todos son desechables y comparten la tabla: un
 * slot nuevo no pide migración, solo otra fila.
 *
 * La llave se DERIVA del ClientConfig aquí adentro y el slot es un tipo cerrado,
 * así que ningún llamador puede armar una llave que apunte a otro cliente.
 */
export type SyncSlot = "dashboard" | "conversation-activity" | "meta-shortlinks";

function rowKey(client: ClientConfig, slot: SyncSlot): string {
  // La fila del dashboard conserva la llave de siempre (el id pelón) para no
  // invalidar el caché que ya existe en producción.
  return slot === "dashboard" ? client.id : `${client.id}:${slot}`;
}

export async function readSlot<T>(
  client: ClientConfig,
  slot: SyncSlot,
): Promise<{ payload: T; syncedAt: string } | null> {
  const rows = await getSql()`
    SELECT payload, synced_at FROM project_sync WHERE project_id = ${rowKey(client, slot)}
  `;
  if (rows.length === 0) return null;
  const gz = Buffer.from(rows[0].payload);
  // claimSync siembra un payload vacío cuando toma el candado de un cliente
  // nunca sincronizado. Si ese sync falla, la fila sobrevive con cero bytes y
  // gunzip tronaría. Un payload vacío significa "no hay caché", no "corrupto".
  if (gz.length === 0) return null;
  const raw = gunzipSync(gz);
  return {
    payload: JSON.parse(raw.toString("utf8")) as T,
    syncedAt: new Date(rows[0].synced_at).toISOString(),
  };
}

/** `syncedAt` es cuándo se trajo el dato de la fuente, no cuándo se escribió. */
export async function writeSlot(
  client: ClientConfig,
  slot: SyncSlot,
  payload: unknown,
  syncedAt: string,
): Promise<void> {
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  await getSql()`
    INSERT INTO project_sync (project_id, payload, synced_at, sync_started_at, last_error)
    VALUES (${rowKey(client, slot)}, ${gz}, ${syncedAt}, NULL, NULL)
    ON CONFLICT (project_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           synced_at = EXCLUDED.synced_at,
           sync_started_at = NULL,
           last_error = NULL
  `;
}

// Toma el candado atómicamente. Devuelve false cuando alguien más lo tiene, que
// es como dos personas abriendo el mismo panel viejo a la vez producen UN sync.
//
// La decisión entera vive dentro del WHERE del UPDATE a propósito: hacerlo como
// read-then-write en TypeScript dejaría una ventana donde ambos lo ven libre y
// ambos proceden.
export async function claimSlot(client: ClientConfig, slot: SyncSlot): Promise<boolean> {
  const rows = await getSql()`
    INSERT INTO project_sync (project_id, payload, synced_at, sync_started_at)
    VALUES (${rowKey(client, slot)}, ''::bytea, to_timestamp(0), now())
    ON CONFLICT (project_id) DO UPDATE
       SET sync_started_at = now()
     WHERE project_sync.sync_started_at IS NULL
        OR project_sync.sync_started_at < now() - make_interval(mins => ${LOCK_TIMEOUT_MINUTES})
    RETURNING project_id
  `;
  return rows.length > 0;
}

// Suelta el candado SIN tocar el payload: un refresco fallido debe dejar el
// último caché bueno donde estaba. Un dashboard de hace una hora le gana a
// ningún dashboard.
export async function releaseSlot(
  client: ClientConfig,
  slot: SyncSlot,
  error?: string,
): Promise<void> {
  await getSql()`
    UPDATE project_sync
       SET sync_started_at = NULL,
           last_error = ${error ?? null}
     WHERE project_id = ${rowKey(client, slot)}
  `;
}

// --- El slot del dashboard, con las firmas de siempre.

export function readSync(
  client: ClientConfig,
): Promise<{ payload: DashboardPayload; syncedAt: string } | null> {
  return readSlot<DashboardPayload>(client, "dashboard");
}

export function writeSync(client: ClientConfig, payload: DashboardPayload): Promise<void> {
  // synced_at sale del payload, no de now(): registra cuándo se trajo el dato de
  // GHL, que es lo que significa "Actualizado hace X" en el header.
  return writeSlot(client, "dashboard", payload, payload.meta.fetchedAt);
}

export function claimSync(client: ClientConfig): Promise<boolean> {
  return claimSlot(client, "dashboard");
}

export function releaseSync(client: ClientConfig, error?: string): Promise<void> {
  return releaseSlot(client, "dashboard", error);
}
