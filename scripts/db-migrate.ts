// Crea la tabla del caché. Idempotente — seguro de correr en cada deploy o a mano.
// Correr: pnpm db:migrate
//
// Sin framework de migraciones: una tabla no lo justifica, y este repo tampoco
// tiene framework de pruebas. Si esto crece más allá de un par de tablas, revisar.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS
// (no tiene "type": "module"), así que tsx compila a CJS donde TLA no existe.
import { neon } from "@neondatabase/serverless";

async function main() {
  // El DDL va por la conexión UNPOOLED: pgbouncer en modo transaction estorba a
  // los cambios de esquema.
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED (o DATABASE_URL) no está definida");
  const sql = neon(url);

  await sql`
    CREATE TABLE IF NOT EXISTS project_sync (
      project_id      text PRIMARY KEY,
      payload         bytea       NOT NULL,
      synced_at       timestamptz NOT NULL,
      sync_started_at timestamptz,
      last_error      text
    )
  `;

  const rows = await sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'project_sync'
     ORDER BY ordinal_position
  `;
  console.log("✅ project_sync lista:");
  for (const r of rows) console.log(`   ${r.column_name} ${r.data_type}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
