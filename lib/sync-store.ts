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
export async function readSync(
  client: ClientConfig,
): Promise<{ payload: DashboardPayload; syncedAt: string } | null> {
  const rows = await getSql()`
    SELECT payload, synced_at FROM project_sync WHERE project_id = ${client.id}
  `;
  if (rows.length === 0) return null;
  const gz = Buffer.from(rows[0].payload);
  // claimSync siembra un payload vacío cuando toma el candado de un cliente
  // nunca sincronizado. Si ese sync falla, la fila sobrevive con cero bytes y
  // gunzip tronaría. Un payload vacío significa "no hay caché", no "corrupto".
  if (gz.length === 0) return null;
  const raw = gunzipSync(gz);
  return {
    payload: JSON.parse(raw.toString("utf8")) as DashboardPayload,
    syncedAt: new Date(rows[0].synced_at).toISOString(),
  };
}

export async function writeSync(client: ClientConfig, payload: DashboardPayload): Promise<void> {
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  // synced_at sale del payload, no de now(): registra cuándo se trajo el dato de
  // GHL, que es lo que significa "Actualizado hace X" en el header.
  await getSql()`
    INSERT INTO project_sync (project_id, payload, synced_at, sync_started_at, last_error)
    VALUES (${client.id}, ${gz}, ${payload.meta.fetchedAt}, NULL, NULL)
    ON CONFLICT (project_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           synced_at = EXCLUDED.synced_at,
           sync_started_at = NULL,
           last_error = NULL
  `;
}

// Toma el candado del sync atómicamente. Devuelve false cuando alguien más lo
// tiene, que es como dos personas abriendo el mismo panel viejo a la vez
// producen UN sync.
//
// La decisión entera vive dentro del WHERE del UPDATE a propósito: hacerlo como
// read-then-write en TypeScript dejaría una ventana donde ambos lo ven libre y
// ambos proceden.
export async function claimSync(client: ClientConfig): Promise<boolean> {
  const rows = await getSql()`
    INSERT INTO project_sync (project_id, payload, synced_at, sync_started_at)
    VALUES (${client.id}, ''::bytea, to_timestamp(0), now())
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
export async function releaseSync(client: ClientConfig, error?: string): Promise<void> {
  await getSql()`
    UPDATE project_sync
       SET sync_started_at = NULL,
           last_error = ${error ?? null}
     WHERE project_id = ${client.id}
  `;
}
