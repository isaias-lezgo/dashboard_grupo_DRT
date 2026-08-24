// Verification for lib/panel-filters.ts — los dos filtros globales de la barra.
// Run: pnpm verify:filters
//
// Un filtro mal no truena: solo devuelve menos registros, y menos registros se
// ven exactamente igual que un mes flojo. Por eso vive aquí.
//
// Wrapped in main() rather than using top-level await: this package is CJS.
import assert from "node:assert/strict";
import type { Opportunity } from "../lib/types";
import { PANEL_SCOPES } from "../lib/panel-scope";
import { NO_SUCURSAL } from "../lib/sales-pivot";
import {
  activeFilterCount,
  advisorKeyOf,
  applyPanelFilters,
  collectSucursales,
  EMPTY_PANEL_FILTERS,
  sucursalOf,
  type PanelFilters,
} from "../lib/panel-filters";

const VAEO_FIELD = PANEL_SCOPES.vaeo.sucursalField; // "Sucursal VAEO"
const MESH_FIELD = PANEL_SCOPES.mesh.sucursalField; // "Sucursal MESH"

let seq = 0;

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

  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: PANEL_SCOPES.vaeo.pipelineId,
    pipelineStageId: "stage-1",
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    contactId: `c${seq}`,
    value: 1,
    stage: "Nuevo Lead",
    pipelineName: "VAEO",
    assignedTo: o.asesor,
    customFieldsResolved: resolved,
  };
}

/** Filtros parciales sobre el estado vacío: aísla al script de campos nuevos. */
const filters = (p: Partial<PanelFilters>): PanelFilters => ({
  ...EMPTY_PANEL_FILTERS,
  ...p,
});

