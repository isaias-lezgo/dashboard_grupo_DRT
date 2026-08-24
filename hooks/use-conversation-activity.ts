"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { fetchStream } from "./fetch-stream";

interface ActivityPayload {
  activity: Array<{ contactId: string; lastOutboundAt: string | null }>;
  meta: {
    conversations: number;
    threadsOpened: number;
    horizonDays: number;
    fetchedAt: string;
  };
}

/**
 * "loading" y "error" NO son lo mismo que un mapa vacío, y por eso el estado
 * viaja aparte del dato: con el mapa vacío la matriz de abandono manda TODAS
 * las oportunidades a la columna "+60 d" y afirma un abandono total. Es el peor
 * modo de fallo posible —alarmante, verosímil y falso— así que el componente
 * no debe pintar la matriz hasta ver "ready".
 */
export type ActivityStatus = "loading" | "ready" | "error";

/**
 * Carga /api/conversation-activity al montar, independiente del sync principal,
 * igual que useConversationsData: el panel pinta primero y la actividad entra
 * después.
 */
export function useConversationActivity() {
  const [activity, setActivity] = useState<Map<string, string | null>>(new Map());
  const [status, setStatus] = useState<ActivityStatus>("loading");
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStatus("loading");

    try {
      const result = await fetchStream<ActivityPayload>(
        "/api/conversation-activity",
        () => {},
        ctrl.signal
      );
      setActivity(new Map(result.activity.map((a) => [a.contactId, a.lastOutboundAt])));
      setStatus("ready");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setActivity(new Map());
        setStatus("error");
      }
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

  return { activity, status, refresh };
}
