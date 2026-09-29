# Meta Ads ②: "Inversión y rendimiento de pauta" — la tarjeta, la cadena de vínculos y el sync que la sostiene

Fecha: 2026-09-28
Estado: diseño aprobado en conversación; pendiente de revisión del documento.
Antecedente: `2026-09-13-meta-ads-conexion-y-sync-design.md` (entrega ①). Este
documento cubre la entrega ② y absorbe lo que la ③ (pestaña PAUTA) pedía en tabla
por campaña: con una tarjeta por pestaña que ya cruza campaña → anuncio, la pestaña
aparte deja de justificarse. Si el cliente la pide, se monta la misma tarjeta.

## El problema

El panel ya trae el gasto de Meta (entrega ①) pero **no lo muestra en ningún lado**,
y "Rendimiento por pauta" agrupa por el nombre del objeto Pauta del CRM, que es el
nombre del *anuncio* copiado por Make, no la campaña a la que la agencia le pone
presupuesto. El cliente quiere ver, por pestaña, lo que ve en el Administrador de
anuncios más lo que solo el CRM sabe: gasto · impresiones · clics · CPM · CTR ·
leads que Meta reportó · leads que llegaron · citas · visitas · ventas · costo por
lead y por venta, **con los nombres de campaña de Meta**, desplegable a anuncio.

## Reconocimiento (medido 2026-09-28 contra producción y Graph)

**La conexión está bien, el sync no.** Token de usuario del sistema, seis cuentas
publicitarias seleccionadas — **una por desarrollo**, todas MXN, todas
`America/Mexico_City`:

| Cuenta | Business de Meta | Sync 2026-09-28 |
|---|---|---|
| Cañadas by El Mirador `act_520082890601955` | Grupo DRT | `code_2500` |
| La Sierra Residencial `act_518074554274771` | Grupo DRT | `code_2500` |
| Saggita Residencial `act_4061902840759597` | Grupo DRT | `code_2500` |
| Átria `act_1680389306087860` | Grupo DRT | `code_2500` |
| Palmyra Residencial `act_1769272331125700` | Lead por Lead | ok |
| Zanda `act_253244402261648` | MadFox | ok |

- **Causa del `2500`**: `paging.next` de Graph vuelve bajo **otra versión**
  (`/v26.0/` cuando se pidió `v23.0`); `graphGetAll` solo quitaba la propia y la
  segunda página iba a `v23.0//v26.0/act_…/insights` → "Unknown path components".
  Solo paginan las cuentas con más de 500 filas de insights en un mes, por eso
  fallaban exactamente las cuatro grandes. **Corregido** (`nextPageRequest` en
  `lib/meta-normalize.ts`, asertado en `verify:meta`); los códigos transitorios 1 y
  2 entraron a los reintentos (Átria cayó con un 2 en la primera corrida buena).
- Con cinco cuentas: **366 campañas · 1,869 anuncios · 14,418 filas diarias ·
  $1.39M** desde 2025-12. El fetch tardó **362 s**, arriba del techo de 300 s del
  refresco en segundo plano: sin arreglarlo, el "Actualizado hace X" se congelaría
  en silencio (CLAUDE.md, "Caché de sincronización").
- La caché en Neon pasó a 6.65 MB gzip; producción la sirve en 5.7 s. Bien.
- **La subcuenta se creó el 2025-10-15** (`dateAdded` de `/locations`). Zanda trae
  campañas de 2020-2021 ("Leads_Enero", "Publicación: …") sin gasto en ventana que
  solo ensucian la lista.

**Cobertura de cada llave del CRM** sobre las 11,914 oportunidades que no son
importación CSV (con cinco cuentas; Átria explica casi todo lo que falta):

| Llave | Tienen | Pegan en Meta |
|---|---|---|
| `opp.adId` (primera attribution, heredada del contacto) | 9,568 | 7,899 |
| custom field `ID Pauta` / `ID de Pauta` (opp) | 9,457 | 7,788 |
| custom field `ID Pauta` (contacto) | 1,816 | 1,633 |
| cualquier `attributions[].utmAdId` (opp + contacto, first o last) | 9,672 | 8,042 |
| `attributions[].utmCampaignId` | 4,727 | 3,824 — y coincide con la campaña del anuncio en 3,740 de 3,782 |
| `URL Pauta` / `attributions[].url` (`fb.me/…`, `instagram.com/p/…`) | 9,214 | 0 directo; **1,562 URLs aprendidas** de oportunidades que traen URL y ad id, 230 ambiguas |
| nombres (`Nombre Pauta`, `adName`, `utmCampaign`, objeto Pauta) | 10,418 | 3,899 a un nombre de anuncio; el objeto Pauta pega a campaña única en 1,943 |

