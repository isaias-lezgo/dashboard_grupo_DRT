# Filtro global por Origen de Lead / Canal de Contacto — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir dos menús desplegables a la barra de filtros —"Origen de lead" y "Canal de contacto"— que recortan los paneles VAEO y MESH, listando cada grafía capturada por separado para que los errores de captura del CRM sean visibles.

**Architecture:** Origen y canal entran como dos dimensiones más del mecanismo de filtros globales que ya existe (`PanelFilters` / `applyPanelFilters` / `MultiSelectFilter`), aplicadas en `app/page.tsx` sobre el set de oportunidades antes del corte por fecha. Lo específico de categorías —extraer grafías crudas, construir y ordenar las opciones, marcar variantes— vive en un módulo nuevo `lib/category-filter.ts`, la contraparte **sin agrupar** de `lib/opportunity-breakdown.ts`.

**Tech Stack:** Next.js 16 (App Router), React, TypeScript, Tailwind CSS v3, shadcn/ui (Popover, Checkbox, Input), Radix, `tsx` + `node:assert/strict` para los scripts de verificación.

**Spec:** `docs/superpowers/specs/2026-08-05-filtro-global-origen-canal-design.md`

## Global Constraints

- **Gestor de paquetes: pnpm.** Nunca `npm install`. Este plan no añade dependencias.
- **`npx tsc --noEmit` es la única puerta real.** `next build` ignora errores de TypeScript y `pnpm lint` está roto (`eslint` no es dependencia del repo).
- **No hay framework de tests.** La verificación son scripts `scripts/verify-*.ts` con `node:assert/strict`, corridos con `tsx`.
- **El paquete es CommonJS** (no hay `"type": "module"`): `tsx` compila a CJS y **el top-level `await` falla**. Todo script envuelve su trabajo en `function main()` y termina con `main()`.
- **Nunca un `ScrollArea` de Radix para listas con `truncate`** — lo rompe. Se usa un `div` con `overflow-y-auto`.
- **Los comentarios de estos archivos van en español**, en el tono de los módulos vecinos (`lib/panel-filters.ts`, `lib/opportunity-breakdown.ts`): explican *por qué*, no *qué*.
- **Punto de aplicación invariable:** los filtros se aplican en `app/page.tsx` sobre el set de oportunidades **antes** del corte por fecha, para que las slices filtradas y los sets `all*` de los drill-downs vean el mismo universo.
- **La base de partida son los filtros de sucursal y asesor**, ya commiteados (`0f746b8`, `225c215`). Al empezar, `npx tsc --noEmit` sale limpio y `pnpm verify:filters` / `pnpm verify:breakdown` pasan. Si no es así, para y avisa antes de tocar nada.

## File Structure

| Archivo | Responsabilidad | Acción |
|---|---|---|
| `lib/opportunity-breakdown.ts` | Agregación de los charts. Dueño de la normalización y las etiquetas oficiales | Modificar (2 cambios aditivos) |
| `lib/category-filter.ts` | Grafías crudas, opciones del menú, orden jerárquico, emparejamiento | **Crear** |
| `lib/panel-filters.ts` | Estado y aplicación de los 4 menús globales | Modificar |
| `components/dashboard/multi-select-filter.tsx` | El menú genérico de la barra | Modificar (2 props opcionales) |
| `app/page.tsx` | Estado, opciones y montaje de los menús; etiqueta del periodo | Modificar |
| `scripts/verify-category-filter.ts` | Aserciones del módulo nuevo | **Crear** |
| `scripts/verify-breakdown.ts` | Aserciones de la agregación | Modificar |
| `scripts/verify-panel-filters.ts` | Aserciones de los filtros globales | Modificar |
| `package.json` | Script `verify:category-filter` | Modificar |
| `CLAUDE.md` | Documentación del repo | Modificar |

---

### Task 1: `normalizeCategoryKey` y `CategoryRow.key`

Dos cambios aditivos a `lib/opportunity-breakdown.ts`. Ninguno cambia lo que los charts muestran hoy: `normalizeCategoryKey` es la extracción de lógica que ya está en línea, y `key` es un campo nuevo que nadie lee todavía.

Existen porque el módulo del filtro (Task 2) necesita **la misma** normalización que los charts para ordenar, y la verificación necesita poder atar un grupo del menú a la fila que el chart dibuja.

**Files:**
- Modify: `lib/opportunity-breakdown.ts`
- Test: `scripts/verify-breakdown.ts`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces:
  - `export const NO_VALUE_KEY: string` — centinela `"\u0000sin-dato"`
  - `export function normalizeCategoryKey(raw: string): string`
  - `CategoryRow` gana `key: string`

- [ ] **Step 1: Escribe las aserciones que fallan**

En `scripts/verify-breakdown.ts`, añade `NO_VALUE_KEY` y `normalizeCategoryKey` al import desde `../lib/opportunity-breakdown`, y mete este bloque nuevo justo **después** del bloque `// 3. La clave de agrupamiento une las variantes de grafía.`:

```ts
  // 3b. normalizeCategoryKey = categoryKey + los alias. Es la que consume
  // lib/category-filter.ts para ordenar; si las dos se separan, las variantes
  // dejan de salir juntas en el menú y el error de captura se vuelve invisible.
  {
    assert.equal(normalizeCategoryKey("Walk-in"), normalizeCategoryKey("WALK IN"));
    assert.equal(
      normalizeCategoryKey("Inmobiliaria"),
      "inmobiliario",
      "el alias se aplica, no solo la clave"
    );
    assert.equal(normalizeCategoryKey("Correo InfoVAEO"), "correo info vaeo");
    assert.equal(
      normalizeCategoryKey("Meta"),
      categoryKey("Meta"),
      "sin alias, es exactamente categoryKey"
    );
    assert.notEqual(
      NO_VALUE_KEY,
      normalizeCategoryKey(NO_VALUE_LABEL),
      "el centinela no colisiona con nada capturable"
    );
  }
```

Y añade estas tres aserciones a bloques existentes:

En el bloque `// 4. Origen: agrupamiento, etiqueta canónica, alias y orden.`, después de la aserción de `Inmobiliario`:

```ts
    assert.equal(
      rowFor(rows, "Inmobiliario").key,
      "inmobiliario",
      "la fila lleva su clave, para atarla a las opciones del menú del filtro"
    );
    assert.equal(rowFor(rows, "Walk In").key, "walk in");
```

En el bloque `// 8. Sin dato: nunca se descarta, y siempre va al final.`, después de `assert.equal(last.label, NO_VALUE_LABEL);`:

```ts
    assert.equal(last.key, NO_VALUE_KEY, "la fila Sin dato lleva el centinela");
```

