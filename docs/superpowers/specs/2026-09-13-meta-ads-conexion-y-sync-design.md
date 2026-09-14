# Meta Ads ①: conexión con Meta, dataset en el sync y cruce por ad id

Fecha: 2026-09-13
Estado: diseño aprobado para implementar
Entregas relacionadas (specs pendientes): ② card "Inversión en pauta" por tab,
③ pestaña PAUTA. Este documento cubre la ①; las secciones "Entregas siguientes" y
"Fuera de alcance" dicen dónde termina.

## El problema

El panel sabe **cuántos** leads llegan por pauta (~99,7 % de las oportunidades) y de
**qué anuncio** vienen, pero no sabe **cuánto costaron**. Sin gasto no hay costo por
lead, por cita, por visita, por apartado ni por venta — que es la pregunta de negocio
que DRT hace sobre su pauta. Hoy esa respuesta vive en el Administrador de anuncios
de cada agencia y se cruza a mano, si se cruza.

Integrar Meta Ads responde tres cosas, en este orden de entrega:

1. **Enriquecer la atribución**: ponerle a cada oportunidad su campaña y conjunto de
   anuncios reales (hoy `campaignName` es el nombre del *ad*).
2. **Costo por resultado del embudo** por desarrollo y por campaña.
3. **Rendimiento de la pauta por sí sola** (gasto, impresiones, CPM, CTR, leads que
   Meta reporta vs. los que llegaron al CRM).

Las tres se apoyan en la misma base — traer el dataset de Meta al sync y cruzarlo
por ad id — y esa base es esta entrega.

---

## Reconocimiento de datos (medido contra `LbjglJfbiUWjKpmxSnvm`, 2026-09-13)

Cada oportunidad reciente de DRT trae, en `attributions[]` y duplicado en custom
fields:

| Dato | Ejemplo | Dónde |
|---|---|---|
| Ad id de Meta | `120247808685340416` | `attributions[].utmAdId` → `opp.adId`; custom field **`ID de Pauta`** |
| URL del anuncio | `https://fb.me/a1U3nrD6x` | `attributions[].url`; custom field **`URL Pauta`** |
| Nombre del **ad** | `Cañadas by El Mirador` | `attributions[].adName`; custom field `Pauta` |
| Fuente | `Paid Social` / `whatsapp` | `utmSessionSource` / `medium` |

Tres hechos determinan el diseño:

1. **Existe una llave exacta.** El `utmAdId` es el id del anuncio en la Marketing API
   de Meta, tal cual. Cobertura ~86 % (CLAUDE.md). No hay que inventar matching por
   nombre; el nombre es solo fallback para ubicar el desarrollo de un ad sin leads.
2. **Los nombres que tiene el CRM son del ad, no de la campaña.** "Cañadas by El
   Mirador" se repite en decenas de ads distintos. Meta resuelve ad → adset → campaña,
   que es la jerarquía a la que el cliente le pone presupuesto.
3. **Varias cuentas publicitarias.** DRT pauta desde más de un ad account (por
   agencia/desarrollo). El gasto se consolida; la moneda no se convierte.

---

## Decisiones de diseño

### 1. Meta es un dataset más del mismo sync (no una ruta aparte)

`syncProject()` gana un paso concurrente `meta`, junto a `pautas`, `tasks`, etc. El
resultado va en `DashboardPayload.metaAds`, y por tanto cae **gratis** en el caché
de Neon, en el refresco en segundo plano, en el banner ámbar de datasets incompletos
y a la vista del Asistente IA (cuando se exponga, ver "Entregas siguientes").

Rechazado: una ruta `/api/meta-ads` con caché propio. Las cards de costo viven en
**todos** los tabs, así que sería un segundo estado de carga por tab, un segundo
caché/candado que duplicar (`sync-store` es una fila por cliente) y más plomería
para que el asistente lo viera. Rechazado también: que Make escriba el gasto en un
custom object de GHL — Make se vuelve la fuente de verdad, no hay backfill, Meta
corrige cifras hacia atrás y se pierde la jerarquía.

