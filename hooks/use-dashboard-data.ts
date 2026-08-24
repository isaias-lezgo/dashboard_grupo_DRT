"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { SyncWarning, DashboardPayload } from "@/lib/types";
import { fetchStream } from "./fetch-stream";

// Re-exported so components import it alongside the other dashboard types
// rather than reaching into lib/types directly.
export type { SyncWarning };

export type StepKey =
  | "config"
  | "contacts"
  | "opportunities"
  | "pautas"
  | "appointments"
  | "tasks";

export type StepStatus =
  | "pending"
  | "loading"
  | "retrying"
  | "done"
  | "partial"
  | "error";

export interface StepState {
  status: StepStatus;
  count?: number;
}

export type StepMap = Record<StepKey, StepState>;

const INITIAL_STEPS: StepMap = {
  config: { status: "pending" },
  contacts: { status: "pending" },
  opportunities: { status: "pending" },
  pautas: { status: "pending" },
  appointments: { status: "pending" },
  tasks: { status: "pending" },
};

// El shape lo define lib/types.ts, donde también lo leen lib/sync.ts (que lo
// produce) y lib/sync-store.ts (que lo gzipea a Postgres). El alias se queda para
// que los componentes sigan importando `DashboardData` de este hook.
export type DashboardData = DashboardPayload;

export function useDashboardData(params?: {
  startDate?: string;
  endDate?: string;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [progress, setProgress] = useState<string>("Iniciando sincronización…");
  const [locationName, setLocationName] = useState<string>("");
  const [steps, setSteps] = useState<StepMap>(INITIAL_STEPS);
  const [elapsedMs, setElapsedMs] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef<number>(Date.now());
  // Wall-clock of the last `step` frame. A sync that stops producing steps is
  // stuck waiting on GHL, which used to look identical to a dead page — the
  // counters just froze with no explanation.
  const lastStepAtRef = useRef<number>(Date.now());

  const startDate = params?.startDate;
  const endDate = params?.endDate;

  const load = useCallback(async (sd?: string, ed?: string, fresh?: boolean) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const searchParams = new URLSearchParams();
    if (sd) searchParams.set("startDate", sd);
    if (ed) searchParams.set("endDate", ed);
    // `fresh=1` le dice a la ruta que ignore el caché de Postgres y vaya a GHL.
    if (fresh) searchParams.set("fresh", "1");
    const qs = searchParams.toString();
    const url = `/api/dashboard${qs ? `?${qs}` : ""}`;

    setIsLoading(true);
    setIsError(false);
    setProgress("Iniciando sincronización…");
    setSteps(INITIAL_STEPS);
    startedAtRef.current = Date.now();
    lastStepAtRef.current = Date.now();
    setElapsedMs(0);

    try {
      const result = await fetchStream<DashboardData>(
        url,
        setProgress,
        ctrl.signal,
        setLocationName,
        (step) => {
          lastStepAtRef.current = Date.now();
          setSteps((prev) => ({
            ...prev,
            [step.key]: { status: step.status, count: step.count },
          }));
        }
      );
      // Ignore the result of a fetch that has since been superseded (e.g. the
      // mount→abort→remount cycle from React StrictMode in dev or router.refresh
      // after login). Otherwise a stale fetch can clobber the newer one's state.
      if (ctrl.signal.aborted) return;
      setData(result);
      if (result.locationName) setLocationName(result.locationName);
      setProgress("");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setIsError(true);
        setProgress("");
      }
    } finally {
      // Only the current (non-aborted) fetch may flip loading off. A superseded
      // fetch's finally must not turn off the spinner while the newer fetch is
      // still in flight — that was surfacing the empty dashboard behind the
      // loading screen.
      if (!ctrl.signal.aborted) setIsLoading(false);
    }
  }, []);

  // Load on mount and when date params change
  useEffect(() => {
    load(startDate, endDate);
    return () => {
      abortRef.current?.abort();
    };
  }, [load, startDate, endDate]);

  // Drives the elapsed-time readout and stall detection. Runs only while
  // loading, so an idle dashboard carries no timer.
  useEffect(() => {
    if (!isLoading) return;
    const id = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
    return () => clearInterval(id);
  }, [isLoading]);

  // No step frame in 15s. The sync is alive but waiting on GHL — the state that
  // used to render as a frozen screen with no explanation.
  const stalled = isLoading && elapsedMs > 0 && Date.now() - lastStepAtRef.current > 15_000;

  // ¿Esta carga es un sync en vivo contra GHL, o el caché sirviendo una fila de
  // Postgres? Decide cuál de las dos caras pinta la pantalla de carga: el detalle
  // por dataset solo tiene sentido en la primera.
  //
  // La señal es la llegada de un frame `step`, y SOLO esa. `progress` y
  // `locationName` no sirven: `load()` fija el primero en el cliente antes de que
  // la red conteste, y el segundo sobrevive de la carga anterior — los dos
  // estarían "encendidos" en ambos caminos. Los `step` solo salen del servidor,
  // y el camino caliente no emite ninguno: manda un único frame `data`.
  const liveSync = Object.values(steps).some((s) => s.status !== "pending");

  // Por defecto va en fresco: el botón "Actualizar" existe precisamente para
  // saltarse el caché. Un refresco que devolviera lo mismo que ya está en
  // pantalla se sentiría roto. El montaje inicial (el useEffect de arriba) NO
  // pasa por aquí, así que sí lee el caché — que es el punto de todo esto.
  const refresh = useCallback(
    (opts?: { fresh?: boolean }) => {
      load(startDate, endDate, opts?.fresh ?? true);
    },
    [load, startDate, endDate],
  );

  return {
    data,
    isLoading,
    isError,
    progress,
    locationName,
    steps,
    elapsedMs,
    stalled,
    liveSync,
    refresh,
  };
}
