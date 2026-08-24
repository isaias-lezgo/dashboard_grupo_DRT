# Ciclo de Decisión — tabla de días Lead→Apartado (dashboard de ventas)

**Fecha:** 2026-07-22
**Ámbito:** dashboard de ventas (`components/dashboard/sales-dashboard.tsx`) + reporte PDF de ventas.

## Objetivo

Agregar una tarjeta "Ciclo de Decisión" al dashboard de ventas que liste cada
**oportunidad ganada** con su línea de tiempo (cuándo llegó, cuándo visitó, cuándo
apartó) y cuántos días tardó desde que entró hasta que se apartó, más tres tarjetas
resumen (promedio general, más rápido, más largo). La misma tabla se replica como una
sección del reporte PDF exportable de ventas.

Reproduce el "Análisis de Ciclo de Decisión" del reporte de cierre, adaptado para que
funcione en todas las sub-cuentas (sin la columna "Unidad", que es un campo
personalizado inmobiliario no siempre presente).

## Fuente de cada columna

Se opera sobre el set de oportunidades **ya filtrado por fecha** que recibe el dashboard
(`opportunities`), igual que las demás gráficas. Se consideran solo las ganadas
(`isWonOpp(o)`, que incluye wins por estatus y por etapa "Negocio Ganado").

| Columna | Fuente |
|---|---|
| **Cliente** | Nombre del contacto, resuelto contra `lookupContacts` por `o.contactId`; fallback `o.contact?.name` → `o.name`. |
| **Asesor** | `o.assignedTo` (o `"Sin asesor"`). |
| **Llegó** | `o.createdAt` (creación de la oportunidad). |
| **Visitó** | `startTime` de la **primera cita** del contacto (cualquier estatus), buscada en `lookupAppointments` por `contactId`; `"—"` si no tiene ninguna. |
| **Apartó** | `o.closedAt`; fallback `o.updatedAt` si `closedAt` viene vacío (para no perder los wins por etapa que no traen `closedAt`). |
| **Días Lead→Apartado** | `round((Apartó − Llegó) / 86 400 000)`, con mínimo 0. |
| **Origen** | `platformLabel(o)` — la misma normalización que usa la gráfica "Origen de oportunidades". No los nombres granulares de formulario del ejemplo (no existen en todas las cuentas). |

### Exclusiones y orden

- Se excluye una oportunidad ganada de la tabla solo si **no se puede resolver una fecha
  "Apartó"** (ni `closedAt` ni `updatedAt`) o si "Apartó" resulta anterior a "Llegó"
  (dato inconsistente). Estas se cuentan como excluidas pero no rompen las estadísticas.
- Orden **ascendente por días** (el más rápido arriba), como en el ejemplo.

### Tarjetas resumen

Calculadas sobre las filas mostradas:
- **Promedio general** — media aritmética de los días (entero redondeado).
- **Más rápido** — fila con menos días, con el nombre del cliente.
- **Más largo** — fila con más días, con el nombre del cliente.

## Diseño visual

- Tarjeta bajo un `SectionHeader` nuevo **"Ciclo de Decisión"**, colocada después de la
  tabla "Volumen y conversión por mes" y antes de la sección "Origen de Oportunidades".
- Tres tarjetas resumen arriba (grid responsivo), luego la tabla.
- Acento **ámbar** (`BRAND_AMBER`) en el encabezado de la columna "Días" y en la tarjeta
  "Promedio general"; **verde** en "Más rápido", **navy** (`STRUCTURAL_NAVY`) en "Más
  largo" — coherente con la paleta del dashboard. La codificación por color es
  auto-evidente (rápido = bueno) y no requiere leyenda.
- Panel scrolleable con un `div` `overflow-y-auto` (no se anida `ScrollArea` ni scroll
  dentro de la card, según las convenciones del repo). Altura máxima acotada; encabezado
  de tabla `sticky`.