### 2. La conexión es un botón, no un token en env

Quien administre el Business Manager de DRT aprieta **Conectar con Meta**, autoriza,
elige qué cuentas comparte y listo. Flujo OAuth de **Facebook Login for Business** con
una configuración de tipo **usuario del sistema**: el token no caduca (solo si lo
revocan) y lo que se conecta es la **empresa**, no la cuenta personal de alguien.

Rechazado: token de usuario (caduca a 60 días, ve solo lo que esa persona ve).
Rechazado: pedirle a alguien un System User token a mano y meterlo en env — funciona,
pero cada cliente nuevo es un trámite de BM y nada lo hace visible cuando se rompe.

### 3. La app de Meta es de Lezgo y sirve a todos los proyectos

Una sola app (`Paneles Lezgo Suite`, App ID `1432292882099074`, publicada), un solo
`config_id` de Login for Business (`1047096268324910`, permisos `ads_read` +
`business_management`). Cada proyecto/cliente guarda el token de *su* empresa en
*su* base. La ruta del callback se estandariza en **`/api/meta/callback`** para que
la lista de redirect URIs de la app sea predecible y el código sea copiable:

```
https://drt.lezgosuite.com/api/meta/callback
https://drt-psi.vercel.app/api/meta/callback
```

Localhost: la app publicada rechaza `http://localhost`; para desarrollar se usa la
**app de prueba** hija (siempre en modo desarrollo, mismo `config_id` heredado, su
propio App ID/Secret) y sus credenciales van en `.env.local`. Previews de Vercel:
**no se conecta desde un preview** (URL aleatoria, no registrable); el botón muestra
"Conecta desde producción". Un callback central (`auth.lezgosuite.com`) que reenvíe
por `state` queda como opción futura; el `state` ya lleva el origen firmado para
que sea agregar el relay, no cambiar los proyectos.

WhatsApp (asistente futuro) vive en la **misma app** como otra configuración de
Login; por eso la tabla de conexión se indexa por `product`.

### 4. El cruce es por ad id; el desarrollo de un ad se infiere

El id manda siempre. El desarrollo (Meta no sabe de desarrollos) se infiere por los
leads del ad y, a falta de leads, por nombre. El gasto **no se reparte** entre
desarrollos ni se convierte de moneda: repartirlo inventa precisión que no existe.

### 5. Cada sync re-trae la ventana completa

Sin merge incremental. Es lo consistente con "el caché es desechable y no guarda
historia" y hace irrelevante que Meta corrija cifras hacia atrás (ventana de
atribución): no hay estado parcial que se pueda desincronizar.

---

## Arquitectura

```
[Conectar con Meta]
   → GET /api/meta/connect      arma la URL del diálogo (config_id + state firmado) y redirige
   → facebook.com/dialog/oauth  el admin del BM autoriza y elige cuentas
   → GET /api/meta/callback     verifica state, code → token, /me/adaccounts, guarda fila
   → redirect /?meta=connected

sync (lib/sync.ts)
   readMetaConnection(client, "ads")        ← Neon, tabla meta_connection
   ├─ sin fila / sin DATABASE_URL  → paso `meta` NO se emite; metaAds = null
   └─ con fila → lib/meta-client.ts → Graph API v23.0
        listAds(act)                 jerarquía campaña/adset/ad
        adInsightsDaily(act, mes)    gasto y acciones por ad por día
      → normaliza → DashboardPayload.metaAds → gzip en project_sync como todo lo demás

browser
   lib/meta-attribution.ts  (puro)  índice por adId, desarrollo por ad, cohorte, costo por etapa
   components/dashboard/meta-connection.tsx   píldora del header
```

---

## Componentes

### `lib/meta-oauth.ts` — firma, cifrado y URLs (puro, `verify:meta-oauth`)

