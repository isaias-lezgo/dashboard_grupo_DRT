import { getConversations, getMessages } from "@/lib/ghl-client"
import { ghlMessageToInternal } from "@/lib/ghl-message-mapper"
import type { Message } from "@/lib/types"
import { requireClient, unauthorized } from "@/lib/session"
import { withClient } from "@/lib/ghl-context"

export const runtime = "nodejs"

const BATCH_SIZE = 10

async function fetchThread(
  contactId: string,
  messageLimit: number
): Promise<{ contactId: string; messages: Message[]; hasMore: boolean }> {
  try {
    const convResp = await getConversations({ contactId, limit: 1 })
    const conv = convResp.conversations[0]
    if (!conv) return { contactId, messages: [], hasMore: false }
    const msgResp = await getMessages(conv.id, { limit: messageLimit })
    const messages: Message[] = msgResp.messages.messages
      .map((m) => ghlMessageToInternal(m, contactId))
      .filter((m): m is Message => m !== null)
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      )
    // GHL doesn't return a total message count, but nextPage tells us whether
    // older messages exist beyond this slice — the truncation signal the model
    // needs so it doesn't draw conclusions from a partial thread.
    return { contactId, messages, hasMore: msgResp.messages.nextPage ?? false }
  } catch (err) {
    console.warn(`[conversations] Failed to fetch thread for contact ${contactId}:`, err)
    return { contactId, messages: [], hasMore: false }
  }
}

export async function GET(request: Request) {
  const client = await requireClient()
  if (!client) return unauthorized()

  const { searchParams } = new URL(request.url)

  const contactIds = (searchParams.get("contactIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  const rawLimit = parseInt(searchParams.get("messageLimit") ?? "100", 10)
  const messageLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100

  const locationId = client.locationId

  if (contactIds.length === 0) {
    return Response.json({ threads: [], locationId })
  }

  return withClient(client, async () => {
    const threads: Array<{ contactId: string; messages: Message[]; hasMore: boolean }> = []

    for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
      const batch = contactIds.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(batch.map((id) => fetchThread(id, messageLimit)))
      threads.push(...results)
    }

    return Response.json({ threads, locationId })
  })
}
