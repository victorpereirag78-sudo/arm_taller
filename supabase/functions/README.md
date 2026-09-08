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
| `WHATSAPP_APP_SECRET` | app secret de Meta; valida la firma `X-Hub-Signature-256` del webhook entrante. **Obligatorio**: sin él, `taller-whatsapp-webhook` responde 200 pero no procesa ningún mensaje (falla cerrado, no se puede aprobar presupuestos sin autenticar) |

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

Ambas funciones se pueden desplegar ya; quedan inertes hasta cargar los secrets:

- `taller-notification-dispatch`: sin `DISPATCH_KEY` responde 401 a todo (y el
  cron aún no existe). Con `DISPATCH_KEY` pero sin `WHATSAPP_TOKEN` /
  `WHATSAPP_PHONE_ID`, marca cada notificación de WhatsApp como `error`
  ("Faltan WHATSAPP_TOKEN / WHATSAPP_PHONE_ID") y sigue. El canal Mi Vehículo
  funciona igual (no pasa por Edge Functions).
- `taller-whatsapp-webhook`: sin `WHATSAPP_APP_SECRET` responde 200 pero no
  procesa nada. Sin `WHATSAPP_VERIFY_TOKEN` la verificación GET de Meta da 403.
- Al cargar los secrets, `intento` vuelve a permitir el reenvío hasta 5
  veces (ver `fn_taller_notif_pendientes_whatsapp`).
