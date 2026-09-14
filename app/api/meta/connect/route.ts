// app/api/meta/connect/route.ts
// Arranca el OAuth con Meta: firma un state con el id del cliente y redirige al
// diálogo de Facebook Login for Business. Detrás de requireClient() para que el
// state solo pueda llevar el id de quien está logueado.
import { requireClient, unauthorized } from "@/lib/session";
import { isDbConfigured } from "@/lib/db";
import {
  buildDialogUrl,
  redirectUriFor,
  signState,
  verifyState,
  OAUTH_COOKIE,
  STATE_MAX_AGE_MS,
} from "@/lib/meta-oauth";

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
