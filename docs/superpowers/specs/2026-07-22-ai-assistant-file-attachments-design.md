# Adjuntos en el Asistente IA — imágenes, PDF, CSV y Excel

**Fecha:** 2026-07-22
**Estado:** Aprobado — pendiente de plan de implementación

## Objetivo

Permitir que el usuario suelte **imágenes, PDF, CSV y Excel** en el chat del
Asistente IA (`conversations-chat.tsx`) y que el modelo pueda razonar sobre ellos.
Dos requisitos que dominan el diseño:

1. **Eficiencia de tokens** — no volcar archivos crudos al prompt. Pre-procesar con
   librería para darle a la IA la versión más digerible/barata posible.
2. **Tabulares consultables por tools** — un CSV/Excel debe poder tanto analizarse
   solo como cruzarse con los datos del CRM ("ambos por igual"). Eso obliga a que las
   filas del archivo sean consultables por las herramientas del agente, no solo texto
   pegado en el prompt.

Alcance acordado: **todo de una** (imágenes + PDF + tabulares con tools en un solo
entregable). Sin cambio de modelo — `claude-sonnet-4-6` ya soporta visión y documentos.

## Decisión de arquitectura: procesamiento en el servidor

Los archivos que requieren librería (PDF, CSV, Excel) se procesan en una **nueva ruta
del servidor**, no en el navegador.

- **Ruta nueva:** `app/api/attachments/process/route.ts`. El cliente sube el archivo,
  el server corre las librerías (Node) y devuelve un `ProcessedAttachment` normalizado.
- **Por qué server-side:** es consistente con el patrón del app (todo el trabajo pesado
  es server-only, ver CLAUDE.md), mantiene el bundle del cliente ligero (~2 MB de libs
  fuera del navegador) y evita la configuración quisquillosa del worker de pdf.js en
  Next 16.
- **Excepción — imágenes:** se validan (tamaño) y se codifican a base64 **en el
  cliente**. No necesitan librería; Anthropic las redimensiona internamente. No pasan
  por la ruta de procesamiento.
- La ruta necesita solo el gate del middleware (no toca GHL), igual que `/api/chat` y
  `/api/analyze-report`. **No** requiere `requireClient()` / `withClient()`.

## Flujo general

```
Usuario adjunta archivo(s) en el composer (botón / drag-drop / paste)
   │
   ├─ Imagen  → validar tamaño + base64 en el cliente ──────────────┐
   │                                                                 │
   └─ PDF / CSV / Excel → POST /api/attachments/process ────────────┤
                              (Node: unpdf + xlsx)                   │
                              devuelve ProcessedAttachment           │
                                                                     ▼
                                          Se guarda en el estado del chat
                                                                     │
                    ┌────────────────────────────────────────────────┤
                    ▼                                                 ▼
        Bloques de contenido para la IA                  Tablas guardadas en un ref
        (image / document / texto resumen)               (rows completas, por fileId)
                    │                                                 │
                    ▼                                                 ▼
              /api/chat (sin cambios de fondo)          Tools nuevas las consultan
                                                        (client-side, como las demás)
```

## Qué se le manda a la IA por cada tipo

La clave de eficiencia: cada tipo se reduce a la representación más barata que preserve
la información útil.

- **Imagen** → bloque `image` nativo de la API. Claude la ve. (~1,600 tokens.)
- **PDF con capa de texto** → `unpdf` extrae el texto en el server → se manda como
  **texto** (barato). 
- **PDF escaneado / sin texto** → **fallback**: si el texto extraído sale vacío o
  trivial, se manda el PDF crudo como bloque `document` nativo para que Claude lo "vea".
- **CSV / Excel** → `xlsx` parsea en el server y devuelve un **resumen estructurado**,
  NO todas las filas. El resumen contiene:
  - nombres de columnas + tipo inferido (número / fecha / texto)
  - conteo de filas
  - 5–10 filas de muestra
  - stats básicos: por columna numérica (min/max/suma/promedio); por columna categórica
    (top valores)

  Solo el resumen va al prompt. Las **filas completas** se quedan en el cliente para las
  tools. Un Excel de 5,000 filas cuesta ~200 tokens en el prompt en vez de ~50k.
  - **Multi-hoja:** cada hoja de un Excel se procesa como una tabla independiente
    (identificada por `fileId` + nombre de hoja).

## Tabulares consultables por tools

Las filas parseadas se guardan en un `Map<fileId, UploadedTable>` en un `ref` del agent
loop (viven durante la sesión). Se añaden **3 tools** a `lib/ai-tools.ts`, ejecutadas
client-side como el resto de las herramientas del dataset:

- `list_uploaded_files()` — el modelo ve qué archivos tiene cargados y sus esquemas.
- `query_uploaded_table({ fileId, filter?, groupBy?, aggregate?, columns?, limit? })` —
  el caballo de batalla; misma semántica que el `aggregate` existente pero sobre el
  archivo. Cubre **"analizar el archivo solo"**.
- `join_uploaded_table({ fileId, tableColumn, entity: "contacts"|"opportunities",
  entityField, mode: "matched"|"unmatched"|"both" })` — hace el cruce en **una sola
  llamada** (ej: "de estos 500 emails del Excel, cuáles ya son contactos"). Cubre
  **"cruzar con el CRM"**.

