// lib/session.ts
// Node-only. Kept OUT of lib/auth.ts on purpose: auth.ts is imported by Edge
// middleware and must stay pure/runtime-agnostic, and importing the roster there
// would pull it into the Edge bundle.
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifyToken } from "./auth";
import { getClientById, type ClientConfig } from "./clients";

// Re-verifies the signed cookie itself rather than trusting a header injected by
// middleware — a header would be a spoofing surface, and an HMAC verify costs
// microseconds. Returns null when the cookie is invalid OR when the id no longer
// resolves, which means removing a client from the roster instantly invalidates
// their live sessions.
export async function requireClient(): Promise<ClientConfig | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const clientId = await verifyToken(token);
  if (!clientId) return null;
  try {
    return getClientById(clientId);
  } catch (err) {
    // Roster missing/invalid — fail closed rather than serving anyone.
    console.error("[session] Could not load client roster:", err);
    return null;
  }
}

export function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
