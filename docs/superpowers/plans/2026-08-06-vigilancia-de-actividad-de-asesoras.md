# Vigilancia de actividad de asesoras — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar a los dos paneles (VAEO y MESH) los dos gráficos que miden si las asesoras están *trabajando* sus leads —"Oportunidades sin atención" (matriz días-sin-mover × días-sin-mensaje) y "Tareas pendientes por asesor"— y cerrar de paso el tope silencioso de 500 tareas del sync.

**Architecture:** La agregación de cada gráfico vive en un módulo puro de `lib/` con su script `scripts/verify-*.ts`, igual que `advisor-breakdown.ts`. El eje de mensajes necesita datos que el sync actual no trae, así que se agrega **una ruta NDJSON nueva** (`app/api/conversation-activity`) cargada en segundo plano como `dashboard-messages`, más un hook cliente. Los dos componentes se montan idénticos en ambos paneles, con solo `panel` distinto, entrando por el objeto `shared` que ya arman los dos dashboards.

**Tech Stack:** Next.js 16 (App Router), TypeScript, React 19, Recharts vía `components/ui/chart.tsx`, Tailwind CSS v3, pnpm, `tsx` para los scripts de verificación.

**Documento de diseño:** `docs/superpowers/specs/2026-08-06-vigilancia-de-actividad-de-asesoras-design.md`. Léelo antes de empezar — registra por qué se descartó `updatedAt`, por qué el dataset de mensajes actual no sirve, y qué decidió el cliente.

## Global Constraints

- **Gestor de paquetes: pnpm.** `pnpm install` / `pnpm add`. **Nunca `npm install`** — deja `pnpm-lock.yaml` obsoleto y rompe el deploy de Vercel con `ERR_PNPM_OUTDATED_LOCKFILE`.
- **La compuerta real es `npx tsc --noEmit`.** `pnpm build` ignora errores de TypeScript (`next.config.mjs`) y `pnpm lint` está roto (`eslint` no es dependencia del repo). Un build verde no prueba nada.
- **No hay framework de pruebas y no se va a adoptar uno.** Los módulos puros se verifican con scripts `scripts/verify-*.ts` (`node:assert/strict`, corridos con `tsx`). Los componentes se verifican con `npx tsc --noEmit` y manejando la app real.
- **El paquete es CommonJS** (no hay `"type": "module"`), así que `tsx` compila a CJS, donde **el `await` de nivel superior falla**. Todo script de verificación envuelve su trabajo en `async function main()` y termina con `main();`.
- **Nunca se hace match de etapas ni de embudos por id, siempre por nombre**, insensible a mayúsculas — misma regla que `isWonOpp()` en `lib/opportunity-status.ts`.
- **Toda ruta que toca GHL** llama a `requireClient()` (`lib/session.ts`) y corre su trabajo dentro de `withClient(client, ...)` (`lib/ghl-context.ts`). En las rutas de streaming, **el contexto se entra DENTRO del callback `start()`** del `ReadableStream`, nunca alrededor del handler: el stream sobrevive al return del handler.
- **`ChartContainer` ya envuelve a su hijo en un `ResponsiveContainer` de Recharts.** No anides otro.
- **Series apiladas usan `SERIES_PALETTE` / `SERIES_NEUTRALS`** de `components/dashboard/dashboard-ui.tsx`, nunca `CHART_PALETTE`. Cinco tonos es el límite.
- **Toda cubeta centinela ("Sin fecha", "Sin asesor", "Sin dato") lleva SOLO su etiqueta en el rojizo `MISSING_TEXT`.** La barra, el segmento apilado y el sombreado siguen en gris: ahí el color codifica datos. Un estado vacío legítimo ("Sin tareas pendientes") NO usa `MISSING_TEXT`.
- **Los drill-downs resuelven joins contra los sets `all*` sin filtrar**, nunca contra la slice filtrada por fecha.
- **Idioma:** todo el texto de UI, los comentarios de código nuevo y los mensajes de commit van en **español**, siguiendo lo que ya hacen `advisor-breakdown.ts` y `lost-reason-matrix.tsx`.
- **Ninguno de los dos gráficos respeta el filtro global de fechas.** "Sin atención en 60 días" y "vencida" son condiciones de hoy, no de un periodo. Sí respetan los filtros de sucursal / asesor / origen / canal y el toggle de HubSpot, porque esos ya vienen aplicados en `scopedOpportunities`.

### Dos correcciones al spec, decididas aquí

1. **`buildTaskBacklog` recibe un parámetro más del que declara el spec.** El spec pide distinguir "contacto sin ninguna oportunidad" (va al bloque `unscoped`) de "contacto con oportunidades solo en la otra línea" (simplemente no cuenta en este panel). Esa distinción no se puede hacer con solo `scopedOpportunities`, así que la firma real lleva también `allOpportunities`.
2. **El spec dice `SERIES_NEUTRALS` para las cinco cubetas de tiempo; `SERIES_NEUTRALS` solo tiene dos tonos.** La lectura coherente con "cinco tonos, dentro del límite" y con la frase siguiente ("`Sin fecha` … la barra y el segmento apilado en gris") es: **las cuatro cubetas con fecha toman `SERIES_PALETTE` y `Sin fecha` toma `SERIES_NEUTRALS.empty`.** Así se implementa.

---

## Estructura de archivos

**Crear:**

| Archivo | Responsabilidad |
|---|---|
| `lib/task-backlog.ts` | Cubetas de vencimiento por zona horaria + matriz asesor × cubeta, con el reparto por panel |
| `scripts/verify-task-backlog.ts` | Aserciones de lo anterior (fronteras de día en `America/Mexico_City`, join por contacto) |
| `components/dashboard/task-backlog-chart.tsx` | "Tareas pendientes por asesor" — barras horizontales apiladas |
| `lib/stale-opportunity-matrix.ts` | Universo del embudo vivo + cubetas de ambos ejes + matriz cruzada |
| `scripts/verify-stale-matrix.ts` | Aserciones de lo anterior (fronteras 7/8 y 60/61, exclusión de etapas por nombre) |
| `app/api/conversation-activity/route.ts` | Stream NDJSON que deriva la fecha del último mensaje saliente por contacto |
| `hooks/use-conversation-activity.ts` | Hook cliente sobre `fetch-stream.ts`, con estado `loading | ready | error` |
| `components/dashboard/stale-opportunity-matrix.tsx` | "Oportunidades sin atención" — matriz con mapa de calor |

**Modificar:**

| Archivo | Cambio |
|---|---|
| `package.json` | Dos scripts `verify:*` nuevos |
| `lib/ghl-client.ts` | `lastStageChangeAt` en `GHLOpportunity`; `searchConversationsPage()` + sus tipos; `paginateTasks`/`searchLocationTasks` informan truncamiento |
| `lib/types.ts` | `lastStageChangeAt` en `Opportunity` |
| `lib/ghl-message-mapper.ts` | Exportar `isActivityMessage()` |
| `app/api/dashboard/route.ts` | El paso `tasks` emite `partial` cuando la paginación se detuvo por el tope |
| `app/page.tsx` | Montar `useConversationActivity()`; pasar `allTasks`, `conversationActivity` y `activityStatus` a los dos paneles |
| `components/dashboard/vaeo-dashboard.tsx` | Props nuevas + montar los dos gráficos |
| `components/dashboard/mesh-dashboard.tsx` | Idéntico, con `panel="mesh"` |
| `CLAUDE.md` | Documentar los dos módulos, los dos gráficos y los dos scripts nuevos |

---

## Task 1: `lib/task-backlog.ts` — la agregación del rezago de tareas

**Files:**
- Create: `lib/task-backlog.ts`
- Create: `scripts/verify-task-backlog.ts`
- Modify: `package.json` (bloque `scripts`)
- Modify: `CLAUDE.md` (lista de comandos `Verification`)

**Interfaces:**
- Consumes: `Task` y `Opportunity` de `lib/types.ts`; `NO_ADVISOR_LABEL` de `lib/advisor-breakdown.ts`.
- Produces:
  - `TASK_BUCKETS: readonly TaskBucket[]`, `type TaskBucket = "vencidas" | "hoy" | "prox7" | "adelante" | "sinFecha"`
  - `TASK_BUCKET_LABELS: Record<TaskBucket, string>`
  - `MISSING_TASK_BUCKETS: ReadonlySet<TaskBucket>` — las cubetas que son un hueco de captura y llevan su etiqueta en `MISSING_TEXT`
  - `PANEL_TIME_ZONE = "America/Mexico_City"`
  - `interface TaskBacklogCell { count: number; taskIds: string[]; contactIds: string[] }`
  - `interface TaskBacklogRow { advisor: string; unassigned: boolean; total: number; buckets: Record<TaskBucket, TaskBacklogCell>; taskIds: string[]; contactIds: string[] }`
  - `interface TaskBacklog { rows: TaskBacklogRow[]; totals: TaskBacklogRow; unscoped: TaskBacklogCell; grandTotal: number }`
  - `bucketOfDueDate(dueDate: string | undefined, now: Date, timeZone?: string): TaskBucket`
  - `buildTaskBacklog(tasks: Task[], scopedOpportunities: Opportunity[], allOpportunities: Opportunity[], now: Date, timeZone?: string): TaskBacklog`

**Contexto para quien implementa:** `Task` (`lib/types.ts`) trae `status: "pending" | "completed"`, `dueDate?: string` (ISO), `contactId: string` y `assignedToName?: string`. Las tareas de GHL **no traen `opportunityId`** poblado por el sync location-wide, así que el reparto por línea de negocio se hace por el contacto: contacto → sus oportunidades → embudo.

- [ ] **Paso 1: Escribir el script de verificación (falla porque el módulo no existe)**

Crear `scripts/verify-task-backlog.ts`:

```ts
// Verificación de lib/task-backlog.ts — las cubetas de vencimiento de
// "Tareas pendientes por asesor". Correr: pnpm verify:task-backlog
//
// Justifica el script la frontera de día: el servidor corre en UTC en Vercel y
// el cliente vive en America/Mexico_City, así que una tarea que vence hoy a las
// 23:00 local tiene un ISO que cae en el día UTC SIGUIENTE. Leerla sin zona la
// pinta como "Más adelante" cuando en realidad vence hoy — un gráfico de rezago
// que tranquiliza de más es peor que no tenerlo.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Opportunity, Task } from "../lib/types";
import {
  bucketOfDueDate,
  buildTaskBacklog,
  PANEL_TIME_ZONE,
  TASK_BUCKETS,
} from "../lib/task-backlog";
import { NO_ADVISOR_LABEL } from "../lib/advisor-breakdown";

let seq = 0;

function task(t: {
  contactId: string;
  dueDate?: string;
  advisor?: string;
  status?: Task["status"];
}): Task {
  return {
    id: `t${++seq}`,
    title: `Tarea ${seq}`,
    status: t.status ?? "pending",
    dueDate: t.dueDate,
    contactId: t.contactId,
    assignedToName: t.advisor,
  };
}

function opp(o: { contactId: string; pipelineId: string }): Opportunity {
  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: o.pipelineId,
    pipelineStageId: "stage-1",
    status: "open",
    createdAt: "2026-06-15T12:00:00.000Z",
    contactId: o.contactId,
    value: 0,
    stage: "Nuevo Lead",
    pipelineName: "VAEO",
  };
}

const VAEO = "MiATYfkJWklaXqYc7hOr";
const MESH = "DkZiRWdizgMRt7osjuRb";

// 2026-08-06 a las 12:00 en America/Mexico_City (UTC-6) = 18:00Z.
const NOW = new Date("2026-08-06T18:00:00.000Z");

async function main() {
  // 1. Cubetas básicas contra NOW.
  {
    assert.equal(bucketOfDueDate(undefined, NOW), "sinFecha", "sin dueDate");
    assert.equal(bucketOfDueDate("no-es-fecha", NOW), "sinFecha", "dueDate ilegible");
    assert.equal(bucketOfDueDate("2026-08-05T18:00:00.000Z", NOW), "vencidas", "ayer");
    assert.equal(bucketOfDueDate("2026-08-06T09:00:00.000Z", NOW), "hoy", "hoy en la mañana");
    assert.equal(bucketOfDueDate("2026-08-07T18:00:00.000Z", NOW), "prox7", "mañana");
    assert.equal(bucketOfDueDate("2026-08-13T18:00:00.000Z", NOW), "prox7", "día +7, último de la cubeta");
    assert.equal(bucketOfDueDate("2026-08-14T18:00:00.000Z", NOW), "adelante", "día +8, ya no");
  }

  // 2. LA razón de ser del script: la frontera de día es LOCAL, no UTC.
  {
    // 2026-08-06 23:30 en Mexico_City = 2026-08-07T05:30Z. En UTC sería mañana;
    // en la zona del cliente todavía es hoy.
    assert.equal(
      bucketOfDueDate("2026-08-07T05:30:00.000Z", NOW),
      "hoy",
      "23:30 hora local del día de hoy NO es mañana"
    );
    // 2026-08-05 23:30 local = 2026-08-06T05:30Z. En UTC es hoy; localmente
    // venció ayer.
    assert.equal(
      bucketOfDueDate("2026-08-06T05:30:00.000Z", NOW),
      "vencidas",
      "23:30 hora local de ayer YA venció"
    );
    // Con la zona equivocada, ambas se irían a la cubeta de al lado.
    assert.equal(bucketOfDueDate("2026-08-07T05:30:00.000Z", NOW, "UTC"), "prox7");
  }

  // 3. Solo cuentan las pendientes.
  {
    const tasks = [
      task({ contactId: "c1" }),
      task({ contactId: "c1", status: "completed" }),
    ];
    const opps = [opp({ contactId: "c1", pipelineId: VAEO })];
    const b = buildTaskBacklog(tasks, opps, opps, NOW, PANEL_TIME_ZONE);
    assert.equal(b.grandTotal, 1, "la completada no es rezago");
  }

  // 4. Reparto por panel: el join va contacto → sus oportunidades → embudo.
  {
    const opps = [
      opp({ contactId: "c-vaeo", pipelineId: VAEO }),
      opp({ contactId: "c-mesh", pipelineId: MESH }),
      opp({ contactId: "c-ambos", pipelineId: VAEO }),
      opp({ contactId: "c-ambos", pipelineId: MESH }),
    ];
    const tasks = [
      task({ contactId: "c-vaeo", advisor: "Zulema Silva" }),
      task({ contactId: "c-mesh", advisor: "Zulema Silva" }),
      task({ contactId: "c-ambos", advisor: "Zulema Silva" }),
      task({ contactId: "c-huerfano", advisor: "Zulema Silva" }),
    ];
    const scopedVaeo = opps.filter((o) => o.pipelineId === VAEO);
    const scopedMesh = opps.filter((o) => o.pipelineId === MESH);

    const v = buildTaskBacklog(tasks, scopedVaeo, opps, NOW, PANEL_TIME_ZONE);
    assert.equal(v.grandTotal, 2, "VAEO ve c-vaeo y c-ambos");
    assert.equal(v.unscoped.count, 1, "c-huerfano queda fuera del agregado");
    assert.deepEqual(v.unscoped.contactIds, ["c-huerfano"]);

    const m = buildTaskBacklog(tasks, scopedMesh, opps, NOW, PANEL_TIME_ZONE);
    assert.equal(m.grandTotal, 2, "MESH ve c-mesh y c-ambos");
    assert.equal(m.unscoped.count, 1, "el huérfano se reporta en LOS DOS paneles");

    // El contacto con oportunidades en ambas líneas cuenta en ambas: es la
    // misma regla que el panel ya fija para contactos compartidos.
    const inV = v.rows[0].contactIds.includes("c-ambos");
    const inM = m.rows[0].contactIds.includes("c-ambos");
    assert.ok(inV && inM, "c-ambos aparece en los dos paneles");

    // Y el contacto de la OTRA línea nunca se cuela ni como unscoped.
    assert.ok(!v.unscoped.contactIds.includes("c-mesh"), "c-mesh no es huérfano, es de la otra línea");
  }

  // 5. Asesor: se toma de assignedToName; vacío ⇒ "Sin asesor", siempre al final.
  {
    const opps = [
      opp({ contactId: "c1", pipelineId: VAEO }),
      opp({ contactId: "c2", pipelineId: VAEO }),
      opp({ contactId: "c3", pipelineId: VAEO }),
    ];
    const tasks = [
      task({ contactId: "c1", advisor: "Zulema Silva" }),
      task({ contactId: "c2", advisor: "  " }),
      task({ contactId: "c3" }),
      task({ contactId: "c1", advisor: "Diana Arbelaez" }),
      task({ contactId: "c1", advisor: "Diana Arbelaez" }),
    ];
    const b = buildTaskBacklog(tasks, opps, opps, NOW, PANEL_TIME_ZONE);
    assert.equal(b.rows.at(-1)!.advisor, NO_ADVISOR_LABEL, "sin asesor va al final");
    assert.equal(b.rows.at(-1)!.total, 2, "el espacio en blanco cuenta como sin asesor");
    assert.ok(b.rows.at(-1)!.unassigned);
    assert.equal(b.rows[0].advisor, "Diana Arbelaez", "las filas se ordenan por volumen");
    assert.equal(b.rows[0].total, 2);
  }

  // 6. Los totales cuadran con la suma de las celdas.
  {
    const opps = [opp({ contactId: "c1", pipelineId: VAEO })];
    const tasks = [
      task({ contactId: "c1", advisor: "Zulema Silva", dueDate: "2026-08-01T18:00:00.000Z" }),
      task({ contactId: "c1", advisor: "Zulema Silva", dueDate: "2026-08-06T09:00:00.000Z" }),
      task({ contactId: "c1", advisor: "Diana Arbelaez", dueDate: "2026-09-30T18:00:00.000Z" }),
      task({ contactId: "c1", advisor: "Diana Arbelaez" }),
    ];
    const b = buildTaskBacklog(tasks, opps, opps, NOW, PANEL_TIME_ZONE);
    const sumCells = b.rows.reduce(
      (acc, r) => acc + TASK_BUCKETS.reduce((a, k) => a + r.buckets[k].count, 0),
      0
    );
    assert.equal(sumCells, b.grandTotal, "celdas = gran total");
    assert.equal(b.totals.total, b.grandTotal, "la fila de totales cuadra");
    assert.equal(b.totals.buckets.vencidas.count, 1);
    assert.equal(b.totals.buckets.hoy.count, 1);
    assert.equal(b.totals.buckets.adelante.count, 1);
    assert.equal(b.totals.buckets.sinFecha.count, 1);
    assert.equal(b.totals.taskIds.length, 4, "los ids del total no se pierden");
  }

  // 7. Conjuntos vacíos.
  {
    const b = buildTaskBacklog([], [], [], NOW, PANEL_TIME_ZONE);
    assert.deepEqual(b.rows, []);
    assert.equal(b.grandTotal, 0);
    assert.equal(b.unscoped.count, 0);
    assert.equal(b.totals.total, 0);
  }

  console.log("verify-task-backlog: all assertions passed");
}

main();
```

- [ ] **Paso 2: Registrar el script en `package.json` y en `CLAUDE.md`**

En `package.json`, dentro de `"scripts"`, después de la línea de `"verify:filters"`:

```json
    "verify:task-backlog": "tsx scripts/verify-task-backlog.ts",
```

En `CLAUDE.md`, dentro del bloque ` ```bash ` de la sección `## Commands`, después de la línea `pnpm verify:category-filter`:

```
pnpm verify:task-backlog # lib/task-backlog.ts — cubetas de vencimiento por zona horaria
```

- [ ] **Paso 3: Correr el script para verificar que falla**

Run: `pnpm verify:task-backlog`
Expected: FAIL — `Cannot find module '../lib/task-backlog'`.

- [ ] **Paso 4: Escribir `lib/task-backlog.ts`**

```ts
// Agregación detrás de "Tareas pendientes por asesor": el rezago de las tareas
// abiertas, repartido por asesor y por qué tan vencidas están.
//
// Puro y sin React, igual que lib/advisor-breakdown.ts y por la misma razón: un
// conteo mal cubeteado aquí se ve idéntico a uno bien en pantalla. Vive bajo
// scripts/verify-task-backlog.ts.
//
// La frontera de día se calcula SIEMPRE en una zona horaria explícita. El
// servidor corre en UTC en Vercel; sin la zona, una tarea que vence hoy a las
// 23:00 hora de México tiene un ISO del día UTC siguiente y se leería como
// "Más adelante" en vez de "Hoy".
import type { Opportunity, Task } from "./types"
import { NO_ADVISOR_LABEL } from "./advisor-breakdown"

/** La zona del cliente. Las rutas de IA ya usan este mismo default. */
export const PANEL_TIME_ZONE = "America/Mexico_City"

export const TASK_BUCKETS = ["vencidas", "hoy", "prox7", "adelante", "sinFecha"] as const
export type TaskBucket = (typeof TASK_BUCKETS)[number]

export const TASK_BUCKET_LABELS: Record<TaskBucket, string> = {
  vencidas: "Vencidas",
  hoy: "Hoy",
  prox7: "Próx. 7 días",
  adelante: "Más adelante",
  sinFecha: "Sin fecha",
}

/** Cubetas que son un hueco de captura y no una condición del negocio. */
export const MISSING_TASK_BUCKETS: ReadonlySet<TaskBucket> = new Set<TaskBucket>(["sinFecha"])

export interface TaskBacklogCell {
  count: number
  taskIds: string[]
  /** Contactos únicos de la celda, en orden de aparición — para el drill-down. */
  contactIds: string[]
}

export interface TaskBacklogRow {
  advisor: string
  /** true solo en la fila NO_ADVISOR_LABEL, que se pinta distinto y va al final. */
  unassigned: boolean
  total: number
  buckets: Record<TaskBucket, TaskBacklogCell>
  taskIds: string[]
  contactIds: string[]
}

export interface TaskBacklog {
  rows: TaskBacklogRow[]
  /** Fila de totales por cubeta; `advisor` vale "Total". */
  totals: TaskBacklogRow
  /**
   * Tareas de contactos SIN ninguna oportunidad en el dataset. No se tiran —
   * son la misma fuga que vigila la tarjeta "Contactos sin oportunidad" — pero
   * quedan fuera del agregado, porque no hay dato que las atribuya a una línea.
   */
  unscoped: TaskBacklogCell
  grandTotal: number
}

function emptyCell(): TaskBacklogCell {
  return { count: 0, taskIds: [], contactIds: [] }
}

function emptyRow(advisor: string, unassigned = false): TaskBacklogRow {
  const buckets = {} as Record<TaskBucket, TaskBacklogCell>
  for (const b of TASK_BUCKETS) buckets[b] = emptyCell()
  return { advisor, unassigned, total: 0, buckets, taskIds: [], contactIds: [] }
}

function push(cell: TaskBacklogCell, taskId: string, contactId: string) {
  cell.count += 1
  cell.taskIds.push(taskId)
  if (contactId && !cell.contactIds.includes(contactId)) cell.contactIds.push(contactId)
}

/**
 * Índice de día calendario en `timeZone`: días enteros desde la época. Restar
 * dos de estos da la diferencia en DÍAS LOCALES, que es la única resta que no
 * se equivoca cerca de la medianoche ni en un cambio de horario.
 *
 * `en-CA` se usa porque formatea como YYYY-MM-DD, que se parsea sin ambigüedad.
 */
function dayIndex(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d)
  const [y, m, day] = parts.split("-").map(Number)
  return Date.UTC(y, m - 1, day) / 86_400_000
}

/**
 * Cubeta de vencimiento de una tarea. Sin `dueDate` o con una fecha ilegible ⇒
 * `sinFecha`: no es "más adelante", es un dato que nadie capturó.
 */
export function bucketOfDueDate(
  dueDate: string | undefined,
  now: Date,
  timeZone: string = PANEL_TIME_ZONE
): TaskBucket {
  if (!dueDate) return "sinFecha"
  const due = new Date(dueDate)
  if (Number.isNaN(due.getTime())) return "sinFecha"

  const diff = dayIndex(due, timeZone) - dayIndex(now, timeZone)
  if (diff < 0) return "vencidas"
  if (diff === 0) return "hoy"
  if (diff <= 7) return "prox7"
  return "adelante"
}

/**
 * Rezago de tareas del panel.
 *
 * `scopedOpportunities` ya viene acotado al embudo del panel y a los filtros
 * globales; `allOpportunities` es el set completo y sirve solo para distinguir
 * al contacto huérfano (sin ninguna oportunidad, va a `unscoped`) del contacto
 * que sí tiene oportunidades pero en la otra línea (simplemente no cuenta aquí).
 *
 * Ignora el filtro global de fechas a propósito: "vencida" es una condición de
 * hoy, no de un periodo.
 */
export function buildTaskBacklog(
  tasks: Task[],
  scopedOpportunities: Opportunity[],
  allOpportunities: Opportunity[],
  now: Date,
  timeZone: string = PANEL_TIME_ZONE
): TaskBacklog {
  const scopedContacts = new Set<string>()
  for (const o of scopedOpportunities) if (o.contactId) scopedContacts.add(o.contactId)

  const anyContacts = new Set<string>()
  for (const o of allOpportunities) if (o.contactId) anyContacts.add(o.contactId)

  const byAdvisor = new Map<string, TaskBacklogRow>()
  const unscoped = emptyCell()

  for (const t of tasks) {
    if (t.status !== "pending") continue

    if (!scopedContacts.has(t.contactId)) {
      // Sin ninguna oportunidad ⇒ no es atribuible a una línea, se reporta
      // aparte. Con oportunidades solo en la otra línea ⇒ se descarta aquí.
      if (!anyContacts.has(t.contactId)) push(unscoped, t.id, t.contactId)
      continue
    }

    const name = (t.assignedToName ?? "").trim() || NO_ADVISOR_LABEL
    let row = byAdvisor.get(name)
    if (!row) {
      row = emptyRow(name, name === NO_ADVISOR_LABEL)
      byAdvisor.set(name, row)
    }

    push(row.buckets[bucketOfDueDate(t.dueDate, now, timeZone)], t.id, t.contactId)
    row.total += 1
    row.taskIds.push(t.id)
    if (t.contactId && !row.contactIds.includes(t.contactId)) row.contactIds.push(t.contactId)
  }

  const rows = [...byAdvisor.values()].sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1
    return b.total - a.total || a.advisor.localeCompare(b.advisor, "es")
  })

  // Los totales se acumulan sobre las filas YA calculadas, para que no exista
  // una segunda pasada sobre `tasks` que pueda contar distinto.
  const totals = emptyRow("Total")
  for (const r of rows) {
    totals.total += r.total
    totals.taskIds.push(...r.taskIds)
    for (const c of r.contactIds) if (!totals.contactIds.includes(c)) totals.contactIds.push(c)
    for (const b of TASK_BUCKETS) {
      const src = r.buckets[b]
      const dst = totals.buckets[b]
      dst.count += src.count
      dst.taskIds.push(...src.taskIds)
      for (const c of src.contactIds) if (!dst.contactIds.includes(c)) dst.contactIds.push(c)
    }
  }

  return { rows, totals, unscoped, grandTotal: totals.total }
}
```