- `signState({ clientId, product, returnTo, nonce, iat })` / `verifyState()` — HMAC
  con `DASHBOARD_AUTH_SECRET`, la misma familia que la cookie de sesión. Caduca a
  los 10 min. Un `state` manipulado o expirado se rechaza; el verify lo asserta.
- `encryptToken(plain)` / `decryptToken(blob)` — AES-256-GCM con llave derivada de
  `DASHBOARD_AUTH_SECRET` (HKDF, info `meta-token`). El verify asserta ida y vuelta y
  que un blob alterado no descifra.
- `buildDialogUrl({ configId, redirectUri, state })` →
  `https://www.facebook.com/v23.0/dialog/oauth?client_id&config_id&redirect_uri&state&response_type=code`.
  Con Login for Business **no se manda `scope`**: los permisos los define la
  configuración.
- `redirectUriFor(req)` — `${origin}/api/meta/callback`, con `origin` derivado de
  `META_PUBLIC_ORIGIN` si existe (producción) y del `Host` de la petición si no
  (localhost). Nunca de un header `Origin`/`Referer` controlable.

### `lib/meta-connection-store.ts` — la fila por cliente

Tabla nueva, agregada a `scripts/db-migrate.ts` (idempotente, misma conexión unpooled):

```sql
CREATE TABLE IF NOT EXISTS meta_connection (
  client_id           text        NOT NULL,
  product             text        NOT NULL,   -- 'ads' | 'whatsapp'
  token_encrypted     bytea       NOT NULL,
  token_kind          text        NOT NULL,   -- 'system_user' | 'user'
  token_expires_at    timestamptz,            -- NULL para system_user
  business_id         text,
  connected_by        text,                   -- nombre Meta de quien conectó
  available_accounts  jsonb       NOT NULL,   -- [{id,name,currency,timezone,status}]
  selected_accounts   jsonb       NOT NULL,   -- ids; por defecto = todas las disponibles
  connected_at        timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  PRIMARY KEY (client_id, product)
)
```

- `readMetaConnection(client, product)` / `writeMetaConnection(client, product, …)` /
  `updateSelectedAccounts(client, product, ids)` / `deleteMetaConnection(client, product)`.
- **Todas reciben el `ClientConfig`, nunca un string** — la misma regla que
  `sync-store`: leer la fila equivocada conectaría el panel de A con la pauta de B.
- A diferencia de `project_sync`, **esta fila no es desechable**: si se borra hay que
  reconectar. Es el único estado del sistema que no se rellena solo.
- Sin `DATABASE_URL` las funciones devuelven `null`/no-op y lo registran; la base
  sigue sin ser dependencia. El botón "Conectar con Meta" se deshabilita con el
  texto "Requiere base de datos" — no puede guardar el token en ningún lado.

### `app/api/meta/*` — rutas, todas detrás de `requireClient()`

| Ruta | Hace |
|---|---|
| `GET /connect` | Arma `state` y redirige al diálogo. En un preview de Vercel (`VERCEL_ENV === "preview"`) responde 409 con "Conecta desde producción". |
| `GET /callback` | Verifica `state` (y que su `clientId` sea el de la sesión), cambia `code` → token (`/oauth/access_token` con `client_secret`), pide `/me?fields=id,name` y `/me/adaccounts?fields=id,name,account_status,currency,timezone_name`, escribe la fila con `selected = available`, y redirige a `/?meta=connected`. Cualquier fallo redirige a `/?meta=error&reason=…` — nunca deja un token a medias. |
| `GET /connection` | Estado para la píldora: `{ connected, connectedBy, connectedAt, accounts: available con flag selected }`. **Nunca devuelve el token.** |
| `POST /accounts` | `{ ids }` → `updateSelectedAccounts`. Rechaza ids que no estén en `available`. |
| `DELETE /connection` | Borra la fila. No revoca en Meta (eso lo hace el cliente desde su BM); el footnote del diálogo lo dice. |

