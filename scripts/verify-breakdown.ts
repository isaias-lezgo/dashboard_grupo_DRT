// Verification for lib/opportunity-breakdown.ts — la agregación de los tres
// gráficos "Oportunidades por estado / Origen de Lead / Canal de Contacto".
// Correr: pnpm verify:breakdown
//
// Dos cosas justifican el script. Una: las cubetas de estado se apoyan en
// isWonOpp(), y una regresión ahí mueve ventas de una barra a otra sin que nada
// truene. Dos: el agrupamiento de categorías normaliza texto libre sucio
// (`Walk-in` vs `Walk In`, `WHATSAPP` vs `WhatsApp`), y si la clave deja de unir
// dos grafías el gráfico simplemente muestra dos barras chicas donde debía haber
// una grande — invisible a ojo.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Opportunity } from "../lib/types";
import {
  buildCategoryBreakdown,
  buildStatusByMonth,
  categoryKey,
  CANAL_FIELDS,
  NO_DATE_KEY,
  NO_VALUE_KEY,
  NO_VALUE_LABEL,
  normalizeCategoryKey,
  ORIGEN_FIELDS,
  statusBucket,
} from "../lib/opportunity-breakdown";

let seq = 0;

// Oportunidad mínimamente válida; solo importan los campos que lee el módulo.
function opp(o: {
  createdAt?: string;
  status?: Opportunity["status"];
  stage?: string;
  fields?: Record<string, string | string[]>;
}): Opportunity {
  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: "pipe-1",
    pipelineStageId: "stage-1",
    status: o.status ?? "open",
    createdAt: o.createdAt ?? "2026-06-15T12:00:00.000Z",
    contactId: `c${seq}`,
    value: 0,
    stage: o.stage ?? "Nuevo Lead",
    pipelineName: "VAEO",
    customFieldsResolved: o.fields,
  };
}

const rowFor = (rows: ReturnType<typeof buildCategoryBreakdown>, label: string) => {
  const r = rows.find((x) => x.label === label);
  assert.ok(r, `existe la fila "${label}" (hay: ${rows.map((x) => x.label).join(", ")})`);
  return r!;
};