- [ ] **Step 2: Corre la verificación y comprueba que falla**

Run: `pnpm verify:breakdown`
Expected: FAIL. `tsx` truena al importar: `normalizeCategoryKey` y `NO_VALUE_KEY` no existen todavía en el módulo.

- [ ] **Step 3: Implementa los dos cambios**

En `lib/opportunity-breakdown.ts`:

**(a)** Junto a `NO_VALUE_LABEL` (hoy línea 153), añade el centinela:

```ts
export const NO_VALUE_LABEL = "Sin dato"

/**
 * Clave de la cubeta "Sin dato", para los menús de filtro. Empieza con un byte
 * nulo para que ninguna grafía capturada por una persona pueda colisionar con
 * ella — es un valor seleccionable más, no un hueco.
 */
export const NO_VALUE_KEY = "\u0000sin-dato"
```

**(b)** Justo **después** de la declaración de `KEY_ALIASES` (hoy termina en la línea 217), añade:

```ts
/**
 * La clave definitiva de agrupamiento: `categoryKey()` más los alias. Es la que
 * decide qué grafías son "el mismo valor".
 *
 * Existe como función exportada, y no en línea dentro de buildCategoryBreakdown,
 * porque lib/category-filter.ts la necesita para ordenar su menú. Dos
 * definiciones separadas harían que un alias nuevo dejara de agrupar en un lado
 * — y eso no truena, solo separa dos filas que debían ir juntas.
 */
export function normalizeCategoryKey(raw: string): string {
  const key = categoryKey(raw)
  return KEY_ALIASES[key] ?? key
}
```

**(c)** En `interface CategoryRow`, añade el campo:

```ts
export interface CategoryRow {
  /** Clave normalizada del grupo; NO_VALUE_KEY en la fila "Sin dato". */
  key: string
  label: string
  count: number
  /** Porcentaje sobre el total de oportunidades, 0–100. */
  pct: number
  oppIds: string[]
}
```

**(d)** Dentro de `buildCategoryBreakdown`, reemplaza las dos líneas que calculan la clave:

```ts
      const rawKey = categoryKey(raw)
      const key = KEY_ALIASES[rawKey] ?? rawKey
```

por:

```ts
      const key = normalizeCategoryKey(raw)
```

**(e)** En el `.map()` que arma las filas, añade `key`:

```ts
  const rows: CategoryRow[] = [...groups.entries()]
    .map(([key, g]) => ({
      key,
      label: CANONICAL_LABELS[key] ?? mostFrequent(g.spellings),
      count: g.oppIds.length,
      pct: pctOf(g.oppIds.length),
      oppIds: g.oppIds,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "es"))
```

**(f)** En el bloque que empuja la fila "Sin dato", añade su clave:

```ts
  if (missing.length > 0) {
    rows.push({
      key: NO_VALUE_KEY,
      label: NO_VALUE_LABEL,
      count: missing.length,
      pct: pctOf(missing.length),
      oppIds: missing,
    })
  }
```

- [ ] **Step 4: Corre la verificación y el compilador**

Run: `pnpm verify:breakdown && npx tsc --noEmit`
Expected: `verify-breakdown: all assertions passed`, y `tsc` sin salida.

Si `tsc` se queja de algún consumidor de `CategoryRow`, es porque construye la fila a mano en vez de recibirla de `buildCategoryBreakdown`. Revisa `lib/lost-reason-matrix.ts` y `components/dashboard/category-breakdown-chart.tsx` y añade el `key` que falte — **no** vuelvas opcional el campo.

- [ ] **Step 5: Commit**

```bash
git add lib/opportunity-breakdown.ts scripts/verify-breakdown.ts
git commit -m "feat(lib): exportar normalizeCategoryKey y la clave de cada CategoryRow"
```

---

### Task 2: `lib/category-filter.ts`

El módulo nuevo. Puro y sin React. Es la contraparte **sin agrupar** de `opportunity-breakdown.ts`: lista cada grafía tal como está capturada, y solo usa la normalización para **ordenar** y para **marcar variantes**, nunca para fusionar.

**Files:**
- Create: `lib/category-filter.ts`
- Create: `scripts/verify-category-filter.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes (de Task 1): `normalizeCategoryKey(raw: string): string`, `NO_VALUE_KEY: string`, `CategoryRow.key`. Y de lo que ya existía: `ORIGEN_FIELDS`, `CANAL_FIELDS`, `NO_VALUE_LABEL`, `categoryValuesOf(opp, fieldNames)`, `buildCategoryBreakdown(opps, fieldNames)`.
- Produces:
  - `type CategoryDimension = "origen" | "canal"`
  - `CATEGORY_DIMENSIONS: Record<CategoryDimension, { label: string; fields: string[] }>`
  - `interface CategoryOption { value: string; label: string; count: number; groupKey: string; variantCount: number; muted?: boolean }`
  - `categorySpellingsOf(opp: Opportunity, dimension: CategoryDimension): string[]`
  - `matchesCategory(opp: Opportunity, dimension: CategoryDimension, selected: ReadonlySet<string>): boolean`
  - `buildCategoryOptions(opps: Opportunity[], dimension: CategoryDimension): CategoryOption[]`
  - `withPinnedSelection(options: CategoryOption[], selected: string[]): CategoryOption[]`

> **Nota sobre `matchesCategory`:** recibe un `ReadonlySet`, no un arreglo. Se llama una vez por oportunidad dentro del `.filter()` de `applyPanelFilters`; con un arreglo habría que construir un `Set` en cada iteración. El llamador lo arma una sola vez, igual que ya hace con `sucursales` y `asesores`.

- [ ] **Step 1: Escribe el script de verificación que falla**

Crea `scripts/verify-category-filter.ts`:

```ts
// Verification for lib/category-filter.ts — los menús de "Origen de lead" y
// "Canal de contacto" de la barra de filtros.
// Run: pnpm verify:category-filter
//
// Este módulo existe para NO agrupar, mientras el de al lado
// (lib/opportunity-breakdown.ts) sí agrupa. Esa asimetría es deliberada y es
// justo lo que un refactor bienintencionado rompería: alguien "arregla" la
// duplicación fusionando los dos, y el cliente deja de ver que "WALK IN" y
// "Walk In" son dos grafías del mismo valor mal capturado.
//
// La aserción central es la de más abajo: la unión de las oportunidades que
// matchean todas las grafías de un grupo tiene que ser exactamente el oppIds de
// la fila que ese grupo dibuja en el chart. Ata el menú al panel.
//
// Wrapped in main() rather than using top-level await: this package is CJS.
import assert from "node:assert/strict";
import type { Opportunity } from "../lib/types";
import {
  buildCategoryBreakdown,
  NO_VALUE_KEY,
  NO_VALUE_LABEL,
  ORIGEN_FIELDS,
} from "../lib/opportunity-breakdown";
import {
  buildCategoryOptions,
  categorySpellingsOf,
  matchesCategory,
  withPinnedSelection,
} from "../lib/category-filter";

