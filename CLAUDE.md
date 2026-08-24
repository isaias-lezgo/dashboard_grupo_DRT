# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The client: Grupo DRT

This repo is a **single-client fork** of a shared multi-client GHL panel
(`upstream` → `dashboards-GHL`), built to serve **one customer: Grupo DRT**.

**Grupo DRT** (`drt.com.mx`) — a **real-estate developer** based in Querétaro
(Prol. Cipreses 100, Jurica; `America/Mexico_City`). GHL sub-account
`LbjglJfbiUWjKpmxSnvm`, contact `mkt@drt.com.mx`.

It sells **housing and lots** — a long, high-consideration cycle. Not a one-off purchase
and not a subscription, so the funnel that matters is
**lead → contacto → cita → visita al desarrollo → apartado → venta**. "Apartado" (the
deposit) is the hinge: it is the first real commitment, and almost everyone who reaches it
closes. When proposing charts, the Visita → Apartado step says more than any other.

**Six developments, and each one IS a CRM pipeline.** Measured 2026-08-24:

| Desarrollo | Pipeline id | Oportunidades |
|---|---|---|
| Cañadas | `ChCZUhFDe5m0RSNp4qbb` | 4,490 |
| La Sierra | `gRHIvjxjQ2vvHSXQjfC2` | 1,979 |
| Atria | `0HGe4sGXe7v6Keo2Fk7v` | 1,968 |
| Saggita | `5FZvtr1HjvpLDXjcHxfx` | 1,872 |
| Palmyra | `jNQOWHy6JLW5Mbb18l7t` | **0** |
| Zanda | `1f8VurvKrPgbwYrmBo2m` | **0** |

Palmyra and Zanda are real pipelines that have not launched. They get their own tabs and
render honest empty states — do **not** hide them.

**The shape of this account, and what it implies for charts.** All figures measured
2026-08-24 against production; re-measure before trusting them, but the orders of
magnitude are the point:

- **10,309 oportunidades · 11,906 contactos · 34 usuarios** (~24 of them advisors who
  actually carry opportunities).
- **The funnel is high-volume and low-conversion, and that is normal here**: 2,923 open,
  7,303 lost, 55 `status: "won"`, 28 abandoned. **Never report ~0.5% conversion as an
  anomaly or a performance problem without that context.**
- **~17% of opportunities have no `assignedTo`.** That is the single biggest leak in the
  funnel and the reason `assignment-funnel-chart.tsx` earns its place here.
- **Almost every lead comes from pauta**: ~99.7% of opportunities carry the `Pauta` custom
  field, ~86% carry `URL Pauta` and `ID de Pauta`, and ~85% of `source` is
  "Pauta WhatsApp" / "Pauta Formulario" / "Pauta". "Where do leads come from?" is nearly
  always a question about **which campaign**, not which generic channel.
- **The closing fields are barely captured**, which is why the money charts were removed
  (see "Charts deliberately absent" below): `Fecha de Cierre` is populated on ~5% of won
  opportunities, `Unidad` / `Forma de pago` / `Objetivo real` on <4%. Money lives on the
  **native `monetaryValue`** instead — 21 of 55 won opportunities carry one, totalling
  ~$77M.

**Multi-tenancy is no longer a design concern here.** The roster code (`lib/clients.ts`,
password-as-identity, per-location limiter keying) still exists and still works — leave it
alone unless asked — but do **not** weigh new work against cross-client generality, and
don't preserve per-account portability when it complicates a chart. Hardcoding DRT's
actual pipeline names, stages and custom fields is fine and preferred here.

## Commands

```bash
# Development
pnpm dev        # Start Next.js dev server (localhost:3000)
pnpm build      # Production build (TypeScript errors are ignored — see next.config.mjs)
pnpm start      # Serve production build
pnpm lint       # Run ESLint

# Multi-client
pnpm add-client # Add a client to the DASHBOARD_CLIENTS roster (prompts, validates, prints the blob)
                #   Non-interactive: pnpm add-client --name "X" --location <id> --token pit-…

# Verification (see below — there is no test framework)
pnpm verify:clients      # lib/clients.ts   — roster parsing + password lookup
pnpm verify:auth         # lib/auth.ts      — session token; incl. the cookie-tamper rejection
pnpm verify:limiter      # lib/ghl-limiter.ts — per-location isolation
pnpm verify:attachments  # lib/attachments.ts + lib/attachment-tools.ts — tabular parse/query/join
pnpm verify:paged        # lib/paged-fetch.ts — resiliencia del abanico de páginas
pnpm verify:pivot        # lib/sales-pivot.ts + lib/sales-series.ts + lib/panel-scope.ts
pnpm verify:breakdown    # lib/opportunity-breakdown.ts — cubetas de estado + normalización de categorías
pnpm verify:lost-matrix  # lib/lost-reason-matrix.ts — cruce motivo de perdido × categoría
pnpm verify:lost-cross   # lib/lost-cross-matrix.ts — cruce perdidas servicio/origen/canal
pnpm verify:advisors     # lib/advisor-breakdown.ts — matriz asesor × etapa + cubetas de estatus
pnpm verify:assignment   # lib/assignment-funnel.ts — universo sin-asesor vs. denominador del mes
pnpm verify:filters      # lib/panel-filters.ts — filtros globales de desarrollo y asesor
pnpm verify:category-filter # lib/category-filter.ts — opciones de origen/canal SIN agrupar grafías
pnpm verify:task-backlog # lib/task-backlog.ts — cubetas de vencimiento por zona horaria
pnpm verify:stale-matrix # lib/stale-opportunity-matrix.ts — cubetas de abandono en ambos ejes
pnpm verify:sync-store   # lib/sync-store.ts — gzip roundtrip, aislamiento por cliente, el candado
npx tsc --noEmit         # REQUIRED: next build ignores TS errors, so a green build proves nothing

# Caché de sincronización (Neon)
pnpm db:migrate          # crea project_sync — idempotente, va por DATABASE_URL_UNPOOLED
```

