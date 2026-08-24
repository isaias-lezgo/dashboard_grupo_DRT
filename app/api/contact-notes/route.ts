import { getContactNotes } from "@/lib/ghl-client";
import { NextResponse } from "next/server";
import { requireClient, unauthorized } from "@/lib/session";
import { withClient } from "@/lib/ghl-context";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const client = await requireClient();
  if (!client) return unauthorized();

  const { searchParams } = new URL(request.url);
  const contactId = searchParams.get("contactId") ?? "";

  if (!contactId) {
    return NextResponse.json({ error: "Missing contactId" }, { status: 400 });
  }

  return withClient(client, async () => {
    try {
      const data = await getContactNotes(contactId);
      return NextResponse.json({
        notes: (data.notes ?? []).map((n) => ({
          id: n.id,
          body: n.body,
          userId: n.userId,
          dateAdded: n.dateAdded,
        })),
        count: data.notes?.length ?? 0,
      });
    } catch (err) {
      console.error("[/api/contact-notes]", err);
      return NextResponse.json({ error: "Failed to fetch notes" }, { status: 502 });
    }
  });
}
