# Vínculo por post del anuncio (nivel 3b de la cadena)

**Fecha:** 2026-09-29 · **Módulos:** `lib/meta-normalize.ts`, `lib/meta-client.ts`,
`lib/meta-attribution.ts`, `lib/sync.ts`, `lib/sync-store.ts`

## Problema

La tarjeta "Inversión y rendimiento de pauta" decía "163 de pauta no se pudieron
vincular". Medido sobre el caché de producción:

| Grupo | Leads | Qué traen |
|---|---|---|
| Con URL del post | 77 | Objeto Pauta "Mensaje WhatsApp" sin nombre ni ad id; `attributions[].url` = `instagram.com/p/…` o `fb.me/…` |
| Sin llave | 86 | Solo `source` escrito a mano ("Facebook", "Pauta WhatsApp"); 78 de Cañadas, mar-may 2026, 5 ventas |

El nivel 3 (URL aprendida) no alcanza al primer grupo: 66 traen URLs que ningún lead con
ad id "enseñó", y el resto son posts que comparten varios anuncios de varias campañas.

## Decisión

Preguntarle a Meta qué post promueve cada anuncio en lugar de aprenderlo de los leads:

- `/ads` pide `creative{effective_object_story_id,instagram_permalink_url}` (sin
  llamadas extra) → `MetaAd.storyId` / `MetaAd.igCode`.
- Instagram: shortcode del permalink contra el shortcode de la URL del lead.
- `fb.me`: el redirect (sin seguirlo) da `story.php?story_fbid=pfbid…&id=<perfil>`;
  Graph traduce `<perfil>_<pfbid>` al `<página>_<post>` de `effective_object_story_id`.
  Se resuelve en el sync solo para leads sin ad id (81 de 1 378 enlaces), con caché en el
  slot `meta-shortlinks` (rehecho cada 7 días), y viaja en `metaAds.shortLinks`.
- Nivel nuevo **3b** en `classifyLead`, después de la URL aprendida para no mover lo que
  ya resolvía: un anuncio → `ad`; varios de una campaña → `campaign`; varias campañas →
  nada. `via: "post"`.

## Resultado medido

41 leads pasan de `noAdId` a vinculados (40 a anuncio, 1 a campaña); ninguna otra
oportunidad cambia de clasificación. Quedan 122: los 86 sin llave (se corrigen en la
captura) y 36 cuyo post no promueve ningún anuncio actual (borrado u orgánico).

## Descartado

- Contar los 86 sin llave como "pauta del desarrollo" dentro del CPL: sería suponer
  origen de pauta sin evidencia.
- Poner el post antes de la URL aprendida: más autoritativo, pero cambiaría leads que hoy
  resuelven sin necesidad.

## Riesgo

La parte `fb.me` depende de que Facebook siga redirigiendo sin pedir sesión. Si deja de
hacerlo, `storyRefFromRedirect` devuelve null, esos leads vuelven a `noAdId` y el sync no
se rompe. Instagram no depende de eso.
