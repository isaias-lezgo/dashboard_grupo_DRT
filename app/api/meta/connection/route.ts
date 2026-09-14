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
