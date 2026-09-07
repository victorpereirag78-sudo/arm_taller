// Edge Function: taller-whatsapp-webhook
// ---------------------------------------------------------------------
// Recibe los mensajes entrantes de WhatsApp (Meta Cloud API).
//   · GET  → verificación del webhook (Meta lo llama una vez al configurarlo)
//   · POST → mensaje del cliente. Si dice APRUEBO / RECHAZO, responde el
//            último presupuesto pendiente de ese número.
//
// Configurar en Meta → WhatsApp → Configuration → Webhook:
//   Callback URL:  https://<ref>.functions.supabase.co/taller-whatsapp-webhook
//   Verify token:  el valor de WHATSAPP_VERIFY_TOKEN
//   Campos:        messages
//
// Deploy con  --no-verify-jwt  (Meta no manda Authorization).
//
// Variables de entorno:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   WHATSAPP_VERIFY_TOKEN   string arbitrario, el mismo que pones en Meta
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID   para contestar la confirmación
// ---------------------------------------------------------------------
import { createClient } from "jsr:@supabase/supabase-js@2";

const APRUEBA = /\b(apruebo|aprobar|aprobado|acepto|si|sí|ok|dale)\b/i;
const RECHAZA = /\b(rechazo|rechazar|rechazado|no)\b/i;

async function responderWhatsApp(to: string, body: string) {
  const token = Deno.env.get("WHATSAPP_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_ID");
  if (!token || !phoneId) return;
  await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to.replace(/\D/g, ""),
      type: "text",
      text: { body },
    }),
  }).catch((e) => console.error("respuesta wa:", e));
}

Deno.serve(async (req) => {
  const u = new URL(req.url);

  // ── Verificación (GET) ──────────────────────────────────────────
  if (req.method === "GET") {
    const mode = u.searchParams.get("hub.mode");
    const token = u.searchParams.get("hub.verify_token");
    const challenge = u.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === Deno.env.get("WHATSAPP_VERIFY_TOKEN")) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  // Meta reintenta si no recibe 200 rápido: procesamos y respondemos 200 igual.
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response("ok", { status: 200 });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return new Response("ok", { status: 200 });
  const admin = createClient(url, key, { auth: { persistSession: false } });

  try {
    const entries = (payload as { entry?: unknown[] })?.entry ?? [];
    for (const entry of entries as Array<{ changes?: unknown[] }>) {
      for (const ch of entry.changes ?? []) {
        const value = (ch as { value?: Record<string, unknown> }).value ?? {};
        const mensajes = (value.messages ?? []) as Array<{
          from?: string;
          text?: { body?: string };
          type?: string;
        }>;
        for (const m of mensajes) {
          const from = m.from ?? "";
          const texto = m.text?.body?.trim() ?? "";
          if (!from || !texto) continue;

          const esAprob = APRUEBA.test(texto);
          const esRech = RECHAZA.test(texto);
          if (!esAprob && !esRech) continue;

          const { data, error } = await admin.rpc("fn_taller_wa_responder_presupuesto", {
            p_telefono: from,
            p_respuesta: esAprob ? "aprobado" : "rechazado",
          });
          if (error) {
            console.error("RPC responder:", error);
            continue;
          }
          const r = (data ?? {}) as { ok?: boolean; error?: string; numero?: number };
          await responderWhatsApp(
            from,
            r.ok
              ? esAprob
                ? `✅ Presupuesto N° ${r.numero ?? ""} aprobado. El taller ya está avisado.`
                : `Presupuesto N° ${r.numero ?? ""} rechazado. Gracias por avisar.`
              : `No pudimos procesar tu respuesta: ${r.error ?? "intenta más tarde"}`,
          );
        }
      }
    }
  } catch (e) {
    console.error("webhook:", e);
  }

  return new Response("ok", { status: 200 });
});
