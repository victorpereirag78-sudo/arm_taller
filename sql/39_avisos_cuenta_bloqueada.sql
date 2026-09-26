-- ════════════════════════════════════════════════════════════════
-- 39 · Avisos: si la cuenta de Mi Vehículo está bloqueada, va WhatsApp
-- ════════════════════════════════════════════════════════════════
-- Auditoría 2026-09-25. Con canal 'auto' y el vehículo vinculado, los
-- avisos del taller salían SOLO por Mi Vehículo. Pero si el cliente no
-- pagó, su cuenta queda 'bloqueada' (desde la migración 0017 la prueba
-- vencida bloquea sin días de gracia) y la app le muestra el muro de
-- pago: nunca ve el aviso, y el taller cree que sí le avisó.
--
-- Ahora:
--   · El aviso por Mi Vehículo se sigue guardando (queda en su historial
--     para cuando reactive la cuenta).
--   · Si la cuenta del dueño del vehículo está 'bloqueada' y el cliente
--     tiene teléfono, se agrega el aviso por WhatsApp — también cuando la
--     preferencia es 'mi_vehiculo', porque ese canal no le llega.
--   · fn_taller_vinculo_aceptar: un usuario bloqueado recibía "No tienes
--     permiso para vincular este vehículo." (el candado de pago vive en
--     autodocumentos_can_edit_vehicle). Ahora el mensaje dice la causa.
--
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

create or replace function public.fn_taller_emitir_evento(
    p_empresa_id     uuid,
    p_tipo           text,
    p_titulo         text,
    p_detalle        text default null,
    p_orden_id       uuid default null,
    p_presupuesto_id uuid default null,
    p_vehiculo_id    uuid default null,
    p_cliente_id     uuid default null,
    p_payload        jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_evento     uuid;
    v_cli        taller_clientes%rowtype;
    v_autodoc    uuid;
    v_mv_activo  boolean := false;
    v_pref       text;
    v_mv         boolean;
    v_wa         boolean;
begin
    insert into taller_notificacion_eventos (
        empresa_id, tipo, orden_id, presupuesto_id, vehiculo_id, cliente_id,
        titulo, detalle, payload)
    values (
        p_empresa_id, p_tipo, p_orden_id, p_presupuesto_id, p_vehiculo_id, p_cliente_id,
        p_titulo, p_detalle, coalesce(p_payload, '{}'))
    returning id into v_evento;

    if p_cliente_id is not null then
        select * into v_cli from taller_clientes where id = p_cliente_id;
    end if;

    if p_vehiculo_id is not null then
        select autodoc_vehicle_id into v_autodoc
          from taller_vehiculo_vinculo
         where taller_vehiculo_id = p_vehiculo_id
           and estado = 'activo' and autodoc_vehicle_id is not null
         limit 1;
    end if;

    -- ¿El dueño puede ver Mi Vehículo? (bloqueada = muro de pago)
    if v_autodoc is not null then
        select autodocumentos_fn_estado_suscripcion(v.owner_id) <> 'bloqueada'
          into v_mv_activo
          from autodocumentos_vehicles v
         where v.id = v_autodoc;
        v_mv_activo := coalesce(v_mv_activo, false);
    end if;

    v_pref := coalesce(v_cli.canal_pref, 'auto');
    if v_pref = 'ninguno' then
        return v_evento;
    end if;

    v_mv := (v_pref in ('mi_vehiculo', 'ambos', 'auto')) and v_autodoc is not null;
    v_wa := (v_pref in ('whatsapp', 'ambos'))
            or (v_pref in ('auto', 'mi_vehiculo') and not v_mv_activo);

    if v_mv then
        insert into taller_notificaciones (evento_id, empresa_id, canal, destinatario)
        values (v_evento, p_empresa_id, 'mi_vehiculo', v_autodoc::text);
    end if;

    if v_wa and coalesce(v_cli.telefono, '') <> '' then
        insert into taller_notificaciones (evento_id, empresa_id, canal, destinatario)
        values (v_evento, p_empresa_id, 'whatsapp', v_cli.telefono);
    end if;

    return v_evento;

exception when others then
    -- Un evento que falla nunca debe voltear la transacción del taller
    raise warning 'no se pudo emitir evento % : %', p_tipo, sqlerrm;
    return null;
end;
$function$;

-- create or replace conserva los permisos, pero se reafirman (sql/38).
revoke all on function public.fn_taller_emitir_evento(uuid, text, text, text, uuid, uuid, uuid, uuid, jsonb)
    from public, anon, authenticated;
grant execute on function public.fn_taller_emitir_evento(uuid, text, text, text, uuid, uuid, uuid, uuid, jsonb)
    to service_role;

-- ── Mensaje claro al vincular con la cuenta bloqueada ───────────
do $$
declare
    v_oid oid;
    v_src text;
    v_old text := 'if not autodocumentos_can_edit_vehicle(p_autodoc_vehicle_id) then';
    v_new text := 'if autodocumentos_fn_estado_suscripcion(v_uid) = ''bloqueada'' then'
               || E'\n        return jsonb_build_object(''ok'', false, ''error'','
               || E'\n            ''Tu cuenta de Mi Vehículo está bloqueada por falta de pago. Reactívala en Suscripción y vuelve a abrir la invitación.'');'
               || E'\n    end if;'
               || E'\n    if not autodocumentos_can_edit_vehicle(p_autodoc_vehicle_id) then';
begin
    select p.oid, p.prosrc into v_oid, v_src
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'fn_taller_vinculo_aceptar';
    if position('bloqueada por falta de pago' in v_src) > 0 then
        return;
    end if;
    if position(v_old in v_src) = 0 then
        raise exception 'fn_taller_vinculo_aceptar cambió: revisar a mano';
    end if;
    execute replace(pg_get_functiondef(v_oid), v_src, replace(v_src, v_old, v_new));
end $$;