let seq = 0;

function opp(fields?: Record<string, string | string[]>): Opportunity {
  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: "pipe-1",
    pipelineStageId: "stage-1",
    status: "open",
    createdAt: "2026-06-15T12:00:00.000Z",
    contactId: `c${seq}`,
    value: 0,
    stage: "Nuevo Lead",
    pipelineName: "VAEO",
    customFieldsResolved: fields,
  };
}

const origen = (v: string) => opp({ "Origen de Lead": v });
const canal = (v: string) => opp({ "Canal de Contacto": v });

/** Los ids que pasan el filtro de esa dimensión con esas grafías marcadas. */
const idsMatching = (opps: Opportunity[], dim: "origen" | "canal", sel: string[]) =>
  opps.filter((o) => matchesCategory(o, dim, new Set(sel))).map((o) => o.id);

function main() {
  // 1. Las grafías se listan por separado: NO se agrupan.
  {
    // Conteos todos distintos a propósito: un empate dejaría el orden a merced
    // del desempate alfabético entre " " y "-", que no es lo que se prueba aquí.
    const opps = [
      origen("Walk In"),
      origen("Walk In"),
      origen("Walk In"),
      origen("WALK IN"),
      origen("WALK IN"),
      origen("walk-in"),
      origen("Meta"),
    ];
    const options = buildCategoryOptions(opps, "origen");

    assert.deepEqual(
      options.map((o) => o.value),
      ["Walk In", "WALK IN", "walk-in", "Meta"],
      "cuatro grafías, cuatro filas — el grupo grande primero y sus variantes pegadas"
    );
    assert.deepEqual(options.map((o) => o.count), [3, 2, 1, 1]);
    assert.deepEqual(
      options.map((o) => o.variantCount),
      [3, 3, 3, 1],
      "las tres del grupo se marcan; Meta va sola"
    );
    assert.equal(
      options[0].label,
      "Walk In",
      "la etiqueta es la grafía cruda, no la oficial del picklist"
    );

    // Marcar una variante NO trae las otras. Es el punto de todo el módulo.
    assert.deepEqual(
      idsMatching(opps, "origen", ["WALK IN"]).length,
      1,
      "WALK IN selecciona solo su propio registro"
    );
  }

  // 1b. Los alias tampoco fusionan: son errores de captura igual de visibles.
  {
    const opps = [origen("Inmobiliaria"), origen("Inmobiliario")];
    const options = buildCategoryOptions(opps, "origen");
    assert.equal(options.length, 2, "el alias agrupa para ordenar, no para fusionar");
    assert.equal(options[0].variantCount, 2, "pero sí se marcan como variantes entre sí");
    assert.equal(idsMatching(opps, "origen", ["Inmobiliaria"]).length, 1);
  }

  // 2. El espacio de los extremos SÍ se colapsa: esa diferencia no se ve en
  // pantalla, y dos filas idénticas parecerían un bug del panel, no del dato.
  {
    const options = buildCategoryOptions([origen("Walk In"), origen(" Walk In ")], "origen");
    assert.deepEqual(options.map((o) => o.value), ["Walk In"]);
    assert.equal(options[0].count, 2);
    assert.equal(options[0].variantCount, 1, "no son variantes: son la misma grafía");
  }

  // 3. Orden jerárquico: grupos por total descendente, grafías dentro del grupo
  // por su propio conteo. Sin esto, "WALK IN 1" queda a treinta filas de
  // "Walk In 30" y el error tipográfico se vuelve invisible.
  {
    const opps = [
      ...Array.from({ length: 5 }, () => origen("Meta")),
      origen("Walk In"),
      origen("Walk In"),
      origen("Walk In"),
      origen("WALK IN"),
      origen("meta"),
    ];
    const options = buildCategoryOptions(opps, "origen");
    assert.deepEqual(
      options.map((o) => `${o.value}:${o.count}`),
      ["Meta:5", "meta:1", "Walk In:3", "WALK IN:1"],
      "grupo meta (6) antes que grupo walk in (4); dentro, la mayoritaria primero"
    );
    assert.deepEqual(options.map((o) => o.variantCount), [2, 2, 2, 2]);
  }

  // 4. "Sin dato" es seleccionable, va al final y viene en gris.
  {
    const opps = [origen("Meta"), opp(), opp({ "Origen de Lead": "" })];
    const options = buildCategoryOptions(opps, "origen");
    const last = options[options.length - 1];
    assert.equal(last.value, NO_VALUE_KEY);
    assert.equal(last.label, NO_VALUE_LABEL);
    assert.equal(last.count, 2, "sin campo y con campo vacío son lo mismo");
    assert.equal(last.muted, true);
    assert.equal(
      idsMatching(opps, "origen", [NO_VALUE_KEY]).length,
      2,
      "la cubeta vacía es alcanzable desde la barra, no un agujero"
    );
  }

  // 5. Sin selección, pasa todo.
  {
    const opps = [origen("Meta"), opp()];
    assert.equal(idsMatching(opps, "origen", []).length, 2, "menú vacío no filtra");
  }

  // 6. Celda multivalor: coincide por cualquiera de sus valores, y aparece en
  // las dos opciones.
  {
    const multi = origen("Meta, Sitio Web");
    const opps = [multi, origen("Meta")];
    assert.ok(idsMatching(opps, "origen", ["Sitio Web"]).includes(multi.id));
    assert.ok(idsMatching(opps, "origen", ["Meta"]).includes(multi.id));
    assert.equal(idsMatching(opps, "origen", ["Meta"]).length, 2);

    const options = buildCategoryOptions(opps, "origen");
    assert.equal(options.find((o) => o.value === "Sitio Web")?.count, 1);
  }

  // 6b. Un valor repetido idéntico en la misma celda no cuenta doble.
  {
    const options = buildCategoryOptions([origen("Meta, Meta")], "origen");
    assert.deepEqual(options.map((o) => o.count), [1]);
    assert.deepEqual(categorySpellingsOf(origen("Meta, Meta"), "origen"), ["Meta"]);
  }

  // 7. Las dos dimensiones leen campos distintos y no se contaminan.
  {
    const opps = [canal("WhatsApp"), origen("Meta")];
    assert.deepEqual(
      buildCategoryOptions(opps, "canal").map((o) => o.value),
      ["WhatsApp", NO_VALUE_KEY]
    );
    assert.equal(idsMatching(opps, "canal", ["Meta"]).length, 0, "Meta no es un canal");
  }

  // 8. LA ASERCIÓN CENTRAL: el menú no inventa ni pierde registros respecto del
  // chart. Para cada fila del breakdown, las opciones de su grupo tienen que
  // cubrir exactamente sus oppIds.
  //
  // Se compara como CONJUNTO de ids, no como suma de conteos: una celda
  // "Meta, meta" cuenta 1 en el chart (deduplica por clave) pero aparece en las
  // dos opciones del menú, así que la suma daría 2 y el conjunto da 1.
  {
    const opps = [
      origen("Meta"),
      origen("meta"),
      origen("Meta, meta"),
      origen("Walk In"),
      origen("WALK IN"),
      origen("Inmobiliaria"),
      origen("Inmobiliario"),
      origen("Meta, Sitio Web"),
      opp(),
    ];
    const rows = buildCategoryBreakdown(opps, ORIGEN_FIELDS);
    const options = buildCategoryOptions(opps, "origen");

    for (const row of rows) {
      const spellings = options
        .filter((o) => o.groupKey === row.key)
        .map((o) => o.value);
      assert.ok(
        spellings.length > 0,
        `la fila "${row.label}" tiene al menos una grafía en el menú`
      );
      assert.deepEqual(
        new Set(idsMatching(opps, "origen", spellings)),
        new Set(row.oppIds),
        `las grafías de "${row.label}" cubren exactamente lo que el chart dibuja`
      );
    }
  }

  // 9. withPinnedSelection: una grafía marcada que ya no está en la lista se
  // dibuja igual, al final y en cero, o quedaría un filtro activo invisible
  // vaciando el panel sin manera de apagarlo.
  {
    const options = buildCategoryOptions([origen("Meta")], "origen");
    const pinned = withPinnedSelection(options, ["Meta", "Google ADs"]);
    assert.deepEqual(pinned.map((o) => o.value), ["Meta", "Google ADs"]);
    assert.equal(pinned[1].count, 0);
    assert.equal(pinned[1].label, "Google ADs", "se muestra la grafía marcada tal cual");

    assert.equal(
      withPinnedSelection(options, ["Meta"]),
      options,
      "sin nada que fijar, la misma referencia"
    );

    // El centinela fijado se dibuja con su etiqueta legible, no con el byte nulo.
    const conSinDato = withPinnedSelection(options, [NO_VALUE_KEY]);
    assert.equal(conSinDato[conSinDato.length - 1].label, NO_VALUE_LABEL);
  }

  // 10. Conjunto vacío.
  {
    assert.deepEqual(buildCategoryOptions([], "origen"), []);
  }

  console.log("verify-category-filter: all assertions passed");
}

