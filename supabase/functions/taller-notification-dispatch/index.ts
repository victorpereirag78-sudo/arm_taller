// Edge Function: taller-notification-dispatch
// ---------------------------------------------------------------------
// Toma las notificaciones de WhatsApp pendientes (cola en la base) y las
// envía por la WhatsApp Cloud API de Meta. Marca cada una enviado/error.
//
// Se llama:
//   · por cron  (Supabase → Database → Cron, cada 1-2 min):
//        select net.http_post(
//          url    := 'https://<ref>.functions.supabase.co/taller-notification-dispatch',
//          headers:= jsonb_build_object('x-dispatch-key', '<DISPATCH_KEY>'));
//   · o a mano para probar (POST con la cabecera x-dispatch-key).
//
// Variables de entorno (Supabase → Edge Functions → Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (las pone Supabase)
//   DISPATCH_KEY            secreto compartido con el cron
//   WHATSAPP_TOKEN          token permanente de la app de Meta
//   WHATSAPP_PHONE_ID       id del número emisor
// ---------------------------------------------------------------------
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-dispatch-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

/** Texto del mensaje según el evento. Con plantillas de Meta aprobadas
 *  esto se reemplaza por el nombre de la plantilla + parámetros. */
function cuerpoMensaje(n: {
  taller: string;
  titulo: string;
  detalle: string | null;
  tipo: string;
  presupuesto_id: string | null;
}): string {
  const pie =
    n.tipo === "presupuesto_enviado"
      ? '\n\nResponde "APRUEBO" o "RECHAZO" a este mensaje.'
      : "";
  return `*${n.taller}*\n${n.titulo}${n.detalle ? `\n${n.detalle}` : ""}${pie}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (req.headers.get("x-dispatch-key") !== Deno.env.get("DISPATCH_KEY")) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const waToken = Deno.env.get("WHATSAPP_TOKEN");
  const waPhoneId = Deno.env.get("WHATSAPP_PHONE_ID");
  if (!url || !key) return json({ error: "config", detail: "supabase" }, 500);

  const admin = createClient(url, key, { auth: { persistSession: false } });

  // Genera los recordatorios de cita que toquen ahora (emiten eventos →
  // que caen a esta misma cola de WhatsApp / a Mi Vehículo).
  const { data: rec } = await admin.rpc("fn_taller_recordatorios_citas");
  const recordatorios = (rec as { avisos?: number } | null)?.avisos ?? 0;

  const { data: pend, error } = await admin.rpc("fn_taller_notif_pendientes_whatsapp", {
    p_limite: 25,
  });
  if (error) {
    console.error("RPC pendientes:", error);
    return json({ error: "rpc" }, 500);
  }
  const lista = (pend ?? []) as Array<{
    id: string;
    telefono: string;
    titulo: string;
    detalle: string | null;
    tipo: string;
    taller: string;
    presupuesto_id: string | null;
  }>;

  let enviados = 0;
  let errores = 0;

  for (const n of lista) {
    // Sin credenciales de WhatsApp: deja la fila en error explicativo y sigue.
    if (!waToken || !waPhoneId) {
      await admin.rpc("fn_taller_notif_marcar", {
        p_id: n.id,
        p_estado: "error",
        p_error: "Faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_ID",
      });
      errores++;
      continue;
    }

    const to = n.telefono.replace(/\D/g, "");
    try {
      const resp = await fetch(
        `https://graph.facebook.com/v21.0/${waPhoneId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${waToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: { body: cuerpoMensaje(n) },
          }),
        },
      );
      const body = await resp.json();
      if (!resp.ok) {
        await admin.rpc("fn_taller_notif_marcar", {
          p_id: n.id,
          p_estado: "error",
          p_error: JSON.stringify(body?.error ?? body).slice(0, 500),
        });
        errores++;
      } else {
        await admin.rpc("fn_taller_notif_marcar", {
          p_id: n.id,
          p_estado: "enviado",
          p_proveedor_ref: body?.messages?.[0]?.id ?? null,
        });
        enviados++;
      }
    } catch (e) {
      await admin.rpc("fn_taller_notif_marcar", {
        p_id: n.id,
        p_estado: "error",
        p_error: String(e).slice(0, 500),
      });
      errores++;
    }
  }

  return json({ ok: true, recordatorios, procesadas: lista.length, enviados, errores });
});