`pnpm lint` is broken and has been for a while — `eslint` is not actually a dependency of
this repo, so the script exits with `command not found`. `npx tsc --noEmit` is the real
gate.

**No test framework, and not adopting one.** Instead, the pure modules where a silent
bug would be a *cross-tenant data leak* (clients / auth / limiter) or a silently wrong
answer (attachments / paged-fetch / sales-pivot / opportunity-breakdown) have assertion scripts under
`scripts/verify-*.ts` (plain `node:assert/strict`, run via `tsx`). Run them after touching
auth, the roster, the limiter, the attachment parsers, the pagination helpers, or the
sales pivot. Everything else is verified by driving the real app.

There is no way to run a single assertion within a script — each `verify:*` script is
the unit. Run the one that covers the module you touched.

Gotcha when writing these scripts: this package is CommonJS (no `"type": "module"`),
so `tsx` compiles to CJS where **top-level `await` fails**. Wrap async work in a
`main()` and call `main().catch(...)` — see the existing scripts.

**Package manager: pnpm.** This repo is managed with pnpm (`packageManager: pnpm@11.x`
in `package.json`), and the Vercel deploy runs `pnpm install --frozen-lockfile` against
`pnpm-lock.yaml`. **Install and add dependencies with `pnpm install` / `pnpm add <pkg>`
— never `npm install`.** Running `npm install` writes `package-lock.json` but leaves
`pnpm-lock.yaml` stale, which makes the Vercel build fail with
`ERR_PNPM_OUTDATED_LOCKFILE`. If a lockfile ever drifts, run `pnpm install
--lockfile-only` to resync only the lockfile (no `node_modules` churn), then commit it.
A tracked `package-lock.json` lingers from before the switch; it is **not** the source
of truth — ignore it.

`pnpm-workspace.yaml` exists only for its `allowBuilds` list (`sharp`, `esbuild`). pnpm 11
blocks postinstall scripts by default; without those entries the install dies with
`ERR_PNPM_IGNORED_BUILDS`. If a new dependency needs a postinstall, add it there.

## Environment Variables

Required vars in `.env.local`:
- `DASHBOARD_CLIENTS` — JSON array of clients, one per GHL sub-account:
  `[{"id","name","locationId","ghlToken","password"?}]`. `password` is optional and
  defaults to that client's `locationId`. Use `pnpm add-client` to extend it safely.
- `DASHBOARD_AUTH_SECRET` — random string used to HMAC-sign the session cookie (`openssl rand -hex 32`)
- `ANTHROPIC_API_KEY` — used by `app/api/chat` (assistant), `analyze-report` (PDF analyses)
  and `analyze-contact`
- `GHL_API_TOKEN` / `GHL_LOCATION_ID` — **not read by the app.** Kept only so the dev
  GHL MCP server (`.mcp.json`) can point at one sub-account.

Optional (the sync cache — see "Caché de sincronización" below):
- `DATABASE_URL` / `DATABASE_URL_UNPOOLED` — injected by the Neon integration on Vercel;
  `vercel env pull .env.local` brings them down locally. **Absent = the app behaves
  exactly as it did before the cache existed**, doing a full GHL sync on every load.

All are server-side only. `DASHBOARD_CLIENTS` is read in `lib/clients.ts`;
`DASHBOARD_AUTH_SECRET` in `lib/auth.ts`, `app/api/auth/login/route.ts`, and
`middleware.ts` — never exposed to the browser.

## Repo docs

- `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md` — the design doc for a feature;
  `docs/superpowers/plans/` — its implementation plan. Both are written **before** the
  code. When picking up non-trivial work on an existing feature, check for its spec first —
  it usually records why an approach was rejected.
- **`README.md` is stale — do not trust it.** It still describes Next 15, SWR caching, a
  `lib/mock-data.ts` fallback, a `filter-bar.tsx` with member/pipeline/tag filters, and a
  `conversations-dashboard.tsx` tab. None of those exist. This file (CLAUDE.md) is the
  accurate description; treat the README as marketing copy.
- `DESIGN.md` — the design system (named color tokens, typography, component rules).
  `PRODUCT.md` — who the three audiences are and what each asks of the same data.
  `snap.md` / `snap2.md` are one-off Playwright accessibility-tree dumps, not docs.

## Architecture