- [ ] **Paso 5: Correr el script hasta que pase**

Run: `pnpm verify:task-backlog`
Expected: PASS — `verify-task-backlog: all assertions passed`

- [ ] **Paso 6: Comprobar los tipos**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Paso 7: Commit**

```bash
git add lib/task-backlog.ts scripts/verify-task-backlog.ts package.json CLAUDE.md
git commit -m "feat(lib): agregar el rezago de tareas por asesor con cubetas por zona horaria"
```

---

## Task 2: `task-backlog-chart.tsx` — "Tareas pendientes por asesor"

**Files:**
- Create: `components/dashboard/task-backlog-chart.tsx`
- Modify: `components/dashboard/vaeo-dashboard.tsx`
- Modify: `components/dashboard/mesh-dashboard.tsx`
- Modify: `app/page.tsx`

**Interfaces:**
- Consumes: todo lo que produce Task 1; `PANEL_SCOPES` / `scopeOpportunities` / `PanelId` de `lib/panel-scope.ts`; `ChartDrillDrawer` / `DRILL_CLOSED` / `DrillState` de `./chart-drill-drawer`; el chrome de `./dashboard-ui`.
- Produces: `TaskBacklogChart` y `TaskBacklogChartProps`; la prop nueva `allTasks?: Task[]` en `VaeoDashboardProps` y `MeshDashboardProps`.

**Por qué `allTasks` y no `tasks`:** `app/page.tsx` ya pasa `tasks`, pero **filtradas por fecha de creación**. Este gráfico ignora el filtro de fechas por diseño, así que necesita el set completo. Se agrega una prop nueva en vez de cambiar la existente, que otros drawers sí usan.

- [ ] **Paso 1: Crear el componente**

Crear `components/dashboard/task-backlog-chart.tsx`:

```tsx
"use client"

import { useMemo, useState } from "react"
import { ListChecks } from "lucide-react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import type {
  Appointment,
  Call,
  Contact,
  Message,
  Opportunity,
  Pauta,
  Pipeline,
  Task,
} from "@/lib/types"
import {
  buildTaskBacklog,
  MISSING_TASK_BUCKETS,
  TASK_BUCKETS,
  TASK_BUCKET_LABELS,
  type TaskBacklogCell,
  type TaskBucket,
} from "@/lib/task-backlog"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import { cn } from "@/lib/utils"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import {
  CHART_GRID_STROKE,
  CHART_TICK,
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  DashboardCard,
  MISSING_TEXT,
  NonZeroTooltipContent,
  ScopePill,
  SERIES_NEUTRALS,
  SERIES_PALETTE,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const n = (v: number) => v.toLocaleString("es-MX")

/**
 * Color por cubeta. Las cuatro con fecha toman SERIES_PALETTE —validada por
 * pares para stacks— y "Sin fecha" toma el gris de SERIES_NEUTRALS: es un hueco
 * de captura, no un plazo, y el gris lo dice sin inventar una quinta urgencia.
 * La asignación es posicional; la leyenda es la que carga el significado.
 */
const BUCKET_COLOR: Record<TaskBucket, { light: string; dark: string }> = {
  vencidas: { light: SERIES_PALETTE.light[0], dark: SERIES_PALETTE.dark[0] },
  hoy: { light: SERIES_PALETTE.light[1], dark: SERIES_PALETTE.dark[1] },
  prox7: { light: SERIES_PALETTE.light[2], dark: SERIES_PALETTE.dark[2] },
  adelante: { light: SERIES_PALETTE.light[3], dark: SERIES_PALETTE.dark[3] },
  sinFecha: SERIES_NEUTRALS.empty,
}

export interface TaskBacklogChartProps {
  panel: PanelId
  /** Oportunidades ya filtradas por fecha — NO se usan aquí; ver allOpportunities. */
  opportunities: Opportunity[]
  /** Sin filtrar — este gráfico ignora el filtro de fechas. */
  allOpportunities: Opportunity[]
  /** Tareas SIN filtrar por fecha: "vencida" es una condición de hoy. */
  allTasks: Task[]
  contacts: Contact[]
  allContacts: Contact[]
  pipelines?: Pipeline[]
  tasks?: Task[]
  calls?: Call[]
  allPautas?: Pauta[]
  appointments?: Appointment[]
  messages?: Message[]
  locationId?: string
}

/**
 * "Tareas pendientes por asesor": cuánto rezago carga cada quien y qué tan
 * vencido está.
 *
 * Es la contraparte de AdvisorStageTable: esa dice qué cartera tiene cada
 * asesor, esta dice qué de esa cartera ya se le pasó.
 *
 * Las tareas de GHL no traen opportunityId, así que el reparto por línea de
 * negocio va contacto → sus oportunidades → embudo. Un contacto con
 * oportunidades en las dos líneas pone su tarea en los dos paneles; uno sin
 * ninguna oportunidad va a la nota de abajo, fuera del agregado.
 */
export function TaskBacklogChart({
  panel,
  allOpportunities,
  allTasks,
  contacts,
  allContacts,
  pipelines = [],
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId = "",
}: TaskBacklogChartProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]

  const backlog = useMemo(() => {
    const scoped = scopeOpportunities(allOpportunities, panel, pipelines)
    return buildTaskBacklog(allTasks, scoped, allOpportunities, new Date())
  }, [allTasks, allOpportunities, panel, pipelines])

  const config: ChartConfig = useMemo(() => {
    const out: ChartConfig = {}
    for (const b of TASK_BUCKETS) {
      out[b] = { label: TASK_BUCKET_LABELS[b], theme: BUCKET_COLOR[b] }
    }
    return out
  }, [])

  // Recharts consume filas planas. Las cubetas en cero se dejan AUSENTES, no en
  // cero: un cero mete un rectángulo de altura 0 en el stack y desordena el
  // cálculo de cuál segmento queda al final.
  const rows = useMemo(
    () =>
      backlog.rows.map((r) => {
        const row: Record<string, string | number> = { advisor: r.advisor, total: r.total }
        for (const b of TASK_BUCKETS) {
          const c = r.buckets[b].count
          if (c) row[b] = c
        }
        return row
      }),
    [backlog.rows]
  )

  const lastBucketByRow = useMemo(
    () =>
      rows.map((row) => {
        let last: TaskBucket | null = null
        for (const b of TASK_BUCKETS) if (row[b]) last = b
        return last
      }),
    [rows]
  )

  const contactById = useMemo(
    () => new Map((allContacts.length > 0 ? allContacts : contacts).map((c) => [c.id, c])),
    [allContacts, contacts]
  )

  const openDrill = (cell: TaskBacklogCell, title: string, note: string) => {
    if (cell.count === 0) return
    const contactItems = cell.contactIds
      .map((id) => contactById.get(id))
      .filter((c): c is Contact => Boolean(c))
    if (contactItems.length === 0) return
    setDrill({
      open: true,
      title,
      subtitle: `Embudo ${scope.label} · ${note}`,
      opportunities: [],
      contactItems,
    })
  }

  const chartId = `tareas-${panel}`
  // 28px por fila más el margen: con tres asesoras el gráfico no debe ocupar
  // 280px de alto vacío, y con quince no debe aplastar las barras.
  const chartHeight = Math.max(140, backlog.rows.length * 34 + 40)

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Tareas pendientes por asesor"
        icon={ListChecks}
        total={backlog.grandTotal}
        actions={
          <ScopePill
            label="Pendientes · a la fecha de hoy"
            tooltip={
              <>
                Tareas <strong>pendientes</strong> de los contactos que tienen al menos una
                oportunidad en el embudo <strong>{scope.label}</strong>, agrupadas por el
                asesor asignado y por qué tan cerca está su vencimiento.{" "}
                <strong>No respeta el filtro de fechas</strong>: &ldquo;vencida&rdquo; es una
                condición de hoy, no de un periodo. Sí respeta los filtros de sucursal,
                asesor, origen y canal. Las tareas de GHL no guardan a qué oportunidad
                pertenecen, así que el reparto por línea de negocio va por el contacto — uno
                con oportunidades en las dos líneas aparece en los dos paneles.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {backlog.grandTotal === 0 ? (
          <ChartEmpty message="Sin tareas pendientes en este embudo" />
        ) : (
          <>
            <div
              data-chart={`chart-${chartId}`}
              className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1"
            >
              {TASK_BUCKETS.map((b) => {
                const count = backlog.totals.buckets[b].count
                if (count === 0) return null
                return (
                  <span
                    key={b}
                    className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: `var(--color-${b})` }}
                      aria-hidden
                    />
                    {/* La cubeta centinela lleva la ETIQUETA en rojizo, pero su
                        muestra de color sigue en gris: ese cuadro tiene que
                        casar con el segmento del stack. */}
                    <span className={cn(MISSING_TASK_BUCKETS.has(b) && MISSING_TEXT)}>
                      {TASK_BUCKET_LABELS[b]}
                    </span>
                    <span className="tabular-nums">{n(count)}</span>
                  </span>
                )
              })}
            </div>

            {/* Alto por estilo en línea, no por clase: es dinámico. El
                `aspect-video` que trae ChartContainer por defecto queda
                neutralizado — CSS ignora aspect-ratio cuando alto y ancho están
                los dos declarados. */}
            <ChartContainer id={chartId} config={config} style={{ height: chartHeight }} className="w-full">
              <BarChart
                data={rows}
                layout="vertical"
                margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={CHART_GRID_STROKE} />
                <XAxis type="number" tick={CHART_TICK} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="advisor"
                  tick={CHART_TICK}
                  tickLine={false}
                  axisLine={false}
                  width={128}
                />
                <ChartTooltip
                  content={
                    <NonZeroTooltipContent
                      formatter={(value, name) => (
                        <div className="flex w-full items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: `var(--color-${name})` }}
                            aria-hidden
                          />
                          <span className="flex-1 truncate text-muted-foreground">
                            {TASK_BUCKET_LABELS[name as TaskBucket] ?? name}
                          </span>
                          <span className="font-mono font-medium tabular-nums text-foreground">
                            {n(Number(value))}
                          </span>
                        </div>
                      )}
                    />
                  }
                />
                {TASK_BUCKETS.map((b) => (
                  <Bar
                    key={b}
                    dataKey={b}
                    stackId="tareas"
                    fill={`var(--color-${b})`}
                    onClick={(_: unknown, index: number) => {
                      const row = backlog.rows[index]
                      if (!row) return
                      openDrill(
                        row.buckets[b],
                        `${row.advisor} — ${TASK_BUCKET_LABELS[b]}`,
                        `${n(row.buckets[b].count)} tareas pendientes`
                      )
                    }}
                    className="cursor-pointer"
                  />
                ))}
              </BarChart>
            </ChartContainer>

            {backlog.unscoped.count > 0 && (
              <button
                type="button"
                onClick={() =>
                  openDrill(
                    backlog.unscoped,
                    "Tareas de contactos sin oportunidad",
                    `${n(backlog.unscoped.count)} tareas pendientes`
                  )
                }
                className={cn(
                  "mt-2 text-left text-[11px] underline-offset-2 hover:underline",
                  MISSING_TEXT
                )}
              >
                {n(backlog.unscoped.count)} tareas pendientes de contactos sin ninguna
                oportunidad — no se pueden atribuir a una línea de negocio y quedan fuera
                del gráfico.
              </button>
            )}
          </>
        )}
      </ChartCardContent>

      <ChartDrillDrawer
        drill={drill}
        onDrillChange={setDrill}
        contacts={allContacts.length > 0 ? allContacts : contacts}
        tasks={tasks}
        calls={calls}
        allOpportunities={allOpportunities}
        allPautas={allPautas}
        appointments={appointments}
        messages={messages}
        locationId={locationId}
      />
    </DashboardCard>
  )
}
```

> `lastBucketByRow` queda calculado y sin usar: está ahí por si al ver el gráfico real quieres redondear el último segmento de cada barra (`radius` en un `<Cell>`, como hace `sales-by-dimension-chart`). Si decides no hacerlo, **bórralo** — `npx tsc --noEmit` no marca constantes sin usar, pero el repo no las deja.

- [ ] **Paso 2: Pasar `allTasks` desde `app/page.tsx`**

En `app/page.tsx`, dentro de `<VaeoDashboard ...>`, justo después de la línea `tasks={tasks}`:

```tsx
            allTasks={data?.tasks ?? []}
```

Repetir exactamente lo mismo dentro de `<MeshDashboard ...>`, después de su propia línea `tasks={tasks}`.

- [ ] **Paso 3: Declarar la prop y montar el gráfico en los dos paneles**

En `components/dashboard/vaeo-dashboard.tsx`:

1. En la interfaz `VaeoDashboardProps`, después de `tasks?: Task[]`:

```ts
  /** Tareas SIN filtrar por fecha — el rezago se mide contra hoy, no contra el periodo. */
  allTasks?: Task[]
```

2. En la firma desestructurada del componente, después de `tasks = [],`:

```ts
  allTasks = [],
```

3. En el import de componentes, después de la línea de `AdvisorStageTable`:

```ts
import { TaskBacklogChart } from "./task-backlog-chart"
```

4. En el JSX, inmediatamente después de `<AdvisorStageTable {...shared} />`:

```tsx
      <TaskBacklogChart {...shared} allTasks={allTasks} />
```

Aplicar los cuatro cambios idénticos en `components/dashboard/mesh-dashboard.tsx` (la interfaz ahí se llama `MeshDashboardProps`). Las dos listas de props deben quedar en sincronía: es lo que permite que un gráfico se mueva entre paneles sin tocarlo.

- [ ] **Paso 4: Comprobar los tipos**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Paso 5: Manejar la app real**

Run: `pnpm dev`, abrir `http://localhost:3000`, entrar con la contraseña del cliente.

Verificar, en las pestañas VAEO **y** MESH:
1. La tarjeta aparece justo debajo de "Oportunidades por asesor".
2. El total del encabezado es igual a la suma de los números de la leyenda.
3. Mover el filtro global de fechas **no** cambia ningún número de esta tarjeta.
4. Poner un filtro de sucursal **sí** los cambia.
5. Clic en un segmento abre el drawer con contactos, y el conteo del drawer coincide con el del tooltip.
6. La consola del navegador no imprime el aviso de Recharts `"width and height are both fixed numbers"`.

- [ ] **Paso 6: Commit**

```bash
git add components/dashboard/task-backlog-chart.tsx components/dashboard/vaeo-dashboard.tsx components/dashboard/mesh-dashboard.tsx app/page.tsx
git commit -m "feat(panel): montar el rezago de tareas por asesor en los dos paneles"
```

---

## Task 3: el tope de 500 tareas deja de ser silencioso

**Files:**
- Modify: `lib/ghl-client.ts:721-757` (`paginateTasks`, `searchLocationTasks`)
- Modify: `app/api/dashboard/route.ts:593-595` (el paso `tasks`)

**Interfaces:**
- Consumes: `PagedResult<T>` de `lib/paged-fetch.ts`.
- Produces: `searchLocationTasks()` ahora devuelve `{ tasks: GHLTask[]; truncated: boolean }` en vez de `GHLTask[]`. Único llamador en el repo: `app/api/dashboard/route.ts`.

**Por qué:** `paginateTasks` corta en `CAP = 500` **por estado**. Si la sub-cuenta pasa de 500 tareas pendientes, la paginación se detiene y el gráfico de la Task 2 subcuenta en silencio: un gráfico de rezago que da una respuesta tranquilizadora y falsa. La maquinaria de aviso ya existe entera (el frame `step` con `status: "partial"`, el `warnings[]` del frame `data`, y `sync-warning-banner.tsx`, que ya tiene su copy para la clave `tasks`); solo falta que alguien la dispare.

- [ ] **Paso 1: Hacer que `paginateTasks` informe si se detuvo por el tope**

En `lib/ghl-client.ts`, reemplazar el cuerpo de `paginateTasks` (líneas ~721-741):

```ts
async function paginateTasks(filters: {
  contactId?: string[];
  completed: boolean;
  assignedTo?: string[];
  query?: string;
}, cap: number): Promise<{ tasks: GHLTask[]; truncated: boolean }> {
  const limit = 100;
  const all: GHLTask[] = [];
  let skip = 0;
  while (true) {
    const res = await fetchTaskPage(filters, skip, limit);
    all.push(...res.tasks);
    // Página corta = se acabaron los datos. Esta es la ÚNICA salida limpia.
    if (res.tasks.length < limit) return { tasks: all, truncated: false };
    skip += limit;
    // Salir por el tope significa que quedaron tareas sin traer, y el llamador
    // tiene que poder decirlo: un gráfico de rezago que subcuenta en silencio
    // da una respuesta tranquilizadora y falsa.
    if (all.length >= cap) return { tasks: all, truncated: true };
  }
}
```

- [ ] **Paso 2: Propagar el flag por `searchLocationTasks`**

Reemplazar el cuerpo de `searchLocationTasks` (líneas ~742-757):

```ts
// GHL's task search endpoint requires `completed` to be explicitly set —
// omitting it returns an empty list. Fetch pending and completed separately.
export async function searchLocationTasks(filters: {
  contactId?: string[];
  completed?: boolean;
  assignedTo?: string[];
  query?: string;
} = {}): Promise<{ tasks: GHLTask[]; truncated: boolean }> {
  const CAP = 500;

  if (filters.completed !== undefined) {
    return paginateTasks({ ...filters, completed: filters.completed }, CAP);
  }

  const { completed: _ignored, ...rest } = filters;
  const [pending, done] = await Promise.all([
    paginateTasks({ ...rest, completed: false }, CAP),
    paginateTasks({ ...rest, completed: true }, CAP),
  ]);
  return {
    tasks: [...pending.tasks, ...done.tasks],
    truncated: pending.truncated || done.truncated,
  };
}
```

- [ ] **Paso 3: Emitir el paso `tasks` como `partial` cuando se truncó**

En `app/api/dashboard/route.ts`, reemplazar el bloque del dataset `tasks` (línea ~593):

```ts
              runDataset("tasks", send, async () => {
                const { tasks, truncated } = await searchLocationTasks();
                const records = tasks.map(transformTask);
                // `missingPages` no vacío es lo que hace que runDataset marque el
                // paso como "partial" y que la ruta emita el warning ámbar. No se
                // sabe CUÁNTAS faltan (el endpoint no reporta total), así que va
                // sin `total` y el banner omite el "de ~N".
                return {
                  records,
                  missingPages: truncated ? [1] : [],
                  missingEstimate: 0,
                };
              }),
```

`asPaged` ya no se usa para tareas; sigue en uso para las citas, así que **no lo borres**.

- [ ] **Paso 4: Comprobar los tipos y que la paginación sigue verificada**

Run: `npx tsc --noEmit && pnpm verify:paged`
Expected: sin errores de tipos; `verify-paged-fetch` pasa (no toca `paginateTasks`, pero comparte el tipo `PagedResult` que este cambio construye a mano).

- [ ] **Paso 5: Verificar el camino de aviso bajando el tope a propósito**

Cambiar temporalmente `const CAP = 500;` a `const CAP = 100;` en `lib/ghl-client.ts`, correr `pnpm dev`, y comprobar:
1. La pantalla de carga marca el paso "tasks" como incompleto.
2. Aparece el banner ámbar de `sync-warning-banner.tsx` diciendo "Se cargaron N tareas…".

**Regresar `CAP` a 500 antes de commitear.** Confirmarlo con `git diff lib/ghl-client.ts`.

- [ ] **Paso 6: Commit**

```bash
git add lib/ghl-client.ts app/api/dashboard/route.ts
git commit -m "fix(sync): avisar cuando la paginación de tareas se detiene por el tope"
```

---

## Task 4: `lib/stale-opportunity-matrix.ts` — la agregación de la matriz

**Files:**
- Modify: `lib/ghl-client.ts` (interfaz `GHLOpportunity`, cerca de la línea 356)
- Modify: `lib/types.ts` (interfaz `Opportunity`)
- Create: `lib/stale-opportunity-matrix.ts`
- Create: `scripts/verify-stale-matrix.ts`
- Modify: `package.json`, `CLAUDE.md`

**Interfaces:**
- Consumes: `Opportunity` de `lib/types.ts`.
- Produces:
  - `STALE_HORIZON_DAYS = 60` — **la ruta de la Task 5 importa esta constante**; si algún día se agrega una cubeta de 90 días hay que subirla o el gráfico miente.
  - `STALE_BUCKETS: readonly StaleBucketDef[]` con `{ key, label, min, max }`
  - `type StaleBucketKey = "0-7" | "8-15" | "16-30" | "31-60" | "60+"`
  - `CRITICAL_FROM_INDEX = 3`
  - `interface StaleCell { count: number; oppIds: string[] }`
  - `interface StaleRow { bucket: StaleBucketKey; label: string; cells: Record<StaleBucketKey, StaleCell>; total: number; oppIds: string[] }`
  - `interface StaleMatrix { rows: StaleRow[]; colTotals: Record<StaleBucketKey, StaleCell>; grandTotal: number; cellMax: number; criticalCount: number; criticalOppIds: string[] }`
  - `isLiveStage(stage: string): boolean`
  - `daysSince(iso: string | null | undefined, now: Date): number | null`
  - `bucketOfDays(days: number | null): StaleBucketKey`
  - `buildStaleMatrix(opportunities: Opportunity[], lastOutboundByContact: Map<string, string | null>, now: Date): StaleMatrix`

**Contexto para quien implementa:** `transformOpportunity()` en `app/api/dashboard/route.ts` hace `...ghl`, así que `lastStageChangeAt` **ya viaja al navegador hoy mismo**; solo falta declararlo en las dos interfaces. No hay trabajo de backend en esta tarea. `lastStatusChangeAt` ya está declarado en `GHLOpportunity` (línea 356) y sirve de vecino para el campo nuevo.

**Por qué `lastStageChangeAt` y no `updatedAt`:** la cuenta corre flujos de Make y un bot de WhatsApp, y cada escritura automática empuja `updatedAt`. En la muestra del reconocimiento, una oportunidad recién creada ya tenía `updatedAt` ocho minutos después sin que nadie la tocara. Un gráfico basado en `updatedAt` reportaría que todo se está trabajando.

- [ ] **Paso 1: Declarar `lastStageChangeAt` en las dos interfaces**

En `lib/ghl-client.ts`, dentro de `GHLOpportunity`, justo **antes** de la línea `lastStatusChangeAt?: string;`:

```ts
  // Solo cambia cuando alguien mueve la oportunidad de etapa — a diferencia de
  // updatedAt, que empujan también las automatizaciones de Make y el bot.
  lastStageChangeAt?: string;
```

En `lib/types.ts`, dentro de `Opportunity`, justo **antes** de la línea `closedAt?: string`:

```ts
  /** Última vez que la oportunidad cambió de ETAPA. La señal honesta de movimiento. */
  lastStageChangeAt?: string
  lastStatusChangeAt?: string
```

(`lastStatusChangeAt` tampoco estaba declarado en el tipo interno aunque sí llega; se agrega de paso.)

- [ ] **Paso 2: Escribir el script de verificación (falla porque el módulo no existe)**

Crear `scripts/verify-stale-matrix.ts`:

```ts
// Verificación de lib/stale-opportunity-matrix.ts — la matriz de
// "Oportunidades sin atención". Correr: pnpm verify:stale-matrix
//
// Justifican el script dos cosas. Una: el universo se define EXCLUYENDO etapas
// por nombre, y una etapa que cambie de grafía en GHL metería ventas cerradas
// en un gráfico de leads abandonados. Dos: un contacto ausente del mapa de
// actividad cae a propósito en la cubeta más profunda, así que un bug que
// vacíe el mapa no se ve como un error sino como una acusación de abandono
// total — verosímil, alarmante y falsa.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Opportunity } from "../lib/types";
import {
  bucketOfDays,
  buildStaleMatrix,
  daysSince,
  isLiveStage,
  STALE_BUCKETS,
  type StaleBucketKey,
} from "../lib/stale-opportunity-matrix";

let seq = 0;

const NOW = new Date("2026-08-06T12:00:00.000Z");

/** ISO de hace `d` días exactos respecto a NOW. */
const daysAgo = (d: number) =>
  new Date(NOW.getTime() - d * 86_400_000).toISOString();

function opp(o: {
  stage?: string;
  status?: Opportunity["status"];
  contactId?: string;
  movedDaysAgo?: number;
  createdDaysAgo?: number;
}): Opportunity {
  seq++;
  return {
    id: `o${seq}`,
    name: `Opp ${seq}`,
    pipelineId: "MiATYfkJWklaXqYc7hOr",
    pipelineStageId: "stage-1",
    status: o.status ?? "open",
    createdAt: daysAgo(o.createdDaysAgo ?? 0),
    contactId: o.contactId ?? `c${seq}`,
    value: 0,
    stage: o.stage ?? "Lead en proceso",
    pipelineName: "VAEO",
    lastStageChangeAt:
      o.movedDaysAgo === undefined ? undefined : daysAgo(o.movedDaysAgo),
  };
}

const cell = (m: ReturnType<typeof buildStaleMatrix>, row: StaleBucketKey, col: StaleBucketKey) => {
  const r = m.rows.find((x) => x.bucket === row);
  assert.ok(r, `existe la fila ${row}`);
  return r!.cells[col];
};

async function main() {
  // 1. Fronteras exactas de cubeta, en los dos ejes (son la misma función).
  {
    assert.equal(bucketOfDays(0), "0-7");
    assert.equal(bucketOfDays(7), "0-7", "el día 7 todavía es la primera cubeta");
    assert.equal(bucketOfDays(8), "8-15", "el día 8 ya es la segunda");
    assert.equal(bucketOfDays(15), "8-15");
    assert.equal(bucketOfDays(16), "16-30");
    assert.equal(bucketOfDays(30), "16-30");
    assert.equal(bucketOfDays(31), "31-60");
    assert.equal(bucketOfDays(60), "31-60", "el día 60 todavía es 31-60");
    assert.equal(bucketOfDays(61), "60+", "el día 61 cae en la más profunda");
    assert.equal(bucketOfDays(9999), "60+");
    assert.equal(bucketOfDays(null), "60+", "sin dato ⇒ la más profunda");
    // Las cubetas cubren la recta sin huecos ni traslapes.
    for (let d = 0; d <= 120; d++) {
      const k = bucketOfDays(d);
      const def = STALE_BUCKETS.find((b) => b.key === k)!;
      assert.ok(d >= def.min && d <= def.max, `día ${d} dentro de ${k}`);
    }
  }

  // 2. daysSince: piso en días, y null cuando no hay dato utilizable.
  {
    assert.equal(daysSince(daysAgo(3), NOW), 3);
    assert.equal(daysSince(NOW.toISOString(), NOW), 0);
    assert.equal(daysSince(undefined, NOW), null);
    assert.equal(daysSince(null, NOW), null);
    assert.equal(daysSince("no-es-fecha", NOW), null);
    // Una fecha en el FUTURO no es negativa: se trata como recién movida.
    assert.equal(daysSince(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW), 0);
  }

  // 3. El universo excluye Ganado / Perdido / Cliente Futuro POR NOMBRE, en sus
  //    dos grafías, y respeta el status.
  {
    assert.ok(isLiveStage("Nuevo Lead"));
    assert.ok(isLiveStage("Lead Perfilado"));
    assert.ok(isLiveStage("Lead perfilado"), "la grafía de MESH también es viva");
    assert.ok(isLiveStage("Propuesta"));
    assert.ok(isLiveStage("Negociación"));
    assert.ok(!isLiveStage("Ganado"));
    assert.ok(!isLiveStage("ganada"));
    assert.ok(!isLiveStage("09. Negocio Ganado"));
    assert.ok(!isLiveStage("Perdido"));
    assert.ok(!isLiveStage("perdida"));
    assert.ok(!isLiveStage("Cliente Futuro"));
    assert.ok(!isLiveStage("cliente  futuro"), "espacios de más no lo salvan");
  }

  {
    const opps = [
      opp({ stage: "Lead en proceso" }),
      opp({ stage: "Ganado" }),
      opp({ stage: "Perdido" }),
      opp({ stage: "Cliente Futuro" }),
      opp({ stage: "Lead en proceso", status: "won" }),
      opp({ stage: "Lead en proceso", status: "lost" }),
      opp({ stage: "Lead en proceso", status: "abandoned" }),
    ];
    const m = buildStaleMatrix(opps, new Map(), NOW);
    assert.equal(m.grandTotal, 1, "solo la abierta en etapa viva entra");
  }

  // 4. Eje de movimiento: lastStageChangeAt manda; sin él, createdAt.
  {
    const a = opp({ movedDaysAgo: 3, createdDaysAgo: 90 });
    const b = opp({ createdDaysAgo: 45 });
    const m = buildStaleMatrix([a, b], new Map(), NOW);
    assert.deepEqual(cell(m, "0-7", "60+").oppIds, [a.id], "movida hace 3 días, no hace 90");
    assert.deepEqual(cell(m, "31-60", "60+").oppIds, [b.id], "sin lastStageChangeAt cae a createdAt");
  }

  // 5. Eje de mensajes: ausente del mapa y presente-pero-null son LO MISMO.
  {
    const ausente = opp({ contactId: "c-ausente", movedDaysAgo: 2 });
    const nulo = opp({ contactId: "c-nulo", movedDaysAgo: 2 });
    const reciente = opp({ contactId: "c-reciente", movedDaysAgo: 2 });
    const map = new Map<string, string | null>([
      ["c-nulo", null],
      ["c-reciente", daysAgo(4)],
    ]);
    const m = buildStaleMatrix([ausente, nulo, reciente], map, NOW);
    assert.equal(cell(m, "0-7", "60+").count, 2, "ausente y null van juntos a la cubeta profunda");
    assert.deepEqual(cell(m, "0-7", "0-7").oppIds, [reciente.id]);
  }

  // 6. Totales, máximo y cuadrante crítico.
  {
    const criticas = [
      opp({ contactId: "x1", movedDaysAgo: 40 }),
      opp({ contactId: "x2", movedDaysAgo: 70 }),
      opp({ contactId: "x3", movedDaysAgo: 31 }),
    ];
    const sanas = [
      opp({ contactId: "y1", movedDaysAgo: 1 }),
      opp({ contactId: "y2", movedDaysAgo: 20 }),
    ];
    const map = new Map<string, string | null>([
      ["y1", daysAgo(1)],
      ["y2", daysAgo(9)],
    ]);
    const m = buildStaleMatrix([...criticas, ...sanas], map, NOW);

    assert.equal(m.grandTotal, 5);
    const sumCells = m.rows.reduce(
      (acc, r) => acc + STALE_BUCKETS.reduce((a, b) => a + r.cells[b.key].count, 0),
      0
    );
    assert.equal(sumCells, m.grandTotal, "las celdas suman el gran total");

    const sumRows = m.rows.reduce((a, r) => a + r.total, 0);
    assert.equal(sumRows, m.grandTotal, "los totales de fila cuadran");

    const sumCols = STALE_BUCKETS.reduce((a, b) => a + m.colTotals[b.key].count, 0);
    assert.equal(sumCols, m.grandTotal, "los totales de columna cuadran");

    // Las tres críticas: ≥31 días de movimiento y sin mensaje (⇒ 60+).
    assert.equal(m.criticalCount, 3);
    assert.deepEqual(
      [...m.criticalOppIds].sort(),
      criticas.map((o) => o.id).sort()
    );
    assert.equal(m.cellMax, 2, "el máximo de celda es (31-60 × 60+)");

    // Se dibujan las cinco filas aunque estén vacías: un renglón faltante haría
    // que el ojo lea la matriz corrida.
    assert.equal(m.rows.length, STALE_BUCKETS.length);
  }

  // 7. Conjunto vacío.
  {
    const m = buildStaleMatrix([], new Map(), NOW);
    assert.equal(m.grandTotal, 0);
    assert.equal(m.cellMax, 0);
    assert.equal(m.criticalCount, 0);
    assert.equal(m.rows.length, STALE_BUCKETS.length, "la rejilla existe aunque no haya datos");
  }

  console.log("verify-stale-matrix: all assertions passed");
}

main();
```

- [ ] **Paso 3: Registrar el script en `package.json` y en `CLAUDE.md`**

En `package.json`, después de la línea de `"verify:task-backlog"`:

```json
    "verify:stale-matrix": "tsx scripts/verify-stale-matrix.ts",
```

En `CLAUDE.md`, en el bloque de comandos, después de la línea de `pnpm verify:task-backlog`:

```
pnpm verify:stale-matrix # lib/stale-opportunity-matrix.ts — cubetas de abandono en ambos ejes
```

- [ ] **Paso 4: Correr el script para verificar que falla**

Run: `pnpm verify:stale-matrix`
Expected: FAIL — `Cannot find module '../lib/stale-opportunity-matrix'`.

- [ ] **Paso 5: Escribir `lib/stale-opportunity-matrix.ts`**

```ts
// Agregación detrás de "Oportunidades sin atención": la matriz cruzada de días
// sin mover la oportunidad × días sin mandarle un mensaje al contacto.
//
// Es el único gráfico del panel que mide ANTIGÜEDAD SIN ATENCIÓN en vez de
// estado. Un lead parado dos meses en "Lead en proceso" cuenta como oportunidad
// abierta en todos los demás gráficos y ahí se queda; aquí se ve.
//
// Puro y sin React, verificado por scripts/verify-stale-matrix.ts.
import type { Opportunity } from "./types"

/**
 * Hasta dónde tiene que mirar hacia atrás quien alimente el eje de mensajes.
 * Es la frontera de la cubeta más profunda: cualquier conversación más vieja
 * que esto cae en "60+" sin importar su fecha exacta, así que la ruta
 * app/api/conversation-activity puede dejar de paginar aquí.
 *
 * Si algún día se agrega una cubeta de 90 días, HAY QUE SUBIR ESTA CONSTANTE
 * o el gráfico mentirá: las conversaciones entre 60 y 90 días nunca llegarían.
 */
export const STALE_HORIZON_DAYS = 60

export interface StaleBucketDef {
  key: StaleBucketKey
  label: string
  /** Días, inclusivo. */
  min: number
  /** Días, inclusivo. Infinity en la última. */
  max: number
}

export type StaleBucketKey = "0-7" | "8-15" | "16-30" | "31-60" | "60+"

/** Las mismas cubetas en los dos ejes: la comparación que importa es entre celdas. */
export const STALE_BUCKETS: readonly StaleBucketDef[] = [
  { key: "0-7", label: "0–7 d", min: 0, max: 7 },
  { key: "8-15", label: "8–15 d", min: 8, max: 15 },
  { key: "16-30", label: "16–30 d", min: 16, max: 30 },
  { key: "31-60", label: "31–60 d", min: 31, max: 60 },
  { key: "60+", label: "+60 d", min: 61, max: Infinity },
] as const

/**
 * Desde qué índice de cubeta empieza el cuadrante crítico: ≥31 días en AMBOS
 * ejes, o sea sin mover y sin escribir por más de un mes.
 */
export const CRITICAL_FROM_INDEX = 3

const DEEPEST: StaleBucketKey = "60+"

// Se excluyen por NOMBRE, nunca por id — un embudo recreado conserva el nombre
// pero no el id, misma regla que isWonOpp(). "Cliente Futuro" es un
// estacionamiento deliberado: ahí el silencio es la intención, no el abandono.
const CLOSED_STAGE_PATTERNS = [/ganad[oa]|\bwon\b/i, /perdid/i, /cliente\s+futuro/i]

/** ¿La etapa pertenece al embudo VIVO (ni ganada, ni perdida, ni estacionada)? */
export function isLiveStage(stage: string): boolean {
  const s = (stage ?? "").trim()
  return !CLOSED_STAGE_PATTERNS.some((re) => re.test(s))
}

/**
 * Días enteros transcurridos desde `iso` hasta `now`. `null` cuando no hay dato
 * o es ilegible — quien llama decide qué significa eso (aquí: la cubeta más
 * profunda). Una fecha futura devuelve 0, no un negativo.
 */
export function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

/** Cubeta de una antigüedad en días. `null` ⇒ la más profunda. */
export function bucketOfDays(days: number | null): StaleBucketKey {
  if (days === null) return DEEPEST
  for (const b of STALE_BUCKETS) {
    if (days >= b.min && days <= b.max) return b.key
  }
  return DEEPEST
}

export interface StaleCell {
  count: number
  oppIds: string[]
}

export interface StaleRow {
  /** Cubeta del eje de MOVIMIENTO (días sin cambio de etapa). */
  bucket: StaleBucketKey
  label: string
  /** Una celda por cubeta del eje de MENSAJES. */
  cells: Record<StaleBucketKey, StaleCell>
  total: number
  oppIds: string[]
}

export interface StaleMatrix {
  /** Siempre las cinco filas, en orden, aunque alguna quede vacía. */
  rows: StaleRow[]
  colTotals: Record<StaleBucketKey, StaleCell>
  grandTotal: number
  /** Conteo de la celda más poblada. El sombreado se normaliza sobre TODA la matriz. */
  cellMax: number
  criticalCount: number
  criticalOppIds: string[]
}

function emptyCell(): StaleCell {
  return { count: 0, oppIds: [] }
}

function emptyCells(): Record<StaleBucketKey, StaleCell> {
  const out = {} as Record<StaleBucketKey, StaleCell>
  for (const b of STALE_BUCKETS) out[b.key] = emptyCell()
  return out
}

/**
 * Matriz de abandono sobre `opportunities` (que ya deben venir acotadas al
 * embudo del panel — este módulo no filtra por pipeline).
 *
 * `lastOutboundByContact` mapea contacto → ISO del último mensaje SALIENTE, o
 * `null` si se sabe que no hay ninguno. Un contacto **ausente** del mapa se
 * trata igual que `null`: por construcción de la ruta que lo llena, ausencia
 * significa "sin conversación, o sin actividad dentro del horizonte de
 * STALE_HORIZON_DAYS", y ambas cosas caen en la cubeta más profunda. Es
 * correcto, no una aproximación — el último saliente es siempre ≤ el último
 * mensaje de la conversación.
 *
 * Ojo al llamarla: si el mapa llega vacío porque los datos todavía no cargan,
 * TODA la matriz se va a la columna "+60 d" y el gráfico afirma un abandono
 * total. El componente no debe renderizar hasta que la actividad esté lista.
 */
export function buildStaleMatrix(
  opportunities: Opportunity[],
  lastOutboundByContact: Map<string, string | null>,
  now: Date
): StaleMatrix {
  const rows: StaleRow[] = STALE_BUCKETS.map((b) => ({
    bucket: b.key,
    label: b.label,
    cells: emptyCells(),
    total: 0,
    oppIds: [],
  }))
  const rowByKey = new Map(rows.map((r) => [r.bucket, r]))
  const colTotals = emptyCells()

  const criticalOppIds: string[] = []
  let grandTotal = 0

  for (const o of opportunities) {
    if (o.status !== "open") continue
    if (!isLiveStage(o.stage ?? "")) continue

    const moveKey = bucketOfDays(daysSince(o.lastStageChangeAt ?? o.createdAt, now))
    const msgKey = bucketOfDays(daysSince(lastOutboundByContact.get(o.contactId) ?? null, now))

    const row = rowByKey.get(moveKey)!
    row.cells[msgKey].count += 1
    row.cells[msgKey].oppIds.push(o.id)
    row.total += 1
    row.oppIds.push(o.id)

    colTotals[msgKey].count += 1
    colTotals[msgKey].oppIds.push(o.id)
    grandTotal += 1

    const moveIdx = STALE_BUCKETS.findIndex((b) => b.key === moveKey)
    const msgIdx = STALE_BUCKETS.findIndex((b) => b.key === msgKey)
    if (moveIdx >= CRITICAL_FROM_INDEX && msgIdx >= CRITICAL_FROM_INDEX) {
      criticalOppIds.push(o.id)
    }
  }

  let cellMax = 0
  for (const r of rows) {
    for (const b of STALE_BUCKETS) cellMax = Math.max(cellMax, r.cells[b.key].count)
  }

  return {
    rows,
    colTotals,
    grandTotal,
    cellMax,
    criticalCount: criticalOppIds.length,
    criticalOppIds,
  }
}
```

