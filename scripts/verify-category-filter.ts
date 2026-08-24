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
// La aserción central es la del bloque 8: la unión de las oportunidades que
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
    assert.equal(
      idsMatching(opps, "origen", ["WALK IN"]).length,
      2,
      "WALK IN selecciona solo sus propios registros"
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
