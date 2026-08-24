# Matriz de "Motivo de perdido" × Canal de Contacto / Origen de Lead

Fecha: 2026-08-05
Estado: diseño aprobado para implementar (el cliente pidió decidir sin preguntar)

## El problema

Los dos paneles ya muestran **cuántas** oportunidades se pierden (gráfico de estado por
mes) y **de dónde vienen** (rankings de Origen de Lead / Canal de Contacto), pero no
cruzan las dos cosas. La pregunta que falta contestar es: *¿por qué se pierde cada
fuente?* Un lead de Meta que llega por DM no se pierde por lo mismo que uno que llenó un
formulario del sitio web, y hoy el panel no permite verlo.

## Los datos reales (medidos contra la sub-cuenta, 2026-08-05)

Reconocimiento hecho contra `uDQiMzx1Iclb6gbJNRDY` sobre las 2 000 oportunidades con
`status=lost`:

| | VAEO | MESH |
|---|---|---|
| Perdidas | 1 898 | 102 |
| Motivos distintos | 29 (de un catálogo de 37) | 11 |
| Canales distintos presentes | 5 + vacío | 5 + vacío |
| Orígenes distintos presentes | 5 + vacío | 5 + vacío |

Tres hechos determinan el diseño:

1. **El motivo es el campo nativo `lostReason`**, ya resuelto en
   `app/api/dashboard/route.ts` (`lostReasonId` → catálogo de la sub-cuenta, con caída a
   un custom field "Motivo de Perdido" que aquí no se usa). No hace falta tocar el
   backend.
2. **Las columnas son pocas.** Aunque los picklists tienen 14 opciones cada uno, en las
   oportunidades perdidas solo aparecen ~5 valores por dimensión (Canal: DM, WhatsApp,
   Formulario, Llamada, Página WEB; Origen: Meta, Sitio Web, No Identificado, Google ADs,
   Blog VAEO). Una tabla de ~29 × 6 cabe sin gimnasia.
3. **La distribución está brutalmente sesgada**: "No contesta" son 1 374 de 1 898 pérdidas
   en VAEO y "Spam" otras 305. La tabla tiene que dejar leer la cola larga sin que la
   aplaste la fila gigante — de ahí que el sombreado de calor use escala raíz y no lineal.

## Diseño

### Componente

`components/dashboard/lost-reason-matrix.tsx` — una tarjeta **"Motivos de perdido"**,
ancho completo, montada en **los dos paneles** con solo `panel` distinto, igual que el
resto de los gráficos. Su superficie de props es la misma que la de los demás gráficos
por oportunidad, así que entra en el objeto `shared` que ya arman `vaeo-dashboard.tsx` y
`mesh-dashboard.tsx` sin plomería nueva.

### El switch

Dos botones en un control segmentado dentro del header de la tarjeta:

```
[ Canal de Contacto ] [ Origen de Lead ]
```

Estado local (`useState`), default **Canal de Contacto** — es la dimensión más accionable
de las dos: dice por qué medio se cae la conversación. No se persiste ni se sube a
`app/page.tsx`: es una preferencia de lectura de una tarjeta, no un filtro global.

### Estructura de la tabla

- **Filas** = motivo de perdido, ordenadas por total descendente. Las oportunidades sin
  motivo capturado caen en una fila **"Sin motivo"** que va siempre al final, aunque sea
  grande — es una fuga de captura, no un motivo que compita en el ranking (misma regla
  que "Sin dato" en `buildCategoryBreakdown`).
- **Columnas** = las categorías **presentes** en el conjunto de perdidas, ordenadas por
  total descendente, con **"Sin dato"** al final; después la columna **Total** y la
  columna **%** sobre el total de perdidas.
- **Fila de totales** al pie.
- **Celda** = conteo. El cero se dibuja como `–` en gris, no como `0`, para que la cola
  larga se lea.

### De dónde salen las columnas

La matriz **no** re-implementa la normalización de categorías: llama a
`buildCategoryBreakdown(perdidas, fieldNames)` de `lib/opportunity-breakdown.ts` y usa sus
filas como columnas. Eso garantiza por construcción que la columna "WhatsApp" de esta
tabla agrupe exactamente las mismas oportunidades que la barra "WhatsApp" del gráfico de
al lado — que es la clase de divergencia que los módulos compartidos existen para matar.

### Qué cuenta como "perdida"

`statusBucket(opp) === "perdida"` de `lib/opportunity-breakdown.ts`, o sea `lost` **o**
`abandoned`, y nunca una que `isWonOpp()` considere ganada. Misma definición que la barra
roja del gráfico de estado, para que los totales de las dos tarjetas cuadren.

### Multi-valor

Tres registros traen dos categorías en la misma celda ("Meta, Sitio Web"). Esa
oportunidad cuenta en **ambas** columnas, igual que en el gráfico de barras. Consecuencia
explícita: **la suma horizontal de las celdas puede superar el Total de la fila**, porque
el Total es el conteo de oportunidades **distintas**. Es la cifra honesta y se explica en
el tooltip del `ScopePill` en vez de esconderse.

### Interacción

Cada celda con conteo > 0 es clickeable y abre el `ChartDrillDrawer` con esas
oportunidades — igual que el resto de los gráficos. Los joins se resuelven contra
`allOpportunities` / `allContacts`, no contra los slices filtrados por fecha.

El sombreado de calor es un tinte ámbar con alpha `sqrt(count / maxCelda) * 0.55`. Es
redundante con el número impreso, no un encoding que requiera leyenda.

### Módulo puro

`lib/lost-reason-matrix.ts`, sin React, con `buildLostReasonMatrix(opps, fieldNames)`.
Vive aparte de `opportunity-breakdown.ts` (que ya son 326 líneas y otro tema) y le importa
`buildCategoryBreakdown`, `statusBucket`, `categoryKey` y `NO_VALUE_LABEL`.

Se verifica con `scripts/verify-lost-matrix.ts` (`pnpm verify:lost-matrix`), en la misma
línea que los demás: un cruce mal armado da una respuesta silenciosamente equivocada, que
es exactamente lo que justifica un script de aserciones en este repo.

Casos que el script cubre:

1. Solo entran las perdidas — una ganada por etapa (`status: "open"`, etapa "Ganado") no
   aparece; una `abandoned` sí.
2. Las columnas coinciden 1:1 con `buildCategoryBreakdown` sobre el mismo conjunto.
3. Una oportunidad multi-valor suma en dos celdas pero **una sola vez** en el Total de su
   fila y en el gran total.
4. "Sin motivo" y "Sin dato" quedan al final de su eje.
5. El gran total es el número de oportunidades perdidas distintas.
6. Conjunto vacío → matriz vacía sin reventar.

### Colocación

Después de la rejilla de Origen de Lead / Canal de Contacto, a ancho completo, en los dos
paneles.

## Fuera de alcance

- Cruzar motivo × sucursal o motivo × mes. Se puede añadir después como una tercera
  opción del switch si el cliente lo pide; no lo pidió.
- Limpiar el catálogo de motivos en GHL (hay entradas basura: "Su", "fun/", "Mistery,
  Shopper"). Es trabajo del cliente en el CRM, no del panel; la tabla las muestra tal cual
  para que se vean.
- Sección nueva en el PDF exportado.
