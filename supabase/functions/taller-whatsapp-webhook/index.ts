// Edge Function: taller-whatsapp-webhook
// ---------------------------------------------------------------------
// Recibe los mensajes entrantes de WhatsApp (Meta Cloud API).
//   · GET  → verificación del webhook (Meta lo llama una vez al configurarlo)
//   · POST → mensaje del cliente. Botón "Apruebo"/"Rechazo" de la plantilla
//            (trae el id del presupuesto) o el mensaje exacto APRUEBO /
//            RECHAZO (responde el último pendiente de ese número).
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
//   WHATSAPP_APP_SECRET     app secret de Meta — OBLIGATORIO: sin él la función
//                           no procesa ningún mensaje entrante (falla cerrado)
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID   para contestar la confirmación
// ---------------------------------------------------------------------
import { createClient } from "jsr:@supabase/supabase-js@2";

/** Verifica que el POST viene de Meta (HMAC-SHA256 del body con el app secret).
 *  Meta SIEMPRE firma. Este endpoint aprueba/rechaza presupuestos, así que
 *  falla cerrado: si no hay WHATSAPP_APP_SECRET configurado, NO se procesa
 *  ningún mensaje (la función queda inerte hasta cargar el secret). */
async function firmaValida(raw: string, firma: string | null): Promise<boolean> {
  const secret = Deno.env.get("WHATSAPP_APP_SECRET");
  if (!secret) return false;              // sin secret no se procesa nada
  if (!firma?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}` === firma;
}

// Aprobar o rechazar un presupuesto es plata: solo cuenta una respuesta
// inequívoca. El botón de la plantilla trae "APRUEBO:<id>" / "RECHAZO:<id>";
// como texto, el mensaje tiene que ser SOLO la palabra (sin importar
// mayúsculas, tildes ni puntuación). "no sé, ¿cuánto sale?" no rechaza nada.
const PALABRAS_APRUEBA = new Set(["apruebo", "aprobado", "acepto", "si apruebo"]);
const PALABRAS_RECHAZA = new Set(["rechazo", "rechazado", "no acepto", "no apruebo"]);

function normalizar(s: string): string {
  return s
    .normalize("NFD").replace(/\p{M}/gu, "")   // sin tildes
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")                        // sin puntuación ni emojis
    .replace(/\s+/g, " ")
    .trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Interpreta un mensaje entrante. null = no es una respuesta a presupuesto. */
function interpretar(m: MensajeWa): { respuesta: "aprobado" | "rechazado"; presupuestoId: string | null } | null {
  // Botón de plantilla (type "button") o botón interactivo (type "interactive").
  const payload = m.button?.payload ?? m.interactive?.button_reply?.id ?? "";
  const [accion, id] = payload.split(":");
  if (accion === "APRUEBO" || accion === "RECHAZO") {
    return {
      respuesta: accion === "APRUEBO" ? "aprobado" : "rechazado",
      presupuestoId: id && UUID.test(id) ? id : null,
    };
  }

  const texto = normalizar(m.text?.body ?? m.button?.text ?? "");
  if (PALABRAS_APRUEBA.has(texto)) return { respuesta: "aprobado", presupuestoId: null };
  if (PALABRAS_RECHAZA.has(texto)) return { respuesta: "rechazado", presupuestoId: null };
  return null;
}

interface MensajeWa {
  from?: string;
  type?: string;
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: { button_reply?: { id?: string; title?: string } };
}

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
  const raw = await req.text();
  if (!(await firmaValida(raw, req.headers.get("x-hub-signature-256")))) {
    // Firma inválida o falta WHATSAPP_APP_SECRET. Devolvemos 200 para que Meta
    // no reintente en bucle, pero no se procesa nada.
    return new Response("ok", { status: 200 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
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
        const mensajes = (value.messages ?? []) as MensajeWa[];
        for (const m of mensajes) {
          const from = m.from ?? "";
          if (!from) continue;

          const r0 = interpretar(m);
          if (!r0) continue;
          const esAprob = r0.respuesta === "aprobado";

          // Con presupuesto_id la base igual verifica que ese presupuesto
          // sea de un cliente con este teléfono.
          const { data, error } = await admin.rpc("fn_taller_wa_responder_presupuesto", {
            p_telefono: from,
            p_respuesta: r0.respuesta,
            p_presupuesto_id: r0.presupuestoId,
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
