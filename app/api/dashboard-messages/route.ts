import {
  getConversations,
  getMessages,
  getUsers,
  type GHLConversation,
} from "@/lib/ghl-client";
import { ghlMessageToInternal } from "@/lib/ghl-message-mapper";
import type { Message } from "@/lib/types";
import { requireClient, unauthorized } from "@/lib/session";
import { withClient } from "@/lib/ghl-context";

function enc(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export const runtime = "nodejs";

export async function GET() {
  // Resolve the client in the request scope — cookies() is unavailable inside
  // the stream callback below.
  const client = await requireClient();
  if (!client) return unauthorized();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Context entered HERE, not around GET(): the stream outlives the handler's
      // return, so wrapping the handler would leave the pump outside the context.
      await withClient(client, async () => {
        const send = (obj: unknown) => {
          controller.enqueue(encoder.encode(enc(obj)));
        };

        try {
          send({ type: "progress", message: "Cargando asesores…" });

          // Build user lookup map for advisor attribution.
          const usersRaw = await getUsers().catch(() => ({ users: [] }));
          const userMap = new Map<string, string>();
          for (const u of usersRaw.users) {
            const name = u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim();
            userMap.set(u.id, name);
          }

          // Fetch last 30 active conversations PER user (not 30 in total),
          // so every advisor with activity shows up in the conversation charts.
          send({ type: "progress", message: "Cargando conversaciones…" });
          const messages: Message[] = [];
          try {
            const userIds = Array.from(userMap.keys());

            // Bounded concurrency — avoid firing all user-conversation queries
            // simultaneously, which exhausts the GHL rate-limit budget.
            const CONCURRENCY_CONV = 4;
            let convFetchCursor = 0;
            const userConvResults: Array<{ userId: string; conversations: GHLConversation[] }> = [];
            await Promise.all(
              Array.from({ length: Math.min(CONCURRENCY_CONV, userIds.length) }, async () => {
                while (convFetchCursor < userIds.length) {
                  const idx = convFetchCursor++;
                  const userId = userIds[idx];
                  try {
                    const resp = await getConversations({ limit: 30, assignedTo: userId });
                    userConvResults.push({ userId, conversations: resp.conversations });
                  } catch {
                    userConvResults.push({ userId, conversations: [] });
                  }
                }
              })
            );

            // Dedupe conversations across users (a conv reassigned mid-stream
            // could surface under multiple users) and remember which user we
            // queried for, so we can attribute messages even if conv.assignedTo
            // is missing from the GHL payload. Skip deleted conversations.
            const convQueue: Array<{ conv: GHLConversation; queriedUserId: string }> = [];
            const seenConvIds = new Set<string>();
            for (const { userId, conversations } of userConvResults) {
              for (const conv of conversations) {
                if (seenConvIds.has(conv.id)) continue;
                if (conv.deleted) continue;
                seenConvIds.add(conv.id);
                convQueue.push({ conv, queriedUserId: userId });
              }
            }

            // Bounded-concurrency message fetches so a 100+-conversation queue
            // doesn't fan out to hundreds of simultaneous requests.
            const CONCURRENCY = 6;
            let cursor = 0;
            const collected: Message[][] = new Array(convQueue.length);
            await Promise.all(
              Array.from({ length: Math.min(CONCURRENCY, convQueue.length) }, async () => {
                while (cursor < convQueue.length) {
                  const idx = cursor++;
                  const { conv, queriedUserId } = convQueue[idx];
                  const advisorId = conv.assignedTo ?? queriedUserId;
                  const advisorName = userMap.get(advisorId) ?? advisorId;
                  try {
                    const msgResp = await getMessages(conv.id, { limit: 50 });
                    const out: Message[] = [];
                    for (const msg of msgResp.messages.messages) {
                      const transformed = ghlMessageToInternal(msg, conv.contactId, {
                        conversationId: conv.id,
                        assignedTo: advisorName,
                      });
                      if (transformed) out.push(transformed);
                    }
                    collected[idx] = out;
                  } catch {
                    collected[idx] = [];
                  }
                }
              })
            );
            for (const batch of collected) {
              if (batch) messages.push(...batch);
            }
          } catch (err) {
            console.error("[GHL] Conversations fetch failed:", err);
          }

          send({
            type: "data",
            messages,
            meta: {
              totalMessages: messages.length,
              fetchedAt: new Date().toISOString(),
            },
          });
          controller.close();
        } catch (err) {
          send({ type: "error", message: (err as Error).message });
          controller.close();
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
