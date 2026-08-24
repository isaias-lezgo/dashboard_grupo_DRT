# Campañas activas por pauta — diseño

Fecha: 2026-07-21
Dashboard: Marketing

## Problema

El dashboard de Marketing tiene cuatro gráficas agrupadas "por campaña"
(ganadas, citas, etapa, perdidas), pero ninguna responde la pregunta de arranque:
**qué campañas están corriendo ahora y cuánto volumen trae cada una**.

El caso de uso real: algunos clientes trabajan con dos agencias de marketing a la
vez. No existe ningún campo en GHL que diga a qué agencia pertenece una campaña —
ni en el objeto Pauta ni en la oportunidad. La única señal es **el patrón del
nombre de la campaña**: cada agencia nombra sus pautas con su propio prefijo.

De ahí sale el requisito central: la gráfica debe hacer ese patrón *visible*, para
que la persona infiera la agencia. Es lo contrario de lo que hacen las gráficas
actuales — `campaignPrefixCut()` en `marketing-dashboard.tsx` borra a propósito el
prefijo compartido para que las barras no se vean idénticas. Aquí el prefijo es
justamente lo que se quiere leer.

## Unidad de medida

El registro **`Pauta`**, no la oportunidad.

Un registro de Pauta equivale a una entrada del lead, así que los **reingresos ya
cuentan solos**: si un contacto vuelve a entrar por la misma campaña, genera un
segundo registro. No hace falta lógica adicional de reingreso.

Campos usados de `Pauta` (`lib/types.ts`):

- `nombrePauta` — el nombre de la campaña.
- `contactId` — para el conteo de leads únicos. Opcional.
- `createdAt` — ya lo aplica el filtro de fechas global, no se vuelve a usar.

## Definición de "campaña activa"

**Una campaña está activa si tiene al menos una Pauta dentro del filtro de fechas
global** que ya controla el resto del dashboard.

GHL no expone gasto ni el estado del ad set en Meta, así que no hay forma de saber
si una campaña sigue pautada. Se descartó introducir un umbral de recencia propio
(«último lead en los últimos N días»): sería un concepto nuevo que explicar, y el
filtro de fechas que ya existe responde la pregunta al seleccionar un rango
reciente.

Consecuencia: el componente recibe las pautas **ya filtradas**, igual que el resto
de los componentes de dashboard. No filtra por su cuenta.

## Detección de familias

Función pura nueva en `lib/pauta.ts`, junto a `resolveCampaignName()`, que ya es la
fuente de verdad de nombres de campaña.

Algoritmo:

1. Partir `nombrePauta` por los separadores ` - `, `|`, `_`, `/`.
2. Tomar los primeros **N** tokens como clave de familia, donde N es la profundidad
   seleccionada en la UI.
3. Agrupar las campañas por esa clave.
4. **Una familia con un solo miembro se colapsa al bucket "Sin patrón".** Sin esta
   regla, un conjunto de nombres heterogéneos produce una familia por campaña y el
   agrupamiento no aporta nada.

Casos borde:

- Nombre sin ningún separador → cae a "Sin patrón". Es honesto; es preferible a
  inventar una familia.
- Profundidad 2 cuando ningún nombre tiene 2 tokens → el resultado equivale a plano.
  No es un error.
- `nombrePauta === "Sin nombre"` (el valor que pone `app/api/dashboard/route.ts`
  cuando la propiedad viene vacía) → bucket propio, renderizado al final. No se
  mezcla con "Sin patrón", porque significan cosas distintas: uno es "no sé cómo se
  llama", el otro es "se llama algo que no encaja en ninguna familia".

## UI

Card nueva en el dashboard de Marketing, titulada **"Campañas activas por pauta"**.

**Header** (`ChartCardHeader`): resumen `N campañas · N familias · N pautas`, más dos
controles:

- **Profundidad de agrupación**: `1 · 2 · Plano`. Ajusta N en vivo. Existe porque la
  detección automática se puede equivocar (dos agencias que comparten el primer
  token, nombres sin separador). Sigue el patrón visual de `GroupByToggle`.

  **"Plano"** desactiva el *agrupamiento* pero no la *detección*: deja una sola lista
  ordenada por volumen, y cada fila conserva el color de su familia y el prefijo en
  gris. El patrón se sigue viendo, solo que sin headers ni reagrupación. En este modo
  el header omite el conteo de familias.
**No lleva toggle de "Leads únicos".** Los dos números se muestran siempre; el valor
de este chart está justo en ver la brecha entre ambos, y un toggle que esconde uno de
los dos la destruye.

**Cuerpo**: lista de filas con barra proporcional, agrupada por familia.

```
● IW - CC - FF - Corregidora        4 campañas · 127 pautas · 98 leads
     Enero 2026        ██████████████   52   41
     Febrero 2026      ████████         31   28
     Marzo 2026        ██████           25   20

● MKD                               2 campañas · 63 pautas · 55 leads
     Remarketing - Q3  ██████████       38   30
     Prospección       ██████           25   25
```

Detalles de render:

- **El encabezado carga el prefijo compartido; la fila solo lo que la distingue.**
  El encabezado no muestra la clave de agrupación ("IW") sino el **prefijo común más
  largo de sus miembros** ("IW - CC - FF - Corregidora"), y cada fila renderiza
  únicamente el resto ("Enero 2026").

  *Esta decisión reemplazó a la original,* que imprimía el nombre completo en cada
  fila con el prefijo en gris tenue. Se descartó por dos razones, en orden de
  importancia:

  1. **El gris era un código sin leyenda.** Quien construyó el dashboard sabe que el
     gris marca el prefijo compartido; un cliente que abre el reporte no, y nadie va
     a estar ahí para explicárselo. Un canal visual que necesita explicación no
     sirve en algo que ve alguien externo. Subir el prefijo al encabezado elimina el
     código: se lee como un título y su lista.
  2. Apilaba dos ejes de contraste (color *y* peso tipográfico) sobre cuarenta filas,
     lo que en modo oscuro parcheaba la lista en un zigzag gris/blanco.

  Caso borde: si el nombre de un miembro **es** exactamente el prefijo compartido, esa
  fila conserva su nombre completo en vez de renderizar vacía.
- El nombre completo siempre está disponible en el `title` (tooltip nativo) de la fila.
- Un color por familia, solo en el punto del encabezado y en la barra. Los buckets
  "Sin patrón" y "Sin nombre" usan gris neutro: un color de la paleta implicaría que
  identificamos algo.
- **Orden**: familias por volumen total desc; campañas dentro de cada familia por
  volumen desc. "Sin patrón" y "Sin nombre" siempre al final, en ese orden.
- **Barra normalizada contra la campaña más grande de todo el set**, no por familia,
  para que las barras se comparen entre familias.
- **Nada se oculta de forma permanente, y la card nunca tiene scroll propio.**
  Colapsada renderiza los primeros 18 elementos; un botón `Mostrar las N campañas`
  la expande completa. En ambos estados la card mide su altura natural.

  *Esto reemplazó al `div` con `overflow-y-auto` de la versión original.* Un
  contenedor con scroll anidado secuestra la rueda del mouse: para llegar a las
  gráficas de abajo había que recorrer primero las cuarenta campañas. La página debe
  ser la única con scroll.

  Sigue sin haber Top-N en el sentido de esconder la cola: el botón dice cuántas
  campañas hay y las revela todas de un clic.
- Si alguna vez se reintroduce un contenedor con scroll, debe ser un `div` con
  `overflow-y-auto` y **no** `ScrollArea` de Radix, que rompe el `truncate` en
  paneles angostos.

## Segundo dato: leads únicos

La barra mide **pautas** (con reingresos). Al lado se muestra el conteo de
**leads únicos** de esa campaña.