main();
```

- [ ] **Step 2: Registra el script en `package.json`**

En el bloque `"scripts"`, después de `"verify:breakdown"`:

```json
    "verify:category-filter": "tsx scripts/verify-category-filter.ts",
```

- [ ] **Step 3: Corre la verificación y comprueba que falla**

Run: `pnpm verify:category-filter`
Expected: FAIL — `Cannot find module '../lib/category-filter'`.

- [ ] **Step 4: Implementa el módulo**

Crea `lib/category-filter.ts`:

```ts
// Los menús de "Origen de lead" y "Canal de contacto" de la barra de filtros.
//
// Es la contraparte SIN AGRUPAR de lib/opportunity-breakdown.ts, y esa asimetría
// es el punto:
//
//   - El chart agrupa `Walk In` / `WALK IN` / `walk-in` en una barra, porque un
//     ranking partido en filas de un registro deja de responder "cuánto viene de
//     Walk In".
//   - El menú las lista por separado, porque una grafía repetida es un error de
//     captura que el dueño del CRM tiene que corregir en GHL — y no puede
//     corregir lo que no ve.
//
// Por eso NO fusiones los dos módulos. La normalización se usa aquí solo para
// ordenar (que las variantes salgan pegadas) y para marcar cuántas hay; nunca
// para unir dos opciones en una.
import type { Opportunity } from "./types"
import {
  CANAL_FIELDS,
  categoryValuesOf,
  normalizeCategoryKey,
  NO_VALUE_KEY,
  NO_VALUE_LABEL,
  ORIGEN_FIELDS,
} from "./opportunity-breakdown"

export type CategoryDimension = "origen" | "canal"

export const CATEGORY_DIMENSIONS: Record<
  CategoryDimension,
  { label: string; fields: string[] }
> = {
  origen: { label: "Origen de lead", fields: ORIGEN_FIELDS },
  canal: { label: "Canal de contacto", fields: CANAL_FIELDS },
}

export interface CategoryOption {
  /** La grafía cruda: es a la vez el valor guardado y lo que se pinta. */
  value: string
  label: string
  count: number
  /**
   * Clave del grupo al que pertenece la grafía. SOLO para ordenar y para contar
   * variantes — dos opciones con el mismo groupKey siguen siendo dos opciones.
   */
  groupKey: string
  /** Cuántas grafías tiene su grupo. 1 = no hay error de captura que mostrar. */
  variantCount: number
  /** La cubeta "Sin dato": va al final y en gris, como "Sin sucursal". */
  muted?: boolean
}

/**
 * Las grafías distintas de una oportunidad en esa dimensión, ya recortadas.
 * Sin valor devuelve [NO_VALUE_KEY]: "Sin dato" es una opción más del menú, no
 * un hueco.
 *
 * Se deduplica por cadena exacta ("Meta, Meta" es un solo valor) pero NO por
 * clave: "Meta, meta" son dos grafías y cuentan en las dos opciones.
 */
export function categorySpellingsOf(
  opp: Opportunity,
  dimension: CategoryDimension
): string[] {
  const values = categoryValuesOf(opp, CATEGORY_DIMENSIONS[dimension].fields)
  if (values.length === 0) return [NO_VALUE_KEY]
  return [...new Set(values)]
}

/**
 * ¿Pasa esta oportunidad el menú de esa dimensión? Selección vacía = pasa todo.
 *
 * Recibe un Set y no un arreglo porque se llama una vez por oportunidad dentro
 * del filter() de applyPanelFilters; el llamador lo arma una sola vez.
 */
export function matchesCategory(
  opp: Opportunity,
  dimension: CategoryDimension,
  selected: ReadonlySet<string>
): boolean {
  if (selected.size === 0) return true
  return categorySpellingsOf(opp, dimension).some((v) => selected.has(v))
}