Ninguna toca GHL, así que no pasan por `withClient()`.

### `lib/meta-client.ts` — Graph API (server-only)

Mismo estatus que `ghl-client.ts`: **jamás importado desde el browser**. Base
`https://graph.facebook.com/v23.0`. Tres llamadas:

- `listAdAccounts(token)` → `/me/adaccounts?fields=id,name,account_status,currency,timezone_name`.
- `listAds(token, act)` → `/act_{id}/ads?fields=id,name,effective_status,adset{id,name},campaign{id,name,objective}&limit=500`,
  paginado por `paging.cursors.after`. La jerarquía completa en una llamada.
- `adInsightsDaily(token, act, since, until)` →
  `/act_{id}/insights?level=ad&time_increment=1&time_range={since,until}&fields=ad_id,spend,impressions,reach,clicks,inline_link_clicks,actions&limit=500`.
  Se pide **por mes calendario** (Meta se ahoga con rangos largos a nivel ad) y se
  pagina igual.

Resiliencia: concurrencia 2 por cuenta; reintento con backoff exponencial (3
intentos) en los códigos de throttling de Meta (`17`, `80004`, `613`) y en 5xx. Un
`190` (token inválido/revocado) **no se reintenta**: es terminal y se propaga con
`reason: "token_revoked"`. Un `100`/`200` en una cuenta (sin permiso sobre ese act)
marca esa cuenta como fallida y sigue con las demás.

De `actions[]` se extraen dos contadores, y solo dos:

| `action_type` | Campo | Por qué |
|---|---|---|
| `lead` | `leadsForm` | Anuncios con formulario → `source: "Pauta Formulario"` |
| `onsite_conversion.messaging_conversation_started_7d` | `leadsMsg` | Anuncios de WhatsApp → `source: "Pauta WhatsApp"` |

Los demás `action_type` se ignoran. Meta **omite** los días sin gasto, así que el
volumen real es mucho menor que ads × días.

### Ventana de historia

`since` = el `createdAt` más antiguo entre las oportunidades con `adId`, redondeado
al primero de ese mes, con tope de 24 meses atrás. `until` = hoy en
`America/Mexico_City`. Se recalcula en cada sync a partir del dataset de
oportunidades ya cargado — por eso el paso `meta` arranca **después** de que
`opportunities` terminó, no en el mismo `Promise.allSettled` que los demás.

### `DashboardPayload.metaAds`

```ts
export interface MetaAdsData {
  accounts:  { id: string; name: string; currency: string; timezone: string }[]
  campaigns: { id: string; name: string; objective?: string; accountId: string }[]
  adsets:    { id: string; name: string; campaignId: string }[]
  ads:       { id: string; name: string; adsetId: string; status?: string }[]
  daily:     MetaDailyRow[]
  window:    { since: string; until: string }   // YYYY-MM-DD
  /** Cuentas que fallaron en este sync (id + motivo). Vacío = todas bien. */
  failedAccounts: { id: string; reason: string }[]
}

export interface MetaDailyRow {
  adId: string
  date: string        // YYYY-MM-DD en la zona horaria de la cuenta
  spend: number       // en la moneda de la cuenta; no se convierte
  impressions: number
  reach: number
  clicks: number
  linkClicks: number
  leadsForm: number
  leadsMsg: number
}
```

`metaAds?: MetaAdsData | null` en `DashboardPayload`: opcional para que un frame
`data` de un deploy anterior siga parseando; `null` = sin conexión. Tablas
normalizadas con ids de padre, no anidadas — el cruce es por `adId` y los charts
agrupan hacia arriba. Estimado para DRT: cientos de ads × días con gasto → 1-3 MB
JSON, 200-400 KB gzip.

### Encaje en `lib/sync.ts`

