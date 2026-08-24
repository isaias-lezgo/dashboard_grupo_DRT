# Oportunidades por estado, origen y canal — diseño

Fecha: 2026-08-04
Estado: aprobado

Cuatro gráficos nuevos, idénticos en ambos paneles (VAEO y MESH), portados de un
reporte de Looker Studio que el cliente ya usa:

1. **Oportunidades por estado** — barras apiladas por mes de creación, segmentadas
   en ganada / abierta / perdida.
2. **Oportunidades creadas y % ganadas** — combinado: barras de creadas por mes y
   una línea con el porcentaje de esa cohorte que terminó ganada.
3. **Oportunidades por Origen de Lead** — ranking de categorías.
4. **Oportunidades por Canal de Contacto** — el mismo componente, otro campo.

## Lo que dijeron los datos

Sondeo directo contra GHL (`scripts` desechable, 6,000 opps del embudo VAEO +
674 del MESH, 2026-08-04):

| Campo | Tipo GHL | VAEO con valor | MESH con valor |
|---|---|---|---|
| `Origen de Lead` | TEXT | 5962 / 6000 | 666 / 674 |
| `Origen del lead` | SINGLE_OPTIONS | 439 / 6000 | 20 / 674 |
| `Canal de Contacto` | TEXT | 5897 / 6000 | 554 / 674 |
| `Canal del contacto` | SINGLE_OPTIONS | 434 / 6000 | 19 / 674 |

**Hay dos campos personalizados por concepto**, uno de texto libre y un gemelo de
picklist creado después (2026-04-27). El poblado es el de texto; el picklist lo
llena menos del 8% de los registros. El gráfico "Oportunidades por Canal de
Contacto" del reporte de Looker sale **vacío** porque apunta al gemelo picklist —
el dato sí existe, solo está en el otro campo. Los gráficos nuevos leen el campo
de texto y caen al picklist únicamente cuando el texto está vacío, lo que
recupera ~40 registros más por panel.

El costo de que sea texto libre es que las grafías divergen:

- Origen: `Activo Seo` (146) vs `Activo SEO` (2); `Walk In` (13) vs `Walk-in` (6);
  `Inmobiliario` (6) vs `Inmobiliaria` (1); `Cliente Existente` vs
  `Cliente existente`; `Correo InfoVaeo` vs el valor oficial `Correo Info VAEO`.
- Canal: `WHATSAPP` (1722) vs `WhatsApp` (61); `MANUAL` (21) vs `Manual` (5);
  `Visita` (10), que ni siquiera está en el picklist oficial.
- Tres registros traen **dos valores en una celda**: `"Meta, Sitio Web"`,
  `"Google ADs, Meta"`.

## Decisiones

**El eje de tiempo es `createdAt` nativo, no el campo `Fecha de Creación`.**
Looker usa el campo personalizado, que conserva la fecha original de los deals
migrados de HubSpot (de ahí las barras de mar 2025 en su captura). Se eligió el
nativo porque es el mismo que ya filtra el panel entero
(`app/page.tsx` → `filterByDateRange(..., o => o.createdAt, ...)`), de modo que el
gráfico concuerda con el resto de la pantalla. El apilamiento artificial en
mar 2026 que esto provoca —el día de la migración— ya lo resuelve el toggle
**Importación HubSpot**, que está apagado por defecto y se aplica aguas arriba,
tanto a `opportunities` como a `allOpportunities`.

**"Ganada" se define con `isWonOpp()`, no con `status === "won"`.** Looker grafica
el `status` crudo. Aquí no: `lib/opportunity-status.ts` es la fuente única del
repo y ya rige la tabla "Resumen general de ventas". Si este gráfico contara
distinto, dos tarjetas del mismo panel reportarían ventas diferentes — que es
exactamente la clase de bug que ese módulo existe para matar.

Las cubetas son tres, no cuatro:

| Cubeta | Regla |
|---|---|
| Ganada | `isWonOpp(o)` |
| Perdida | `status` ∈ {`lost`, `abandoned`} y no ganó |
| Abierta | el resto |

`abandoned` se pliega en Perdida en vez de tener su propia serie: son 0 registros
hoy en ambos embudos, y una cuarta serie en un apilado de 8 meses cuesta más
legibilidad de la que aporta.

**Ranking horizontal, no dona.** La dona de Looker tiene 14 rebanadas y las
últimas 8 valen menos de 1% cada una. Barras horizontales ordenadas de mayor a
menor caben legibles las 14, se comparan mejor que ángulos y no necesitan leyenda
— la regla del repo para gráficos nuevos.

## Arquitectura

### `lib/opportunity-breakdown.ts` (módulo puro, nuevo)

React-free, como `sales-pivot.ts`, para que un script lo pueda aseverar.

```ts
statusBucket(opp): "ganada" | "abierta" | "perdida"
buildStatusByMonth(opps): StatusMonthRow[]
buildCategoryBreakdown(opps, fieldNames): CategoryRow[]
```

`StatusMonthRow` = `{ key, label, ganada, abierta, perdida, total, ids: Record<bucket, string[]> }`.
Los meses sin datos **entre** el primero y el último se rellenan en cero, para que
el eje no insinúe continuidad donde no la hay. Las opps sin `createdAt` legible
caen en una fila `Sin fecha` al final, nunca se descartan.

`CategoryRow` = `{ label, count, pct, oppIds }`, ordenado descendente.