Primer nivel que pega, en orden: ad id 7,899 · URL 294 · nombre de anuncio 99 ·
cualquier attribution 110 · `ID Pauta` 27+14 · campaña por nombre 3 = **8,446
(70.9 %)**. Quedan 1,240 con ad id que no está en Meta (Átria) y 1,050 de pauta
sin ninguna llave útil.

Dos hechos que cambian el diseño respecto a la entrega ①:

1. **La cuenta publicitaria ES el desarrollo.** Ya no hay que inferir el desarrollo
   de un anuncio por la moda de sus leads: `accountId → pipeline` por nombre. La
   inferencia (`assignAdDesarrollos`) queda como fallback para un ad account que
   no se llame como un desarrollo.
2. **Los nombres de anuncio son genéricos** ("a1", "anuncio 2", 483 distintos para
   1,869 ads); el nombre útil es el de la **campaña**. Por eso la tabla agrupa por
   campaña y el nivel por nombre resuelve a campaña, no a anuncio.

---

## Decisiones de diseño

### 1. La tarjeta reemplaza a "Rendimiento por pauta"

`pauta-performance-table.tsx` se **desmonta** (archivo y `lib/pauta-performance.ts`
se conservan, como `opportunity-status-chart.tsx`); la tarjeta nueva ocupa su lugar
en el orden del panel, en las siete pestañas. Dos tablas de pauta con nombres
distintos para lo mismo confunden más de lo que suman. Decisión del cliente,
2026-09-28.

### 2. Ventana y anuncios desde la creación de la subcuenta

`since` = primer día del mes del `dateAdded` de la subcuenta (2025-10-01), en vez
de "la oportunidad más vieja con ad id". Los anuncios con `created_time` anterior
al `dateAdded` **no entran al dataset** (ni jerarquía ni gasto). Pedido del cliente,
2026-09-28: lo que se pautó antes de que existiera el CRM no tiene con qué cruzarse.
`MAX_HISTORY_MONTHS` se queda como tope de seguridad.

Rechazado: filtrar por `created_time` de la campaña. Una campaña vieja que sigue
recibiendo anuncios nuevos sí tiene leads en el CRM.

### 3. El sync de Meta cabe en el presupuesto: todo en paralelo

Hoy: 2 cuentas a la vez, meses en serie dentro de cada cuenta, ~4 s por petición →
6 min. Nuevo: **todas las cuentas a la vez** (el límite de Graph es por ad account,
no por token) y **3 meses concurrentes por cuenta**. Estimado: 12 meses × 4 s ÷ 3 ≈
20 s por cuenta, todas en paralelo → **< 60 s**. `limit` no cambia nada (medido:
500/2000/5000 tardan igual; una sola llamada de toda la ventana truena con código
1). Si en el futuro rebasa el presupuesto, el siguiente paso es el reporte
asíncrono de insights, no más concurrencia.

### 4. La cadena de vínculos es por niveles, nunca sumados, y cada uno resuelve a anuncio o a campaña

Un lead se ata a **un anuncio** (`ad`) cuando la llave lo identifica, o solo a **una
campaña** (`campaign`) cuando la llave no baja más. Los dos cuentan como "Leads
CRM" de la campaña; solo el primero cuenta en la fila del anuncio. Nivel por nivel,
cada uno solo si el anterior no dio nada:

| # | Llave | Resuelve a |
|---|---|---|
| 1 | ad id: `opp.adId` → cf `ID Pauta`/`ID de Pauta` de la opp → cf del contacto → cualquier `attributions[].utmAdId` (opp, luego contacto; `isFirst` antes que `isLast`) | anuncio |
| 2 | `attributions[].utmCampaignId` que exista en Meta | campaña |
| 3 | URL: cf `URL Pauta` (opp, contacto), `opp.attributionUrl`, `attributions[].url` → mapa **URL → anuncio** aprendido de las oportunidades que traen URL y ad id resuelto | anuncio si la URL apunta a un solo anuncio; campaña si apunta a varios de una misma campaña |
| 4 | nombres: cf `Nombre Pauta` (opp, contacto), `attributions[].adName`, `attributions[].utmCampaign`, `nombre_de_la_pauta` del objeto Pauta | campaña si el nombre es de UNA campaña de Meta; anuncio si es de UN anuncio (casi nunca: son genéricos) |
| — | de pauta sin nada de lo anterior (`isDePauta`) | `noAdId`, al pie con drill |
| — | ad id que no está en ninguna cuenta conectada | `unknownAd`, al pie con drill ("Cambiar cuentas") |
| — | `csv_import`, orgánico, referido | `notPauta`, fuera del costo |

