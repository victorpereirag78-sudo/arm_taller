// Edge Function: taller-notification-dispatch
// ---------------------------------------------------------------------
// Toma las notificaciones de WhatsApp pendientes (cola en la base) y las
// envía por la WhatsApp Cloud API de Meta. Marca cada una enviado/error.
// De paso genera los recordatorios de cita (24 h / 2 h antes), que caen
// a la misma cola y a Mi Vehículo.
//
// Se llama por cron cada 2 min (sql/40). La clave del cron vive en Vault
// (`taller_dispatch_key`) y se valida con fn_taller_dispatch_key_ok; nadie
// tiene que copiarla a mano. DISPATCH_KEY (env) sirve como alternativa
// para probar a mano.
//
// ── Plantillas ────────────────────────────────────────────────────────
// Meta solo deja escribirle primero a un cliente con una PLANTILLA
// aprobada (texto libre solo dentro de las 24 h desde que el cliente te
// escribió). Hay que crearlas en WhatsApp Manager, categoría "Utilidad",
// idioma Español (es):
//
//   arm_taller_aviso        Cuerpo: "Hola, te escribimos de *{{1}}*.
//                                    {{2}}
//                                    {{3}}"
//
//   arm_taller_presupuesto  Cuerpo: "Hola, *{{1}}* te envió el presupuesto
//                                    N° {{2}} por un total de {{3}}.
//                                    ¿Lo apruebas?"
//                           Botones de respuesta rápida: "Apruebo", "Rechazo"
//
// Variables de entorno (Supabase → Edge Functions → Secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (las pone Supabase)
//   WHATSAPP_TOKEN            token permanente de la app de Meta
//   WHATSAPP_PHONE_ID         id del número emisor
//   WHATSAPP_TPL_AVISO        opcional (default arm_taller_aviso)
//   WHATSAPP_TPL_PRESUPUESTO  opcional (default arm_taller_presupuesto)
//   WHATSAPP_TPL_IDIOMA       opcional (default es)
//   WHATSAPP_MODO             opcional: "texto" manda texto libre en vez de
//                             plantilla (solo sirve para probar dentro de la
//                             ventana de 24 h)
//   DISPATCH_KEY              opcional, ver arriba
//
// Sin WHATSAPP_TOKEN / WHATSAPP_PHONE_ID no toca la cola: los avisos quedan
// pendientes (la base descarta los de más de 24 h) y se envían solos cuando
// se cargan las credenciales.
// ---------------------------------------------------------------------
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v21.0";

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

interface Pendiente {
  id: string;
  telefono: string;
  titulo: string;
  detalle: string | null;
  tipo: string;
  taller: string;
  presupuesto_id: string | null;
  payload: { numero?: number; total?: number } | null;
}

/** Meta rechaza parámetros vacíos, con saltos de línea, tabs o más de 4
 *  espacios seguidos. */
function param(s: string | number | null | undefined, max = 500): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return t || "—";
}

function clp(n: number | undefined): string {
  return n == null ? "—" : `$${Math.round(n).toLocaleString("es-CL")}`;
}

/** Normaliza el teléfono a formato internacional sin "+" (Chile por defecto). */
function telefonoWa(tel: string): string {
  const d = tel.replace(/\D/g, "");
  if (d.length === 9 && d.startsWith("9")) return `56${d}`; // móvil chileno sin código país
  if (d.length === 8) return `569${d}`;                      // móvil antiguo sin el 9
  return d;
}

function textoLibre(n: Pendiente): string {
  const pie = n.tipo === "presupuesto_enviado"
    ? '\n\nResponde "APRUEBO" o "RECHAZO" a este mensaje.'
    : "";
  return `*${n.taller}*\n${n.titulo}${n.detalle ? `\n${n.detalle}` : ""}${pie}`;
}

