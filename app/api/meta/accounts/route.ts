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
