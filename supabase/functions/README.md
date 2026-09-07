# Edge Functions — ARM Taller

Se despliegan al proyecto Supabase compartido (`rhggndoqjnlzmfxsllto`).
No hace falta scaffold completo de Supabase en este repo: basta el CLI.

```bash
# una vez
npm i -g supabase
supabase login

# desplegar
supabase functions deploy taller-notification-dispatch --project-ref rhggndoqjnlzmfxsllto
supabase functions deploy taller-whatsapp-webhook --project-ref rhggndoqjnlzmfxsllto --no-verify-jwt
```

## Secrets (Supabase → Edge Functions → Secrets)

| Secret | Para qué |
|---|---|
| `DISPATCH_KEY` | secreto compartido entre el cron y `taller-notification-dispatch` |
| `WHATSAPP_TOKEN` | token permanente de la app de Meta (WhatsApp Cloud API) |
| `WHATSAPP_PHONE_ID` | id del número emisor |
| `WHATSAPP_VERIFY_TOKEN` | string arbitrario; el mismo que se pone en el webhook de Meta |

`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase solo.

## Cron para el dispatcher

Supabase → Database → Cron → New job (cada 1-2 min):

```sql
select net.http_post(
  url     := 'https://rhggndoqjnlzmfxsllto.functions.supabase.co/taller-notification-dispatch',
  headers := jsonb_build_object('x-dispatch-key', '<DISPATCH_KEY>', 'content-type', 'application/json'),
  body    := '{}'::jsonb
);
```

## Webhook de Meta

WhatsApp → Configuration → Webhook:
- Callback URL: `https://rhggndoqjnlzmfxsllto.functions.supabase.co/taller-whatsapp-webhook`
- Verify token: el valor de `WHATSAPP_VERIFY_TOKEN`
- Campos suscritos: `messages`

## Sin credenciales de WhatsApp todavía

- El dispatcher marca cada notificación de WhatsApp como `error` con el
  detalle "Faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_ID" y sigue. El canal
  Mi Vehículo funciona igual (no pasa por Edge Functions).
- Al cargar los secrets, `intento` vuelve a permitir el reenvío hasta 5
  veces (ver `fn_taller_notif_pendientes_whatsapp`).