- [ ] **Paso 6: Correr el script hasta que pase**

Run: `pnpm verify:stale-matrix`
Expected: PASS — `verify-stale-matrix: all assertions passed`

- [ ] **Paso 7: Comprobar los tipos**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Paso 8: Commit**

```bash
git add lib/stale-opportunity-matrix.ts scripts/verify-stale-matrix.ts lib/types.ts lib/ghl-client.ts package.json CLAUDE.md
git commit -m "feat(lib): agregar la matriz de oportunidades sin atención"
```

---

## Task 5: `app/api/conversation-activity` — derivar el último mensaje saliente

**Files:**
- Modify: `lib/ghl-client.ts` (después de `getConversations`, ~línea 550)
- Modify: `lib/ghl-message-mapper.ts` (exportar `isActivityMessage`)
- Create: `app/api/conversation-activity/route.ts`

**Interfaces:**
- Consumes: `STALE_HORIZON_DAYS` de `lib/stale-opportunity-matrix.ts`; `requireClient`/`unauthorized` de `lib/session.ts`; `withClient` de `lib/ghl-context.ts`; `getMessages` de `lib/ghl-client.ts`.
- Produces:
  - En `lib/ghl-client.ts`: `interface GHLConversationSearchDoc`, `interface GHLConversationSearchResponse`, `searchConversationsPage(params): Promise<GHLConversationSearchResponse>`
  - En `lib/ghl-message-mapper.ts`: `isActivityMessage(m: { messageType?: string }): boolean`
  - La ruta, cuyo frame `data` es
    `{ activity: Array<{ contactId: string; lastOutboundAt: string | null }>, meta: { conversations: number; threadsOpened: number; horizonDays: number; fetchedAt: string } }`

**El problema que resuelve, en corto:** `/conversations/search` **no expone** la fecha del último mensaje saliente. `lastManualMessageDate` no lo es (en la muestra vino igual a `lastMessageDate` en una conversación que terminaba en entrante, o sea que cuenta manuales en ambas direcciones). Dos observaciones lo derivan sin fuerza bruta:

1. Si la conversación **termina en saliente**, `lastMessageDate` *es* la fecha del último saliente. Cubre el 93 % de los casos, gratis.
2. El último saliente es siempre **≤** el último mensaje. Luego, una conversación muda por 70 días implica ≥70 días sin saliente, y cae en la cubeta más profunda sin abrir el hilo.

Solo hay que abrir el hilo del ~7 % que termina en entrante y está dentro del horizonte (~845 conversaciones en total en la cuenta, muchas menos dentro de 60 días).

- [ ] **Paso 1: Agregar la paginación de conversaciones a `lib/ghl-client.ts`**

Insertar en `lib/ghl-client.ts` inmediatamente después del cierre de `getConversations`:

```ts
/**
 * Un documento de /conversations/search. Extiende GHLConversation con los
 * campos que solo devuelve la búsqueda paginada.
 */
export interface GHLConversationSearchDoc extends GHLConversation {
  /** Dirección del ÚLTIMO mensaje. Cuando es "outbound", lastMessageDate ES la fecha del último saliente. */
  lastMessageDirection?: "inbound" | "outbound";
  lastManualMessageDate?: string;
  lastOutboundMessageAction?: string;
  /** Cursor de la API: sort[0] es lastMessageDate en epoch ms. */
  sort?: Array<number | string>;
}

export interface GHLConversationSearchResponse {
  conversations: GHLConversationSearchDoc[];
  total?: number;
}

/**
 * Una página de /conversations/search ordenada por fecha del último mensaje.
 *
 * Se pagina por CURSOR (`startAfterDate` = el sort[0] del último documento de
 * la página anterior), no por offset. Dos conversaciones con el mismo
 * lastMessageDate al milisegundo pueden repetirse o perderse en el corte: quien
 * llama debe deduplicar por id de conversación.
 */
export async function searchConversationsPage(params: {
  limit?: number;
  startAfterDate?: number | string;
  sortBy?: string;
  sort?: "asc" | "desc";
  status?: string;
}): Promise<GHLConversationSearchResponse> {
  return ghlFetch<GHLConversationSearchResponse>("/conversations/search", {
    params: {
      limit: params.limit ?? 100,
      sortBy: params.sortBy ?? "last_message_date",
      sort: params.sort ?? "desc",
      status: params.status ?? "all",
      startAfterDate: params.startAfterDate,
    },
  });
}
```

- [ ] **Paso 2: Exportar `isActivityMessage` desde `lib/ghl-message-mapper.ts`**

En `lib/ghl-message-mapper.ts`, insertar justo después de la declaración de `ACTIVITY_BY_TYPE`:

```ts
/**
 * ¿El mensaje es actividad del sistema (un chip de "oportunidad actualizada",
 * "cita registrada"…) en vez de un mensaje a una persona?
 *
 * Existe para que quien mide "cuándo fue la última vez que le escribimos" no
 * cuente un evento automático como si alguien hubiera contactado al lead.
 */
export function isActivityMessage(m: { messageType?: string }): boolean {
  return Boolean(m.messageType && m.messageType in ACTIVITY_BY_TYPE)
}
```

- [ ] **Paso 3: Escribir la ruta**

Crear `app/api/conversation-activity/route.ts`:

```ts
// Deriva, por contacto, la fecha del ÚLTIMO MENSAJE SALIENTE — el eje de
// mensajes de la matriz "Oportunidades sin atención".
//
// GHL no expone ese dato: /conversations/search trae lastMessageDate y
// lastMessageDirection, pero ninguna fecha de "último saliente"
// (lastManualMessageDate NO lo es: cuenta manuales en ambas direcciones). Se
// deriva con dos observaciones:
//
//   1. Si la conversación termina en SALIENTE, lastMessageDate ya es la fecha
//      buscada. Es el ~93 % de los casos y no cuesta una sola llamada extra.
//   2. El último saliente es siempre ≤ el último mensaje. Una conversación muda
//      por más de STALE_HORIZON_DAYS cae en la cubeta más profunda sin abrirla.
//
// Solo se abre el hilo del resto: termina en entrante Y está dentro del
// horizonte.
//
// Se carga en segundo plano como /api/dashboard-messages: fuera de la ruta
// crítica, el panel pinta primero.
import { getMessages, searchConversationsPage } from "@/lib/ghl-client";
import { isActivityMessage } from "@/lib/ghl-message-mapper";
import { STALE_HORIZON_DAYS } from "@/lib/stale-opportunity-matrix";
import { requireClient, unauthorized } from "@/lib/session";
import { withClient } from "@/lib/ghl-context";

function enc(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export const runtime = "nodejs";

/** Páginas máximas del recorrido. ~20 bastan para 60 días; el tope es un seguro. */
const MAX_PAGES = 60;
const PAGE_SIZE = 100;
/** Mismo patrón que dashboard-messages: no disparar cientos de hilos a la vez. */
const CONCURRENCY = 6;

export async function GET() {
  // El cliente se resuelve en el scope del request: cookies() no está
  // disponible dentro del callback del stream.
  const client = await requireClient();
  if (!client) return unauthorized();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // El contexto se entra AQUÍ, no alrededor de GET(): el stream sobrevive al
      // return del handler, así que envolver el handler dejaría la bomba
      // corriendo fuera del contexto.
      await withClient(client, async () => {
        const send = (obj: unknown) => {
          controller.enqueue(encoder.encode(enc(obj)));
        };

        try {
          const cutoff = Date.now() - STALE_HORIZON_DAYS * 86_400_000;

          send({ type: "progress", message: "Cargando actividad de conversaciones…" });

          // 1. Recorrer las conversaciones de la más reciente a la más vieja y
          //    cortar al cruzar el horizonte.
          const outboundAt = new Map<string, string>(); // contactId → ISO
          const pending: Array<{ conversationId: string; contactId: string }> = [];
          const seenConvIds = new Set<string>();
          let cursor: number | string | undefined;
          let scanned = 0;
          let reachedHorizon = false;

          for (let page = 0; page < MAX_PAGES && !reachedHorizon; page++) {
            let docs;
            try {
              const res = await searchConversationsPage({
                limit: PAGE_SIZE,
                startAfterDate: cursor,
              });
              docs = res.conversations;
            } catch (err) {
              // Se conserva lo que ya se recorrió, igual que cursorWalk: una
              // página perdida mueve algunos leads una cubeta, perderlo todo
              // haría que el gráfico acuse abandono total.
              console.error("[GHL] conversation-activity: página fallida:", err);
              break;
            }

            if (docs.length === 0) break;

            for (const c of docs) {
              // El cursor es por VALOR de sort: dos conversaciones con el mismo
              // lastMessageDate al milisegundo pueden repetirse en el corte.
              if (seenConvIds.has(c.id)) continue;
              seenConvIds.add(c.id);
              if (c.deleted) continue;
              scanned++;

              const ts = c.lastMessageDate ? new Date(c.lastMessageDate).getTime() : NaN;
              if (!Number.isNaN(ts) && ts < cutoff) {
                reachedHorizon = true;
                continue;
              }
              if (!c.contactId) continue;

              if (c.lastMessageDirection === "outbound" && c.lastMessageDate) {
                // Observación 1: termina en saliente ⇒ ya es la fecha buscada.
                const prev = outboundAt.get(c.contactId);
                if (!prev || new Date(c.lastMessageDate) > new Date(prev)) {
                  outboundAt.set(c.contactId, c.lastMessageDate);
                }
              } else {
                pending.push({ conversationId: c.id, contactId: c.contactId });
              }
            }

            const last = docs[docs.length - 1];
            const next = last?.sort?.[0];
            if (next === undefined) break;
            cursor = next;
            if (docs.length < PAGE_SIZE) break;

            send({
              type: "progress",
              message: `Revisando conversaciones… ${scanned.toLocaleString("es-MX")}`,
            });
          }

          // 2. Abrir solo los hilos que terminan en entrante y siguen dentro del
          //    horizonte, con concurrencia acotada.
          send({
            type: "progress",
            message: `Revisando ${pending.length.toLocaleString("es-MX")} conversaciones sin respuesta…`,
          });

          let idx = 0;
          const found: Array<{ contactId: string; iso: string } | null> = new Array(pending.length);
          await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
              while (idx < pending.length) {
                const i = idx++;
                const { conversationId, contactId } = pending[i];
                try {
                  const res = await getMessages(conversationId, { limit: 50 });
                  let best: string | null = null;
                  for (const m of res.messages.messages) {
                    if (m.direction !== "outbound") continue;
                    // Un chip de "oportunidad creada" no es un mensaje a nadie.
                    if (isActivityMessage(m)) continue;
                    if (!best || new Date(m.dateAdded) > new Date(best)) best = m.dateAdded;
                  }
                  found[i] = best ? { contactId, iso: best } : null;
                } catch {
                  // El hilo no abrió: se deja sin dato. El cliente lo lee como la
                  // cubeta más profunda, que es la lectura conservadora correcta
                  // (el último saliente es ≤ el último mensaje, que ya es viejo).
                  found[i] = null;
                }
              }
            })
          );

          for (const hit of found) {
            if (!hit) continue;
            const prev = outboundAt.get(hit.contactId);
            if (!prev || new Date(hit.iso) > new Date(prev)) {
              outboundAt.set(hit.contactId, hit.iso);
            }
          }

          // Solo se emiten los contactos CON dato. Todo lo demás —contacto sin
          // conversación, o conversación fuera del horizonte— el cliente lo
          // trata como null, que es la cubeta más profunda. Es correcto por la
          // observación 2, no una aproximación.
          const activity = [...outboundAt.entries()].map(([contactId, lastOutboundAt]) => ({
            contactId,
            lastOutboundAt,
          }));

          send({
            type: "data",
            activity,
            meta: {
              conversations: scanned,
              threadsOpened: pending.length,
              horizonDays: STALE_HORIZON_DAYS,
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
```

- [ ] **Paso 4: Comprobar los tipos**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Paso 5: Manejar la ruta real contra la sub-cuenta**

Run: `pnpm dev`, entrar al panel para que el navegador tenga la cookie `dash_session`, y luego abrir `http://localhost:3000/api/conversation-activity` en la misma pestaña.

