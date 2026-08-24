import { getContactTasks, type GHLContactTask } from "@/lib/ghl-client";
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
      const data = await getContactTasks(contactId);
      return NextResponse.json({
        tasks: (data.tasks ?? []).map((t: GHLContactTask) => ({
          id: t.id,
          title: t.title,
          body: t.body,
          dueDate: t.dueDate,
          status: t.status,
          assignedTo: t.assignedTo,
          dateAdded: t.dateAdded,
        })),
        count: data.tasks?.length ?? 0,
      });
    } catch (err) {
      console.error("[/api/contact-tasks]", err);
      return NextResponse.json({ error: "Failed to fetch tasks" }, { status: 502 });
    }
  });
}