/**
 * Una opción por grafía distinta, ordenada en dos niveles: los grupos por su
 * total descendente, y dentro de cada grupo las grafías por su propio conteo.
 *
 * Ese orden es lo que hace visible el error: ordenado solo por conteo, "WALK IN"
 * con 2 registros quedaría treinta filas debajo de "Walk In" con 31, y nadie
 * notaría que son el mismo valor mal capturado.
 *
 * Los empates se rompen alfabéticamente para que el orden sea estable entre
 * renders. "Sin dato" siempre al final: es una fuga de atribución, no una
 * categoría que compita en el ranking.
 */
export function buildCategoryOptions(
  opps: Opportunity[],
  dimension: CategoryDimension
): CategoryOption[] {
  const counts = new Map<string, number>()
  for (const opp of opps) {
    for (const spelling of categorySpellingsOf(opp, dimension)) {
      counts.set(spelling, (counts.get(spelling) ?? 0) + 1)
    }
  }

  // Totales y número de grafías por grupo — los dos niveles del orden.
  const groupTotals = new Map<string, number>()
  const groupSpellings = new Map<string, number>()
  for (const [value, n] of counts) {
    if (value === NO_VALUE_KEY) continue
    const groupKey = normalizeCategoryKey(value)
    groupTotals.set(groupKey, (groupTotals.get(groupKey) ?? 0) + n)
    groupSpellings.set(groupKey, (groupSpellings.get(groupKey) ?? 0) + 1)
  }

  const options: CategoryOption[] = []
  for (const [value, count] of counts) {
    if (value === NO_VALUE_KEY) continue
    const groupKey = normalizeCategoryKey(value)
    options.push({
      value,
      label: value,
      count,
      groupKey,
      variantCount: groupSpellings.get(groupKey) ?? 1,
    })
  }

  options.sort((a, b) => {
    if (a.groupKey !== b.groupKey) {
      const byGroup = (groupTotals.get(b.groupKey) ?? 0) - (groupTotals.get(a.groupKey) ?? 0)
      if (byGroup !== 0) return byGroup
      return a.groupKey.localeCompare(b.groupKey, "es")
    }
    return b.count - a.count || a.value.localeCompare(b.value, "es")
  })

  const sinDato = counts.get(NO_VALUE_KEY) ?? 0
  if (sinDato > 0) {
    options.push({
      value: NO_VALUE_KEY,
      label: NO_VALUE_LABEL,
      count: sinDato,
      groupKey: NO_VALUE_KEY,
      variantCount: 1,
      muted: true,
    })
  }

  return options
}

/**
 * Añade al final, con conteo 0, las grafías marcadas que ya no están en la
 * lista — porque se movió el rango de fechas, o se cambió de pestaña y ese valor
 * no existe en el otro pipeline.
 *
 * Sin esto queda un filtro activo invisible: el panel sale vacío y el menú no
 * ofrece manera de apagarlo.
 */
export function withPinnedSelection(
  options: CategoryOption[],
  selected: string[]
): CategoryOption[] {
  const present = new Set(options.map((o) => o.value))
  const missing = selected.filter((v) => !present.has(v))
  if (missing.length === 0) return options

  return [
    ...options,
    ...missing.map((value) => ({
      value,
      label: value === NO_VALUE_KEY ? NO_VALUE_LABEL : value,
      count: 0,
      groupKey: value === NO_VALUE_KEY ? NO_VALUE_KEY : normalizeCategoryKey(value),
      variantCount: 1,
      muted: true,
    })),
  ]
}
```

- [ ] **Step 5: Corre la verificación y el compilador**

Run: `pnpm verify:category-filter && npx tsc --noEmit`
Expected: `verify-category-filter: all assertions passed`, y `tsc` sin salida.

- [ ] **Step 6: Commit**

```bash
git add lib/category-filter.ts scripts/verify-category-filter.ts package.json
git commit -m "feat(lib): opciones de origen y canal sin agrupar las grafías"
```

---

### Task 3: Origen y canal como dimensiones de `PanelFilters`

Un solo objeto de estado y una sola función de aplicación para los cuatro menús: es lo que garantiza que se combinen entre sí (AND) sin escribir el cruce dos veces.

**Files:**
- Modify: `lib/panel-filters.ts`
- Test: `scripts/verify-panel-filters.ts`

**Interfaces:**
- Consumes (de Task 2): `matchesCategory(opp, dimension, selected: ReadonlySet<string>)`.
- Produces: `PanelFilters` gana `origen: string[]` y `canal: string[]`; `EMPTY_PANEL_FILTERS` los incluye; `applyPanelFilters` y `activeFilterCount` los contemplan.

> **Ojo:** añadir dos campos requeridos rompe la compilación de todos los literales `{ sucursales, asesores }` que hoy existen en `scripts/verify-panel-filters.ts`. Se arreglan con un helper en el propio script (Step 1), no volviendo opcionales los campos.

- [ ] **Step 1: Escribe las aserciones que fallan**

En `scripts/verify-panel-filters.ts`:

**(a)** Añade `type PanelFilters` al import desde `../lib/panel-filters`.

**(b)** Justo antes de `function main()`, añade el helper y actualiza el fabricador de oportunidades para que acepte categorías:

```ts
/** Filtros parciales sobre el estado vacío: aísla al script de campos nuevos. */
const filters = (p: Partial<PanelFilters>): PanelFilters => ({
  ...EMPTY_PANEL_FILTERS,
  ...p,
});
```

**(c)** Reemplaza **todos** los literales `{ sucursales: [...], asesores: [...] }` pasados a `applyPanelFilters` y `activeFilterCount` por llamadas al helper — están en los bloques 3, 4 y 5. Los `EMPTY_PANEL_FILTERS` que ya se pasan tal cual no se tocan. Por ejemplo:

```ts
    const two = applyPanelFilters(opps, filters({ sucursales: ["MTY Tanarah", "MTY Varzor"] }));
```

```ts
    assert.equal(activeFilterCount(filters({ sucursales: ["MTY Tanarah"], asesores: ["zulema"] })), 2);
