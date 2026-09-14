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