function mensaje(n: Pendiente, to: string): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", to };

  if (Deno.env.get("WHATSAPP_MODO") === "texto") {
    return { ...base, type: "text", text: { body: textoLibre(n) } };
  }

  const idioma = { code: Deno.env.get("WHATSAPP_TPL_IDIOMA") ?? "es" };

  if (n.tipo === "presupuesto_enviado" && n.presupuesto_id) {
    return {
      ...base,
      type: "template",
      template: {
        name: Deno.env.get("WHATSAPP_TPL_PRESUPUESTO") ?? "arm_taller_presupuesto",
        language: idioma,
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: param(n.taller) },
              { type: "text", text: param(n.payload?.numero) },
              { type: "text", text: param(clp(n.payload?.total)) },
            ],
          },
          // El payload del botón lleva el presupuesto exacto: así la
          // respuesta no depende de "el último pendiente de ese teléfono".
          {
            type: "button", sub_type: "quick_reply", index: "0",
            parameters: [{ type: "payload", payload: `APRUEBO:${n.presupuesto_id}` }],
          },
          {
            type: "button", sub_type: "quick_reply", index: "1",
            parameters: [{ type: "payload", payload: `RECHAZO:${n.presupuesto_id}` }],
          },
        ],
      },
    };
  }

  return {
    ...base,
    type: "template",
    template: {
      name: Deno.env.get("WHATSAPP_TPL_AVISO") ?? "arm_taller_aviso",
      language: idioma,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: param(n.taller) },
            { type: "text", text: param(n.titulo) },
            { type: "text", text: param(n.detalle) },
          ],
        },
      ],
    },
  };
}

/** ¿Vale la pena reintentar? Errores de red, 5xx y límites de Meta sí;
 *  número inválido o plantilla inexistente no. */
function esPasajero(status: number, err: { code?: number } | undefined): boolean {
  if (status >= 500 || status === 429) return true;
  return [4, 80007, 130429, 131000, 131016, 131048, 131056].includes(err?.code ?? -1);
}

async function claveValida(admin: SupabaseClient, clave: string | null): Promise<boolean> {
  if (!clave) return false;
  const env = Deno.env.get("DISPATCH_KEY");
  if (env && clave === env) return true;
  const { data } = await admin.rpc("fn_taller_dispatch_key_ok", { p_key: clave });
  return data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "config", detail: "supabase" }, 500);
  const admin = createClient(url, key, { auth: { persistSession: false } });

  if (!(await claveValida(admin, req.headers.get("x-dispatch-key")))) {
    return json({ error: "unauthorized" }, 401);
  }

  // Recordatorios de cita: emiten eventos (Mi Vehículo y/o esta cola).
  const { data: rec } = await admin.rpc("fn_taller_recordatorios_citas");
  const recordatorios = (rec as { avisos?: number } | null)?.avisos ?? 0;

  const waToken = Deno.env.get("WHATSAPP_TOKEN");
  const waPhoneId = Deno.env.get("WHATSAPP_PHONE_ID");
  if (!waToken || !waPhoneId) {
    return json({ ok: true, recordatorios, whatsapp: "sin_credenciales" });
  }

  const { data: pend, error } = await admin.rpc("fn_taller_notif_pendientes_whatsapp", {
    p_limite: 25,
  });
  if (error) {
    console.error("RPC pendientes:", error);
    return json({ error: "rpc" }, 500);
  }
  const lista = (pend ?? []) as Pendiente[];

  let enviados = 0;
  let errores = 0;

  for (const n of lista) {
    const to = telefonoWa(n.telefono);
    try {
      const resp = await fetch(`${GRAPH}/${waPhoneId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${waToken}`, "content-type": "application/json" },
        body: JSON.stringify(mensaje(n, to)),
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.ok) {
        await admin.rpc("fn_taller_notif_marcar", {
          p_id: n.id,
          p_estado: "enviado",
          p_proveedor_ref: body?.messages?.[0]?.id ?? null,
        });
        enviados++;
      } else {
        await admin.rpc("fn_taller_notif_marcar", {
          p_id: n.id,
          p_estado: esPasajero(resp.status, body?.error) ? "reintentar" : "error",
          p_error: JSON.stringify(body?.error ?? body).slice(0, 500),
        });
        errores++;
      }
    } catch (e) {
      await admin.rpc("fn_taller_notif_marcar", {
        p_id: n.id,
        p_estado: "reintentar",
        p_error: String(e).slice(0, 500),
      });
      errores++;
    }
  }

  return json({ ok: true, recordatorios, procesadas: lista.length, enviados, errores });
});
