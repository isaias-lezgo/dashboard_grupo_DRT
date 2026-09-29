# Cruce con la API de Leads de Meta (nivel "lead" de la cadena)

**Fecha:** 2026-09-29 · **Estado:** propuesta — bloqueada por el permiso `leads_retrieval`
**Precede:** `2026-09-29-vinculo-por-post-del-anuncio-design.md` (nivel 3b)

## Problema

Tras el nivel 3b quedan 122 leads "de pauta sin vincular". GHL no guarda nada del
anuncio en ellos: en el contacto, `attributionSource` / `lastAttributionSource` traen
`adId`, `ctwaClid`, `url` y `adName` en null (verificado en crudo 2026-09-29). El primer
mensaje de la conversación sí dice de dónde vienen. Medido sobre los 163 originales:

| Primer mensaje | Leads |
|---|---|
| "¡Hola! Completé el formulario…" + respuestas (nombre, teléfono, email): **formulario instantáneo de Meta con destino WhatsApp** | 75 (55 La Sierra, 18 Cañadas, 2 Palmyra) |
| "¡Hola! Quiero más información." (saludo genérico de click-to-WhatsApp) | 25 |
| Texto libre, a menudo recibido en el WhatsApp personal de un asesor | ~46 |
| Sin conversación | 17 |

Solo el primer grupo tiene una llave recuperable: Meta guarda cada envío de formulario
como un lead con su `ad_id`. Parte de esos 75 ya los resolvió el nivel 3b por la URL del
post; el resto (incluidos 16 sin ninguna URL) solo se resuelve por aquí.

## Propuesta

1. **Dataset nuevo en el sync de Meta**: por cada anuncio de las cuentas conectadas que
   use un formulario, leer `GET /{ad_id}/leads` (o `/{form_id}/leads` si sale más barato)
   con `fields=id,created_time,ad_id,form_id,field_data`, filtrado por
   `time_created > ventana`.
2. **No viaja la PII**: de `field_data` se guarda solo el teléfono normalizado (últimos 10
   dígitos) y el email en minúsculas, **hasheados** (SHA-256 con sal derivada de
   `DASHBOARD_AUTH_SECRET`), más `ad_id` y `created_time`. El navegador recibe
   `metaAds.leadKeys: Record<hash, adId>`; nunca nombres, teléfonos ni emails de Meta.
3. **Nivel nuevo en `classifyLead`**, después del 3b y antes de nombres: hashear el teléfono
   y el email del contacto (y los `phone_number` / `email` del primer mensaje si llegan en
   el payload) y buscarlos en `leadKeys`. Un hash que apunte a varios anuncios no
   identifica nada (mismo criterio que la URL). `via: "lead"`.
4. **Caché acumulativo** en un slot propio (`meta-leads`), porque la API podría no devolver
   leads viejos (ver riesgo 1): lo ya visto se conserva aunque Meta deje de darlo. Es la
   única excepción a "el caché no guarda historia", y se justifica porque guarda hashes y
   ad ids, no datos personales.

## Requisitos (fuera del código)

- Agregar **`leads_retrieval`** a la configuración de Facebook Login for Business
  (`META_LOGIN_CONFIG_ID` 1047096268324910, app "Paneles Lezgo Suite" 1432292882099074).
  Según la documentación, leer leads pide token de página o de un usuario que pueda
  anunciarse en la cuenta, con `leads_retrieval` + `ads_management` + permisos `pages_*`.
  Hoy el token tiene `ads_read`, `ads_management`, `business_management`,
  `pages_show_list`, `pages_read_engagement`.
- Probablemente **App Review** para acceso avanzado a `leads_retrieval`.
- **Reconectar Meta desde producción** (localhost no completa el OAuth).
- Que el usuario del sistema tenga acceso a las **páginas** dueñas de los formularios (el
  acceso a formularios se da en Business Settings → Integraciones → Acceso a clientes
  potenciales).

## Paso 0 — medir antes de construir

Con el permiso concedido, y antes de escribir el dataset:

1. ¿`/{ad_id}/leads` devuelve leads de **enero a junio de 2026**? **72 de los 75 leads de
   formulario son anteriores a julio.** Si la API solo devuelve ~90 días hacia atrás, el
   rezago actual casi no se recupera (3 de 75) y el valor es de aquí en adelante.
2. ¿Los formularios con destino WhatsApp aparecen como leads normales, con `ad_id`?
3. ¿El teléfono del formulario coincide con el del contacto de GHL? En la muestra no
   siempre: el `phone_number` del formulario y el número de WhatsApp difieren a veces, por
   eso se cruza también por email y por lo que traiga el primer mensaje.

Si (1) sale en ~90 días, decidir con el cliente si vale la pena por el flujo futuro.

## Descartado

- **Leer el primer mensaje de la conversación en el sync** para sacar `*Source URL:*`: en
  los 163 solo 1 lead trae la URL en el mensaje y no en `attributions[]`. No compensa
  ~2 llamadas a GHL por lead.
- **Atribuir el saludo genérico** ("Quiero más información") o el texto libre: es igual en
  todos los anuncios; sería inventar.

## Riesgos

1. Retención de la API (paso 0.1).
2. PII: el diseño hashea en el servidor y no guarda datos de Meta en claro; revisar con el
   cliente que el uso esté cubierto por su aviso de privacidad.
3. Cuota de Graph: el 2026-09-29 la app llegó a "Application request limit reached"
   (código 4) con los syncs más consultas de diagnóstico. Pedir leads por anuncio multiplica
   las llamadas; medir, y preferir `/{form_id}/leads` si hay menos formularios que anuncios.