Verificar en la respuesta NDJSON:
1. Llegan frames `progress` y termina en un frame `data`.
2. `meta.conversations` es del orden de cientos-a-miles, no 0.
3. `meta.threadsOpened` es mucho menor que `meta.conversations` (la observación 1 debe cubrir la gran mayoría).
4. `activity` trae entradas con `lastOutboundAt` en ISO.
5. La respuesta tarda segundos, no minutos. Si `threadsOpened` sale en miles, anótalo: significa que el horizonte no está cortando y hay que revisar el cursor antes de seguir.

- [ ] **Paso 6: Commit**

```bash
git add lib/ghl-client.ts lib/ghl-message-mapper.ts app/api/conversation-activity/route.ts
git commit -m "feat(api): derivar la fecha del último mensaje saliente por contacto"
```

---

## Task 6: `use-conversation-activity.ts` + cableado en `app/page.tsx`

**Files:**
- Create: `hooks/use-conversation-activity.ts`
- Modify: `app/page.tsx`
- Modify: `components/dashboard/vaeo-dashboard.tsx`
- Modify: `components/dashboard/mesh-dashboard.tsx`

**Interfaces:**
- Consumes: `fetchStream` de `hooks/fetch-stream.ts`; el frame `data` de la Task 5.
- Produces:
  - `type ActivityStatus = "loading" | "ready" | "error"`
  - `useConversationActivity(): { activity: Map<string, string | null>; status: ActivityStatus; refresh: () => void }`
  - Props nuevas `conversationActivity?: Map<string, string | null>` y `activityStatus?: ActivityStatus` y `onRetryActivity?: () => void` en los dos dashboards.

- [ ] **Paso 1: Escribir el hook**

Crear `hooks/use-conversation-activity.ts`:

```ts
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
```

- [ ] **Paso 2: Montar el hook en `app/page.tsx`**

En `app/page.tsx`, junto al import de `useConversationsData` (línea ~42):

```ts
import { useConversationActivity } from "@/hooks/use-conversation-activity"
```

Justo debajo de `const { messages } = useConversationsData()` (línea ~107):

```ts
  // Actividad de conversaciones para la matriz de abandono. Va aparte del sync
  // principal (es un recorrido de cientos de conversaciones) y su ESTADO viaja
  // con ella: con el mapa vacío la matriz acusaría abandono total.
  const {
    activity: conversationActivity,
    status: activityStatus,
    refresh: refreshActivity,
  } = useConversationActivity()
```

Dentro de `<VaeoDashboard ...>`, después de la línea `allTasks={data?.tasks ?? []}` que agregó la Task 2:

```tsx
            conversationActivity={conversationActivity}
            activityStatus={activityStatus}
            onRetryActivity={refreshActivity}
```

Repetir las tres líneas idénticas dentro de `<MeshDashboard ...>`.

- [ ] **Paso 3: Declarar las props en los dos dashboards**

En `components/dashboard/vaeo-dashboard.tsx`:

1. Import de tipo, junto a los demás imports de arriba:

```ts
import type { ActivityStatus } from "@/hooks/use-conversation-activity"
```

2. En `VaeoDashboardProps`, después de `allTasks?: Task[]`:

```ts
  /** Contacto → ISO del último mensaje saliente. Ausente = sin dato = cubeta más profunda. */
  conversationActivity?: Map<string, string | null>
  /** El mapa vacío NO significa "nadie escribió": hasta "ready" no se pinta la matriz. */
  activityStatus?: ActivityStatus
  onRetryActivity?: () => void
```

3. En la firma desestructurada, después de `allTasks = [],`:

```ts
  conversationActivity,
  activityStatus = "loading",
  onRetryActivity,
```

Aplicar los tres cambios idénticos en `components/dashboard/mesh-dashboard.tsx`.

> Las props se declaran ahora aunque el componente que las consume llega en la Task 7. Así el cableado queda revisable por sí solo, y `npx tsc --noEmit` ya cubre que los dos paneles declaren lo mismo. TypeScript no marca props declaradas y no usadas.

- [ ] **Paso 4: Comprobar los tipos**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Paso 5: Verificar el ciclo de vida del hook en la app real**

Run: `pnpm dev`, abrir el panel con la pestaña Network abierta.

Verificar:
1. Sale una sola petición a `/api/conversation-activity`, en paralelo con `/api/dashboard`.
2. Cambiar de pestaña VAEO ↔ MESH **no** dispara otra petición.
3. El panel pinta sus gráficos antes de que esa petición termine.

- [ ] **Paso 6: Commit**

```bash
git add hooks/use-conversation-activity.ts app/page.tsx components/dashboard/vaeo-dashboard.tsx components/dashboard/mesh-dashboard.tsx
git commit -m "feat(panel): cargar la actividad de conversaciones en segundo plano"
```

---

## Task 7: `stale-opportunity-matrix.tsx` — "Oportunidades sin atención"

**Files:**
- Create: `components/dashboard/stale-opportunity-matrix.tsx`
- Modify: `components/dashboard/vaeo-dashboard.tsx`
- Modify: `components/dashboard/mesh-dashboard.tsx`

**Interfaces:**
- Consumes: todo lo que produce la Task 4; las props de actividad de la Task 6; el chrome de `./dashboard-ui`; `ChartDrillDrawer` de `./chart-drill-drawer`.
- Produces: `StaleOpportunityMatrix` y `StaleOpportunityMatrixProps`.

**Dos diferencias deliberadas contra `advisor-stage-table`, no las "arregles":**

1. **El sombreado se normaliza sobre TODA la matriz**, no por columna. En `advisor-stage-table` la normalización por columna existe porque las etapas tienen órdenes de magnitud distintos; aquí las dos dimensiones son la misma escala de días y la comparación que importa es entre celdas.
2. **La intensidad por conteo va en un gris neutro**, y el rojizo se reserva para delimitar el **cuadrante crítico** (≥31 días en ambos ejes). Es la única codificación posicional. Montar la rampa de calor en rojo y además teñir el cuadrante pondría dos escalas de color en la misma celda.

- [ ] **Paso 1: Crear el componente**

Crear `components/dashboard/stale-opportunity-matrix.tsx`:

```tsx
"use client"

import { useMemo, useState } from "react"
import { AlarmClock, RotateCw } from "lucide-react"
import type {
  Appointment,
  Call,
  Contact,
  Message,
  Opportunity,
  Pauta,
  Pipeline,
  Task,
} from "@/lib/types"
import {
  buildStaleMatrix,
  CRITICAL_FROM_INDEX,
  STALE_BUCKETS,
  type StaleCell,
} from "@/lib/stale-opportunity-matrix"
import { PANEL_SCOPES, scopeOpportunities, type PanelId } from "@/lib/panel-scope"
import type { ActivityStatus } from "@/hooks/use-conversation-activity"
import { cn } from "@/lib/utils"
import {
  ChartCardContent,
  ChartCardHeader,
  ChartEmpty,
  DashboardCard,
  ScopePill,
} from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"

const n = (v: number) => v.toLocaleString("es-MX")

/**
 * La rampa de intensidad va en GRIS a propósito. El único color de la matriz es
 * el rojizo del cuadrante crítico, que codifica POSICIÓN; si la intensidad
 * también fuera roja habría dos escalas de color peleándose la misma celda.
 */
const HEAT_RGB = "100, 116, 139" // slate-500
const CRITICAL_TINT = "rgba(244, 63, 94, 0.07)" // rose-500 muy tenue

/**
 * Raíz cuadrada y no lineal, por lo mismo que en "Motivos de perdido": la celda
 * más poblada suele llevarse un múltiplo del resto, y en escala lineal el resto
 * de la matriz quedaría en blanco indistinguible.
 */
function heatAlpha(count: number, max: number): number {
  if (count === 0 || max === 0) return 0
  return Math.sqrt(Math.min(count / max, 1)) * 0.5
}

export interface StaleOpportunityMatrixProps {
  panel: PanelId
  /** Ya filtradas por fecha — NO se usan aquí; ver allOpportunities. */
  opportunities: Opportunity[]
  /** Sin filtrar: "sin atención en 60 días" es una condición de hoy, no de un periodo. */
  allOpportunities: Opportunity[]
  conversationActivity?: Map<string, string | null>
  activityStatus?: ActivityStatus
  onRetryActivity?: () => void
  contacts: Contact[]
  allContacts: Contact[]
  pipelines?: Pipeline[]
  tasks?: Task[]
  calls?: Call[]
  allPautas?: Pauta[]
  appointments?: Appointment[]
  messages?: Message[]
  locationId?: string
}

/**
 * "Oportunidades sin atención": días sin mover la oportunidad × días sin
 * mandarle un mensaje al contacto.
 *
 * Es el único gráfico del panel que mide antigüedad sin atención. Los demás
 * miden estado, y por eso un lead parado dos meses en "Lead en proceso" les
 * resulta invisible: cuenta como oportunidad abierta y ahí se queda.
 *
 * NO renderiza la matriz hasta que la actividad de conversaciones esté lista.
 * Con el mapa vacío todas las oportunidades caerían en la columna "+60 d" y el
 * gráfico afirmaría un abandono total — alarmante, verosímil y falso.
 */
export function StaleOpportunityMatrix({
  panel,
  allOpportunities,
  conversationActivity,
  activityStatus = "loading",
  onRetryActivity,
  contacts,
  allContacts,
  pipelines = [],
  tasks = [],
  calls = [],
  allPautas = [],
  appointments = [],
  messages = [],
  locationId = "",
}: StaleOpportunityMatrixProps) {
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)
  const scope = PANEL_SCOPES[panel]
  const ready = activityStatus === "ready" && conversationActivity !== undefined

  const matrix = useMemo(() => {
    if (!ready) return null
    const scoped = scopeOpportunities(allOpportunities, panel, pipelines)
    return buildStaleMatrix(scoped, conversationActivity!, new Date())
  }, [ready, allOpportunities, conversationActivity, panel, pipelines])

  const oppById = useMemo(
    () => new Map(allOpportunities.map((o) => [o.id, o])),
    [allOpportunities]
  )

  const openDrill = (cell: StaleCell, title: string, note: string) => {
    if (cell.count === 0) return
    const items = cell.oppIds
      .map((id) => oppById.get(id))
      .filter((o): o is Opportunity => Boolean(o))
    if (items.length === 0) return
    setDrill({
      open: true,
      title,
      subtitle: `Embudo ${scope.label} · ${note}`,
      opportunities: items,
    })
  }

  const stickyCol = "sticky left-0 z-20 bg-card"

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Oportunidades sin atención"
        icon={AlarmClock}
        total={matrix?.grandTotal ?? 0}
        actions={
          <ScopePill
            label="Embudo vivo · a la fecha de hoy"
            tooltip={
              <>
                Solo oportunidades <strong>abiertas</strong> del embudo{" "}
                <strong>{scope.label}</strong>, sin las etapas Ganado, Perdido ni Cliente
                Futuro (esta última es un estacionamiento deliberado: ahí el silencio es la
                intención). <strong>No respeta el filtro de fechas</strong> — &ldquo;sin
                atención en 60 días&rdquo; es una condición de hoy, no de un periodo.{" "}
                <strong>Movimiento</strong> significa cambio de <em>etapa</em>, no cualquier
                edición: las automatizaciones tocan la oportunidad todo el tiempo y
                reportarían que todo se está trabajando. <strong>Mensaje</strong> significa
                cualquier saliente, <em>incluidos los automáticos</em>. Un contacto sin
                conversación, o con la última fuera de los 60 días, cae en la columna
                &ldquo;+60 d&rdquo;.
              </>
            }
          />
        }
      />
      <ChartCardContent>
        {activityStatus === "loading" ? (
          <div className="flex h-[240px] flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            Cargando actividad de conversaciones…
          </div>
        ) : activityStatus === "error" || !matrix ? (
          // Nunca ceros y nunca una matriz parcial: sin el dato de mensajes, la
          // matriz entera se iría a la columna "+60 d" y acusaría un abandono
          // que no ocurrió.
          <div className="flex h-[240px] flex-col items-center justify-center gap-3 text-center text-xs text-muted-foreground">
            <p className="max-w-sm">
              No se pudo cargar la actividad de conversaciones, y sin ella esta matriz
              reportaría que ningún lead ha sido contactado. Por eso no se muestra.
            </p>
            {onRetryActivity && (
              <button
                type="button"
                onClick={onRetryActivity}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-muted"
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden />
                Reintentar
              </button>
            )}
          </div>
        ) : matrix.grandTotal === 0 ? (
          <ChartEmpty message="Sin oportunidades abiertas en este embudo" />
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: CRITICAL_TINT, outline: "1px solid rgba(244,63,94,0.35)" }}
                  aria-hidden
                />
                Más de 30 días sin mover y sin escribir
              </span>
              <span className="ml-auto tabular-nums">
                {n(matrix.criticalCount)} de {n(matrix.grandTotal)} en el cuadrante crítico
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-max min-w-full border-separate border-spacing-0 text-right text-xs tabular-nums">
                <thead>
                  <tr>
                    <th
                      className={cn(
                        stickyCol,
                        "border-b border-r border-border px-3 py-2 text-left font-semibold"
                      )}
                    >
                      Sin mover ↓ / sin mensaje →
                    </th>
                    {STALE_BUCKETS.map((b) => (
                      <th
                        key={b.key}
                        className="min-w-[5rem] border-b border-border px-3 py-2 font-medium text-muted-foreground"
                      >
                        {b.label}
                      </th>
                    ))}
                    <th className="min-w-[4.5rem] border-b border-l border-border px-3 py-2 font-semibold">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.map((row, rowIndex) => (
                    <tr key={row.bucket}>
                      <th
                        scope="row"
                        className={cn(
                          stickyCol,
                          "border-b border-r border-border px-3 py-1.5 text-left font-medium"
                        )}
                      >
                        {row.label}
                      </th>

                      {STALE_BUCKETS.map((b, colIndex) => {
                        const cell = row.cells[b.key]
                        const critical =
                          rowIndex >= CRITICAL_FROM_INDEX && colIndex >= CRITICAL_FROM_INDEX
                        return (
                          <td
                            key={b.key}
                            onClick={() =>
                              openDrill(
                                cell,
                                `${row.label} sin mover · ${b.label} sin mensaje`,
                                `${n(cell.count)} oportunidades`
                              )
                            }
                            style={{
                              backgroundColor: `rgba(${HEAT_RGB}, ${heatAlpha(cell.count, matrix.cellMax)})`,
                              // El tinte del cuadrante va como background-image
                              // para que se componga ENCIMA del gris de la
                              // intensidad en vez de reemplazarlo.
                              backgroundImage: critical
                                ? `linear-gradient(${CRITICAL_TINT}, ${CRITICAL_TINT})`
                                : undefined,
                            }}
                            className={cn(
                              "border-b border-border px-3 py-1.5",
                              cell.count > 0 &&
                                "cursor-pointer hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-primary/40"
                            )}
                          >
                            {cell.count === 0 ? (
                              <span className="text-muted-foreground">–</span>
                            ) : (
                              n(cell.count)
                            )}
                          </td>
                        )
                      })}

                      <td
                        onClick={() =>
                          openDrill(
                            { count: row.total, oppIds: row.oppIds },
                            `${row.label} sin mover — todas`,
                            `${n(row.total)} oportunidades`
                          )
                        }
                        className={cn(
                          "border-b border-l border-border px-3 py-1.5 font-semibold",
                          row.total > 0 && "cursor-pointer hover:bg-muted/50"
                        )}
                      >
                        {n(row.total)}
                      </td>
                    </tr>
                  ))}

                  <tr className="font-semibold">
                    <th
                      scope="row"
                      className={cn(stickyCol, "border-r border-border px-3 py-2 text-left")}
                    >
                      Total
                    </th>
                    {STALE_BUCKETS.map((b) => (
                      <td
                        key={b.key}
                        onClick={() =>
                          openDrill(
                            matrix.colTotals[b.key],
                            `${b.label} sin mensaje — todas`,
                            `${n(matrix.colTotals[b.key].count)} oportunidades`
                          )
                        }
                        className={cn(
                          "px-3 py-2",
                          matrix.colTotals[b.key].count > 0 && "cursor-pointer hover:bg-muted/50"
                        )}
                      >
                        {matrix.colTotals[b.key].count === 0 ? (
                          <span className="text-muted-foreground">–</span>
                        ) : (
                          n(matrix.colTotals[b.key].count)
                        )}
                      </td>
                    ))}
                    <td className="border-l border-border px-3 py-2">{n(matrix.grandTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </ChartCardContent>

      <ChartDrillDrawer
        drill={drill}
        onDrillChange={setDrill}
        contacts={allContacts.length > 0 ? allContacts : contacts}
        tasks={tasks}
        calls={calls}
        allOpportunities={allOpportunities}
        allPautas={allPautas}
        appointments={appointments}
        messages={messages}
        locationId={locationId}
      />
    </DashboardCard>
  )
}
```

