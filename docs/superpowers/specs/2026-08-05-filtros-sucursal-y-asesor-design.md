# Filtros globales de sucursal y asesor

**Fecha:** 2026-08-05
**Ámbito:** `lib/panel-filters.ts` (nuevo), `scripts/verify-panel-filters.ts` (nuevo),
`components/dashboard/multi-select-filter.tsx` (nuevo),
`components/dashboard/date-range-filter.tsx`, `app/page.tsx`, `package.json`, `CLAUDE.md`.

## Qué se está construyendo

Dos menús desplegables de selección múltiple en la barra de filtros, junto al filtro de
fechas: **Sucursal** y **Asesor**. Son filtros globales del panel, del mismo tipo que la
fecha y el toggle de Importación HubSpot — cambian *de qué oportunidades está hablando el
panel completo*, no cómo dibuja un gráfico.

## Semántica

- **Selección vacía = sin filtro.** Es el estado inicial y el que deja el botón "Limpiar".
  No se usa "todas seleccionadas" como estado neutro: con esa convención, agregar una
  sucursal nueva en el CRM la dejaría fuera de un filtro que el usuario cree que no tiene
  puesto.
- **Dentro de un menú, OR; entre los dos menús, AND.** "MTY Tanarah o SLP Covalia, y
  atendidas por Zulema".
- **Aplican solo a oportunidades.** Hoy todos los gráficos de los dos paneles cuentan
  oportunidades; los contactos no tienen sucursal propia (la sucursal vive en un custom
  field de la oportunidad), así que filtrarlos sería inventar una atribución.
- **Se aplican en `app/page.tsx`, junto al filtro de HubSpot y *antes* del filtro de
  fechas**, sobre `scopedOpportunities`. Así las slices filtradas por fecha y los sets
  `all*` que resuelven los drill-downs ven exactamente el mismo universo — un drill-down
  nunca puede sacar a la luz un registro que los gráficos excluyeron. Es la misma regla que
  ya obedece el toggle de HubSpot.
- **El asistente IA queda exento**, igual que con la fecha y HubSpot: siempre razona sobre
  el dataset completo.

## La sucursal: un solo campo lógico sobre dos campos reales

La sucursal vive en un custom field **distinto por línea de negocio** (`Sucursal VAEO` /
`Sucursal MESH`, ver `PANEL_SCOPES`). Una oportunidad solo puebla el de su embudo, así que
`sucursalOf(opp)` puede leer el primero no vacío de los dos y devolver un valor único sin
saber de qué panel es. Eso permite **un solo menú global** en una barra que vive por encima
de las pestañas.

Consecuencia aceptada: `QRO Central Park` existe en las dos líneas y se selecciona una sola
vez, filtrando en ambos paneles. Es lo correcto — es la misma sucursal física. Y si se
elige una sucursal que solo existe en VAEO y se cambia a la pestaña MESH, MESH sale vacío;
eso es honesto, no un bug, y el contador del botón ("Sucursal · 2") deja ver por qué.

**Las opciones se derivan del dataset**, no se hardcodean: el menú lista los valores
distintos que traen las oportunidades cargadas, ordenados alfabéticamente, más
**"Sin sucursal"** al final para que esos registros sigan siendo alcanzables. Una sucursal
nueva en el CRM aparece sola.

## El asesor: tres nombres, fijos

El cliente pidió explícitamente **solo Zulema, Dariana y Diana**. En GHL son
`Zulema Silva`, `Dariana Turrubiates` y `Diana Arbelaez` (verificado contra `/users/` el
2026-08-05), y `opp.assignedTo` ya trae el nombre resuelto por la ruta de sync.

La lista va **hardcodeada** — es una decisión de negocio, no un dato: la subcuenta tiene
nueve usuarios, de los cuales el resto son dueño, marketing y soporte, y ofrecerlos como
opciones de un filtro de ventas sería ruido. Hardcodear los nombres de VAEO es la práctica
declarada de este repo.

El match es por **primer nombre**, normalizado sin acentos y sin distinguir mayúsculas, no
por igualdad del nombre completo: si alguien corrige un apellido en GHL el filtro no debe
dejar de funcionar en silencio. Los tres primeros nombres son distinguibles entre sí
(`diana` no es subcadena de `dariana` — la comparación es de token completo, de todos
modos).

Con un asesor seleccionado, las oportunidades **sin asignar o de cualquier otra persona
quedan fuera**. No se ofrece una opción "Sin asesor": el usuario pidió filtrar *por* asesor.

## El componente: `multi-select-filter.tsx`

Un solo `MultiSelectFilter` genérico montado dos veces (`Popover` + filas con `Checkbox`,
ambos ya en `components/ui`). Nada de `Select` de shadcn — no hace selección múltiple.

- **Botón**: ícono + etiqueta. Sin selección se ve como el resto de la barra; con selección
  se pinta como activo y muestra el conteo (`Sucursal · 2`), que es lo que evita el clásico
  "¿por qué no salen datos?" con un filtro puesto y olvidado.
- **Contenido**: filas con checkbox, más "Limpiar" cuando hay algo seleccionado. Si la
  lista pasa de ~10 opciones lleva un `overflow-y-auto` simple — no `ScrollArea`, que en
  este repo rompe `truncate`.
- **Estado vacío**: si el dataset no trajo ninguna opción, el botón se deshabilita.

## Verificación

Módulo puro nuevo ⇒ script de aserciones nuevo, `scripts/verify-panel-filters.ts`
(`pnpm verify:filters`):

1. Selección vacía devuelve **la misma referencia** del arreglo, no una copia — igual que
   `applyHubspotFilter`, para no romper memos aguas abajo.
2. `sucursalOf` lee el campo de VAEO o el de MESH indistintamente, y devuelve la cubeta
   vacía cuando ninguno está puesto (incluido un valor de solo espacios).
3. Filtro por sucursal: OR dentro del menú, y "Sin sucursal" alcanza a los que no tienen.
4. Filtro por asesor: match por primer nombre, sin acentos ni mayúsculas; una oportunidad
   sin asignar o de otra persona no entra.
5. Los dos filtros combinan con AND.
6. `collectSucursales` devuelve valores distintos, ordenados, sin la cubeta vacía (que el
   menú agrega aparte).

Más `npx tsc --noEmit` y una pasada por la app real.

## Fuera de alcance

- Filtrar contactos, citas, tareas o pautas por estos criterios.
- Persistir la selección entre sesiones (localStorage / querystring).
- Exponer los filtros al asistente IA o al PDF.
- Cualquier otro corte (servicio, origen de lead, etapa) — el mismo componente los soporta
  cuando se pidan.