Nuevo `StepKey` `"meta"` en `hooks/use-dashboard-data.ts` y una fila más en
`SyncFace` de `loading-screen.tsx` ("Meta Ads"). Comportamiento del paso:

| Situación | Paso `meta` | `metaAds` | Banner |
|---|---|---|---|
| Sin fila en `meta_connection` o sin `DATABASE_URL` | **no se emite** | `null` | no |
| Todo bien | `done` con `count = ads` | dataset | no |
| Una cuenta de varias falla | `partial` | dataset sin esa cuenta, `failedAccounts` la nombra | sí: "Meta Ads: la cuenta X no respondió" |
| Token revocado (`190`) | `error`, `reason: "token_revoked"` | **el `metaAds` del último sync bueno** (se lee de `readSync` antes de escribir) | sí: "Meta desconectado — reconectar" |
| Meta caído / otro error | `error` | ídem último bueno | sí: "Meta Ads no respondió" |

"Sin conexión" **no es un error** y no levanta banner: el panel muestra el botón.
`SyncWarning` gana un campo opcional `reason?: string` para distinguir revocado de
caído; el banner lo mapea a texto. `warnings[]` sigue viajando en el payload, así
que un load en caliente desde caché sigue mostrando el estado correcto.

El paso lee el token con `decryptToken` **dentro** de `syncProject` y no lo pasa a
ningún frame ni log.

### `lib/meta-attribution.ts` — el cruce (puro, `verify:meta-attribution`)

**Llave.** `oppAdId(opp)`: `opp.adId`, y si falta, el custom field `ID de Pauta`
(match de nombre insensible a mayúsculas, como `categoryValuesOf`). Normalizada:
trim, solo dígitos. Sin id → bucket **"Sin ad id"** (rojizo `MISSING_TEXT`: hueco
de captura, no error del cruce).

**Índice.** `buildMetaIndex(metaAds)` → `adId → { ad, adset, campaign, account }`
y `dailyByAd`. Se construye una vez por payload y se memoiza en el panel.

**Desarrollo de cada ad.** `assignAdDesarrollos(index, allOpportunities, pipelines)`
→ `Map<adId, desarrollo>`, en este orden:

1. **Por sus leads** — la moda de `desarrolloOf(opp, pipelines)` entre las
   oportunidades (del set **sin filtrar**) que traen ese `adId`. Un ad con 40 leads
   en Cañadas y 2 en Atria es de Cañadas; los 2 se siguen viendo como leads en Atria,
   solo el gasto no se reparte.
2. **Por nombre** — sin leads, se busca cada etiqueta de `PANEL_SCOPES` (sin
   acentos ni mayúsculas) en campaña → adset → ad. Hardcodear los seis está bien
   aquí (CLAUDE.md).
3. **`Sin desarrollo`** — gasto que no se pudo ubicar. Va a GENERAL y a la pestaña
   PAUTA, en rojizo. *Gasto sin un solo lead es hallazgo, no residuo.*

`scopeMetaDaily(metaAds, desarrolloByAd, panel)` filtra `daily` a los ads del
desarrollo del tab; GENERAL devuelve el array original (misma convención que
`scopeOpportunities`).

**Costo por resultado — cohorte de creación.** `buildCostPerStage({ opportunities,
daily, index, range, pipelines })` para la ventana del filtro global:

- **Gasto** = Σ `spend` con `date` en la ventana.
- **Leads CRM** = oportunidades **creadas** en la ventana (`createdAt` convertido a
  `America/Mexico_City` para comparar con `date`) con `adId` en el índice.
  **Leads Meta** = Σ `leadsForm + leadsMsg` de los mismos días. La diferencia
  ("N no llegaron") es un hallazgo en sí: leads que Meta cobró y nunca entraron al
  CRM.
