-- ════════════════════════════════════════════════════════════════
-- 41 · Mensaje del taller al cliente + bandeja (campanita) Mi Vehículo
-- ════════════════════════════════════════════════════════════════
-- Hasta ahora a Mi Vehículo solo llegaban avisos automáticos (cambios de
-- estado de la OT, presupuestos, citas) y el cliente tenía que entrar a
-- Talleres → vehículo → Seguimiento para verlos.
--
-- 1. fn_taller_mensaje_cliente: el taller escribe un mensaje libre desde
--    el detalle de la OT. Pasa por el mismo motor de avisos
--    (fn_taller_emitir_evento): llega a Mi Vehículo si el vehículo está
--    vinculado y por WhatsApp según "Cómo avisarle" del cliente. Devuelve
--    por qué canales salió (vacío = al cliente no le llega por ningún lado).
-- 2. fn_mv_bandeja / fn_mv_bandeja_no_leidas / fn_mv_bandeja_todas_leidas:
--    todas las novedades de todos los vehículos del usuario, para la
--    campanita del encabezado de Mi Vehículo.
--
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

-- ── 1 · Mensaje del taller ──────────────────────────────────────
create or replace function public.fn_taller_mensaje_cliente(
    p_empresa_id uuid,
    p_orden_id   uuid,
    p_mensaje    text,
    p_usuario    text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_o       taller_ordenes%rowtype;
    v_msg     text := btrim(coalesce(p_mensaje, ''));
    v_evento  uuid;
    v_canales jsonb;
begin
    perform public.taller_exigir_empresa(p_empresa_id);

    if length(v_msg) < 2 then
        return jsonb_build_object('ok', false, 'error', 'Escribe el mensaje.');
    end if;
    if length(v_msg) > 500 then
        return jsonb_build_object('ok', false, 'error', 'El mensaje puede tener hasta 500 caracteres.');
    end if;

    select * into v_o from taller_ordenes where id = p_orden_id and empresa_id = p_empresa_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Orden no encontrada.');
    end if;

    v_evento := fn_taller_emitir_evento(
        p_empresa_id,
        'mensaje_taller',
        'Mensaje sobre tu orden N° ' || v_o.numero,
        v_msg,
        v_o.id,
        null,
        v_o.vehiculo_id,
        v_o.cliente_id,
        jsonb_build_object('orden_numero', v_o.numero, 'usuario', p_usuario));

    if v_evento is null then
        return jsonb_build_object('ok', false, 'error', 'No se pudo registrar el mensaje.');
    end if;

    select coalesce(jsonb_agg(canal order by canal), '[]'::jsonb) into v_canales
      from taller_notificaciones where evento_id = v_evento;

    return jsonb_build_object('ok', true, 'evento_id', v_evento, 'canales', v_canales);
exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

revoke all on function public.fn_taller_mensaje_cliente(uuid, uuid, text, text) from public;
grant execute on function public.fn_taller_mensaje_cliente(uuid, uuid, text, text) to anon, authenticated, service_role;

-- ── 2 · Bandeja de Mi Vehículo ──────────────────────────────────
-- Vehículos del usuario con vínculo activo (fn_mv_links ya aplica
-- autodocumentos_can_view_vehicle). Un vehículo puede estar vinculado a
-- varios talleres: distinct.
create or replace function public.fn_mv_bandeja(p_limite integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
    v_items jsonb;
    v_n     integer;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;

    with mios as (select distinct autodoc_vehicle_id from fn_mv_links())
    select count(*) filter (where n.estado <> 'leido')
      into v_n
      from taller_notificaciones n
      join mios m on m.autodoc_vehicle_id::text = n.destinatario
     where n.canal = 'mi_vehiculo';

    with mios as (select distinct autodoc_vehicle_id from fn_mv_links())
    select coalesce(jsonb_agg(x.j order by x.ts desc), '[]'::jsonb) into v_items
      from (
        select e.creado_at as ts,
               jsonb_build_object(
                   'id',          n.id,
                   'tipo',        e.tipo,
                   'titulo',      e.titulo,
                   'detalle',     e.detalle,
                   'ts',          e.creado_at,
                   'leido',       n.estado = 'leido',
                   'vehicle_id',  v.id,
                   'patente',     v.plate,
                   'vehiculo',    nullif(btrim(coalesce(v.brand, '') || ' ' || coalesce(v.model, '')), ''),
                   'taller',      emp.nombre) as j
          from taller_notificaciones n
          join mios m on m.autodoc_vehicle_id::text = n.destinatario
          join taller_notificacion_eventos e on e.id = n.evento_id
          join autodocumentos_vehicles v on v.id = m.autodoc_vehicle_id
          join empresas emp on emp.id = n.empresa_id
         where n.canal = 'mi_vehiculo'
         order by e.creado_at desc
         limit greatest(least(coalesce(p_limite, 30), 100), 1)
      ) x;

    return jsonb_build_object('ok', true, 'novedades', v_items, 'no_leidas', coalesce(v_n, 0));
exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

-- Solo el número, para el contador de la campanita (se consulta seguido).
create or replace function public.fn_mv_bandeja_no_leidas()
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
    select case when auth.uid() is null then 0 else (
        select count(*)::integer
          from taller_notificaciones n
         where n.canal = 'mi_vehiculo'
           and n.estado <> 'leido'
           and n.destinatario in (select distinct autodoc_vehicle_id::text from fn_mv_links())
    ) end;
$function$;

create or replace function public.fn_mv_bandeja_todas_leidas()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;
    update taller_notificaciones
       set estado = 'leido', leido_at = now()
     where canal = 'mi_vehiculo'
       and estado <> 'leido'
       and destinatario in (select distinct autodoc_vehicle_id::text from fn_mv_links());
    return jsonb_build_object('ok', true);
exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

revoke all on function public.fn_mv_bandeja(integer) from public, anon;
revoke all on function public.fn_mv_bandeja_no_leidas() from public, anon;
revoke all on function public.fn_mv_bandeja_todas_leidas() from public, anon;
grant execute on function public.fn_mv_bandeja(integer) to authenticated;
grant execute on function public.fn_mv_bandeja_no_leidas() to authenticated;
grant execute on function public.fn_mv_bandeja_todas_leidas() to authenticated;
