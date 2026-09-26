# Edge Functions — ARM Taller

Proyecto Supabase compartido `rhggndoqjnlzmfxsllto`.

| Función | Estado | verify_jwt |
|---|---|---|
| `taller-notification-dispatch` | desplegada (2026-09-26) | no — la autentica la clave del cron |
| `taller-whatsapp-webhook` | desplegada (2026-09-26) | no — la autentica la firma de Meta |

Redesplegar con el CLI si se cambia el código:

```bash
supabase functions deploy taller-notification-dispatch --project-ref rhggndoqjnlzmfxsllto --no-verify-jwt
supabase functions deploy taller-whatsapp-webhook --project-ref rhggndoqjnlzmfxsllto --no-verify-jwt
```

## Cron (ya creado por `sql/40`)

Job `taller-notification-dispatch`, cada 2 minutos. La clave que comparte con
la función vive en Vault (`taller_dispatch_key`, generada dentro de la base) y
la función la valida con `fn_taller_dispatch_key_ok`: no hay que copiarla a
ningún lado. Cada corrida:

1. genera los recordatorios de cita (24 h / 2 h antes) → llegan a Mi Vehículo
   y a la cola de WhatsApp;
2. si hay credenciales de Meta, envía la cola de WhatsApp.

Sin credenciales, la cola no se toca; los avisos con más de 24 h se descartan
solos (`fn_taller_notif_pendientes_whatsapp`) para no mandar avisos viejos
cuando se conecte WhatsApp.

## Secrets (Supabase → Edge Functions → Secrets)

| Secret | Para qué |
|---|---|
| `WHATSAPP_TOKEN` | token **permanente** de un usuario del sistema de Meta Business (no el temporal de 24 h) |
| `WHATSAPP_PHONE_ID` | "Phone number ID" del número emisor (no es el número) |
| `WHATSAPP_VERIFY_TOKEN` | texto inventado por ti; el mismo que se pone en el webhook de Meta |
| `WHATSAPP_APP_SECRET` | "App secret" de la app de Meta; valida la firma `X-Hub-Signature-256`. **Obligatorio**: sin él el webhook no procesa nada (falla cerrado) |
| `WHATSAPP_TPL_AVISO` | opcional, default `arm_taller_aviso` |
| `WHATSAPP_TPL_PRESUPUESTO` | opcional, default `arm_taller_presupuesto` |
| `WHATSAPP_TPL_IDIOMA` | opcional, default `es` |

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase.

## Plantillas (WhatsApp Manager → Plantillas de mensajes)

Meta solo deja escribirle **primero** a un cliente con una plantilla aprobada.
Categoría **Utilidad**, idioma **Español (es)**:

**`arm_taller_aviso`** — cuerpo:

```
Hola, te escribimos de *{{1}}*.
{{2}}
{{3}}
```

Ejemplos para la revisión de Meta: `Taller Demo` · `¡Tu Toyota Yaris está listo para retirar!` · `Orden N° 15`

**`arm_taller_presupuesto`** — cuerpo:

```
Hola, *{{1}}* te envió el presupuesto N° {{2}} por un total de {{3}}. ¿Lo apruebas?
```

Botones → **Respuesta rápida**: `Apruebo` y `Rechazo` (en ese orden).
Ejemplos: `Taller Demo` · `12` · `$185.000`

El botón lleva el id del presupuesto, así la respuesta va al presupuesto
correcto aunque el cliente tenga varios pendientes. Como texto, solo cuenta
el mensaje exacto `APRUEBO` o `RECHAZO` (sin importar mayúsculas ni tildes).

## Webhook de Meta

App de Meta → WhatsApp → Configuración → Webhook:
- Callback URL: `https://rhggndoqjnlzmfxsllto.functions.supabase.co/taller-whatsapp-webhook`
- Verify token: el valor de `WHATSAPP_VERIFY_TOKEN`
- Campos suscritos: `messages`
