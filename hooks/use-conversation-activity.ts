"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { fetchStream } from "./fetch-stream";

import type { ActivityMeta } from "@/lib/activity-cache";

export type { ActivityMeta };

interface ActivityPayload {
  activity: Array<{ contactId: string; lastOutboundAt: string | null }>;
  meta: ActivityMeta;
  /** true = salió del caché de Neon (sin frames de progreso). */
  cached?: boolean;
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
 * Avance de la carga, para la barra de la tarjeta.
 * - `waiting`: el sync principal sigue corriendo; arrancar ahora partiría el
 *   presupuesto de GHL entre los dos y ambos acabarían en 429.
 * - `scan`: recorriendo conversaciones; `horizonPct` es qué tan atrás llegó
 *   dentro de los 60 días (el total de conversaciones no se conoce de antemano).
 * - `threads`: abriendo los hilos que terminan en entrante; `done / total`.
 * - `retry`: el primer intento falló y se reintenta solo.
 */
export interface ActivityProgress {
  phase: "waiting" | "connecting" | "scan" | "threads" | "retry";
  scanned: number;
  horizonPct: number;
  done: number;
  total: number;
  /** Inicio del intento actual (ms), para estimar el tiempo restante. */
  startedAt: number;
}

/** Peso de la fase `scan` en la barra: ~40 s de páginas contra ~90 s de hilos (2026-09-28). */
const SCAN_WEIGHT = 0.3;
const AUTO_RETRY_DELAY_MS = 8_000;

/** Fracción global 0–1 de la carga. */
export function activityFraction(p: ActivityProgress): number {
  if (p.phase === "scan") return p.horizonPct * SCAN_WEIGHT;
  if (p.phase === "threads") {
    return SCAN_WEIGHT + (p.total > 0 ? p.done / p.total : 1) * (1 - SCAN_WEIGHT);
  }
  return 0;
}

const INITIAL: ActivityProgress = {
  phase: "waiting",
  scanned: 0,
  horizonPct: 0,
  done: 0,
  total: 0,
  startedAt: 0,
};

/**
 * Carga /api/conversation-activity independiente del sync principal: el panel
 * pinta primero y la actividad entra después.
 *
 * `enabled` la retiene hasta que el dataset principal llegó. Arrancar las dos a
 * la vez era lo que la tumbaba en producción: cada función serverless tiene su
 * propio limitador, así que juntas rebasaban el presupuesto de GHL de la
 * sub-cuenta y la actividad se ahogaba en 429 hasta agotar su tiempo.
 */
export function useConversationActivity({ enabled = true }: { enabled?: boolean } = {}) {
  const [activity, setActivity] = useState<Map<string, string | null>>(new Map());
  const [status, setStatus] = useState<ActivityStatus>("loading");
  const [progress, setProgress] = useState<ActivityProgress>(INITIAL);
  const [meta, setMeta] = useState<ActivityMeta | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(false);

  const load = useCallback(async (attempt = 0, fresh = false) => {
    abortRef.current?.abort();
    if (retryTimer.current) clearTimeout(retryTimer.current);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStatus("loading");
    setErrorMessage(null);
    setProgress({ ...INITIAL, phase: "connecting", startedAt: Date.now() });

    try {
      const result = await fetchStream<ActivityPayload>(
        // ?fresh=1 salta el caché: es lo que pide "Reintentar" y el reintento
        // automático, donde el caché ya no sirvió.
        fresh ? "/api/conversation-activity?fresh=1" : "/api/conversation-activity",
        () => {},
        ctrl.signal,
        undefined,
        undefined,
        (tick) => {
          setProgress((prev) => ({
            ...prev,
            phase: tick.phase === "threads" ? "threads" : "scan",
            scanned: Number(tick.scanned ?? prev.scanned),
            horizonPct: tick.phase === "threads" ? 1 : Number(tick.horizonPct ?? 0),
            done: Number(tick.done ?? 0),
            total: Number(tick.total ?? 0),
          }));
        }
      );
      setActivity(new Map(result.activity.map((a) => [a.contactId, a.lastOutboundAt])));
      setMeta(result.meta);
      setStatus("ready");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      // Un reintento automático: el fallo típico es contención pasajera con
      // GHL, y pedirle al usuario que apriete un botón por eso es ruido.
      if (attempt === 0) {
        setProgress((prev) => ({ ...prev, phase: "retry" }));
        retryTimer.current = setTimeout(() => load(1, true), AUTO_RETRY_DELAY_MS);
        return;
      }
      setActivity(new Map());
      setMeta(null);
      setErrorMessage((err as Error).message || null);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    load();
  }, [enabled, load]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  const refresh = useCallback(() => {
    started.current = true;
    load(0, true);
  }, [load]);

  return { activity, status, progress, meta, errorMessage, refresh };
}