This is a single-page Next.js 16 (App Router) dashboard that surfaces GoHighLevel CRM data in eight tabs: **GENERAL**, one per desarrollo (**Atria**, **Cañadas**, **La Sierra**, **Palmyra**, **Saggita**, **Zanda**), and **Asistente IA**. The multi-tenant machinery from the shared panel is still in place (a client's password resolves to their own GHL sub-account — see "Multi-client" below), but this deployment serves Grupo DRT only.

### Panel scope: the pipeline IS the desarrollo

**Every panel is the same charts over a different pipeline.** A chart is built once and
renders in any tab with only the pipeline scope changing — that is why there is exactly
**one** `components/dashboard/panel-dashboard.tsx` taking a `panel: PanelId` prop, and not
one component per tab. (It used to be two twin files, `vaeo-dashboard` / `mesh-dashboard`,
that differed only in a string literal. With seven scopes that stopped being tenable; if
you find yourself copying it again, parameterize instead.)

All six pipelines live in the **same** GHL sub-account (`LbjglJfbiUWjKpmxSnvm`, "Grupo
DRT"), so the main sync fetches them together and the split is client-side. The stage
names are **identical across all six**:

```
00. Recibido → 01. Contactado → 02. Lead en Seguimiento → 03. Lead Calificado
→ 04. Cita Programada → 05. Visita al Desarrollo → 06. Negociación
→ 07. Apartado → 08. Venta
```

plus two side buckets: **Inversión Futura** and **Negocio perdido** (spelled
`Negocio Perdido` in La Sierra, Palmyra and Zanda — hence the rule below).

Match stages **by name, case-insensitively** — never by stage id — the same rule
`isWonOpp()` already follows.

Two stages sit at **zero** in every pipeline today (`03. Lead Calificado`,
`06. Negociación`). They are not dead code to delete: they are stages the operation
skips, and a funnel chart that shows them empty is telling the client something true.

**GENERAL is deliberately "all opportunities", not "the six desarrollos we know about."**
When DRT opens a seventh development, its leads reach GENERAL and the desarrollo filter
the same day, with no code change; only its own tab has to be added to `PANEL_SCOPES`.
`scopeOpportunities(opps, "general")` returns the **same array reference**, not a copy, so
the tab that handles the most data doesn't churn every memo downstream.

Consequences to keep in mind when building charts:

- **The opportunity is the entry point, not the contact.** A contact has no pipeline of
  their own; they belong to a panel because one of their opportunities does. Scope by
  filtering opportunities on `pipelineId`, then resolve contacts from that set.
- A contact with opportunities in *several* pipelines legitimately appears in *several*
  panels. That is not double-counting to fix — they are comparing developments.
- A contact with **no** opportunity belongs to no pipeline, so it can't be scoped to any
  desarrollo — but it is **never silently dropped**. Those contacts are leads that
  nobody has moved into an embudo yet, which is exactly the leak worth watching. Surface
  them in a **card at the top of the panel** ("Contactos sin oportunidad" — count +
  drill-down to the list), above the pipeline-scoped charts, and keep them **out** of the
  chart aggregates so the funnel numbers stay honest.
- The pipeline scope is applied **before** the date filter conceptually, but both are just
  filters over the same arrays; order doesn't matter as long as drill-downs still join
  against the unfiltered `all*` sets (see "Drill-downs" below).

`app/page.tsx` passes the **full** opportunity/contact sets to the dashboard; each chart
applies the scope itself through **`lib/panel-scope.ts`** (`scopeOpportunities(opps, panel,
pipelines)`), the single definition every panel shares. `resolvePipelineId()` matches the
pipeline by **name** (accent- and case-insensitively, so the `canadas` key finds
"Cañadas") and falls back to the hardcoded id; it returns `null` for GENERAL.

**There is no sucursal custom field in this account.** The geographic/commercial dimension
is the **desarrollo**, and the desarrollo is read from the **pipeline** — which is why
`desarrolloOf(opp, pipelines)` takes the pipeline list instead of a field name. Do not
reintroduce a `sucursalField`-style seam here.

### Current state

- **Every tab renders the same chart set**, from the single `panel-dashboard.tsx`, which
  builds one `shared` object and spreads it into every per-opportunity chart. Keep that
  pattern rather than re-listing props per chart. The mounted charts:
  `opportunity-status-chart.tsx`, `opportunity-win-rate-chart.tsx`,
  `assignment-funnel-chart.tsx` ("Leads sin asesor por mes": the universe is
  **exclusively** the opportunities with no `assignedTo`, stacked by creation month and
  split by status. The assigned ones aren't drawn — "Oportunidades por estado" and the
  advisor table cover those — but they DO count toward `monthTotal`, the denominator of
  the "% del mes" in the tooltip and footnote: without it a raw orphan count loses the
  scale that makes it mean anything. The legend lists only buckets with records
  (`activeBuckets`), so a "Ganadas" series pinned at zero never appears. **~17% of DRT's
  opportunities are orphaned, so this card is the headline finding, not a footnote**),
  `advisor-stage-table.tsx` (asesor × etapa, with a stacked status bar per row; shading is
  normalized **per column** and the "Sin asesor" row stays outside that normalization and
  outside the tint, because it is an order of magnitude larger),
  `stale-opportunity-matrix.tsx` ("Oportunidades sin atención": days without a stage change
  × days without an outbound message, over the open opportunities of the live funnel),
  `task-backlog-chart.tsx` ("Tareas pendientes por asesor", stacked by due date), two
  mounts of `category-breakdown-chart.tsx` (`OrigenDeLeadChart` / `CanalDeContactoChart`),
  `lost-reason-matrix.tsx` ("Motivos de perdido": motivo × categoría, with its own local
  switch between Canal de Contacto and Origen de Lead — that switch is card-local state,
  not a global filter), and `lost-cross-matrix.tsx` (the same lost opportunities crossed
  over **two of three** dimensions, with a per-axis switch; choosing the other axis's
  dimension **transposes** the table instead of forcing a third onto the other axis).
- **`lost-cross-matrix.tsx` still offers a `Servicio` axis, and DRT has no such field.**
  Its `LOST_DIMENSIONS.servicio` reads `SERVICIO_FIELD` ("Servicio") from `lib/sales-pivot.ts`,
  which was VAEO's vocabulary — here it will resolve to an all-"Sin servicio" column. The
  DRT-correct third dimension is almost certainly **desarrollo** (from the pipeline) or
  `Tipo de vivienda`; pick one, measure its capture rate first, and rewire that entry.
  Origen × Canal — the other two axes — work today.
- **Charts deliberately absent, and why.** `sales-pivot-table.tsx`,
  `sales-by-dimension-chart.tsx` and `lost-by-dimension-chart.tsx` were **removed** in the
  DRT fork. All three key off `Fecha de Cierre` × sucursal × servicio, and in this account
  `Fecha de Cierre` is populated on ~5% of won opportunities while sucursal and servicio
  don't exist at all — they would render as empty frames, not as an honest capture-gap
  finding. `lib/sales-pivot.ts` and `lib/sales-series.ts` **were kept**: they take the
  dimension as a *parameter*, `pnpm verify:pivot` still asserts them, and `lost-cross-matrix`
  still imports their constants. If DRT starts capturing close dates, rebuild the charts on
  top of those modules — but change the seam from a **field name** to a **resolver
  function**, because the desarrollo is not a custom field. The deleted components are
  recoverable from `upstream` (`dashboards-GHL`) and from the VAEO panel repo; this repo's
  own history starts at its first commit and does not contain them.
- **`ChartContainer` (`components/ui/chart.tsx`) already wraps its child in a Recharts `ResponsiveContainer`.** Do not nest another one inside it — the chart still renders, but Recharts logs "width and height are both fixed numbers" on every resize. Charts recovered from `upstream` predate this and do nest one; drop it when you port them.
- The panel also takes **`dateRange`** (the resolved `ResolvedDateRange | null` from `app/page.tsx`). It exists for charts that measure a date *other than* `createdAt` — nothing mounted uses it today, but keep it wired: it is exactly what a rebuilt close-date chart would need, and re-plumbing it later is the expensive part.
- **Los dos gráficos de vigilancia de asesoras ignoran el filtro global de fechas**
  (`stale-opportunity-matrix.tsx`, `task-backlog-chart.tsx`). "Sin atención en 60 días" y
  "vencida" son condiciones de HOY, no de un periodo, así que leen `allOpportunities` y la
  prop nueva `allTasks` en vez de las slices filtradas. Sí respetan desarrollo / asesor /
  origen / canal, porque esos ya vienen aplicados aguas arriba.
  - Existe una tercera prop, **`unfilteredOpportunities`** (el set crudo de
    `data.opportunities`), y NO es redundante con `allOpportunities`: esa última ya pasó
    por los menús de panel. Solo la usa el rezago de tareas, para distinguir al contacto
    que no tiene NINGUNA oportunidad —que va a la nota al pie, fuera del agregado— del que
    sí tiene pero quedó fuera de un filtro. Con `allOpportunities` en su lugar, poner un
    filtro de desarrollo hacía que la nota afirmara que 131 contactos no tenían
    oportunidades cuando sí las tenían. No las fusiones.
  - El eje de mensajes de la matriz **no** sale del dataset de `dashboard-messages`: esa
    ruta trae las últimas 30 conversaciones POR USUARIO (~270 de 12 054), y la ausencia de
    un contacto ahí no prueba silencio, solo que no entró en la muestra. Sale de
    `app/api/conversation-activity`, que recorre `/conversations/search` por cursor hasta
    `STALE_HORIZON_DAYS` y solo abre el hilo de las conversaciones que terminan en
    entrante — el resto ya tiene su fecha en `lastMessageDate`. Medido: 3 200
    conversaciones recorridas, 600 hilos abiertos, ~85 s.
  - **`/conversations/search` devuelve `lastMessageDate` como epoch en MILISEGUNDOS**, no
    como el ISO que declara el tipo y que usa el resto de la API. La ruta lo normaliza con
    `toIso()` en la frontera. No lo quites: río abajo se hace `new Date(valor)`, que con un
    número funciona de casualidad, pero el mismo epoch como cadena daría Invalid Date y
    mandaría a todos los contactos a la cubeta de abandono.
  - **`STALE_HORIZON_DAYS` (60) acopla la ruta a las cubetas.** Si se agrega una cubeta de
    90 días hay que subirla, o las conversaciones entre 60 y 90 días nunca llegarán y el
    gráfico mentirá.
  - **La matriz no se renderiza hasta que `activityStatus === "ready"`.** Con el mapa
    vacío toda oportunidad cae en la columna "+60 d" y el gráfico afirma un abandono
    total: alarmante, verosímil y falso. `loading` pinta un esqueleto y `error` pinta un
    estado explícito con reintentar — nunca ceros, nunca una matriz parcial.
  - **El movimiento se mide con `lastStageChangeAt`, nunca con `updatedAt`.** La cuenta
    corre flujos de Make y un bot de WhatsApp, y cada escritura automática empuja
    `updatedAt` (medido: 7-9 min por delante de `createdAt` en oportunidades que nadie
    tocó); un gráfico basado en él reportaría que todo se está trabajando.
- Charts the shared panel had and this fork deleted are recoverable from git history / `upstream` — check there before rebuilding one from scratch.
- The last tab (`DashboardTab` id `"conversations"`, labelled **"Asistente IA"**) renders `conversations-chat.tsx`. It is **permanently mounted and merely hidden** when inactive, so the chat history survives tab switches — do not make it conditional. It always sees the full, unfiltered dataset.
- Both dashboards can **export a branded PDF report** of their own charts (see "PDF report export").

### Data flow

```
browser → middleware.ts (verifies the signed dash_session cookie)
    ↓
app/api/dashboard/route.ts
    ↓  requireClient()  → resolves the cookie's client id to a ClientConfig (lib/session.ts)
    ↓  readSync(client)  → lib/sync-store.ts → Neon
    ├─ HAY caché y no viene ?fresh=1 → manda UN frame `data` y termina (0.8-2.4 s).
    │    Si pasó de 15 min, after(() => refreshInBackground()) corre el sync
    │    DESPUÉS de que la respuesta salió; el usuario nunca lo espera.
    └─ NO hay caché (o ?fresh=1, o Postgres no responde) → sync en vivo ↓
    ↓  lib/sync.ts  syncProject(client, send?)  ← la MISMA función en ambos caminos
    ↓  withClient(...)  → establishes the per-request credential context (lib/ghl-context.ts)
    ↓
lib/ghl-client.ts  (raw GHL types + fetch helpers; reads token+location from the context)
    ↓  lib/ghl-limiter.ts  (concurrency + rate limiting, keyed PER LOCATION)
GHL REST API (services.leadconnectorhq.com)
    ↓  back up: transforms GHL → internal types; contacts/opps/pautas/appointments/tasks fetched concurrently
    ↓  NDJSON stream of {progress|location|step|data|error} frames
hooks/fetch-stream.ts  (parses the NDJSON stream)
    ↓
hooks/use-dashboard-data.ts  (custom streaming fetcher; exposes data, progress text, and structured per-dataset `steps`. No SWR/caching — refresh() re-runs the full sync)
    ↓
app/page.tsx  (tab state, date-filter state, applies the client-side date-range filter, renders dashboard)
    ↓
components/dashboard/{marketing,sales}-dashboard.tsx
```

Beyond that main sync, the app has other routes under `app/api/`. **Every one that touches
GHL must run through `requireClient()` + `withClient()`**; the ones that work off data the
browser already holds (`chat`, `analyze-report`, `attachments/process`) need only the
middleware gate.

### Caché de sincronización (Neon Postgres)

Un sync completo contra GHL tarda decenas de segundos; con el caché la carga normal baja
a un par. La ruta lee una fila de `project_sync` con el payload ya armado, la manda, y
**si el dato pasó de 15 min dispara el refresco DESPUÉS de responder** (`after()` de
`next/server`). El usuario nunca espera al refresco.

- **`lib/db.ts`** es lo único que sabe que la base es Neon. `getSql()` es perezoso a
  propósito: importar el módulo sin `DATABASE_URL` — un verify script, un paso de build —
  no debe tronar, y `neon()` truena con una URL vacía.
- **`lib/sync-store.ts`** — `readSync` / `writeSync` / `claimSync` / `releaseSync` /
  `isStale`. Una tabla, `bytea` + gzip (nunca consultamos dentro del payload, lo mandamos
  entero). El caché es **desechable**: se sobrescribe entero, guarda solo el presente, y
  si se borra la tabla se rellena sola. Esa propiedad es lo que lo mantiene en una tabla
  en vez de un esquema y lo que evita acumular datos personales históricos. **No guardes
  historia aquí.**
- **`lib/sync.ts`** — `syncProject(client, send?)`. La orquestación salió del route
  handler precisamente para que la ruta y el refresco en segundo plano llamen al mismo
  código; dos copias se desincronizan al primer cambio. `send` es opcional porque el
  refresco no tiene a quién mandarle progreso, y `withClient()` se entra **dentro** de
  `syncProject`, no alrededor del handler: el stream sigue produciendo frames después de
  que `GET()` regresó.
- **Todas las funciones del store reciben el `ClientConfig`, nunca un string.** Leer la
  fila equivocada renderizaría el panel de A con datos de B — la misma clase de fuga que
  `lib/ghl-context.ts` existe para evitar.
- **`claimSync` decide dentro del `WHERE` del UPDATE**, no en TypeScript: un
  read-then-write dejaría una ventana donde dos peticiones ven el candado libre y ambas
  sincronizan. El candado se auto-sana a los 10 min. `releaseSync` **no toca el payload**
  — un refresco fallido debe dejar el último caché bueno donde estaba.
- **`synced_at` sale del payload (`meta.fetchedAt`), no de `now()`**: registra cuándo se
  trajo el dato de GHL, que es lo que significa el "Actualizado hace X" del header.
- **La base NO es una dependencia.** Todo fallo de Postgres se registra y cae al sync en
  vivo (`readCache` / `saveQuietly` en la ruta). Meter el caché no puede crear una forma
  nueva de que el panel no cargue. Se prueba apuntando `DATABASE_URL` a un host inválido
  y confirmando que la app sigue funcionando.
- **`maxDuration = 300` necesita Fluid Compute encendido** (Settings → Functions). Eso es
  lo que sube el techo, no el plan. Sin Fluid el techo es 60 s y un refresco cortado a la
  mitad falla **en silencio**, porque corre después de que la respuesta salió; el síntoma
  es que el "Actualizado hace X" deja de avanzar.
- El botón **Actualizar** manda `?fresh=1` (`refresh()` en `use-dashboard-data.ts` va en
  fresco por defecto); el montaje inicial no, que es el punto de todo esto.
- **No caches las rutas de detalle** que se piden al abrir un drawer, ni
  `/api/conversation-activity`. Van a GHL en vivo y ahí está bien.

### Multi-client (multi-tenancy)

One deployment serves every client. **The password IS the client's identity.** The full
mechanism (roster seam, signed cookie, `requireClient()`, the `withClient()`
AsyncLocalStorage context, per-location limiter keying) is in the **`multi-tenancy`
skill** — load it before touching `lib/clients.ts`, `lib/auth.ts`, `lib/session.ts`,
`lib/ghl-context.ts`, `lib/ghl-limiter.ts` or `app/api/auth/*`. The two prohibitions below
stay here because they must never be out of context:

**NEVER** replace the AsyncLocalStorage context with a module-level "current client"
variable: one serverless instance serves overlapping requests, so that would
silently serve client A's dashboard using client B's token.

**Password model — a deliberate, informed tradeoff. Do not "fix" it unprompted.**
A client's password defaults to their GHL `locationId`. That id is *not* a secret
(it appears in GHL URLs, embed codes, webhook payloads, Make scenarios) and it
**cannot be rotated**. The owner accepted this knowingly, for the convenience of
having nothing extra to manage. The escape hatch is already built in: the optional
`password` field on a client entry overrides the default, so any single client can be
given a real, rotatable password by adding one line — no migration, no code change.
Suggest that if a password leaks; don't rewrite the model on your own initiative.

### Loading & progress

The dashboard fetch streams NDJSON progress frames rather than returning a single JSON blob, so the UI can show live progress during the multi-second GHL sync:
- `{ type: "location", name }` — sub-account name (resolved first, for the loading header).
- `{ type: "step", key, status, count }` — structured per-dataset progress. `key` ∈
  `config | contacts | opportunities | pautas | appointments | tasks`; `status` ∈
  `loading | retrying | done | partial | error`. `partial` means the dataset came back
  known-incomplete (some pages never landed) and `error` means it came back with nothing
  — neither is the same as a legitimate zero, which is `done` with `count: 0`. The `data`
  frame carries a matching `warnings[]` that drives the dashboard's amber banner
  (`components/dashboard/sync-warning-banner.tsx`). Because those datasets are fetched
  **concurrently**, the loading screen (`components/dashboard/loading-screen.tsx`) renders
  one live row per dataset with a running count, plus a determinate progress bar driven by
  completed-step count.
- `{ type: "progress", message }` — human-readable fallback text.
- `{ type: "data", ... }` / `{ type: "error", ... }` — terminal frames.

**`loading-screen.tsx` tiene DOS caras, y el interruptor es `liveSync`** (derivado en
`use-dashboard-data.ts`). El caché cambió lo que significa "cargando":

- **`CacheFace`** — el camino caliente. El payload viene de Postgres, llega un único
  frame `data` y no hay nada que reportar: anillo, título y una barra indeterminada.
  Sin filas, sin barra determinada, sin `0%`, sin cronómetro, sin la píldora de
  subcuenta (en caché tampoco llega frame `location`). Antes se pintaban las seis filas
  congeladas en gris al 0% por uno o dos segundos, lo que leía como app trabada — **un
  porcentaje que nunca se mueve es peor que ningún porcentaje.**
- **`SyncFace`** — el camino frío. Es la pantalla detallada de siempre, intacta. Aquí el
  sync tarda del orden de minuto y medio y el detalle por dataset sí se gana su lugar.

**La señal es la llegada de un frame `step`, y SOLO esa.** `progress` y `locationName`
no sirven: `load()` fija el primero en el cliente antes de que la red conteste, y el
segundo sobrevive de la carga anterior, así que ambos estarían encendidos en los dos
caminos. Los `step` solo salen del servidor y el camino caliente no emite ninguno.

Ojo con dónde se ve cada una: `app/page.tsx` monta la pantalla solo con
`isInitialLoad = isLoading && !data`, así que **el botón "Actualizar" nunca la muestra**
— deja el panel puesto y reporta el progreso en el header. `SyncFace` aparece en la
primera carga de la sesión cuando no hay fila en caché, o cuando Postgres no responde.

### AI assistant

The assistant is an **agent loop that runs in the browser**, not on the server:
`app/api/chat/route.ts` handles one Anthropic turn per request and holds no session
state; `hooks/use-agent-loop.ts` executes the ~25 tools locally and POSTs back
`tool_result` blocks. Users can also drop PDF / CSV / Excel files into the composer.
Full details — tool inventory, the Spanish system prompt's regression rules, prompt
caching, timezone handling, and the attachment pipeline — are in the **`ai-assistant`
skill**. Load it before touching `app/api/chat`, `hooks/use-agent-loop.ts`,
`lib/ai-*.ts`, `lib/conversations-panel.ts`, `lib/attachments.ts` or
`app/api/attachments/process`.

### Shared domain rules (single sources of truth)

Four small `lib/` modules exist so Marketing, Ventas, and the AI tools all agree on the
same definitions. **Never re-inline any of this logic in a component** — a local copy
that drifts makes two tabs report different numbers for the same question, which is the
bug class these modules were extracted to kill.

| Module | Owns |
|---|---|
| `lib/pauta.ts` | what counts as "de pauta" + campaign-name resolution (below) |
| `lib/opportunity-status.ts` | `isWonOpp()` — canonical "won" detection |
| `lib/source-platform.ts` | "Origen de lead" platform bucketing + `PLATFORM_COLORS` / `PLATFORM_ORDER` |
| `lib/csv.ts` | CSV cell escaping (`csvCell`, `buildCsv`) |
| `lib/panel-scope.ts` | which pipeline each panel means, and the desarrollo dimension read from it |
| `lib/panel-filters.ts` | los cuatro filtros globales de la barra (desarrollo, asesor, origen, canal) |
| `lib/category-filter.ts` | las opciones de los menús de Origen/Canal — la contraparte **sin agrupar** de `opportunity-breakdown.ts`; no los fusiones (ver abajo) |
| `lib/sales-pivot.ts` | la agregación del pivote de ventas — **sin montar** en DRT (ver "Charts deliberately absent") |
| `lib/sales-series.ts` | la agregación de las barras apiladas; `include` / `monthOf` / `measure` la abren a universos que no son "ganadas × mes de cierre × dinero" **sin duplicar** el orden de series ni el plegado de "Otros" |
| `lib/opportunity-breakdown.ts` | won/open/lost bucketing per month + "Origen de Lead" / "Canal de Contacto" category rollups |
| `lib/lost-reason-matrix.ts` | el cruce motivo de perdido × categoría (toma sus columnas de `buildCategoryBreakdown`, no re-normaliza) |
| `lib/lost-cross-matrix.ts` | el cruce de perdidas sobre dos de tres dimensiones (servicio / origen / canal); **ambos** ejes pueden ser multi-valor |
| `lib/advisor-breakdown.ts` | la matriz asesor × etapa del embudo + el desglose de estatus por asesor |
| `lib/assignment-funnel.ts` | el universo de las oportunidades sin asesor, por mes y por estatus, con el total del mes como denominador |
| `lib/stale-opportunity-matrix.ts` | el universo del embudo vivo + las cubetas de abandono en los dos ejes (movimiento y mensajes) |
| `lib/task-backlog.ts` | las cubetas de vencimiento de tareas, calculadas en `America/Mexico_City` |

- **`isWonOpp()`**: some sub-accounts never flip `status` to `"won"` — they record a sale
  by moving the opportunity into a late stage while `status` stays `"open"`. Detection
  matches the **stage name** (`/ganad[oa]|\bwon\b|\bventas?\b/i`), never hardcoded stage
  IDs, so it stays portable across locations. An explicitly `lost`/`abandoned` opp is
  never a win regardless of stage.
  - **DRT is exactly that case, in different words: its winning stage is "08. Venta", not
    "Ganado".** Measured 2026-08-24 across the six pipelines: **74 opportunities sit in
    "08. Venta" but only 47 carry `status: "won"`**. That is why `\bventas?\b` is in the
    pattern — without it the panel would report 47 sales instead of 74, the exact silent
    undercount this module exists to prevent. The word boundary keeps it off "Ventana".
- **`source-platform.ts`**: buckets into Instagram / Facebook / TikTok / Google / Otro by
  loose substring match, because field *names* differ per sub-account ("Origen de Lead"
  vs "Origen del Lead", "Tipo de pauta" vs "Tipo de anuncio"). **WhatsApp is deliberately
  absent** — it's a contact channel, not a lead origin, so a bare "whatsapp" stays in
  "Otro". `components/dashboard/origen-de-lead-criteria.tsx` is the UI that explains these
  rules to the user; keep the two in sync.
- **`csv.ts`**: shared by the assistant's `export_csv` tool and the drill drawer's
  "Exportar" button (`lib/drill-export.ts`), so both files escape identically.
  `lib/download.ts` triggers the actual browser download for both.

#### Pauta (paid-advertising) classification

`lib/pauta.ts` is the **single source of truth** for what counts as "de pauta", shared by
the marketing charts and the AI tools. Do not re-inline this logic anywhere.

- `isDePauta(opp, pautaContacts)` — a deliberate **union**: the contact is linked to a
  Pauta custom-object record **OR** the opportunity itself carries a paid-traffic
  source/medium (`isPaidTraffic`). Neither signal alone is complete — Pauta records come
  from a Make scenario and don't always exist, and not every paid lead keeps its UTM — so
  each covers the other's gaps.
- `resolveCampaignName()` — an ordered fallback chain, since sub-accounts name the field
  differently ("Nombre pauta", "Nombre de la pauta", …) and some accounts have no
  attribution URL at all.
- Totals legitimately differ between grouping modes; that's by design, not a bug.

### PDF report export

Both dashboards export a branded PDF via `components/dashboard/export-report-button.tsx`;
the same `create_pdf` spec/renderer backs the AI assistant's PDF tool, so changing
`lib/pdf/*` affects both. **Brand rule**: `sanitizeBrand()` strips "GoHighLevel"/"GHL"
from all rendered text — the platform is presented as "Lezgo Suite CRM", and the AI
prompts carry the same rule. Everything else — `lib/report.ts`, the `analyze-report`
Haiku pass and its token budget, the pdfmake renderers — is in the **`pdf-report`
skill**.

### Key design decisions

- **No mock-data fallback**: when the GHL API is unavailable or errors, the UI renders against empty arrays (`data?.contacts ?? []` patterns in `app/page.tsx`). The former `lib/mock-data.ts` and its stand-ins have been removed.
- **All GHL API calls are server-only**: `lib/ghl-client.ts` is never imported from client components — only from API routes. This keeps the token out of the browser bundle. Client code reaches GHL data through `lib/ghl-fetchers.ts`, which calls those routes.
- **`/opportunities/search` uses `location_id` (snake_case)** while most other endpoints use `locationId` (camelCase). The `useSnakeCaseLocationId` flag in `ghlFetch` handles this quirk.
- **Filtering is entirely client-side**: `lib/date-range.ts` (`DateFilter`, `resolveDateRange`, `filterByDateRange`) filters the already-fetched dataset by date; `components/dashboard/date-range-filter.tsx` is the UI *and* the bar that hosts every other panel-wide filter. The filtered slices are computed in `app/page.tsx` and passed to each dashboard as props. The filter bar is hidden on the AI assistant tab, which always sees the full dataset.
- **The panel-wide filters compose in a fixed order** — they live in `app/page.tsx` and are
  applied to the opportunity set **before** the date cut, so the date-filtered slices and
  the unfiltered `all*` lookup sets agree. A drill-down must never surface a record the
  charts excluded:
  `data.opportunities` → `applyPanelFilters` → `scopedOpportunities`
  → `filterByDateRange` → `opportunities`.
  **`lib/panel-filters.ts`** owns four menus: **Desarrollo**, **Asesor**, **Origen de lead**
  y **Canal de contacto** (`multi-select-filter.tsx`, one generic component mounted four
  times). Notes worth keeping:
  - **Empty selection = no filter.** Do not "fix" this into an all-selected neutral state:
    with that convention a development newly added in the CRM would silently sit outside a
    filter the user believes is off.
  - `desarrolloOf()` reads the **pipeline name**, not a custom field — the desarrollo IS the
    embudo — which is what lets **one global menu** serve a bar that lives above the tabs.
    Options are derived from the loaded dataset, plus a `Sin desarrollo` bucket so records
    in an unresolved pipeline stay reachable. With no pipeline list everything lands in
    that bucket; that degraded mode is deliberate, since inventing a desarrollo is worse.
  - **The advisor list is derived from the DATA, never hardcoded.** `collectAdvisors()`
    reads the distinct `assignedTo` values and orders them **by volume descending** — with
    ~24 advisors, alphabetical buries the people who actually sell. A hand-written list
    (which is what the VAEO fork had) goes stale in silence the first time someone joins.
  - **The advisor key is the FULL normalized name, not the first name.** This account has an
    *Adriana López* and an *Adriana Ortega*, a *Mónica Gomez* and a *Mónica Leal*: matching
    on the first name would merge two people into one row and misattribute their pipelines
    with nothing looking broken. The accepted cost is symmetric — a surname corrected in GHL
    shows up as a new advisor until the next sync — but that failure is **visible** (a row
    splits in two), which is the right side to err on. `scripts/verify-panel-filters.ts`
    asserts both collisions; don't "simplify" it back to first names.
  - A `Sin asesor` bucket is selectable, and it matters: **~17% of opportunities are
    orphaned**, and a filter that couldn't reach them would hide the biggest leak.
  - **Los menús de origen y canal listan cada grafía capturada por separado**, sin agrupar:
    `Walk In` / `WALK IN` / `walk-in` son tres filas, ordenadas de modo que queden
    consecutivas y con un ⚠ que las señala. Los charts las SIGUEN agrupando. La asimetría
    es el punto: una grafía repetida es un error de captura que el cliente tiene que
    corregir en GHL, y agrupar lo esconde. Por eso `lib/category-filter.ts` y
    `lib/opportunity-breakdown.ts` normalizan distinto — **no "arregles" esa duplicación
    fusionando los módulos**; `category-filter` solo le pide prestado
    `normalizeCategoryKey` para ordenar, nunca para unir dos opciones.
  - Sus opciones se acotan al pipeline de la pestaña activa y al rango de fechas; las de
    desarrollo y asesor no. Divergencia conocida, documentada en el spec del filtro.
  - They filter **opportunities only** — contacts carry no desarrollo of their own.
  - The AI assistant is exempt, same as the date filter.
- **`calls` is always empty** in live data — GHL doesn't expose a public calls endpoint in the standard API. **`tasks` is populated** via the location-wide `/locations/:id/tasks/search` endpoint (`searchLocationTasks`), fetched concurrently with the other datasets.
- **Drill-downs resolve joins against the *unfiltered* set.** Dashboards take both
  `opportunities` (date-filtered, for display) and `allOpportunities` (everything, as a
  lookup table) — likewise `allContacts` / `allPautas` / `allAppointments`. An opportunity
  can be created outside the window that puts its contact on screen, so joining against the
  filtered slice silently drops real rows. Keep that pairing when adding a drawer.

### Internal type system

`lib/types.ts` defines the canonical internal types; the API route transforms raw GHL shapes into these before returning JSON. Always work against the internal types in components — **never import from `lib/ghl-client.ts` on the client side.**

## GHL API Gotchas

The REST API has enough sharp edges (customFields differing between read and write, DATE
fields arriving as epoch-ms at UTC midnight, snake_case on `/opportunities/search`, tag
writes overwriting the whole list) that they live in the **`ghl-api` skill**. Load it
before touching `lib/ghl-client.ts`, `app/api/dashboard/route.ts`, `lib/ghl-fetchers.ts`,
or any code that reads or writes GHL data.

## GHL MCP Server

An HTTP MCP server (`ghl-mcp`, configured in `.mcp.json`) connects directly to GoHighLevel's hosted MCP endpoint (`https://services.leadconnectorhq.com/mcp/`). It authenticates with the same `GHL_API_TOKEN` and `GHL_LOCATION_ID` env vars used by `lib/ghl-client.ts`.

- **Purpose**: lets Claude Code query/mutate live GHL data directly during development (inspecting real contacts, opportunities, pipelines, custom fields, conversations) without writing throwaway scripts. It is **not** part of the app's runtime data flow — the app always goes through `app/api/dashboard/route.ts` → `lib/ghl-client.ts`. Never wire MCP calls into application code.
- **Use it to**: verify real data shapes, discover pipeline/custom-field IDs, confirm API behavior, and validate transforms against production data before coding them in `route.ts`.
- **Caution**: its tools are prefixed `mcp__ghl-mcp__`, and the write ones (create/update/upsert/send/post) mutate live production data. Default to read-only tools; only use write tools when explicitly asked.

### UI components

- `components/ui/` — shadcn/ui components (generated, **do not hand-edit**)
- Shared chart chrome lives in `dashboard-ui.tsx`: `ChartCardHeader`, `ScopePill` (scope
  label + tooltip explaining a chart's rule), and `CardTone` (won/lost card tints — the
  light/dark pairs are tuned by eye, not numerically matched; don't "normalize" them)
- **Toda cubeta centinela va en el rojizo de `MISSING_TEXT`** (`dashboard-ui.tsx`, token
  `--missing`): "Sin fecha", "Sin desarrollo", "Sin servicio", "Sin dato", "Sin asesor",
  "Sin motivo", y el "Sin datos de contacto" del drawer. No son una categoría del negocio
  sino un hueco de captura en GHL, y el gris de antes las hacía leer como una fila más.
  Tres reglas: (1) tiñe **solo la etiqueta** — la barra, el sombreado y el segmento
  apilado siguen en gris, porque ahí el color codifica datos y el rojo rompería la
  validación de `SERIES_NEUTRALS`; (2) en un eje de Recharts se usa `MissingAwareTick`,
  que detecta la cubeta por texto (`isMissingLabel`) porque el tick llega sin la bandera
  que sí traen las filas de las tablas; (3) un **estado vacío** ("Sin oportunidades en el
  periodo") NO lo usa — es un resultado legítimamente vacío, no un dato faltante.

**Chart conventions** — apply to every new chart:
- Use `NonZeroTooltipContent` so empty series don't render noise, and wire a drill-down
  drawer (`chart-drill-drawer.tsx`) — every chart should be clickable through to its records
- Series apiladas: usa `SERIES_PALETTE` / `SERIES_NEUTRALS` (`dashboard-ui.tsx`), no
  `CHART_PALETTE` — esta última no pasa la validación de contraste/CVD en un stack. Cinco
  tonos es el límite; una dimensión con más valores pliega su cola en "Otros"
  (`lib/sales-series.ts`). El color se asigna sobre el set SIN filtrar, para que mover el
  filtro de fechas no repinte las series.
- Una leyenda propia (fuera del `ChartContainer`) **no ve** las variables `--color-<slot>`
  que emite `ChartStyle`: van bajo el selector `[data-chart=chart-<id>]`. Pásale un `id`
  al `ChartContainer` y marca el bloque de chips con el mismo `data-chart` —
  `sales-by-dimension-chart.tsx` es el ejemplo. (La vieja regla "ningún encoding que
  requiera leyenda" se eliminó: una barra apilada la requiere por definición, y estos
  charts calcan un reporte que el cliente ya usa.)
- Never nest a scroll container inside a card. For narrow scrollable panels use a plain
  `overflow-y-auto` div — Radix `ScrollArea` breaks `truncate`
