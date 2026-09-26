-- ════════════════════════════════════════════════════════════════
-- 40 · WhatsApp: cola que no se quema, clave del cron en Vault y cron
-- ════════════════════════════════════════════════════════════════
-- Preparación para desplegar taller-notification-dispatch y
-- taller-whatsapp-webhook (2026-09-26).
--
-- 1. fn_taller_notif_pendientes_whatsapp: descarta (estado 'descartado')
--    los avisos de WhatsApp con más de 24 h en cola — mandar "tu auto
--    está listo" días después confunde más de lo que ayuda — y devuelve
--    también el payload (número y total del presupuesto) para armar la
--    plantilla de Meta.
-- 2. fn_taller_notif_marcar acepta 'reintentar': el error fue pasajero
--    (red, límite de Meta); queda 'pendiente' y suma un intento. Al 5º
--    intento pasa a 'error'. Antes cualquier error era definitivo.
-- 3. La clave que comparten el cron y la Edge Function vive en Vault
--    (`taller_dispatch_key`, generada acá, nadie la ve). La función la
--    valida con fn_taller_dispatch_key_ok (solo service_role).
-- 4. Cron `taller-notification-dispatch` cada 2 minutos. Además de
--    WhatsApp, genera los recordatorios de cita (24 h / 2 h antes), que
--    también llegan a Mi Vehículo.
--
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

-- ── 1 · Cola de WhatsApp ────────────────────────────────────────
create or replace function public.fn_taller_notif_pendientes_whatsapp(p_limite integer default 25)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_r jsonb;
begin
    update taller_notificaciones
       set estado = 'descartado',
           error  = 'Vencida: más de 24 h en cola sin enviarse'
     where canal = 'whatsapp'
       and estado = 'pendiente'
       and creado_at < now() - interval '24 hours';

    select coalesce(jsonb_agg(x.j order by x.creado_at), '[]'::jsonb) into v_r
      from (
        select n.creado_at,
               jsonb_build_object(
                   'id',             n.id,
                   'telefono',       n.destinatario,
                   'titulo',         e.titulo,
                   'detalle',        e.detalle,
                   'tipo',           e.tipo,
                   'taller',         emp.nombre,
                   'orden_id',       e.orden_id,
                   'presupuesto_id', e.presupuesto_id,
                   'payload',        e.payload,
                   'intento',        n.intento) as j
          from taller_notificaciones n
          join taller_notificacion_eventos e on e.id = n.evento_id
          join empresas emp on emp.id = n.empresa_id
         where n.canal = 'whatsapp'
           and n.estado = 'pendiente'
           and n.intento < 5
         order by n.creado_at
         limit greatest(coalesce(p_limite, 25), 1)
      ) x;

    return v_r;
end;
$function$;

create or replace function public.fn_taller_notif_marcar(
    p_id            uuid,
    p_estado        text,
    p_proveedor_ref text default null,
    p_error         text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    if p_estado not in ('enviado', 'error', 'descartado', 'reintentar') then
        return jsonb_build_object('ok', false, 'error', 'Estado no válido.');
    end if;

    update taller_notificaciones
       set estado = case
                        when p_estado <> 'reintentar' then p_estado
                        when intento + 1 >= 5         then 'error'
                        else 'pendiente'
                    end,
           intento       = intento + 1,
           enviado_at    = case when p_estado = 'enviado' then now() else enviado_at end,
           proveedor_ref = coalesce(p_proveedor_ref, proveedor_ref),
           error         = p_error
     where id = p_id;

    return jsonb_build_object('ok', found);
exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

-- ── 3 · Clave del cron en Vault ─────────────────────────────────
do $$
begin
    if not exists (select 1 from vault.secrets where name = 'taller_dispatch_key') then
        perform vault.create_secret(
            encode(extensions.gen_random_bytes(32), 'hex'),
            'taller_dispatch_key',
            'Clave compartida: cron → Edge Function taller-notification-dispatch');
    end if;
end $$;

create or replace function public.fn_taller_dispatch_key_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
    select coalesce(p_key, '') <> ''
       and exists (select 1 from vault.decrypted_secrets
                    where name = 'taller_dispatch_key'
                      and decrypted_secret = p_key);
$function$;

-- Solo la usan las Edge Functions (service_role).
revoke all on function public.fn_taller_dispatch_key_ok(text) from public, anon, authenticated;
revoke all on function public.fn_taller_notif_pendientes_whatsapp(integer) from public, anon, authenticated;
revoke all on function public.fn_taller_notif_marcar(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_taller_dispatch_key_ok(text) to service_role;
grant execute on function public.fn_taller_notif_pendientes_whatsapp(integer) to service_role;
grant execute on function public.fn_taller_notif_marcar(uuid, text, text, text) to service_role;

-- ── 4 · Cron cada 2 minutos ─────────────────────────────────────
select cron.unschedule(jobid) from cron.job where jobname = 'taller-notification-dispatch';

select cron.schedule(
    'taller-notification-dispatch',
    '*/2 * * * *',
    $cron$
    select net.http_post(
        url     := 'https://rhggndoqjnlzmfxsllto.functions.supabase.co/taller-notification-dispatch',
        headers := jsonb_build_object(
                       'content-type', 'application/json',
                       'x-dispatch-key', (select decrypted_secret from vault.decrypted_secrets
                                           where name = 'taller_dispatch_key')),
        body    := '{}'::jsonb,
        timeout_milliseconds := 30000
    );
    $cron$
);
