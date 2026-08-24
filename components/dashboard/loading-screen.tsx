"use client"

import { motion, AnimatePresence } from "framer-motion"
import type { StepKey, StepMap, StepStatus } from "@/hooks/use-dashboard-data"

interface LoadingScreenProps {
  progress: string
  /** Name of the GHL sub-account being opened. Empty until resolved. */
  locationName?: string
  /** Live per-dataset progress. All datasets load concurrently. */
  steps?: StepMap
  /** Milliseconds since the sync started. */
  elapsedMs?: number
  /** No step frame has arrived in >15s — the API is throttling us. */
  stalled?: boolean
  /**
   * True once a `step` frame has arrived, which only happens on a live GHL sync.
   * Picks between the two faces below. See `liveSync` in use-dashboard-data.ts
   * for why a step frame is the only trustworthy signal.
   */
  liveSync?: boolean
}

// Visible rows, in display order, with their Spanish labels. These mirror the
// concurrent fetches in /api/dashboard — each advances independently.
const STEP_ROWS: { key: StepKey; label: string }[] = [
  { key: "config", label: "Configuración" },
  { key: "contacts", label: "Contactos" },
  { key: "opportunities", label: "Oportunidades" },
  { key: "pautas", label: "Pautas" },
  { key: "appointments", label: "Citas" },
  { key: "tasks", label: "Tareas" },
]

const FALLBACK_STEPS: StepMap = {
  config: { status: "loading" },
  contacts: { status: "pending" },
  opportunities: { status: "pending" },
  pautas: { status: "pending" },
  appointments: { status: "pending" },
  tasks: { status: "pending" },
}