**Normalización sin lista blanca.** Se agrupa por una *clave* derivada
(minúsculas, sin acentos, no-alfanuméricos colapsados a un espacio), así que
`Walk In`/`Walk-in`, `Activo Seo`/`Activo SEO` y `WHATSAPP`/`WhatsApp` colapsan
solas sin enumerar variantes. La *etiqueta* visible sale de un mapa chico con los
valores oficiales del picklist de GHL; una clave que no esté en el mapa muestra la
grafía más frecuente entre sus registros. Consecuencia deliberada: un valor nuevo
que el equipo capture mañana aparece solo en el gráfico, nunca se cae.

Solo dos alias explícitos, porque son palabras distintas y la clave no las une:
`inmobiliaria → Inmobiliario`, `correo infovaeo → Correo Info VAEO`.

**Celdas multivalor**: se parten por coma y la oportunidad cuenta en **cada**
categoría que nombra — genuinamente tiene los dos orígenes. Los porcentajes suman
100.05% con los 3 registros de hoy; se documenta en el tooltip del gráfico en vez
de esconderlo bajo una regla de "primer valor gana" que perdería información real.

**Vacío** → categoría `Sin dato`, nunca se descarta: son leads sin atribución, que
es justo la fuga que vale la pena ver.

### `components/dashboard/opportunity-status-chart.tsx`

`BarChart` apilado de Recharts. X = mes (`mmm yyyy`, es-MX), Y = oportunidades.
Verde `#10b981` ganadas, navy `#335577` abiertas, rojo `#ef4444` perdidas, con
leyenda compacta. `NonZeroTooltipContent` para que un mes sin ganadas no muestre
"Ganadas: 0". Clic en un segmento → `ChartDrillDrawer` con esas oportunidades,
resueltas contra `allOpportunities`. `ScopePill` con la regla completa.

### `components/dashboard/opportunity-win-rate-chart.tsx`

`ComposedChart` de Recharts: barras de oportunidades creadas por mes (eje
izquierdo) más una línea con el % ganado de esa misma cohorte (eje derecho).
Consume **las mismas filas de `buildStatusByMonth()`** que el gráfico anterior,
a propósito: si cada uno contara sus propios meses, algún día dirían cosas
distintas del mismo mes.

El eje del porcentaje se deja **automático, no fijo a 100%**. La tasa de cierre
real ronda 2–6%, y con el eje clavado en 100 la línea queda pegada al suelo y la
tendencia —que es lo único que este gráfico aporta sobre el anterior— se vuelve
ilegible. El costo es que la altura de la línea no es comparable entre paneles
con escalas distintas; el `ScopePill` lo dice.

El drill entra por la barra y trae la cohorte completa del mes, no solo las
ganadas: el punto es qué proporción de ese grupo cerró, y el drawer ya distingue
el estatus de cada renglón. Los puntos de la línea no son clickeables — la API de
`activeDot` de Recharts no expone el `payload` en su handler con tipos sanos, y
no vale un cast para duplicar un drill que la barra ya ofrece.

`ScopePill` advierte lo que Looker no: **los meses recientes todavía tienen
oportunidades abiertas**, así que su porcentaje solo puede subir y aún no es
comparable con el de un mes cerrado.

### `components/dashboard/category-breakdown-chart.tsx`

Un componente reutilizable, montado dos veces (Origen y Canal). Barras
horizontales ordenadas con conteo y % a la derecha. Clic en una barra → el mismo
drawer. Los dos se rinden lado a lado en `grid md:grid-cols-2`.

### Montaje

Los cuatro van en **ambos** paneles con el mismo código, cambiando solo el prop
`panel`; el alcance de embudo lo aplica `scopeOpportunities()`. `mesh-dashboard.tsx`
deja de ser `PanelPlaceholder`. Orden: barras por estado → creadas y % ganadas →
la pareja origen/canal, con la tabla de ventas arriba de todo en VAEO.

La tabla "Resumen general de ventas" **sigue siendo solo de VAEO**: nadie pidió
montarla en MESH y es una decisión aparte, así que MESH arranca directo con los
cuatro gráficos nuevos.

Los gráficos leen el prop `opportunities` (ya filtrado por fecha y por el toggle
de HubSpot) y resuelven los joins del drawer contra `allOpportunities`.

## Verificación

`scripts/verify-breakdown.ts`, expuesto como `pnpm verify:breakdown`. Asevera:

- las tres cubetas, incluida la opp en etapa "Ganado" con `status: "open"` y la
  marcada `lost` que vive en una etapa cuyo nombre dice "Ganado";
- que `Walk-in` y `Walk In` colapsen en una fila, con la etiqueta oficial;
- el alias `Inmobiliaria → Inmobiliario`;
- la celda multivalor contando en ambas categorías;
- el fallback al campo picklist solo cuando el de texto está vacío;
- el relleno de meses intermedios en cero y la fila `Sin fecha`;
- que una grafía desconocida sobreviva con su variante más frecuente.

`npx tsc --noEmit` como puerta final: `next build` ignora errores de TypeScript.

## Fuera de alcance

- No se toca el reporte PDF (`lib/report.ts`); si estos gráficos deben ir al PDF,
  es un cambio aparte y hay que revisar el presupuesto de tokens de
  `analyze-report`.
- No se limpian los datos en GHL. La normalización es de lectura; los valores
  divergentes siguen ahí. Vale la pena decirle al cliente que consolide los cuatro
  campos personalizados en dos, pero eso es trabajo de CRM, no de panel.