```

**(d)** Añade `origen` al fabricador `opp()`, extendiendo su parámetro y el `resolved`:

```ts
function opp(o: {
  sucursalVaeo?: string;
  sucursalMesh?: string;
  asesor?: string;
  origen?: string;
}): Opportunity {
  const resolved: Record<string, string> = {};
  if (o.sucursalVaeo !== undefined) resolved[VAEO_FIELD] = o.sucursalVaeo;
  if (o.sucursalMesh !== undefined) resolved[MESH_FIELD] = o.sucursalMesh;
  if (o.origen !== undefined) resolved["Origen de Lead"] = o.origen;
  // … el resto igual
```

**(e)** Añade este bloque nuevo al final de `main()`, justo antes del `console.log`:

```ts
  // 7. Los CUATRO menús cruzan con AND. Esta es la razón de que origen y canal
  // vivan en el mismo objeto de estado que sucursal y asesor: el cruce está
  // escrito una sola vez.
  {
    const opps = [
      opp({ sucursalVaeo: "MTY Tanarah", asesor: "Zulema Silva", origen: "Meta" }),
      opp({ sucursalVaeo: "MTY Tanarah", asesor: "Zulema Silva", origen: "Walk In" }),
      opp({ sucursalVaeo: "SLP Covalia", asesor: "Zulema Silva", origen: "Meta" }),
      opp({ sucursalVaeo: "MTY Tanarah", asesor: "Diana Arbelaez", origen: "Meta" }),
    ];
    const all = applyPanelFilters(
      opps,
      filters({ sucursales: ["MTY Tanarah"], asesores: ["zulema"], origen: ["Meta"] })
    );
    assert.equal(all.length, 1, "sucursal Y asesor Y origen");
    assert.equal(
      activeFilterCount(filters({ origen: ["Meta"], canal: ["WhatsApp", "DM"] })),
      3,
      "la píldora de filtros activos cuenta también los dos menús nuevos"
    );

    // Las grafías NO se agrupan tampoco cruzando el filtro completo.
    const variantes = [opp({ origen: "Walk In" }), opp({ origen: "WALK IN" })];
    assert.equal(applyPanelFilters(variantes, filters({ origen: ["Walk In"] })).length, 1);

    // Y sin selección en ninguno de los cuatro, sigue siendo la misma referencia.
    assert.equal(applyPanelFilters(opps, EMPTY_PANEL_FILTERS), opps);
  }
```

- [ ] **Step 2: Corre la verificación y comprueba que falla**

Run: `pnpm verify:filters`
Expected: FAIL — `origen` y `canal` no existen en `PanelFilters`, así que `tsx` truena al tipar el helper `filters()`.

- [ ] **Step 3: Extiende el módulo**

En `lib/panel-filters.ts`:

**(a)** Añade el import:

```ts
import { matchesCategory } from "./category-filter"
```

**(b)** Extiende la interfaz y el estado vacío:

```ts
/** Estado de los cuatro menús. Arreglo vacío = ese menú no filtra nada. */
export interface PanelFilters {
  /** Valores de sucursal seleccionados; NO_SUCURSAL alcanza a los que no tienen. */
  sucursales: string[]
  /** Claves de asesor seleccionadas (las de ADVISORS). */
  asesores: string[]
  /** Grafías crudas de "Origen de Lead"; NO_VALUE_KEY alcanza a los sin dato. */
  origen: string[]
  /** Grafías crudas de "Canal de Contacto"; NO_VALUE_KEY alcanza a los sin dato. */
  canal: string[]
}

export const EMPTY_PANEL_FILTERS: PanelFilters = {
  sucursales: [],
  asesores: [],
  origen: [],
  canal: [],
}
```

**(c)** Reemplaza el cuerpo de `applyPanelFilters`:

```ts
export function applyPanelFilters(
  opps: Opportunity[],
  filters: PanelFilters
): Opportunity[] {
  const bySucursal = filters.sucursales.length > 0
  const byAsesor = filters.asesores.length > 0
  const byOrigen = filters.origen.length > 0
  const byCanal = filters.canal.length > 0
  // Misma referencia cuando no hay nada que filtrar, igual que
  // applyHubspotFilter: una copia nueva invalidaría los memos aguas abajo.
  if (!bySucursal && !byAsesor && !byOrigen && !byCanal) return opps

  const sucursales = new Set(filters.sucursales)
  const asesores = new Set(filters.asesores)
  // Los Sets de categoría se arman una vez, no una por oportunidad.
  const origen = new Set(filters.origen)
  const canal = new Set(filters.canal)

  return opps.filter((o) => {
    if (bySucursal && !sucursales.has(sucursalOf(o))) return false
    if (byAsesor) {
      const key = advisorKeyOf(o)
      if (!key || !asesores.has(key)) return false
    }
    if (byOrigen && !matchesCategory(o, "origen", origen)) return false
    if (byCanal && !matchesCategory(o, "canal", canal)) return false
    return true
  })
}
```

**(d)** Extiende `activeFilterCount`:

```ts
/** Cuántas opciones hay marcadas en total — alimenta el aviso de "filtros activos". */
export function activeFilterCount(filters: PanelFilters): number {
  return (
    filters.sucursales.length +
    filters.asesores.length +
    filters.origen.length +
    filters.canal.length
  )
}
```

- [ ] **Step 4: Corre todo lo que puede haber roto**

Run: `pnpm verify:filters && pnpm verify:category-filter && npx tsc --noEmit`
Expected: las dos verificaciones pasan y `tsc` sale sin salida.

`tsc` señalará `app/page.tsx` si construye un `PanelFilters` literal — no lo hace, usa `EMPTY_PANEL_FILTERS` y actualizaciones parciales con spread, así que debería compilar sin tocarlo.

- [ ] **Step 5: Commit**

```bash
git add lib/panel-filters.ts scripts/verify-panel-filters.ts
git commit -m "feat(lib): origen y canal como dimensiones de PanelFilters"
```

---

### Task 4: Buscador y marca de variante en `MultiSelectFilter`

Dos props **opcionales**, para que los montajes de sucursal y asesor no cambien en absoluto.

No hay script de verificación para este archivo — es un componente de React y el repo no tiene forma de renderizarlo en un harness. Se verifica compilando y manejando el panel real (Task 5).

**Files:**
- Modify: `components/dashboard/multi-select-filter.tsx`

**Interfaces:**
- Consumes: nada de tareas anteriores.
- Produces: `MultiSelectOption` gana `variantHint?: string`; `MultiSelectFilterProps` gana `searchable?: boolean`.

- [ ] **Step 1: Añade los imports**

```tsx
import { AlertTriangle, Check, ChevronDown, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
```

- [ ] **Step 2: Extiende los tipos**

```tsx
export interface MultiSelectOption {
  /** Valor guardado en el estado. */
  value: string
  label: string
  /** Cuántos registros trae — se pinta a la derecha de la fila. */
  count?: number
  /**
   * Cubetas que no son una categoría real ("Sin sucursal"): van al final y en
   * gris, para que no compitan con una sucursal de verdad.
   */
  muted?: boolean
  /**
   * Aviso de grafía duplicada. Cuando viene, la fila muestra un ⚠ con este
   * texto: es la señal de que el valor está mal capturado en el CRM, y es la
   * razón de que el menú de categorías no agrupe las variantes.
   */
  variantHint?: string
}

interface MultiSelectFilterProps {
  label: string
  icon: LucideIcon
  options: MultiSelectOption[]
  selected: string[]
  onChange: (values: string[]) => void
  /** Texto del popover cuando no hay ninguna opción en el dataset. */
  emptyMessage?: string
  /**
   * Muestra un buscador arriba de la lista. Para los menús largos (origen y
   * canal listan una fila por grafía capturada, no una por categoría).
   */
  searchable?: boolean
  className?: string
}
```

- [ ] **Step 3: Filtra la lista con el buscador**

Dentro del componente, después de `const selectedSet = …`:

```tsx
  const [query, setQuery] = React.useState("")

  // Sin acentos ni mayúsculas: escribir "walk" tiene que encontrar "Walk In",
  // "WALK IN" y "walk-in", que es justo la comparación que el usuario quiere
  // hacer cuando anda cazando grafías repetidas.
  const visible = React.useMemo(() => {
    const q = query.trim()
    if (!searchable || q === "") return options
    const norm = (s: string) =>
      s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    const needle = norm(q)
    return options.filter((o) => norm(o.label).includes(needle))
  }, [options, query, searchable])
```

Y en la firma del componente añade `searchable = false,` junto a las demás props.

- [ ] **Step 4: Limpia la búsqueda al cerrar el popover**

Reemplaza la apertura del `Popover`:

```tsx
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Que no quede una búsqueda vieja escondiendo opciones al reabrir.
        if (!next) setQuery("")
      }}
    >