function SyncRing() {
  const size = 88
  const stroke = 2.5
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(var(--border))"
          strokeWidth={stroke}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          animate={{ strokeDashoffset: [circumference, circumference * 0.25, circumference] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center gap-[3px]">
        {[0, 1, 2, 3].map((i) => (
          <motion.span
            key={i}
            className="w-[3px] rounded-full bg-primary"
            style={{ height: 14 }}
            animate={{ scaleY: [0.35, 1, 0.5, 0.85, 0.35] }}
            transition={{
              duration: 1.1,
              delay: i * 0.12,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>
    </div>
  )
}

// Visual treatment per step state. `retrying` and `partial` are amber (the sync
// is coping), `error` is destructive (the dataset is gone). All three terminal
// states count toward the progress bar — the sync really did move on.
const STEP_STYLE: Record<
  StepStatus,
  { dot: string; label: string; note?: string; noteClass?: string }
> = {
  pending: {
    dot: "border border-border bg-muted/50 text-muted-foreground",
    label: "text-muted-foreground/60",
  },
  loading: {
    dot: "border-2 border-primary bg-primary/10 text-primary",
    label: "font-medium text-foreground",
  },
  retrying: {
    dot: "border-2 border-amber-500 bg-amber-500/10 text-amber-500",
    label: "font-medium text-foreground",
    note: "reintentando…",
    noteClass: "text-amber-500",
  },
  done: {
    dot: "bg-primary text-primary-foreground",
    label: "text-muted-foreground",
  },
  partial: {
    dot: "bg-amber-500 text-white",
    label: "text-muted-foreground",
    note: "parcial",
    noteClass: "text-amber-500",
  },
  error: {
    dot: "bg-destructive text-destructive-foreground",
    label: "text-muted-foreground",
    note: "error",
    noteClass: "text-destructive",
  },
}

const SETTLED_STATUSES: StepStatus[] = ["done", "partial", "error"]

function StepRow({
  label,
  status,
  count,
  delay,
}: {
  label: string
  status: StepStatus
  count?: number
  delay: number
}) {
  const style = STEP_STYLE[status]
  const isSettled = SETTLED_STATUSES.includes(status)
  const isSpinning = status === "loading" || status === "retrying"

  return (
    <motion.div
      className="flex items-center gap-3"
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.3 }}
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold transition-colors duration-300 ${style.dot}`}
      >
        {status === "done" || status === "partial" ? (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2 6l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : status === "error" ? (
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
          </svg>
        ) : isSpinning ? (
          <motion.span
            className={`h-1.5 w-1.5 rounded-full ${status === "retrying" ? "bg-amber-500" : "bg-primary"}`}
            animate={{ scale: [1, 1.35, 1], opacity: [1, 0.6, 1] }}
            transition={{ duration: 1, repeat: Infinity }}
          />
        ) : (
          <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
        )}
      </span>

      <span className={`flex-1 text-sm transition-colors duration-300 ${style.label}`}>
        {label}
      </span>

      {/* Live count: running total while loading, final total once settled.
          Tabular numerals keep the column from jittering as digits change. */}
      <span className="flex min-w-[3.5rem] items-center justify-end gap-2 text-right text-xs tabular-nums">
        {style.note && (
          <span className={`text-[11px] font-medium ${style.noteClass}`}>{style.note}</span>
        )}
        {count !== undefined && (isSpinning || isSettled) ? (
          <motion.span
            key={`${status}-${count}`}
            className={isSettled ? "font-medium text-foreground" : "text-muted-foreground"}
            initial={{ opacity: 0.4 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
          >
            {count.toLocaleString("es-MX")}
          </motion.span>
        ) : isSpinning ? (
          <span className="text-muted-foreground/60">…</span>
        ) : null}
      </span>
    </motion.div>
  )
}

/**
 * La cara del camino caliente: el payload viene del caché en Postgres, así que
 * no hay progreso que reportar — llega un único frame `data` y se acabó.
 *
 * Deliberadamente desnuda. Esta pantalla dura uno o dos segundos, y en ese lapso
 * las seis filas de datasets no alcanzan a decir nada: se quedaban congeladas en
 * gris al 0% y luego saltaba el panel, que leía como si algo se hubiera trabado.
 * Un porcentaje que nunca se mueve es peor que ningún porcentaje.
 */
function CacheFace() {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-8 px-8">
      <SyncRing />

      <div className="flex flex-col items-center gap-5">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Lezgo Suite Analíticas
        </h2>

        {/* Indeterminado a propósito: no sabemos cuánto falta y fingirlo con una
            barra determinada sería mentir. */}
        <div className="h-1.5 w-48 overflow-hidden rounded-full bg-border" aria-hidden>
          <motion.div
            className="h-full w-1/3 rounded-full bg-primary"
            animate={{ x: ["-100%", "300%"] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
      </div>

      {/* El contenedor es aria-live, así que necesita algo que anunciar: esta
          cara no tiene texto de estado visible. */}
      <span className="sr-only">Cargando panel</span>
    </div>
  )
}

/**
 * La cara del camino frío: un sync real contra GHL, que tarda del orden de un
 * minuto y medio. Aquí el detalle por dataset sí se gana su lugar — es la
 * diferencia entre "va avanzando" y "se trabó".
 *
 * Se ve en la primera carga, cuando la base no responde, y cada vez que se pica
 * "Actualizar" (que manda `?fresh=1`).
 */
function SyncFace({
  progress,
  locationName,
  steps,
  elapsedMs,
  stalled,
}: {
  progress: string
  locationName?: string
  steps?: StepMap
  elapsedMs: number
  stalled: boolean
}) {
  const resolved = steps ?? FALLBACK_STEPS

  const total = STEP_ROWS.length
  // Every terminal state advances the bar, not just `done` — a dataset that
  // came back partial or failed is still one the sync is finished with.
  const completed = STEP_ROWS.filter((s) =>
    SETTLED_STATUSES.includes(resolved[s.key].status)
  ).length
  const pct = Math.round((completed / total) * 100)

  const mmss = (ms: number) => {
    const secs = Math.floor(ms / 1000)
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`
  }

  return (
    <>
      <div className="flex w-full max-w-md flex-col items-center gap-10 px-8">
        <SyncRing />

        <div className="flex w-full flex-col items-center gap-6">
          <div className="text-center">
            <motion.h2
              className="text-2xl font-bold tracking-tight text-foreground"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.35 }}
            >
              Lezgo Suite Analíticas
            </motion.h2>
            <motion.p
              className="mt-2 text-sm text-muted-foreground"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2, duration: 0.35 }}
            >
              Abriendo subcuenta
            </motion.p>
            {/* Skeleton → name pill swap. Deliberately NOT wrapped in
                AnimatePresence mode="wait": the placeholder's infinite-repeat
                opacity animation never fires an exit-complete callback, which
                deadlocks the presence swap so the pill never mounts. A plain
                conditional with a CSS-pulse skeleton unmounts cleanly the
                instant the sub-account name resolves. */}
            <div className="mt-3 flex min-h-[2rem] items-center justify-center">
              {locationName ? (
                <motion.span
                  key={locationName}
                  className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5 text-sm font-semibold text-primary"
                  initial={{ opacity: 0, y: 6, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                >
                  {locationName}
                </motion.span>
              ) : (
                <span className="h-7 w-40 animate-pulse rounded-full bg-muted" aria-hidden />
              )}
            </div>
          </div>

          <div className="w-full space-y-2.5">
            {STEP_ROWS.map((row, i) => {
              const s = resolved[row.key]
              return (
                <StepRow
                  key={row.key}
                  label={row.label}
                  status={s.status}
                  count={s.count}
                  delay={0.15 + i * 0.05}
                />
              )
            })}
          </div>

          {/* Determinate progress bar driven by completed-step count, so the
              user always sees how far along the sync is — not just motion. */}
          <div className="w-full space-y-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
              />
            </div>
            <div className="flex min-h-[1.25rem] items-center justify-between text-xs">
              <AnimatePresence mode="wait">
                <motion.span
                  key={stalled ? "stalled" : progress}
                  className={`max-w-[65%] truncate ${stalled ? "text-amber-500" : "text-muted-foreground"}`}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.2 }}
                >
                  {stalled
                    ? "Lezgo Suite CRM está limitando las solicitudes — esto puede tardar"
                    : progress || "Sincronizando…"}
                </motion.span>
              </AnimatePresence>
              <span className="flex items-center gap-2 tabular-nums text-muted-foreground">
                {elapsedMs > 0 && <span>{mmss(elapsedMs)}</span>}
                <span>{pct}%</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Ancla contra el overlay fijo de LoadingScreen, que es el ancestro
          posicionado más cercano — por eso esta cara devuelve un fragmento y no
          un div propio. */}
      <motion.div
        className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-border"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
      >
        <motion.div
          className="h-full w-1/3 bg-primary"
          animate={{ x: ["-100%", "400%"] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>
    </>
  )
}

export function LoadingScreen({
  progress,
  locationName,
  steps,
  elapsedMs = 0,
  stalled = false,
  liveSync = false,
}: LoadingScreenProps) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background"
      // Opaque from the first frame (no enter fade) so the empty dashboard
      // behind it never shows through on initial load / after login. The exit
      // fade still plays to reveal the populated dashboard once data arrives.
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="absolute inset-x-0 top-0 h-0.5 bg-primary/80" />

      {/* El overlay, la línea de arriba y el fade de salida son los mismos en
          ambos caminos: cambiar de cara solo cambia el contenido de adentro, así
          que la escalada a sync en vivo no parpadea ni remonta la pantalla.
          Condicional plano en vez de AnimatePresence mode="wait" — ver el
          comentario de la píldora de subcuenta: una animación de repetición
          infinita nunca dispara el callback de exit y deja el swap trabado. */}
      {liveSync ? (
        <SyncFace
          progress={progress}
          locationName={locationName}
          steps={steps}
          elapsedMs={elapsedMs}
          stalled={stalled}
        />
      ) : (
        <CacheFace />
      )}
    </motion.div>
  )
}
