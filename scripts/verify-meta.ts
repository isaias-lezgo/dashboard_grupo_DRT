// Verificación de lib/meta-normalize.ts. Correr: pnpm verify:meta
//
// La parte pura de la integración con Meta: de `actions` solo salen dos
// contadores, la ventana se parte por mes calendario, y la jerarquía se
// normaliza en tablas planas. Un bug aquí es un costo por lead equivocado.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import {
  normalizeInsightRow,
  normalizeAds,
  igShortcode,
  isFbShortLink,
  storyRefFromRedirect,
  monthChunks,
  historyWindow,
  mergeMetaAds,
  nextPageRequest,
  filterAdsCreatedSince,
  dateChunks,
  splitRange,
  INSIGHTS_CHUNK_DAYS,
  MAX_HISTORY_MONTHS,
} from "../lib/meta-normalize";

async function main() {
  // --- actions: solo lead y messaging; el resto se ignora; números como strings
  const row = normalizeInsightRow({
    ad_id: "120247808685340416",
    date_start: "2026-09-01",
    spend: "123.45",
    impressions: "1000",
    clicks: "40",
    inline_link_clicks: "35",
    actions: [
      { action_type: "lead", value: "3" },
      { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "5" },
      { action_type: "link_click", value: "35" },
      { action_type: "post_engagement", value: "90" },
    ],
  }, "act_1");
  assert.equal("reach" in row, false, "reach no se pide ni se guarda: no se muestra en ningún lado y pesa en 22 000 filas");
  assert.deepEqual(row, {
    adId: "120247808685340416",
    accountId: "act_1",
    date: "2026-09-01",
    spend: 123.45,
    impressions: 1000,
    clicks: 40,
    linkClicks: 35,
    leadsForm: 3,
    leadsMsg: 5,
  });

  // --- campos ausentes → 0, nunca NaN
  const bare = normalizeInsightRow({ ad_id: "1", date_start: "2026-09-02" }, "act_1");
  assert.equal(bare.spend, 0);
  assert.equal(bare.leadsForm, 0);
  assert.equal(bare.leadsMsg, 0);
  assert.equal(bare.linkClicks, 0);

  // --- jerarquía: tablas planas, sin duplicar padres, con accountId en la campaña
  const h = normalizeAds("act_1", [
    { id: "a1", name: "Ad 1", effective_status: "ACTIVE", adset: { id: "s1", name: "Set 1" }, campaign: { id: "c1", name: "Camp 1", objective: "OUTCOME_LEADS" } },
    { id: "a2", name: "Ad 2", effective_status: "PAUSED", adset: { id: "s1", name: "Set 1" }, campaign: { id: "c1", name: "Camp 1", objective: "OUTCOME_LEADS" } },
    { id: "a3", name: "Ad 3", adset: { id: "s2", name: "Set 2" }, campaign: { id: "c2", name: "Camp 2" } },
  ]);
  assert.deepEqual(h.campaigns, [
    { id: "c1", name: "Camp 1", objective: "OUTCOME_LEADS", accountId: "act_1" },
    { id: "c2", name: "Camp 2", objective: undefined, accountId: "act_1" },
  ]);
  assert.deepEqual(h.adsets, [
    { id: "s1", name: "Set 1", campaignId: "c1" },
    { id: "s2", name: "Set 2", campaignId: "c2" },
  ]);
  assert.deepEqual(h.ads, [
    { id: "a1", name: "Ad 1", adsetId: "s1", status: "ACTIVE" },
    { id: "a2", name: "Ad 2", adsetId: "s1", status: "PAUSED" },
    { id: "a3", name: "Ad 3", adsetId: "s2", status: undefined },
  ]);
  // --- un ad sin adset/campaign (borrados) se conserva con padres vacíos
  // el post que promueve el creative
  const withPost = normalizeAds("act_1", [
    { id: "p1", name: "a", creative: { effective_object_story_id: "900_1", instagram_permalink_url: "https://www.instagram.com/p/DctvIqmgT34/" } },
    { id: "p2", name: "b", creative: {} },
  ]);
  assert.equal(withPost.ads[0].storyId, "900_1");
  assert.equal(withPost.ads[0].igCode, "DctvIqmgT34");
  assert.equal("storyId" in withPost.ads[1] || "igCode" in withPost.ads[1], false, "sin creative no se inventa post");
  assert.equal(igShortcode("https://www.instagram.com/reel/AbC_-9/?igsh=x"), "AbC_-9");
  assert.equal(igShortcode("https://fb.me/abc"), null);
  assert.equal(isFbShortLink("https://fb.me/6OtVLxEhM"), true);
  assert.equal(isFbShortLink("https://fb.me/6OtVLxEhM/extra"), false);
  assert.equal(isFbShortLink("https://www.facebook.com/x"), false);
  assert.equal(
    storyRefFromRedirect("https://www.facebook.com/story.php?story_fbid=pfbid082EM&id=100063709399083&post_id=x"),
    "100063709399083_pfbid082EM"
  );
  assert.equal(storyRefFromRedirect("https://www.facebook.com/login"), null);
  assert.equal(storyRefFromRedirect("https://evil.com/story.php?story_fbid=1&id=2"), null);
  assert.equal(storyRefFromRedirect(null), null);

  const orphan = normalizeAds("act_1", [{ id: "a9", name: "Huérfano" }]);
  assert.deepEqual(orphan.ads, [{ id: "a9", name: "Huérfano", adsetId: "", status: undefined }]);
  assert.deepEqual(orphan.adsets, []);

  // --- chunks por mes calendario, con bordes
  assert.deepEqual(monthChunks("2026-07-15", "2026-09-13"), [
    { since: "2026-07-15", until: "2026-07-31" },
    { since: "2026-08-01", until: "2026-08-31" },
    { since: "2026-09-01", until: "2026-09-13" },
  ]);
  assert.deepEqual(monthChunks("2026-09-01", "2026-09-01"), [{ since: "2026-09-01", until: "2026-09-01" }]);
  assert.deepEqual(monthChunks("2026-02-01", "2026-03-01"), [
    { since: "2026-02-01", until: "2026-02-28" },
    { since: "2026-03-01", until: "2026-03-01" },
  ]);
  assert.deepEqual(monthChunks("2026-09-13", "2026-09-01"), [], "ventana invertida = nada");

  // --- ventana de historia: desde el primer día del mes en que se creó la subcuenta
  assert.deepEqual(historyWindow("2025-10-15T21:34:53.965Z", "2026-09-28"), {
    since: "2025-10-01",
    until: "2026-09-28",
  });
  // --- tope de 24 meses
  const old = historyWindow("2020-01-01T00:00:00.000Z", "2026-09-13");
  assert.equal(old.since, "2024-09-01", `tope de ${MAX_HISTORY_MONTHS} meses`);
  // --- sin fecha de creación (GHL no la devolvió): solo el mes actual
  assert.deepEqual(historyWindow(undefined, "2026-09-13"), { since: "2026-09-01", until: "2026-09-13" });
  assert.deepEqual(historyWindow("no-es-fecha", "2026-09-13"), { since: "2026-09-01", until: "2026-09-13" });
  // --- subcuenta "creada" después de hoy (reloj mal): no se pide una ventana invertida
  assert.deepEqual(historyWindow("2027-01-01T00:00:00.000Z", "2026-09-13"), { since: "2026-09-01", until: "2026-09-13" });

  // --- merge: concatena, marca fallidas, conserva la ventana
  const merged = mergeMetaAds(
    [
      { account: { id: "act_1", name: "Uno", currency: "MXN", timezone: "America/Mexico_City" }, hierarchy: h, daily: [row] },
      { account: { id: "act_2", name: "Dos", currency: "MXN", timezone: "America/Mexico_City" }, hierarchy: orphan, daily: [bare] },
    ],
    [{ id: "act_3", reason: "permission" }],
    { since: "2026-01-01", until: "2026-09-13" }
  );
  assert.equal(merged.accounts.length, 2);
  assert.equal(merged.campaigns.length, 2);
  assert.equal(merged.ads.length, 4);
  assert.equal(merged.daily.length, 2);
  assert.deepEqual(merged.failedAccounts, [{ id: "act_3", reason: "permission" }]);
  assert.deepEqual(merged.window, { since: "2026-01-01", until: "2026-09-13" });

  // --- paging.next: Graph lo devuelve bajo OTRA versión y con el token puesto.
  // Antes solo se quitaba la versión propia y la segunda página iba a
  // `v23.0//v26.0/…` → code 2500 en las cuatro cuentas grandes de DRT.
  const np = nextPageRequest(
    "https://graph.facebook.com/v26.0/act_520082890601955/insights?level=ad&limit=500&after=MTAw&access_token=SECRET"
  );
  assert.equal(np.path, "act_520082890601955/insights");
  assert.deepEqual(np.params, { level: "ad", limit: "500", after: "MTAw" });
  assert.equal(
    nextPageRequest("https://graph.facebook.com/act_1/ads?after=x&access_token=S").path,
    "act_1/ads",
    "sin versión en el enlace"
  );

  // --- anuncios creados antes de la subcuenta se descartan con su id; sin fecha se conservan
  const rawAds = [
    { id: "old", name: "Leads_Enero", created_time: "2021-01-05T10:00:00+0000" },
    { id: "edge", name: "El mismo día", created_time: "2025-10-15T23:59:00-0600" },
    { id: "new", name: "a1", created_time: "2026-02-01T10:00:00+0000" },
    { id: "nodate", name: "sin created_time" },
  ];
  const f = filterAdsCreatedSince(rawAds, "2025-10-15");
  assert.deepEqual(f.kept.map((a) => a.id), ["edge", "new", "nodate"]);
  assert.deepEqual([...f.droppedIds], ["old"]);
  const all = filterAdsCreatedSince(rawAds, null);
  assert.equal(all.kept.length, 4, "sin fecha de subcuenta no se filtra nada");
  assert.equal(all.droppedIds.size, 0);
  // --- el created_time viaja al dataset; la fila diaria sabe de qué cuenta es
  const hNew = normalizeAds("act_1", [{ id: "n", name: "a1", created_time: "2026-02-01T10:00:00+0000" }]);
  assert.equal(hNew.ads[0].createdTime, "2026-02-01T10:00:00+0000");
  assert.equal(normalizeInsightRow({ ad_id: "1", date_start: "2026-09-01" }, "act_9").accountId, "act_9");

  // --- insights por tramos de 7 días: Meta agota sus ~30 s con un mes entero a nivel
  // anuncio × día en cuentas de >500 anuncios (Átria, Saggita: code 2 / 1504044 y
  // code 1 / 99, medido 2026-09-29). Tramos contiguos, sin traslape, el último recortado.
  assert.equal(INSIGHTS_CHUNK_DAYS, 7);
  assert.deepEqual(dateChunks("2026-09-01", "2026-09-29", 7), [
    { since: "2026-09-01", until: "2026-09-07" },
    { since: "2026-09-08", until: "2026-09-14" },
    { since: "2026-09-15", until: "2026-09-21" },
    { since: "2026-09-22", until: "2026-09-28" },
    { since: "2026-09-29", until: "2026-09-29" },
  ]);
  assert.deepEqual(dateChunks("2026-02-26", "2026-03-03", 7), [{ since: "2026-02-26", until: "2026-03-03" }], "cruza el mes sin cortar");
  assert.deepEqual(dateChunks("2026-09-13", "2026-09-01", 7), [], "ventana invertida = nada");
  // --- bisección: un tramo que Meta no puede calcular se parte a la mitad hasta el día
  assert.deepEqual(splitRange("2026-09-01", "2026-09-07"), [
    { since: "2026-09-01", until: "2026-09-04" },
    { since: "2026-09-05", until: "2026-09-07" },
  ]);
  assert.deepEqual(splitRange("2026-09-01", "2026-09-02"), [
    { since: "2026-09-01", until: "2026-09-01" },
    { since: "2026-09-02", until: "2026-09-02" },
  ]);
  assert.equal(splitRange("2026-09-01", "2026-09-01"), null, "un día no se parte más");

  console.log("✅ verify:meta OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