```

- [ ] **Step 5: Renderiza el buscador y el aviso de variante**

Dentro del `<>` que hoy envuelve la lista, **antes** del `div` con `max-h-72`:

```tsx
            {searchable && (
              <div className="border-b border-border p-2">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar…"
                  aria-label={`Buscar en ${label.toLowerCase()}`}
                  className="h-7 text-[11px]"
                />
              </div>
            )}
```

Cambia el `.map` para recorrer `visible` en vez de `options`, y añade el ⚠ y el estado de "sin coincidencias":

```tsx
            {/* overflow-y-auto a secas: Radix ScrollArea rompe `truncate`. */}
            <div className="max-h-72 overflow-y-auto py-1">
              {visible.length === 0 ? (
                <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  Sin coincidencias
                </p>
              ) : (
                visible.map((option) => {
                  const checked = selectedSet.has(option.value)
                  return (
                    <label
                      key={option.value}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-xs transition-colors hover:bg-muted/60",
                        option.muted && "text-muted-foreground"
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(option.value)}
                        className="h-3.5 w-3.5 shrink-0"
                        aria-label={option.label}
                      />
                      {/* La grafía se pinta VERBATIM: cualquier capitalización
                          aquí volvería a esconder el error de captura. */}
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                      {option.variantHint && (
                        <span
                          title={option.variantHint}
                          aria-label={option.variantHint}
                          className="shrink-0"
                        >
                          <AlertTriangle className="h-3 w-3 text-amber-500" />
                        </span>
                      )}
                      {option.count !== undefined && (
                        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                          {option.count.toLocaleString("es-MX")}
                        </span>
                      )}
                    </label>
                  )
                })
              )}
            </div>
```

El `title` va en un `<span>` que envuelve el icono, no dentro del SVG: es lo que hace que el navegador muestre el tooltip nativo al pasar el cursor, sin depender de cómo `lucide-react` trate a sus hijos.

- [ ] **Step 6: Compila**

Run: `npx tsc --noEmit`
Expected: sin salida.

- [ ] **Step 7: Commit**

```bash
git add components/dashboard/multi-select-filter.tsx
git commit -m "feat(ui): buscador y aviso de grafía duplicada en el menú de filtros"
```

---

### Task 5: Montar los dos menús y cerrar la documentación

**Files:**
- Modify: `app/page.tsx`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `buildCategoryOptions`, `withPinnedSelection`, `CATEGORY_DIMENSIONS`, `CategoryOption` (Task 2); `PanelFilters.origen/canal` (Task 3); `searchable` y `variantHint` (Task 4); y lo que ya existía: `scopeOpportunities` (`lib/panel-scope.ts`), `MultiSelectFilter`, `MultiSelectOption`, `ADVISORS`, `NO_VALUE_KEY` / `NO_VALUE_LABEL`.
- Produces: la feature completa.

- [ ] **Step 1: Añade los imports**

En `app/page.tsx`:

```tsx
import {
  ActiveFiltersPill,
  MultiSelectFilter,
  type MultiSelectOption,
} from "@/components/dashboard/multi-select-filter"
import {
  buildCategoryOptions,
  withPinnedSelection,
  type CategoryOption,
} from "@/lib/category-filter"
import { scopeOpportunities } from "@/lib/panel-scope"
import { NO_VALUE_KEY, NO_VALUE_LABEL } from "@/lib/opportunity-breakdown"
```

Y añade `Megaphone` y `MessageSquare` al import de iconos de `lucide-react`.

- [ ] **Step 2: Calcula las opciones de los dos menús**

Después del `useMemo` de `asesorOptions`:

```tsx
  // Las opciones de origen y canal se acotan al pipeline de la pestaña activa y
  // al rango de fechas —así los conteos hablan de lo que el panel está
  // mostrando— pero NO a los filtros de panel: si se calcularan sobre el set ya
  // filtrado, marcar "Meta" borraría del menú todo lo demás.
  //
  // Es una regla distinta de la de sucursal y asesor, que se calculan sobre el
  // set completo. Está documentado en el spec como divergencia conocida.
  const categoryBase = useMemo(() => {
    if (activeTab === "conversations") return []
    const scoped = scopeOpportunities(hubspotScoped, activeTab, data?.pipelines ?? [])
    return filterByDateRange(scoped, (o) => o.createdAt, dateRange)
  }, [hubspotScoped, activeTab, data?.pipelines, dateRange])

  const origenOptions = useMemo(
    () => toMenuOptions(buildCategoryOptions(categoryBase, "origen"), panelFilters.origen),
    [categoryBase, panelFilters.origen]
  )
  const canalOptions = useMemo(
    () => toMenuOptions(buildCategoryOptions(categoryBase, "canal"), panelFilters.canal),
    [categoryBase, panelFilters.canal]
  )
```

Y **fuera** del componente (junto a `TAB_TITLES`, al inicio del archivo), el mapeo a la forma que el menú consume:

```tsx
/**
 * De opción de categoría a fila del menú. El aviso de variante es lo único que
 * se compone aquí: el módulo cuenta las grafías, la UI decide cómo se lee.
 */
