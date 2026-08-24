import type { GHLMessage } from "./ghl-client"
import type { ActivityKind, Message, MessageChannel } from "./types"

const CHANNEL_BY_TYPE: Record<string, MessageChannel> = {
  TYPE_CALL: "call",
  TYPE_IVR_CALL: "call",
  TYPE_CUSTOM_CALL: "call",
  TYPE_CAMPAIGN_CALL: "call",
  TYPE_CAMPAIGN_MANUAL_CALL: "call",
  TYPE_CAMPAIGN_VOICEMAIL: "call",

  TYPE_SMS: "sms",
  TYPE_RCS: "sms",
  TYPE_SMS_REVIEW_REQUEST: "sms",
  TYPE_SMS_NO_SHOW_REQUEST: "sms",
  TYPE_CAMPAIGN_SMS: "sms",
  TYPE_CAMPAIGN_MANUAL_SMS: "sms",
  TYPE_CUSTOM_SMS: "sms",
  TYPE_CUSTOM_PROVIDER_SMS: "sms",
  TYPE_SMS_REACTION: "sms",

  TYPE_EMAIL: "email",
  TYPE_CAMPAIGN_EMAIL: "email",
  TYPE_CUSTOM_EMAIL: "email",
  TYPE_CUSTOM_PROVIDER_EMAIL: "email",

  TYPE_FACEBOOK: "facebook",
  TYPE_CAMPAIGN_FACEBOOK: "facebook",
  TYPE_FACEBOOK_COMMENT: "facebook",

  TYPE_INSTAGRAM: "instagram",
  TYPE_INSTAGRAM_COMMENT: "instagram",

  TYPE_WHATSAPP: "whatsapp",

  TYPE_TIKTOK: "tiktok",
  TYPE_TIKTOK_COMMENT: "tiktok",

  TYPE_GMB: "google_chat",
  TYPE_CAMPAIGN_GMB: "google_chat",

  TYPE_WEBCHAT: "webchat",
  TYPE_LIVE_CHAT: "live_chat",
  TYPE_LIVE_CHAT_INFO_MESSAGE: "live_chat",

  TYPE_REVIEW: "review",
  TYPE_FORM_SUBMISSION: "form_submission",
  TYPE_INTERNAL_COMMENT: "internal_comment",
}

const ACTIVITY_BY_TYPE: Record<string, { kind: ActivityKind; label: string }> = {
  TYPE_ACTIVITY_OPPORTUNITY: { kind: "opportunity", label: "Oportunidad actualizada" },
  TYPE_ACTIVITY_APPOINTMENT: { kind: "appointment", label: "Cita registrada" },
  TYPE_ACTIVITY_INVOICE: { kind: "invoice", label: "Factura registrada" },
  TYPE_ACTIVITY_PAYMENT: { kind: "payment", label: "Pago registrado" },
  TYPE_ACTIVITY_CONTACT: { kind: "contact", label: "Contacto actualizado" },
  TYPE_ACTIVITY_EMPLOYEE_ACTION_LOG: { kind: "employee_action", label: "Acción de empleado" },
  TYPE_ACTIVITY_WHATSAPP: { kind: "other", label: "Actividad de WhatsApp" },
}

/**
 * ¿El mensaje es actividad del sistema (un chip de "oportunidad actualizada",
 * "cita registrada"…) en vez de un mensaje a una persona?
 *
 * Existe para que quien mide "cuándo fue la última vez que le escribimos" no
 * cuente un evento automático como si alguien hubiera contactado al lead.
 */
export function isActivityMessage(m: { messageType?: string }): boolean {
  return Boolean(m.messageType && m.messageType in ACTIVITY_BY_TYPE)
}

export function ghlMessageToInternal(
  m: GHLMessage,
  contactId: string,
  extra?: { conversationId?: string; assignedTo?: string }
): Message | null {
  const typeKey = m.messageType ?? ""
  const activity = ACTIVITY_BY_TYPE[typeKey]
  if (activity) {
    return {
      id: m.id,
      contactId,
      conversationId: extra?.conversationId,
      assignedTo: extra?.assignedTo,
      direction: m.direction,
      kind: "activity",
      source: "system",
      activityKind: activity.kind,
      content: m.body?.trim() || activity.label,
      createdAt: m.dateAdded,
    }
  }
  if (!m.body) return null
  return {
    id: m.id,
    contactId,
    conversationId: extra?.conversationId,
    assignedTo: extra?.assignedTo,
    direction: m.direction,
    kind: "message",
    source: CHANNEL_BY_TYPE[typeKey] ?? "other",
    content: m.body,
    createdAt: m.dateAdded,
  }
}