- **Costo por etapa** = gasto ÷ leads de la cohorte que **alcanzaron** la etapa.
  "Alcanzó" = índice de su etapa actual (por nombre, insensible a mayúsculas, como
  `isWonOpp`) ≥ índice de la etapa objetivo; una perdida en `05. Visita` sí alcanzó
  Visita. GHL no guarda historial de etapas: la etapa actual es la mejor
  aproximación al máximo alcanzado, y el footnote lo dice. Cinco columnas:
  **Contactado (≥01) · Cita (≥04) · Visita (≥05) · Apartado (≥07) · Venta
  (08 ∨ `isWonOpp`)**. Los side buckets (`Inversión Futura`, `Negocio perdido`) no
  cuentan como etapa alcanzada.
- Sin leads en una etapa → `null` (la UI pinta `—`). Nunca `$0`, nunca `∞`.
- Monedas: si las cuentas involucradas difieren en `currency`, el resultado lleva
  `mixedCurrency: true` y los totales se devuelven por moneda; la UI lo señala.

**Ad no conectado.** Oportunidad con `adId` que **no está** en el índice: de una
cuenta que DRT no compartió, o ad borrado. Se cuenta aparte (`unknownAdLeads`) y es
la señal para "Cambiar cuentas".

**Rendimiento por campaña.** `buildCampaignPerformance(...)` → filas por campaña de
Meta con gasto · impresiones · clics · CPM · CTR · leads Meta · leads CRM · las cinco
etapas · CPL · costo/apartado · costo/venta, agrupadas por familia con
`groupCampaignsByFamily` de `lib/pauta.ts` (los nombres de Meta traen los mismos
prefijos de agencia). Se construye aquí para que ② y ③ no lo dupliquen; ③ lo monta.

**Lo que NO hace**: no reparte gasto, no convierte moneda, no atribuye por nombre
cuando hay ad id, y no toca `lib/pauta.ts` — `isDePauta` sigue siendo "es de
pauta"; esto es "cuánto costó", una pregunta distinta.

### `components/dashboard/meta-connection.tsx` — la píldora

En el header, junto a "Actualizar", visible en todos los tabs (incluido Asistente
IA). Lee `GET /api/meta/connection` al montar y al volver con `?meta=…`.

- Sin conexión: botón **Conectar con Meta** → `/api/meta/connect`. En preview:
  deshabilitado, "Conecta desde producción". Sin base: deshabilitado, "Requiere
  base de datos".
- `?meta=connected`: toast "Meta conectado · N cuentas" y dispara `refresh()`
  (sync en fresco) para que el gasto aparezca sin esperar los 15 min.
- `?meta=error&reason=…`: toast con el motivo (`state_invalid`, `denied`,
  `token_exchange`, `no_accounts`, `db`).
- Conectado: píldora **"Meta · N cuentas"** con menú → **Cambiar cuentas** (diálogo
  con checkboxes sobre `available`, guarda con `POST /accounts` y hace `refresh()`;
  footnote: "Para compartir más cuentas, vuelve a conectar") · **Reconectar** (vuelve
  al diálogo de Meta) · **Desconectar** (confirmación; explica que no revoca en Meta).
- Si el último sync trae warning `meta` con `reason: token_revoked`: la píldora se
  pone en rojo "Meta desconectado" con **Reconectar** como acción primaria.

Sin píldora ámbar de caducidad: el token es de usuario del sistema y no caduca.
`token_kind`/`token_expires_at` quedan en la tabla por si un cliente futuro tuviera
que conectar con token de usuario (plan B si Meta exige verificación); la píldora
solo pintaría el aviso cuando `token_expires_at` no sea nulo.

---

## Variables de entorno

```
META_APP_ID            # de la app publicada (Vercel) o de la app de prueba (.env.local)
META_APP_SECRET        # ídem; server-only, nunca al bundle
META_LOGIN_CONFIG_ID   # 1047096268324910 — el mismo en ambas
META_PUBLIC_ORIGIN     # opcional; https://drt.lezgosuite.com en producción, para fijar redirect_uri
```

