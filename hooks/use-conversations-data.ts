"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { Message } from "@/lib/types";
import { fetchStream } from "./fetch-stream";

interface ConversationsPayload {
  messages: Message[];
  meta: { totalMessages: number; fetchedAt: string };
}

/**
 * Fetches conversation messages from /api/dashboard-messages on mount,
 * independent of the main dashboard load. This keeps the expensive per-user
 * message fan-out off the critical path: the dashboard paints first, messages
 * stream in after.
 */
export function useConversationsData() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setIsLoading(true);
    setIsError(false);

    try {
      const result = await fetchStream<ConversationsPayload>(
        "/api/dashboard-messages",
        () => {},
        ctrl.signal
      );
      setMessages(result.messages);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setIsError(true);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  const refresh = useCallback(() => {
    load();
  }, [load]);

  return { messages, isLoading, isError, refresh };
}