`LeadAttribution` crece: `{ kind: "ad" | "campaign", adId?, campaignId, via: 1|2|3|4 }`
más los tres centinelas. `via` alimenta la nota al pie ("N por ad id, N por URL, N
por nombre") y el `subtitle` del drill. **El mapa URL → anuncio se aprende sobre el
set SIN filtrar** — como `assignAdDesarrollos` — y una URL ambigua a nivel anuncio
sube a campaña, no se descarta. Se conservan `exact`/`byName` como alias solo en
`verify-meta-attribution.ts` mientras se migran las aserciones; la UI no los ve.

Rechazado: sumar niveles ("tiene ad id Y URL"). Contarían dos veces. Rechazado:
casar por nombre cuando hay ad id (regla de la entrega ①, se mantiene).

### 5. Cohorte de creación, mismo rango para gasto y leads

Sin cambio respecto a ①: gasto = Σ `spend` con `date` en el rango del filtro global;
leads = oportunidades **creadas** en el rango (día CDMX) atadas a un anuncio o
campaña del dataset; etapas por `reachedStage` y venta por `isWonOpp`. Sin
resultados → `null` → "—", nunca `$0`. Los otros filtros globales (asesor, origen,
canal, campaña, agencia) acotan **solo los leads**; el gasto no sabe de asesores.
La ⓘ de la tarjeta lo dice.

### 6. Por pestaña, el gasto se acota por cuenta publicitaria

`scopeMetaDaily` deja de mirar `desarrolloByAd` cuando la cuenta se resuelve a un
pipeline: `accountToPipeline` casa el nombre de la cuenta contra los pipelines
(`fold`, agujas largas primero, mismo criterio que `assignAdDesarrollos`). Una
cuenta que no se llame como ningún desarrollo cae a la inferencia por leads, y si
tampoco, a `Sin desarrollo` (solo visible en GENERAL, en rojizo). Los leads se
acotan por pipeline como todo lo demás. Un lead de Cañadas atado a un anuncio de la
cuenta de Atria cuenta en el CRM de Cañadas y en el gasto de Atria, y el pie lo
dice ("N leads de esta pestaña vienen de anuncios de otra cuenta").

---

## Componentes

### `lib/sync.ts` + `lib/ghl-client.ts`

- `GHLLocation` gana `dateAdded?: string`; el paso `config` lo guarda como
  `locationCreatedAt` y viaja en `DashboardPayload.meta.locationCreatedAt`
  (opcional; un frame viejo sigue parseando).
- `historyWindow(locationCreatedAt, today)` — firma nueva: primer día del mes de
  `locationCreatedAt`, con el tope de `MAX_HISTORY_MONTHS`; sin fecha, el mes en
  curso. Deja de recibir oportunidades.
- `fetchMetaAds` recibe `adsCreatedSince` y filtra `created_time < since` antes de
  normalizar (`listAds` pide `created_time`). Las filas de insights de esos
  anuncios viejos **se descartan** con ellos (su gasto es anterior al CRM por
  definición del pedido). Distinto es un anuncio **borrado**: Graph devuelve sus
  insights pero no aparece en `/ads` (medido: 16 ads, $9,392); esas filas se
  **conservan** en `daily` y se muestran bajo "Anuncio eliminado" dentro de su
  campaña si `utmCampaignId`/URL la identifican, o en "Sin campaña" en GENERAL.
  Gasto real, nunca se tira.
- Concurrencia: `ACCOUNT_CONCURRENCY = 6`, `MONTH_CONCURRENCY = 3` (mismo patrón de
  workers sobre cola).

### `lib/types.ts`

- `MetaAd` gana `createdTime?: string`. `MetaCampaign` ya trae `accountId`.
- `DashboardPayload.meta.locationCreatedAt?: string`.

### `lib/meta-attribution.ts` (puro, `verify:meta-attribution`)

- `buildMetaIndex` además indexa `campaignsById`, `adsByCampaign`, `byUrl`
  (aprendido: lo construye `buildUrlIndex(allOpportunities, index)` y se inyecta
  al contexto), y `byName` distingue nombres de anuncio de nombres de campaña.
- `classifyLead(opp, ctx)` — la cadena de la decisión 4. `ctx` gana
  `contactById` (para los custom fields y attributions del contacto) y `urlIndex`.
- `accountToPipeline(accounts, pipelines)` y el cambio en `scopeMetaDaily`.
- **`buildPautaInvestment(input): PautaInvestment`** — la agregación de la tarjeta:

```ts
interface PautaInvestment {
  currency: string                 // "" si mixta
  mixedCurrency: boolean
  kpi: {
    spend: number; impressions: number; clicks: number; cpm: number|null; ctr: number|null
    leadsMeta: number; leadsCrm: number; cpl: number|null
    citas: number; visitas: number; ventas: number; costPerVenta: number|null
  }
  campaigns: CampaignRow[]         // orden: gasto desc; "Sin campaña" al final
  // Al pie, cada uno con oppIds para el drill:
  noAdId: Cell; unknownAd: Cell; otherAccount: Cell
  via: Record<1|2|3|4, number>     // cuántos leads entraron por cada nivel
  unlinkedSpend: number            // gasto de anuncios eliminados sin campaña
}
interface CampaignRow {
  campaignId: string; name: string; accountId: string; accountName: string
  metrics: Metrics                 // las mismas columnas del kpi, por campaña
  campaignOnlyLeads: number        // atados a la campaña sin anuncio (niveles 2-4)
  ads: AdRow[]                     // orden: gasto desc
}
interface AdRow { adId: string; name: string; urls: string[]; deleted: boolean; metrics: Metrics }
interface Metrics { spend; impressions; clicks; cpm; ctr; leadsMeta; leadsCrm; citas; visitas; ventas; cpl; oppIds: { leads; citas; visitas; ventas } }
```

  `citas` es la unión del embudo de GENERAL (`≥04` ∪ objeto Citas), `visitas` es
  `≥05` ∨ ganada, `ventas` es `isWonOpp` — las mismas reglas que
  `desarrollo-funnel.ts`, importadas, no copiadas. `urls` de un anuncio son las
  URLs con que sus leads entraron (del mapa aprendido), las más frecuentes primero.
  `buildCampaignPerformance` y `buildCostPerStage` de la entrega ① se **eliminan**:
  `buildPautaInvestment` los sustituye y nada más los importaba.

### `components/dashboard/pauta-investment-card.tsx`

Una tarjeta, `DashboardCard` + `ChartCardHeader` ("Inversión y rendimiento de
pauta", icono `Coins`, `total` = leads CRM), con `ScopePill` "cohorte por fecha" y
la ⓘ que explica cohorte, cadena y qué filtra el gasto.

- **Fila KPI**: siete tarjetas chicas (Gasto · Leads CRM con "Meta reportó N" ·
  CPL resaltado · Citas · Visitas · Ventas · Costo por venta), cada una con su
  porcentaje sobre leads CRM donde aplique. Debajo, una línea muted:
  "Impresiones · Clics · CPM · CTR".
- **Tabla** campaña → anuncio: columnas Campaña / anuncio · Gasto ↓ · Impr. · Clics
  · CPM · CTR · Leads Meta · Leads CRM · Citas · Visitas · Ventas · CPL. Fila de
  campaña con chevron; al abrir, sus anuncios (id en mono con botón copiar, nombre,
  URL principal con "+N" y enlace externo, "eliminado" en rojizo) y, si
  `campaignOnlyLeads > 0`, una subfila "Sin anuncio identificado". Buscador por
  nombre de campaña, **Top 15 por gasto** con "Ver N más", botón "Expandir todo".
  Celdas del CRM con drill (`ChartDrillDrawer`, como el resto). Sombreado de la
  columna Gasto normalizado por columna, como en `advisor-stage-table`.
- **Estados**: sin conexión → `ChartEmpty` con el botón "Conectar con Meta"
  (reusa `meta-connection.tsx`); conexión con `token_revoked` → el mismo con
  "Reconectar"; `partial` → nota ámbar con las cuentas que faltaron; sin gasto en el
  rango → "Sin gasto en el periodo" (vacío legítimo, sin rojizo). Moneda mixta →
  los totales se muestran por moneda y CPL/CPA se apagan.
- **Pie**: "N leads de pauta del periodo entraron por ad id, N por URL, N por
  nombre; N de pauta no se pudieron vincular [drill]; N traen un ad id de una cuenta
  no conectada [drill → Cambiar cuentas]; N vienen de anuncios de otra cuenta
  [drill]". Los porcentajes de la fila son sobre Leads CRM de la fila.

Convenciones que aplican: `MISSING_TEXT` solo en etiquetas centinela, nunca en
barras; `ChartContainer` no se usa (no hay Recharts); sin scroll anidado — la tabla
va en un `overflow-x-auto` plano.

### `components/dashboard/panel-dashboard.tsx` y `app/page.tsx`

- `PautaInvestmentCard {...shared} metaAds={metaAds} allAppointments={…}
  dateRange={dateRange} locationCreatedAt={…}` donde estaba `PautaPerformanceTable`.
- `app/page.tsx` pasa `data?.metaAds` y el estado de conexión (`warnings` con
  `key: "meta"`) al panel. El `MetaIndex`, el mapa URL y `accountToPipeline` se
  memoizan **una vez en `page.tsx`** sobre el set sin filtrar y bajan como prop:
  siete pestañas no deben reconstruir el índice cada una.

### Filtro global "Campaña" (`lib/panel-filters.ts`)

Nivel 1 ya usa `buildMetaCampaignByAd`. Pasa a usar `classifyLead` completo para
que un lead atado a campaña por URL o por `utmCampaignId` también liste bajo el
nombre de Meta. Mismo orden de prioridad, sin cambio de UI.

### CLAUDE.md

Se actualiza la sección "Meta Ads" (ventana, filtro de anuncios, concurrencia,
cadena de cuatro niveles, cuenta = desarrollo) y "Current state" (la tarjeta
reemplaza a "Rendimiento por pauta"; `pauta-performance-table.tsx` desmontado).

---

## Errores y estados

| Falla | Qué pasa | Qué ve el usuario |
|---|---|---|
| Una cuenta falla en el sync | `partial`, el resto se muestra | nota ámbar en la tarjeta con el nombre de la cuenta, y el banner de siempre |
| Token revocado / secreto rotado | último `metaAds` bueno | tarjeta con datos + aviso "Reconectar" |
| `dateAdded` de la subcuenta no viene | ventana = mes en curso, sin filtro de anuncios | nota: "sin fecha de creación de la subcuenta, se muestra el mes en curso" |
| Lead con ad id de cuenta no conectada | `unknownAd` | conteo al pie con drill |
| Meta reporta leads y el CRM no los tiene | diferencia en la KPI | "Meta reportó N" bajo Leads CRM |
| Cuenta con moneda distinta | `mixedCurrency` | totales por moneda, costos apagados |

Regla de ①, intacta: nada de Meta puede impedir que el panel cargue.

## Verificación

- `pnpm verify:meta` — `nextPageRequest` (ya), `historyWindow(locationCreatedAt)`,
  filtro por `created_time`.
- `pnpm verify:meta-attribution` — la cadena nivel por nivel con un caso por nivel
  y uno por centinela; que un lead con ad id **no** se cuente por URL ni nombre;
  URL ambigua → campaña; `accountToPipeline` con y sin nombre reconocible;
  `buildPautaInvestment`: KPI, orden por gasto, `campaignOnlyLeads`, anuncio
  eliminado con gasto, `null` en vez de división por cero, moneda mixta.
- `pnpm verify:filters` sigue verde (nivel 1 de campaña cambia de función, no de
  resultado para los leads con ad id).
- `npx tsc --noEmit`.
- Contra realidad: `?fresh=1` en producción tras desplegar; el paso `meta` debe
  terminar `done` con seis cuentas y el sync completo bajo 300 s (mirar
  `synced_at` avanzar); **cuadrar el gasto de agosto de "CAÑADA | Domus | FORM 2
  Jul" con el Administrador de anuncios**; abrir Atria y Cañadas y confirmar que
  el gasto de cada pestaña es el de su cuenta.

## Fuera de alcance

- Pestaña PAUTA aparte (esta tarjeta la cubre; se reabre si el cliente la pide).
- Exponer `metaAds` al Asistente IA (sigue pendiente de ①).
- Conversión de moneda, reparto de gasto entre desarrollos, reporte asíncrono de
  insights, entrada en el PDF.
- El toggle "Origen" de la captura de referencia: el origen (WhatsApp / formulario)
  ya se lee en el nombre de campaña de DRT y en `leadsForm` vs `leadsMsg`; una
  segunda agrupación duplica la tabla sin pregunta nueva.
