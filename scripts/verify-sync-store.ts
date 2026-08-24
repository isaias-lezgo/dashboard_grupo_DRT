// Verificación de lib/sync-store.ts. Correr: pnpm verify:sync-store
//
// El store está indexado POR CLIENTE, así que un bug aquí es una fuga de datos
// entre clientes — la misma clase de falla que el contexto de credenciales existe
// para evitar. Por eso este script también ejercita la base real cuando hay
// DATABASE_URL: el SQL es donde la llave realmente se usa.
//
// Las aserciones puras corren siempre; el roundtrip contra Postgres solo si hay
// DATABASE_URL (el script de pnpm la inyecta desde .env.local con --env-file).
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS
// (no tiene "type": "module"), así que tsx compila a CJS donde TLA no existe.
import assert from "node:assert/strict";
import {
  FRESH_WINDOW_MS,
  isStale,
  readSync,
  writeSync,
  claimSync,
  releaseSync,
} from "../lib/sync-store";
import type { ClientConfig } from "../lib/clients";
import type { DashboardPayload } from "../lib/types";

// Ids sintéticos que no pueden colisionar con un cliente real: el ID_RE del
// roster prohíbe guiones bajos, así que nada en DASHBOARD_CLIENTS puede llamarse
// así.
const A: ClientConfig = { id: "__verify_a", name: "A", locationId: "loc-a", ghlToken: "pit-a" };
const B: ClientConfig = { id: "__verify_b", name: "B", locationId: "loc-b", ghlToken: "pit-b" };

function payload(marker: string, fetchedAt: string): DashboardPayload {
  return {
    locationName: `Ubicación ${marker} ñ 🎯`,
    contacts: [],
    opportunities: [],
    calls: [],
    tasks: [],
    appointments: [],
    pipelines: [],
    members: [marker],
    tags: [],
    campaigns: [],
    sources: [],
    pautas: [],
    warnings: [],
    locationId: `loc-${marker}`,
    meta: { totalContacts: 0, totalOpportunities: 0, fetchedAt },
  };
}

async function main() {
  const now = new Date("2026-08-17T12:00:00.000Z");

  // --- frescura: fronteras exactas, no "como quince minutos"
  assert.equal(FRESH_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(isStale(new Date(now.getTime() - 1000).toISOString(), now), false, "1 s es fresco");
  assert.equal(
    isStale(new Date(now.getTime() - FRESH_WINDOW_MS + 1).toISOString(), now),
    false,
    "justo debajo de la ventana es fresco",
  );
  assert.equal(
    isStale(new Date(now.getTime() - FRESH_WINDOW_MS).toISOString(), now),
    true,
    "exactamente la ventana ya es viejo",
  );
  assert.equal(
    isStale(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), now),
    true,
    "una hora es viejo",
  );
  // Un reloj chueco que ponga synced_at en el futuro NO debe leerse como viejo.
  assert.equal(isStale(new Date(now.getTime() + 5000).toISOString(), now), false, "el futuro no es viejo");

  if (!process.env.DATABASE_URL) {
    console.log("⚠️  DATABASE_URL ausente — se omitió el roundtrip real");
    console.log("✅ lib/sync-store.ts — aserciones puras pasaron");
    return;
  }

  // --- roundtrip: lo que entra sale idéntico, acentos y emoji incluidos
  const stamp = new Date().toISOString();
  await writeSync(A, payload("a", stamp));
  const readA = await readSync(A);
  assert.ok(readA, "A debe poder leerse de vuelta");
  assert.deepEqual(readA.payload, payload("a", stamp), "el payload debe sobrevivir el gzip");
  assert.equal(readA.payload.locationName, "Ubicación a ñ 🎯");

  // --- LA GARANTÍA DE AISLAMIENTO: la escritura de un cliente es invisible al otro
  await writeSync(B, payload("b", stamp));
  const againA = await readSync(A);
  assert.ok(againA);
  assert.equal(againA.payload.members[0], "a", "A debe seguir leyendo lo de A, nunca lo de B");
  const readB = await readSync(B);
  assert.ok(readB);
  assert.equal(readB.payload.members[0], "b");

  // --- un cliente nunca sincronizado lee null, no un error
  const never = await readSync({ ...A, id: "__verify_nunca" });
  assert.equal(never, null);

  // --- el candado: el segundo no se lo lleva mientras el primero lo tiene
  assert.equal(await claimSync(A), true, "el primer claim gana");
  assert.equal(await claimSync(A), false, "el segundo claim se rechaza mientras esté tomado");
  await releaseSync(A);
  assert.equal(await claimSync(A), true, "vuelve a ser tomable tras soltarlo");
  await releaseSync(A, "boom");

  // --- soltar con error registra el error sin destruir el payload cacheado
  const afterError = await readSync(A);
  assert.ok(afterError, "un sync fallido NO debe tirar el payload que ya teníamos");
  assert.equal(afterError.payload.members[0], "a");

  // --- un claim sobre un cliente nunca sincronizado siembra un payload VACÍO.
  // Leer eso debe devolver null ("no hay caché"), no reventar en gunzip.
  const C: ClientConfig = { ...A, id: "__verify_c" };
  assert.equal(await claimSync(C), true, "reclamar un cliente sin sync debe funcionar");
  await releaseSync(C, "murió a medio sync");
  assert.equal(await readSync(C), null, "un payload vacío lee como sin caché, no como corrupción");

  // --- escribir sobrescribe: el caché guarda solo el presente
  const newer = new Date(Date.now() + 1000).toISOString();
  await writeSync(A, payload("a2", newer));
  const overwritten = await readSync(A);
  assert.ok(overwritten);
  assert.equal(overwritten.payload.members[0], "a2");
  assert.equal(overwritten.syncedAt, newer);

  // --- limpieza, para que la tabla solo contenga clientes reales
  const { getSql } = await import("../lib/db");
  await getSql()`DELETE FROM project_sync WHERE project_id LIKE '\\_\\_verify%'`;
  const leftovers =
    await getSql()`SELECT count(*)::int AS n FROM project_sync WHERE project_id LIKE '\\_\\_verify%'`;
  assert.equal(leftovers[0].n, 0, "las filas de verificación deben quedar borradas");

  console.log("✅ lib/sync-store.ts — todas las aserciones pasaron (incluido el roundtrip real)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