El modelo ya tiene `search_contacts`, `aggregate`, `relate`, etc.; combinando
`join_uploaded_table` con esas resuelve cruces arbitrarios sin quemar turnos.

El system prompt (`lib/ai-context.ts`) gana una sección corta explicando que puede haber
archivos adjuntos, cómo consultarlos y que el resumen del prompt es una muestra (no debe
concluir totales de la muestra — consistente con la regla existente de no concluir de
muestras truncadas).

## UI del composer (`conversations-chat.tsx`)

- Ícono de clip → `<input type="file" multiple>`; además **drag-drop** sobre el área de
  chat y **paste** de imagen del portapapeles.
- Chips de preview arriba del textarea: ícono por tipo + nombre + tamaño + botón "x" para
  quitar. Miniatura para imágenes.
- Estado "Procesando archivo…" mientras la ruta de procesamiento responde.
- Validación de límites **antes** de mandar (ver Límites).
- El mensaje de usuario que se envía combina los bloques de adjuntos + el texto escrito.

## Tipos y plomería

- `hooks/use-agent-loop.ts`:
  - `AnyBlock` gana variantes `ImageBlock` y `DocumentBlock` (forma de bloque de
    contenido de Anthropic).
  - `send()` acepta adjuntos además de texto; arma los bloques del mensaje de usuario.
  - Nuevo `Map<fileId, UploadedTable>` en un `ref` para las filas parseadas.
- `lib/ai-tools.ts`:
  - `ChatDataset` (o el contexto de ejecución) gana `uploadedTables`.
  - +3 tools nuevas con su executor.
- `app/api/chat/route.ts`: prácticamente sin cambios (ya reenvía bloques de contenido
  crudos a Anthropic). Verificar que `withRollingCacheBreakpoint` maneje bien un último
  bloque no-texto (imagen/documento) — por cómo está escrito ya hace spread del bloque y
  añade `cache_control`, lo cual es válido en bloques image/document, pero se prueba.
- `app/api/attachments/process/route.ts`: ruta nueva. `runtime = "nodejs"`. Recibe el
  archivo (base64 + nombre + mime), devuelve `ProcessedAttachment`.

### Forma normalizada del resultado

```ts
type ProcessedAttachment =
  | { kind: "pdf_text"; filename: string; text: string; pageCount: number }
  | { kind: "pdf_visual"; filename: string; mediaType: string; dataBase64: string }
  | {
      kind: "table";
      fileId: string;
      filename: string;
      sheetName?: string;
      schema: Array<{ name: string; type: "number" | "date" | "text" }>;
      rowCount: number;
      sampleRows: Array<Record<string, unknown>>;
      stats: unknown; // por-columna: numéricas (min/max/sum/avg), categóricas (top valores)
      rows: Array<Record<string, unknown>>; // filas completas → se stashean en el cliente
    };
// Imágenes: no pasan por esta ruta; el cliente arma { kind: "image", mediaType, dataBase64 }.
```

## Límites

- Imagen ≤ 5 MB (tope de Anthropic).
- PDF ≤ 32 MB.
- Tabular: sin tope duro de filas, pero aviso en la UI si el archivo supera **50,000
  filas** (rendimiento del cruce client-side); el resumen al prompt siempre es acotado
  (muestra + stats), sin importar el tamaño.
- Varios adjuntos por mensaje permitidos (unos pocos).
- Persistencia: los adjuntos viven en el estado del chat en memoria (sesión). Las filas
  de tablas viven en el `ref` durante la sesión. No hay persistencia entre recargas —
  consistente con el chat actual.

## Librerías nuevas (2, ambas server-side)

- **`xlsx`** (SheetJS) — parsea Excel **y** CSV (una sola lib para todo lo tabular).
- **`unpdf`** — extracción de texto de PDF, diseñada para serverless (Vercel).

Instalación con `npm install --legacy-peer-deps` (según CLAUDE.md).

Nota: `lib/csv.ts` existente solo **serializa** CSV (para exports); no sirve para
importar. No se reutiliza para el parseo de entrada.

## Costos

El contador de costo existente (`estimateCost` en `use-agent-loop.ts`) ya cuenta input
tokens, así que el costo de imágenes y texto de PDF se refleja automáticamente. El diseño
minimiza ese costo vía el pre-procesamiento (texto de PDF en vez de páginas-imagen,
resumen tabular en vez de filas crudas).

## Fuera de alcance (YAGNI)

- Persistencia de adjuntos entre sesiones / recargas.
- Otros formatos (Word, PPT, imágenes vectoriales, audio).
- Edición o escritura de archivos (solo lectura/análisis).
- OCR propio (el fallback a documento nativo delega la lectura visual a Claude).

## Verificación

No hay framework de tests (ver CLAUDE.md). Se verifica manejando la app real:

- `npx tsc --noEmit` debe pasar (el build ignora errores de TS).
- Driving manual: adjuntar una imagen, un PDF con texto, un PDF escaneado, un CSV y un
  Excel multi-hoja; confirmar resumen en el prompt, `query_uploaded_table` y
  `join_uploaded_table` contra el CRM.
- La ruta de procesamiento se puede ejercitar con archivos de muestra vía la UI.
```