function toMenuOptions(
  options: CategoryOption[],
  selected: string[]
): MultiSelectOption[] {
  return withPinnedSelection(options, selected).map((o) => ({
    value: o.value,
    label: o.label,
    count: o.count,
    muted: o.muted,
    variantHint:
      o.variantCount > 1
        ? `${o.variantCount} grafías distintas de este valor — probable error de captura en el CRM`
        : undefined,
  }))
}
```

- [ ] **Step 3: Monta los dos menús**

En el `filters={…}` del `DateRangeFilter`, entre el `MultiSelectFilter` de Asesor y el `ActiveFiltersPill`:

```tsx
              <MultiSelectFilter
                label="Origen de lead"
                icon={Megaphone}
                options={origenOptions}
                selected={panelFilters.origen}
                onChange={(origen) => setPanelFilters((f) => ({ ...f, origen }))}
                emptyMessage="Sin valores en este periodo"
                searchable
              />
              <MultiSelectFilter
                label="Canal de contacto"
                icon={MessageSquare}
                options={canalOptions}
                selected={panelFilters.canal}
                onChange={(canal) => setPanelFilters((f) => ({ ...f, canal }))}
                emptyMessage="Sin valores en este periodo"
                searchable
              />
```

- [ ] **Step 4: Di en la portada del PDF que el reporte está filtrado**

Un reporte que omite en silencio que está filtrado es un reporte que miente. El spec pide el sufijo para origen y canal; se incluyen **los cuatro** menús por la misma razón — un reporte cortado por sucursal es igual de engañoso si no lo dice.

Reemplaza el `useMemo` de `periodLabel` por:

```tsx
  // Human label of the active date filter, for the PDF report cover.
  const periodLabel = useMemo(() => {
    const base = (() => {
      switch (dateFilter.preset) {
        case "week": return "Últimos 7 días"
        case "month": return "Últimos 30 días"
        case "3m": return "Últimos 3 meses"
        case "6m": return "Últimos 6 meses"
        case "custom":
          if (!dateRange) return "Todo el historial"
          return `${format(dateRange.from, "d MMM yyyy", { locale: es })} – ${format(dateRange.to, "d MMM yyyy", { locale: es })}`
        default: return "Todo el historial"
      }
    })()

    // El alcance del reporte incluye los filtros de la barra, no solo la fecha.
    const list = (values: string[]) =>
      values.map((v) => (v === NO_VALUE_KEY ? NO_VALUE_LABEL : v)).join(", ")
    const parts = [base]
    if (panelFilters.sucursales.length) parts.push(`Sucursal: ${list(panelFilters.sucursales)}`)
    if (panelFilters.asesores.length) {
      const names = panelFilters.asesores.map(
        (k) => ADVISORS.find((a) => a.key === k)?.label ?? k
      )
      parts.push(`Asesor: ${names.join(", ")}`)
    }
    if (panelFilters.origen.length) parts.push(`Origen: ${list(panelFilters.origen)}`)
    if (panelFilters.canal.length) parts.push(`Canal: ${list(panelFilters.canal)}`)
    return parts.join(" · ")
  }, [dateFilter.preset, dateRange, panelFilters])
```

- [ ] **Step 5: Compila y corre todas las verificaciones tocadas**

Run: `npx tsc --noEmit && pnpm verify:breakdown && pnpm verify:category-filter && pnpm verify:filters`
Expected: `tsc` sin salida y las tres verificaciones con su línea `all assertions passed`.

- [ ] **Step 6: Maneja el panel real**

Run: `pnpm dev`, abre `localhost:3000` y entra al panel.

Comprueba, en este orden:
1. Los dos menús nuevos aparecen en la barra, después de Asesor, y muestran conteos.
2. Si el CRM tiene grafías repetidas, salen en filas **consecutivas** con el ⚠, y el tooltip dice cuántas son. (Si no aparece ninguna, el dato está limpio: confírmalo comparando la cantidad de opciones del menú con las barras del chart de Origen de Lead.)
3. Marcar una grafía recorta **todos** los charts del panel, incluidas la tabla pivote y las barras de ventas, que miden por Fecha de Cierre.
4. El buscador encuentra las variantes: escribe `walk` y salen las tres.
5. Abre un drill-down de cualquier chart con el filtro puesto: **ningún registro fuera del filtro** debe aparecer en el drawer.
6. Cambia de pestaña VAEO ↔ MESH con un filtro puesto: la selección persiste, y si ese valor no existe en el otro pipeline la opción sigue visible al final en cero, desmarcable.
7. Mueve el rango de fechas: los conteos de los dos menús nuevos cambian.
8. Exporta el PDF y confirma que la portada dice el filtro activo.
9. Revisa la consola del navegador: sin warnings nuevos.

- [ ] **Step 7: Documenta en `CLAUDE.md`**

**(a)** En la sección de comandos de verificación, después de la línea de `verify:breakdown`:

```
pnpm verify:category-filter # lib/category-filter.ts — opciones de origen/canal SIN agrupar grafías
```

**(b)** En la tabla de "Shared domain rules (single sources of truth)", después de la fila de `lib/opportunity-breakdown.ts`:

```
| `lib/category-filter.ts` | las opciones de los menús de Origen/Canal — la contraparte **sin agrupar** de `opportunity-breakdown.ts`; no los fusiones (ver abajo) |
```

**(c)** En "Key design decisions", junto a la entrada de los filtros globales, añade:

```
- **La barra tiene cuatro menús de alcance** (sucursal, asesor, origen de lead, canal
  de contacto), todos en `PanelFilters` y aplicados por `applyPanelFilters` en
  `app/page.tsx` sobre las oportunidades **antes** del corte por fecha, igual que el
  toggle de HubSpot. El Asistente IA queda exento, como con los otros filtros.
  **Los menús de origen y canal listan cada grafía capturada por separado**
  (`Walk In` / `WALK IN` / `walk-in` son tres filas, con un ⚠ que las señala),
  mientras los charts las siguen agrupando: una grafía repetida es un error de
  captura que el cliente tiene que corregir en GHL, y agrupar lo esconde. Esa
  duplicación entre `lib/category-filter.ts` y `lib/opportunity-breakdown.ts` es
  deliberada — no la "arregles" fusionando los módulos.
```

- [ ] **Step 8: Commit**

```bash
git add app/page.tsx CLAUDE.md
git commit -m "feat(panel): filtrar VAEO y MESH por origen de lead y canal de contacto"
```

---

## Verificación final

Con todas las tareas hechas:

```bash
npx tsc --noEmit
pnpm verify:breakdown
pnpm verify:category-filter
pnpm verify:filters
pnpm verify:pivot
pnpm verify:lost-matrix
pnpm verify:advisors
```

Las tres últimas se corren porque `CategoryRow` cambió de forma y esos módulos leen sus filas. Todas deben imprimir su línea `all assertions passed`.