Son de Lezgo, no del cliente: **no** van en `DASHBOARD_CLIENTS`. Sin las tres
primeras el botón se deshabilita ("Meta no configurado") y el sync se comporta como
sin conexión.

---

## Errores y estados

| Falla | Qué pasa | Qué ve el usuario |
|---|---|---|
| `state` inválido / expirado en el callback | 400, no se guarda nada | toast "La conexión expiró, inténtalo de nuevo" |
| El usuario cancela en Meta | redirect con `error=access_denied` | toast "Conexión cancelada" |
| Meta no devuelve cuentas | no se guarda la fila | toast "Esa empresa no compartió cuentas publicitarias" |
| Postgres no responde en el callback | no se guarda; log | toast "No se pudo guardar la conexión" |
| Token revocado en el sync | `error` + último `metaAds` bueno | píldora roja + banner; el gasto de antes sigue en pantalla |
| Una cuenta sin permiso | `partial` | banner nombra la cuenta; el resto se ve |

Regla general: **meter Meta no puede crear una forma nueva de que el panel no
cargue**. Todo fallo de Meta o de la tabla nueva se registra y el sync de GHL sigue.

---

## Verificación

- `pnpm verify:meta-oauth` — `signState`/`verifyState` (válido, manipulado, expirado,
  `clientId` ajeno), `encryptToken`/`decryptToken` (ida y vuelta, blob alterado),
  `buildDialogUrl` (sin `scope`, con `config_id`).
- `pnpm verify:meta` — extracción de `actions` (solo los dos tipos), chunking por mes
  calendario (bordes, mes actual parcial), normalización de la jerarquía, marcado de
  cuenta fallida sin tumbar las demás.
- `pnpm verify:meta-attribution` — `oppAdId` (utmAdId, custom field, sin id, con
  espacios), desarrollo por moda / por nombre / `Sin desarrollo`, cohorte por
  `createdAt` en zona horaria de México contra `date`, "alcanzó etapa" con perdidas,
  `null` en vez de división por cero, `unknownAdLeads`, moneda mixta.
- `pnpm verify:sync-store` sigue verde (no cambia).
- `npx tsc --noEmit`.
- Contra realidad: conectar con la app de prueba desde localhost, `?fresh=1`, y
  **cuadrar el gasto de un mes de una campaña concreta con el Administrador de
  anuncios de DRT** antes de confiar en cualquier costo. Probar la caída de
  Postgres apuntando `DATABASE_URL` a un host inválido: el panel carga igual, sin
  Meta, sin banner.

---

## Entregas siguientes (specs propios)

- **② Card "Inversión en pauta"** en `panel-dashboard.tsx`, debajo de "Contactos sin
  oportunidad": gasto, leads CRM vs Meta, tabla de cinco etapas con conteo y costo,
  drill-down por celda, estado "Conectar con Meta" cuando no hay conexión, vacío
  honesto para Palmyra/Zanda, y entrada en el PDF (`lib/report.ts`).
- **③ Pestaña PAUTA** (`DashboardTab` `"pauta"`, entre Zanda y Asistente IA): fila
  KPI, gasto por mes por desarrollo (`SERIES_PALETTE` vía `lib/sales-series.ts`),
  tabla por campaña agrupada por familia con las filas de gasto-sin-leads en rojizo.
  La barra global filtra gasto y leads por fechas y desarrollo; asesor/origen/canal
  filtran solo los leads.
- Después: exponer `metaAds` al Asistente IA (`ai-context` + tool `resumen_pauta`);
  WhatsApp como segunda configuración de Login en la misma app (`product =
  "whatsapp"`).

## Fuera de alcance

- Conectar desde previews de Vercel (callback central).
- Conversión de moneda.
- Reparto proporcional de gasto entre desarrollos.
- Revocar el token en Meta desde el panel.
- Escribir nada en Meta (`ads_management`): solo lectura, siempre.