function main() {
  // 1. Cubetas de estado: isWonOpp manda, no el status crudo.
  {
    assert.equal(statusBucket(opp({ status: "won" })), "ganada");
    assert.equal(
      statusBucket(opp({ status: "open", stage: "Ganado" })),
      "ganada",
      "etapa Ganado con status open cuenta como ganada (regla de isWonOpp)"
    );
    assert.equal(
      statusBucket(opp({ status: "lost", stage: "Ganado" })),
      "perdida",
      "un lost explícito nunca es ganada, aunque viva en una etapa 'Ganado'"
    );
    assert.equal(statusBucket(opp({ status: "abandoned" })), "perdida", "abandoned se pliega en perdida");
    assert.equal(statusBucket(opp({ status: "open", stage: "Propuesta" })), "abierta");
  }

  // 2. Meses: relleno de huecos intermedios y fila "Sin fecha".
  {
    const rows = buildStatusByMonth([
      opp({ createdAt: "2026-01-10T12:00:00.000Z", status: "won" }),
      opp({ createdAt: "2026-04-02T12:00:00.000Z", status: "lost" }),
      opp({ createdAt: "2026-04-20T12:00:00.000Z", status: "open", stage: "Propuesta" }),
      opp({ createdAt: "" }),
      opp({ createdAt: "no es una fecha" }),
    ]);

    assert.deepEqual(
      rows.map((r) => r.key),
      ["2026-01", "2026-02", "2026-03", "2026-04", NO_DATE_KEY],
      "feb y mar se rellenan en cero para que el eje no mienta sobre la continuidad"
    );
    assert.equal(rows[1].total, 0, "un mes rellenado va vacío");
    assert.equal(rows[0].ganada, 1);
    assert.equal(rows[3].perdida, 1);
    assert.equal(rows[3].abierta, 1);
    assert.equal(rows[4].total, 2, "createdAt vacío e ilegible caen ambos en Sin fecha");
    assert.deepEqual(rows[0].ids.ganada, ["o6"], "los ids del drill-down viajan con la cubeta");
    assert.equal(rows[rows.length - 1].label, "Sin fecha");
  }

  // 2b. Relleno cruzando el fin de año.
  {
    const rows = buildStatusByMonth([
      opp({ createdAt: "2025-11-05T12:00:00.000Z" }),
      opp({ createdAt: "2026-01-05T12:00:00.000Z" }),
    ]);
    assert.deepEqual(rows.map((r) => r.key), ["2025-11", "2025-12", "2026-01"]);
    assert.equal(rows[0].label, "nov 2025");
    assert.equal(rows[2].label, "ene 2026");
  }

  // 2c. Sin datos, y solo-sin-fecha.
  {
    assert.deepEqual(buildStatusByMonth([]), []);
    const only = buildStatusByMonth([opp({ createdAt: "" })]);
    assert.deepEqual(only.map((r) => r.key), [NO_DATE_KEY]);
  }

  // 3. La clave de agrupamiento une las variantes de grafía.
  {
    assert.equal(categoryKey("Walk-in"), categoryKey("Walk In"));
    assert.equal(categoryKey("Activo Seo"), categoryKey("Activo SEO"));
    assert.equal(categoryKey("WHATSAPP"), categoryKey("WhatsApp"));
    assert.equal(categoryKey("Correo electrónico"), "correo electronico", "quita acentos");
    assert.notEqual(categoryKey("Meta"), categoryKey("Mailing"));
  }

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

  // 4. Origen: agrupamiento, etiqueta canónica, alias y orden.
  {
    const rows = buildCategoryBreakdown(
      [
        opp({ fields: { "Origen de Lead": "Meta" } }),
        opp({ fields: { "Origen de Lead": "Meta" } }),
        opp({ fields: { "Origen de Lead": "Meta" } }),
        opp({ fields: { "Origen de Lead": "Walk-in" } }),
        opp({ fields: { "Origen de Lead": "Walk In" } }),
        opp({ fields: { "Origen de Lead": "Inmobiliaria" } }),
        opp({ fields: { "Origen de Lead": "Inmobiliario" } }),
        opp({ fields: { "Origen de Lead": "activo seo" } }),
      ],
      ORIGEN_FIELDS
    );

    assert.equal(rowFor(rows, "Meta").count, 3);
    assert.equal(rowFor(rows, "Walk In").count, 2, "Walk-in y Walk In son una sola fila");
    assert.equal(
      rowFor(rows, "Inmobiliario").count,
      2,
      "Inmobiliaria entra por alias explícito: la clave sola no las une"
    );
    assert.equal(
      rowFor(rows, "Inmobiliario").key,
      "inmobiliario",
      "la fila lleva su clave, para atarla a las opciones del menú del filtro"
    );
    assert.equal(rowFor(rows, "Walk In").key, "walk in");
    assert.equal(
      rowFor(rows, "Activo SEO").count,
      1,
      "la etiqueta es la oficial del picklist, no la grafía capturada"
    );
    assert.deepEqual(
      rows.map((r) => r.label),
      ["Meta", "Inmobiliario", "Walk In", "Activo SEO"],
      "orden descendente por conteo, desempate alfabético"
    );
    assert.equal(rowFor(rows, "Meta").pct, 37.5);
  }

  // 5. Valor desconocido: sobrevive con su grafía más frecuente.
  {
    const rows = buildCategoryBreakdown(
      [
        opp({ fields: { "Origen de Lead": "Podcast Nuevo" } }),
        opp({ fields: { "Origen de Lead": "podcast nuevo" } }),
        opp({ fields: { "Origen de Lead": "Podcast Nuevo" } }),
      ],
      ORIGEN_FIELDS
    );
    assert.deepEqual(rows.map((r) => r.label), ["Podcast Nuevo"]);
    assert.equal(rows[0].count, 3, "una categoría nueva nunca se cae del gráfico");
  }

  // 6. Celda multivalor: cuenta en cada categoría que nombra.
  {
    const multi = opp({ fields: { "Origen de Lead": "Meta, Sitio Web" } });
    const rows = buildCategoryBreakdown(
      [multi, opp({ fields: { "Origen de Lead": "Meta" } })],
      ORIGEN_FIELDS
    );
    assert.equal(rowFor(rows, "Meta").count, 2);
    assert.equal(rowFor(rows, "Sitio Web").count, 1);
    assert.ok(rowFor(rows, "Sitio Web").oppIds.includes(multi.id));
    assert.ok(
      rows.reduce((a, r) => a + r.pct, 0) > 100,
      "los % pasan de 100 con multivalor; es a propósito y se explica en el tooltip"
    );
  }

  // 6b. Un valor repetido dentro de la misma celda no cuenta doble.
  {
    const rows = buildCategoryBreakdown(
      [opp({ fields: { "Origen de Lead": "Meta, meta" } })],
      ORIGEN_FIELDS
    );
    assert.deepEqual(rows.map((r) => r.count), [1]);
  }

  // 7. Fallback al gemelo picklist solo cuando el campo de texto viene vacío.
  {
    const rows = buildCategoryBreakdown(
      [
        opp({ fields: { "Canal de Contacto": "WHATSAPP", "Canal del contacto": "Formulario" } }),
        opp({ fields: { "Canal de Contacto": "   ", "Canal del contacto": "Formulario" } }),
        opp({ fields: { "Canal del contacto": "Llamada" } }),
      ],
      CANAL_FIELDS
    );
    assert.equal(rowFor(rows, "WhatsApp").count, 1, "el campo de texto gana cuando tiene valor");
    assert.equal(rowFor(rows, "Formulario").count, 1, "texto en blanco cae al picklist");
    assert.equal(rowFor(rows, "Llamada").count, 1);
    assert.equal(rows.length, 3, "nadie cayó en Sin dato");
  }

  // 8. Sin dato: nunca se descarta, y siempre va al final.
  {
    const rows = buildCategoryBreakdown(
      [
        opp({}),
        opp({}),
        opp({}),
        opp({ fields: { "Origen de Lead": "" } }),
        opp({ fields: { "Origen de Lead": "Meta" } }),
      ],
      ORIGEN_FIELDS
    );
    const last = rows[rows.length - 1];
    assert.equal(last.label, NO_VALUE_LABEL);
    assert.equal(last.key, NO_VALUE_KEY, "la fila Sin dato lleva el centinela");
    assert.equal(last.count, 4, "sin campo y con campo vacío son lo mismo");
    assert.equal(last.pct, 80);
    assert.equal(rows[0].label, "Meta", "Sin dato no compite en el ranking aunque sea mayoría");
  }

  // 9. Conjunto vacío.
  {
    assert.deepEqual(buildCategoryBreakdown([], ORIGEN_FIELDS), []);
  }

  console.log("verify-breakdown: all assertions passed");
}

main();