- Fechas formateadas en español corto (`"6 jun"`), vía `toLocaleDateString("es-MX", { day: "numeric", month: "short" })`.
- Estado vacío: `ChartEmpty` con "Sin oportunidades ganadas en el periodo".

## Interacción

- Cada **fila** es clickeable → abre el drawer de esa oportunidad
  (`openDrill(nombreCliente, [opp])`).
- Tarjeta **"Más rápido" / "Más largo"** → abre su oportunidad en el drawer.
- Tarjeta **"Promedio general"** → abre todas las oportunidades del ciclo en el drawer.

## Estructura de código

`sales-dashboard.tsx` ya tiene ~1535 líneas; no conviene engordarlo. Se crea un
componente propio:

**`components/dashboard/decision-cycle-table.tsx`**
- Props: `opportunities: Opportunity[]` (ya filtradas), `contacts: Contact[]` (lookup,
  = `lookupContacts`), `appointments: Appointment[]` (lookup, = `lookupAppointments`),
  `onOpenOpps: (title: string, opps: Opportunity[], subtitle?: string) => void`.
- Computa las filas y las estadísticas en un `useMemo` interno (reutilizable por el
  dashboard para el PDF, ver abajo — se exporta un helper puro `buildDecisionCycle(...)`
  que devuelve `{ rows, stats, excludedCount }` para no duplicar la lógica).
- `sales-dashboard.tsx` renderiza `<DecisionCycleTable ... onOpenOpps={openDrill} />` y
  usa `buildDecisionCycle` en `buildReport`.

Helper puro exportado:
```ts
export interface DecisionCycleRow {
  opp: Opportunity
  cliente: string
  asesor: string
  llego: string        // ISO
  visito: string | null // ISO or null
  aparto: string       // ISO
  dias: number
  origen: string
}
export interface DecisionCycleStats {
  promedio: number
  fastest: DecisionCycleRow | null
  longest: DecisionCycleRow | null
}
export function buildDecisionCycle(
  opportunities: Opportunity[],
  contacts: Contact[],
  appointments: Appointment[],
): { rows: DecisionCycleRow[]; stats: DecisionCycleStats; excludedCount: number }
```

## Reporte PDF (ventas)

Se agrega una sección espejo en `buildReport` de `sales-dashboard.tsx`, construida desde
`buildDecisionCycle` (los mismos datos que la pantalla):

- `id: "ciclo"`, `title: "Ciclo de decisión (oportunidades ganadas)"`.
- `explanation`: describe qué mide (días desde que la oportunidad se creó hasta que se
  apartó/ganó) y menciona promedio, más rápido y más largo.
- Un bloque `table` con encabezados `["Cliente", "Asesor", "Llegó", "Visitó", "Apartó", "Días", "Origen"]`.
- Se limita a **25 filas** en el PDF, conservando el mismo orden (ascendente por días);
  si hay más de 25 ganadas, se muestran las primeras 25 y se indica el truncamiento en el
  `explanation` (p. ej. "Se listan las 25 de cierre más rápido de N ganadas.").
- `max_tokens` del análisis es fijo (8000) y ventas pasa de ~8 a ~9 secciones: cabe sin
  cambios en `app/api/analyze-report/route.ts`. No se toca esa ruta.

## Fuera de alcance

- Columna "Unidad" (campo personalizado inmobiliario).
- Nombres granulares de formulario en "Origen" (se usa la plataforma normalizada).
- Cualquier cambio al modelo de datos, a la sincronización GHL o a `analyze-report`.

## Verificación

No hay framework de tests. Se verifica:
- `npx tsc --noEmit` en verde.
- Levantar la app real (`pnpm dev`), tab de Ventas: la tarjeta aparece, las fechas y los
  días cuadran contra un par de oportunidades ganadas conocidas, el orden es ascendente,
  las tarjetas resumen coinciden, el clic en fila/tarjeta abre el drawer correcto.
- Exportar el PDF de ventas y confirmar que la sección "Ciclo de decisión" se renderiza
  con su tabla y su análisis.