- [ ] **Paso 2: Montar el componente en los dos paneles**

En `components/dashboard/vaeo-dashboard.tsx`:

1. Import, después del de `TaskBacklogChart`:

```ts
import { StaleOpportunityMatrix } from "./stale-opportunity-matrix"
```

2. En el JSX, entre `<AdvisorStageTable {...shared} />` y `<TaskBacklogChart ... />`, para dejar los tres bloques de asesoras en el orden del spec (quién tiene qué → qué está abandonado → qué está atrasado):

```tsx
      <StaleOpportunityMatrix
        {...shared}
        conversationActivity={conversationActivity}
        activityStatus={activityStatus}
        onRetryActivity={onRetryActivity}
      />
```

Aplicar los dos cambios idénticos en `components/dashboard/mesh-dashboard.tsx`.

- [ ] **Paso 3: Comprobar los tipos**

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Paso 4: Correr toda la verificación**

Run:

```bash
pnpm verify:stale-matrix && pnpm verify:task-backlog && pnpm verify:advisors && pnpm verify:pivot && pnpm verify:paged && npx tsc --noEmit
```

Expected: los cinco scripts imprimen `all assertions passed` y `tsc` no dice nada.

- [ ] **Paso 5: Manejar la app real**

Run: `pnpm dev`.

Verificar, en VAEO **y** en MESH:
1. Mientras carga la actividad, la tarjeta muestra el esqueleto "Cargando actividad de conversaciones…" — **nunca una matriz de ceros ni una columna "+60 d" llena**.
2. Al terminar, la matriz se pinta y su gran total coincide con las oportunidades abiertas del embudo menos Ganado/Perdido/Cliente Futuro.
3. La suma de las cinco columnas y la de las cinco filas dan el mismo gran total.
4. El cuadrante inferior derecho (2×2) se distingue por el tinte rojizo, y el conteo de la leyenda coincide con la suma de esas cuatro celdas.
5. Mover el filtro de fechas **no** cambia ningún número; poner un filtro de sucursal **sí**.
6. Clic en una celda abre el drawer con exactamente ese número de oportunidades.
7. Con la red cortada (DevTools → Offline, y recargar), la tarjeta muestra el estado de error con botón de reintentar, y el botón vuelve a disparar la petición.

**Contra datos reales, revisar además los dos riesgos que el spec dejó abiertos** y anotar el resultado en el commit o en un comentario del PR:
- **¿El eje de mensajes salió plano?** Con "cualquier saliente" y un bot de WhatsApp activo, es posible que casi todo caiga en la primera columna y la matriz mida de hecho solo el movimiento de etapa. Si pasa, cambiar a "último saliente manual" es un cambio acotado al derivador de la ruta (Task 5, paso 3): las cubetas y el componente no se tocan.
- **¿`lastStageChangeAt` trae ruido de automatizaciones?** Si un flujo de Make mueve etapas solo, el eje de movimiento hereda el mismo ruido del que se acusa a `updatedAt`. No se observó en el reconocimiento; confírmalo antes de dar el gráfico por bueno.

- [ ] **Paso 6: Commit**

```bash
git add components/dashboard/stale-opportunity-matrix.tsx components/dashboard/vaeo-dashboard.tsx components/dashboard/mesh-dashboard.tsx
git commit -m "feat(panel): montar la matriz de oportunidades sin atención en los dos paneles"
```

---

## Task 8: documentar en `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

**Por qué es su propia tarea:** `CLAUDE.md` es la descripción autorizada de la arquitectura (el `README.md` está obsoleto y no se debe creer). Los dos bloques que hay que tocar describen a los dos gráficos juntos, y solo se pueden escribir con verdad una vez que ambos existen. Las líneas de los comandos `verify:*` ya se agregaron en las Tasks 1 y 4.

- [ ] **Paso 1: Agregar los tres módulos nuevos a la tabla de "Shared domain rules"**

En la tabla `| Module | Owns |` de la sección **Shared domain rules**, después de la fila de `lib/advisor-breakdown.ts`:

```
| `lib/stale-opportunity-matrix.ts` | el universo del embudo vivo + las cubetas de abandono en los dos ejes (movimiento y mensajes) |
| `lib/task-backlog.ts` | las cubetas de vencimiento de tareas, calculadas en `America/Mexico_City` |
```

- [ ] **Paso 2: Describir los dos gráficos en "Current state"**

En la sección **### Current state**, dentro del primer bullet (la lista de gráficos compartidos), después de la mención de `advisor-stage-table.tsx`, agregar:

```
`stale-opportunity-matrix.tsx` ("Oportunidades sin atención": días sin cambio de etapa ×
días sin mensaje saliente, sobre las abiertas del embudo vivo — sin Ganado, Perdido ni
Cliente Futuro), y `task-backlog-chart.tsx` ("Tareas pendientes por asesor", barras
apiladas por vencimiento),
```

- [ ] **Paso 3: Agregar el bullet de las reglas que estos dos gráficos rompen a propósito**

Al final de la sección **### Current state**, como bullet nuevo:

```markdown
- **Los dos gráficos de vigilancia de asesoras ignoran el filtro global de fechas**
  (`stale-opportunity-matrix.tsx`, `task-backlog-chart.tsx`). "Sin atención en 60 días" y
  "vencida" son condiciones de HOY, no de un periodo, así que leen `allOpportunities` y la
  prop nueva `allTasks` en vez de las slices filtradas. Sí respetan sucursal / asesor /
  origen / canal y el toggle de HubSpot, porque esos ya vienen aplicados aguas arriba.
  - El eje de mensajes de la matriz **no** sale del dataset de `dashboard-messages`: esa
    ruta trae las últimas 30 conversaciones POR USUARIO (~270 de 12 054), y la ausencia de
    un contacto ahí no prueba silencio, solo que no entró en la muestra. Sale de
    `app/api/conversation-activity`, que recorre `/conversations/search` por cursor hasta
    `STALE_HORIZON_DAYS` y solo abre el hilo de las conversaciones que terminan en
    entrante — el resto ya tiene su fecha en `lastMessageDate`.
  - **`STALE_HORIZON_DAYS` (60) acopla la ruta a las cubetas.** Si se agrega una cubeta de
    90 días hay que subirla, o las conversaciones entre 60 y 90 días nunca llegarán y el
    gráfico mentirá.
  - **La matriz no se renderiza hasta que `activityStatus === "ready"`.** Con el mapa
    vacío toda oportunidad cae en la columna "+60 d" y el gráfico afirma un abandono
    total: alarmante, verosímil y falso. `loading` pinta un esqueleto y `error` pinta un
    estado explícito con reintentar — nunca ceros, nunca una matriz parcial.
  - **El movimiento se mide con `lastStageChangeAt`, nunca con `updatedAt`.** La cuenta
    corre flujos de Make y un bot de WhatsApp, y cada escritura automática empuja
    `updatedAt`; un gráfico basado en él reportaría que todo se está trabajando.
```

- [ ] **Paso 4: Revisar el archivo renderizado**

Run: `git diff CLAUDE.md`
Expected: solo los bloques descritos arriba, más las dos líneas de comandos `verify:*` que ya venían de las Tasks 1 y 4. Comprobar que las tablas de Markdown siguen alineando y que ningún bloque de código quedó sin cerrar.

- [ ] **Paso 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: documentar los dos gráficos de vigilancia de actividad de asesoras"
```

---

## Cobertura del spec

| Requisito del spec | Dónde |
|---|---|
| `lastStageChangeAt` en las dos interfaces | Task 4, paso 1 |
| `lib/stale-opportunity-matrix.ts` + universo por nombre de etapa | Task 4 |
| Cubetas `0-7 / 8-15 / 16-30 / 31-60 / 60+` en ambos ejes | Task 4 |
| `pnpm verify:stale-matrix` con los casos que enumera el spec | Task 4, paso 2 |
| `app/api/conversation-activity` con el algoritmo de 5 pasos | Task 5 |
| Corte en `HORIZONTE = 60 días`, cursor `startAfterDate`, dedupe por id | Task 5, paso 3 |
| Concurrencia acotada al abrir hilos (`CONCURRENCY = 6`) | Task 5, paso 3 |
| Excluir actividad de sistema al buscar el saliente | Task 5, pasos 2 y 3 |
| `hooks/use-conversation-activity.ts` con `loading/ready/error` | Task 6 |
| Componente de la matriz, sombreado global + cuadrante crítico | Task 7 |
| No renderizar hasta `ready`; error con reintentar | Task 7, paso 1 |
| `ScopePill` sin eufemismos | Task 7, paso 1 |
| Drill-down por celda contra los sets `all*` | Task 7, paso 1 |
| `lib/task-backlog.ts` + cubetas en `America/Mexico_City` | Task 1 |
| `pnpm verify:task-backlog` con los casos que enumera el spec | Task 1, paso 1 |
| Join contacto → oportunidades → embudo; huérfanos aparte | Task 1, paso 4 |
| Componente de barras apiladas + leyenda propia + drill | Task 2 |
| Nota de "tareas de contactos sin oportunidad" con drill | Task 2, paso 1 |
| Bug del `CAP = 500` de tareas | Task 3 |
| Orden en el panel: AdvisorStageTable → Stale → TaskBacklog | Task 7, paso 2 |
| Idénticos en VAEO y MESH, solo cambia `panel` | Tasks 2 y 7 |
| Riesgos a revisar contra datos reales | Task 7, paso 5 |

**Fuera de alcance, según el spec — no lo implementes:** alertas o acciones sobre los leads abandonados; exportación de estas dos secciones al PDF (`lib/report.ts`, cuyo presupuesto de tokens está dimensionado a las secciones actuales); exponer la actividad de conversación al asistente de IA.