function main() {
  // 1. Sin selección no se filtra NADA, y se devuelve la MISMA referencia.
  // Una copia nueva invalidaría los memos de app/page.tsx en cada render.
  {
    const opps = [opp({ sucursalVaeo: "MTY Tanarah", asesor: "Zulema Silva" })];
    assert.equal(
      applyPanelFilters(opps, EMPTY_PANEL_FILTERS),
      opps,
      "sin filtros: misma referencia, sin copia"
    );
    assert.equal(activeFilterCount(EMPTY_PANEL_FILTERS), 0);
  }

  // 2. sucursalOf lee cualquiera de los dos campos, y la cubeta vacía cubre
  // tanto el campo ausente como uno de puros espacios.
  {
    assert.equal(sucursalOf(opp({ sucursalVaeo: "SLP Covalia" })), "SLP Covalia");
    assert.equal(sucursalOf(opp({ sucursalMesh: "MTY Varzor" })), "MTY Varzor");
    assert.equal(sucursalOf(opp({})), NO_SUCURSAL, "sin campo cae en la cubeta vacía");
    assert.equal(
      sucursalOf(opp({ sucursalVaeo: "   " })),
      NO_SUCURSAL,
      "puros espacios es lo mismo que vacío"
    );
    // El valor se recorta, no se compara con espacios pegados.
    assert.equal(sucursalOf(opp({ sucursalVaeo: " QRO Central Park " })), "QRO Central Park");
  }

  // 3. Filtro por sucursal: OR dentro del menú, y NO_SUCURSAL alcanza a los que
  // no tienen — si no, esos registros serían inalcanzables desde la barra.
  {
    const opps = [
      opp({ sucursalVaeo: "MTY Tanarah" }),
      opp({ sucursalVaeo: "SLP Covalia" }),
      opp({ sucursalMesh: "MTY Varzor" }),
      opp({}),
    ];
    const two = applyPanelFilters(
      opps,
      filters({ sucursales: ["MTY Tanarah", "MTY Varzor"] })
    );
    assert.deepEqual(
      two.map(sucursalOf),
      ["MTY Tanarah", "MTY Varzor"],
      "OR dentro del menú, cruzando el campo de VAEO y el de MESH"
    );

    const sinSucursal = applyPanelFilters(opps, filters({ sucursales: [NO_SUCURSAL] }));
    assert.deepEqual(
      sinSucursal.map(sucursalOf),
      [NO_SUCURSAL],
      "la cubeta vacía es seleccionable, no un agujero"
    );
  }

  // 4. Filtro por asesor: match por PRIMER NOMBRE, sin acentos ni mayúsculas.
  // Un apellido corregido en GHL no debe romper el filtro en silencio.
  {
    assert.equal(advisorKeyOf(opp({ asesor: "Zulema Silva" })), "zulema");
    assert.equal(advisorKeyOf(opp({ asesor: "zulema silva garza" })), "zulema", "sin mayúsculas");
    assert.equal(advisorKeyOf(opp({ asesor: "Zulemá Silva" })), "zulema", "sin acentos");
    assert.equal(advisorKeyOf(opp({ asesor: "Dariana Turrubiates" })), "dariana");
    assert.equal(advisorKeyOf(opp({ asesor: "Diana Arbelaez" })), "diana");
    // "diana" NO debe capturar a "dariana": el match es de token completo.
    assert.notEqual(advisorKeyOf(opp({ asesor: "Dariana Turrubiates" })), "diana");
    assert.equal(advisorKeyOf(opp({ asesor: "Jorge Pizzuto" })), undefined, "otro usuario no cuenta");
    assert.equal(advisorKeyOf(opp({})), undefined, "sin asignar no cuenta");

    const opps = [
      opp({ asesor: "Zulema Silva" }),
      opp({ asesor: "Diana Arbelaez" }),
      opp({ asesor: "Jorge Pizzuto" }),
      opp({}),
    ];
    const solo = applyPanelFilters(opps, filters({ asesores: ["zulema"] }));
    assert.deepEqual(solo.map((o) => o.assignedTo), ["Zulema Silva"]);
    const dos = applyPanelFilters(opps, filters({ asesores: ["zulema", "diana"] }));
    assert.equal(dos.length, 2, "OR dentro del menú de asesores");
    assert.equal(
      applyPanelFilters(opps, filters({ asesores: ["dariana"] })).length,
      0,
      "un asesor sin oportunidades devuelve vacío, no todo"
    );
  }

  // 5. Los dos menús combinan con AND.
  {
    const opps = [
      opp({ sucursalVaeo: "MTY Tanarah", asesor: "Zulema Silva" }),
      opp({ sucursalVaeo: "MTY Tanarah", asesor: "Diana Arbelaez" }),
      opp({ sucursalVaeo: "SLP Covalia", asesor: "Zulema Silva" }),
    ];
    const both = applyPanelFilters(
      opps,
      filters({ sucursales: ["MTY Tanarah"], asesores: ["zulema"] })
    );
    assert.equal(both.length, 1, "sucursal Y asesor, no sucursal O asesor");
    assert.equal(both[0].customFieldsResolved?.[VAEO_FIELD], "MTY Tanarah");
    assert.equal(both[0].assignedTo, "Zulema Silva");
    assert.equal(
      activeFilterCount(filters({ sucursales: ["MTY Tanarah"], asesores: ["zulema"] })),
      2
    );
  }

  // 6. collectSucursales: distintos, ordenados, sin la cubeta vacía (el menú la
  // agrega aparte para dejarla siempre al final).
  {
    const opps = [
      opp({ sucursalVaeo: "SLP Covalia" }),
      opp({ sucursalVaeo: "MTY Tanarah" }),
      opp({ sucursalVaeo: "MTY Tanarah" }),
      opp({ sucursalMesh: "QRO Central Park" }),
      opp({}),
    ];
    assert.deepEqual(
      collectSucursales(opps),
      ["MTY Tanarah", "QRO Central Park", "SLP Covalia"],
      "distintos y ordenados, sin la cubeta vacía"
    );
    assert.deepEqual(collectSucursales([]), [], "sin datos, sin opciones");
  }

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

  console.log("verify-panel-filters: all assertions passed");
}

main();
