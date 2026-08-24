// Client-side fetch helpers — run in the browser, call Next.js API routes.
// These are intentionally NOT server-side; they're called from the AI agent
// loop after the AI decides to invoke a tool.

export async function fetchContactMessages(
  input: Record<string, unknown>
): Promise<unknown> {
  const contactId = typeof input.contactId === "string" ? input.contactId : "";
  if (!contactId) return { error: "Missing contactId" };
  const limit =
    typeof input.limit === "number"
      ? Math.min(100, Math.max(1, Math.floor(input.limit)))
      : 50;

  const res = await fetch(
    `/api/conversations?contactIds=${encodeURIComponent(contactId)}`,
    { method: "GET" }
  );
  if (!res.ok) return { error: `GHL fetch failed (HTTP ${res.status})` };

  const data = (await res.json()) as {
    threads: Array<{ contactId: string; messages: Array<Record<string, unknown>> }>;
  };
  const thread = data.threads?.find((t) => t.contactId === contactId);
  const msgs = (thread?.messages ?? []).filter((m) => m.kind !== "activity");
  const sorted = [...msgs].sort(
    (a, b) =>
      new Date(String(b.createdAt ?? "")).getTime() -
      new Date(String(a.createdAt ?? "")).getTime()
  );
  const capped = sorted.slice(0, limit);
  return {
    contactId,
    returned: capped.length,
    totalAvailable: msgs.length,
    rows: capped.map((m) => ({
      id: m.id,
      direction: m.direction,
      source: m.source,
      content:
        typeof m.content === "string" && m.content.length > 500
          ? m.content.slice(0, 500) + "…"
          : m.content,
      createdAt: m.createdAt,
    })),
  };
}

export async function fetchConversationThreads(
  input: Record<string, unknown>
): Promise<unknown> {
  const rawIds = Array.isArray(input.contactIds)
    ? (input.contactIds as string[])
    : [];
  if (rawIds.length === 0)
    return { error: "contactIds is required and must be a non-empty array" };

  const limit =
    typeof input.limit === "number"
      ? Math.min(50, Math.max(1, Math.floor(input.limit)))
      : 30;
  const messageLimit =
    typeof input.messageLimit === "number"
      ? Math.max(1, Math.floor(input.messageLimit))
      : 100;
  const contactIds = rawIds.slice(0, limit);

  const params = new URLSearchParams({
    contactIds: contactIds.join(","),
    messageLimit: String(messageLimit),
  });

  const res = await fetch(`/api/conversations?${params}`, { method: "GET" });
  if (!res.ok) return { error: `GHL fetch failed (HTTP ${res.status})` };

  const data = (await res.json()) as {
    threads: Array<{ contactId: string; messages: Array<Record<string, unknown>>; hasMore?: boolean }>;
  };

  const threads = (data.threads ?? []).map((t) => {
    const chat = t.messages.filter((m) => m.kind !== "activity");
    const sorted = [...chat].sort(
      (a, b) =>
        new Date(String(b.createdAt ?? "")).getTime() -
        new Date(String(a.createdAt ?? "")).getTime()
    );
    return {
      contactId: t.contactId,
      messageCount: chat.length,
      // true when older messages exist beyond this slice (messageLimit hit).
      // The model must NOT infer loss reasons / root cause from a hasMore=true
      // thread — pull the full history with get_contact_messages first.
      hasMore: t.hasMore ?? false,
      messages: sorted.map((m) => ({
        id: m.id,
        direction: m.direction,
        source: m.source,
        content:
          typeof m.content === "string" && m.content.length > 500
            ? m.content.slice(0, 500) + "…"
            : m.content,
        createdAt: m.createdAt,
      })),
    };
  });

  return { returned: threads.length, threads };
}

export async function fetchContactTasks(
  input: Record<string, unknown>
): Promise<unknown> {
  const contactId = typeof input.contactId === "string" ? input.contactId : "";
  if (!contactId) return { error: "Missing contactId" };

  const res = await fetch(
    `/api/contact-tasks?contactId=${encodeURIComponent(contactId)}`,
    { method: "GET" }
  );
  if (!res.ok) return { error: `Tasks fetch failed (HTTP ${res.status})` };
  return res.json();
}

export async function fetchContactNotes(
  input: Record<string, unknown>
): Promise<unknown> {
  const contactId = typeof input.contactId === "string" ? input.contactId : "";
  if (!contactId) return { error: "Missing contactId" };

  const res = await fetch(
    `/api/contact-notes?contactId=${encodeURIComponent(contactId)}`,
    { method: "GET" }
  );
  if (!res.ok) return { error: `Notes fetch failed (HTTP ${res.status})` };
  return res.json();
}