"Lead único" **reutiliza la definición que ya existe en el dashboard**: el callback
`isUniqueLead()` de `marketing-dashboard.tsx`, que marca una pauta como lead único
cuando es la **primera pauta histórica de ese contacto** (rango 0 en
`pautaReingresoMap`); las posteriores son reingresos. Esta es la definición detrás del
KPI "Leads únicos" (= pautas − reingresos).

Deliberadamente **no** se usa "contactos distintos por campaña", que era la
formulación inicial. Los dos números difieren — un contacto cuya primera pauta fue de
otra campaña contaría como distinto aquí pero no como lead único — y tener dos
definiciones de "lead único" en el mismo dashboard es una trampa. El componente recibe
`isUniqueLead` como prop en vez de reimplementarlo.

Las pautas sin `contactId` cuentan como pauta pero **no** como lead único. Hace falta
el guard explícito: `pautaReingresoMap` solo indexa pautas con contacto, así que
`isUniqueLead()` devuelve `true` por defecto para una pauta huérfana. Mismo guard que
usa el chart "Pautas por canal de contacto".

La brecha entre ambos números indica de un vistazo qué campaña está recirculando a
la misma gente en vez de traer gente nueva.

## Drill-down

Regla del proyecto: gráfica nueva → drawer.

- Clic en una **fila de campaña** → `ChartDrillDrawer` con las pautas de esa campaña.
- Clic en el **header de familia** → drawer con todas las pautas de la familia.

**No se reutiliza `openPautaDrill`.** Ese callback se bifurca según el estado global
`pautaUniqueLeads` (el toggle del chart de canales): con el toggle encendido resuelve a
contactos, no a pautas. Como este chart siempre mide registros, el drawer mostraría un
conteo distinto al de la barra dependiendo de un toggle de *otra* gráfica.

En su lugar, `marketing-dashboard.tsx` expone un callback nuevo,
`openPautaRecordsDrill`, que siempre abre en modo registros. Ya existe precedente:
`openSinContactoDrill` hace exactamente eso, y por la misma razón. El componente lo
recibe como prop en vez de manejar su propio estado de drawer.

## Ubicación del código

- `lib/pauta.ts` — la detección de familias (función pura). Va aquí porque el archivo
  ya es el dueño de la resolución de nombres de campaña y solo tiene ~128 líneas.
- `components/dashboard/campaign-activity-chart.tsx` — **archivo nuevo**.
  `marketing-dashboard.tsx` ya tiene 2 304 líneas; agregar otra gráfica inline lo
  empeora. El componente recibe `pautas` (ya filtradas), `contacts` y el callback de
  drill como props, igual que el resto de los componentes de dashboard.

## Estados vacíos

- Sin pautas en el rango → `ChartEmpty` con "Sin pautas en el periodo seleccionado."
- Con pautas pero todas "Sin nombre" → la lista se renderiza con el bucket
  "Sin nombre" solamente. No es un estado de error.

## Fuera de alcance

- **Reporte PDF** (`lib/report.ts`, `lib/pdf/charts.ts`). La gráfica no entra al
  reporte en este cambio. Primero se valida en el dashboard; agregarla al PDF en el
  mismo paso duplica la superficie de cambio y el riesgo de romper el reporte. Se
  puede agregar después como cambio propio.
- Cualquier mapeo de agencia configurado por cliente. La inferencia la hace la
  persona a partir del patrón visible.
- Datos de gasto o estado de campaña de Meta. No están disponibles vía GHL.

## Verificación

- `npx tsc --noEmit` — obligatorio: `next build` ignora errores de TypeScript
  (ver `next.config.mjs`), así que un build verde no prueba nada.
- Levantar la app contra un sub-account real que tenga dos patrones de nombre
  distintos, y confirmar: las familias se detectan, el control de profundidad
  reagrupa en vivo, y el drill abre con las pautas correctas.

**No se agrega script `verify:*`.** Esos están reservados para los tres módulos puros
donde un bug silencioso sería una fuga de datos entre clientes (`lib/clients.ts`,
`lib/auth.ts`, `lib/ghl-limiter.ts`). Esto es lógica de presentación.
