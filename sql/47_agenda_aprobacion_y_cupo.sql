-- ════════════════════════════════════════════════════════════════
-- 47 · Agenda: el taller aprueba (o propone otra fecha) según su cupo
-- ════════════════════════════════════════════════════════════════
-- El cliente de Mi Vehículo PIDE una hora; no la toma. Hasta ahora:
--   · se podía pedir una franja de hoy que ya había pasado;
--   · el cliente no veía qué pasó con su solicitud;
--   · el taller no tenía cómo decir «no tengo cupo» (descartar no avisaba);
--   · al agendar sin elegir bahía no se revisaba el cupo.
--
-- Ahora:
-- 1. fn_mv_solicitar_hora rechaza fechas pasadas y franjas de hoy que ya
--    terminaron (mañana hasta las 12:00, tarde hasta las 18:00, hora de Chile).
-- 2. fn_mv_solicitudes: el cliente ve sus solicitudes en espera y las que el
--    taller no pudo atender, con el mensaje del taller.
-- 3. fn_solicitud_a_cita: no agenda en el pasado; si no se elige bahía, asigna
--    una libre y, si no hay ninguna, responde «sin cupo». Si la fecha es otra
--    que la pedida, le avisa al cliente que es una propuesta del taller.
--    El cliente la confirma o la cancela (fn_mv_cita_responder, sql/27).
-- 4. fn_solicitud_sin_cupo: el taller rechaza la solicitud con un mensaje y
--    el cliente lo recibe (app, y WhatsApp si está conectado).
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

alter table public.taller_solicitudes_hora
    add column if not exists respuesta     text,
    add column if not exists respondido_at timestamptz;


-- ── 1 · Pedir hora: sin fechas ni franjas pasadas ───────────────
create or replace function fn_mv_solicitar_hora(
    p_empresa_id uuid,
    p_datos      jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid    uuid := auth.uid();
    v_id     uuid;
    v_nom    text;
    v_ahora  timestamp := now() at time zone 'America/Santiago';
    v_fecha  date := nullif(p_datos->>'fecha_preferida', '')::date;
    v_franja text := nullif(p_datos->>'franja', '');
begin
    if v_uid is null then
        return jsonb_build_object('ok', false, 'error', 'Necesitas iniciar sesión.');
    end if;
    if not exists (select 1 from empresas
                    where id = p_empresa_id and activo
                      and (tipo = 'taller'
                           or exists (select 1 from fn_mv_links() l
                                       where l.empresa_id = p_empresa_id))) then
        return jsonb_build_object('ok', false, 'error', 'Taller no encontrado.');
    end if;

    if v_fecha is not null then
        if v_fecha < v_ahora::date then
            return jsonb_build_object('ok', false,
                'error', 'Esa fecha ya pasó. Elige hoy o un día que viene.');
        end if;
        if v_fecha = v_ahora::date then
            if v_franja = 'manana' and v_ahora::time >= time '12:00' then
                return jsonb_build_object('ok', false,
                    'error', 'La mañana de hoy ya pasó. Elige la tarde u otro día.');
            end if;
            if v_ahora::time >= time '18:00' then
                return jsonb_build_object('ok', false,
                    'error', 'El horario de hoy ya terminó. Elige otro día.');
            end if;
        end if;
    end if;

    select full_name into v_nom from autodocumentos_profiles where id = v_uid;

    insert into taller_solicitudes_hora (
        empresa_id, autodoc_vehicle_id, solicitante_uid, nombre, telefono,
        patente, vehiculo_desc, servicio, motivo, fecha_preferida, franja)
    values (
        p_empresa_id,
        nullif(p_datos->>'autodoc_vehicle_id', '')::uuid,
        v_uid,
        coalesce(p_datos->>'nombre', v_nom),
        p_datos->>'telefono',
        upper(regexp_replace(coalesce(p_datos->>'patente', ''), '[^A-Za-z0-9]+', '', 'g')),
        p_datos->>'vehiculo_desc',
        p_datos->>'servicio',
        p_datos->>'motivo',
        v_fecha,
        v_franja)
    returning id into v_id;

    return jsonb_build_object('ok', true, 'solicitud_id', v_id);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── 2 · Lo que el cliente ve de sus solicitudes ─────────────────
-- En espera y las que el taller no pudo atender. Las agendadas ya aparecen
-- como cita (fn_mv_citas).
create or replace function fn_mv_solicitudes(p_autodoc_vehicle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r jsonb;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
        'solicitud_id',    s.id,
        'taller',          e.nombre,
        'servicio',        s.servicio,
        'motivo',          s.motivo,
        'fecha_preferida', s.fecha_preferida,
        'franja',          s.franja,
        'estado',          case when s.estado = 'descartada' then 'sin_cupo' else 'en_espera' end,
        'respuesta',       s.respuesta,
        'creado_at',       s.creado_at
    ) order by s.creado_at desc), '[]'::jsonb) into v_r
    from taller_solicitudes_hora s
    join empresas e on e.id = s.empresa_id
    where s.solicitante_uid = auth.uid()
      and s.autodoc_vehicle_id = p_autodoc_vehicle_id
      and (   s.estado in ('nueva', 'contactado')
           or (s.estado = 'descartada' and s.respuesta is not null
               and s.respondido_at > now() - interval '14 days'))
      and s.creado_at > now() - interval '30 days';

    return jsonb_build_object('ok', true, 'solicitudes', v_r);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── 3 · Agendar la solicitud: sin pasado y con control de cupo ──
create or replace function fn_solicitud_a_cita(
    p_empresa_id    uuid,
    p_solicitud_id  uuid,
    p_fecha         date,
    p_hora          time,
    p_duracion      integer default null,
    p_bahia_id      uuid default null,
    p_mecanico_id   uuid default null,
    p_usuario       text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_s     taller_solicitudes_hora%rowtype;
    v_veh   uuid;
    v_cli   uuid;
    v_res   jsonb;
    v_cita  uuid;
    v_dur   integer := coalesce(p_duracion, 60);
    v_fin   time;
    v_bahia uuid := p_bahia_id;
    v_hay   boolean;
    v_otra  boolean;
begin
    perform public.taller_exigir_empresa(p_empresa_id);

    select * into v_s from taller_solicitudes_hora
     where id = p_solicitud_id and empresa_id = p_empresa_id for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Solicitud no encontrada.');
    end if;
    if v_s.estado = 'agendada' then
        return jsonb_build_object('ok', false, 'error', 'Esa solicitud ya está agendada.');
    end if;

    if (p_fecha + p_hora) < (now() at time zone 'America/Santiago') then
        return jsonb_build_object('ok', false, 'error', 'Esa fecha y hora ya pasó. Elige otra.');
    end if;

    -- Cupo: si no se eligió bahía, tomar una que esté libre a esa hora.
    v_fin := (p_hora + (v_dur || ' minutes')::interval)::time;
    select exists (select 1 from taller_bahias b
                    where b.empresa_id = p_empresa_id and b.activo) into v_hay;
    if v_bahia is null and v_hay then
        select b.id into v_bahia
          from taller_bahias b
         where b.empresa_id = p_empresa_id and b.activo
           and not exists (
               select 1 from taller_citas c
                where c.empresa_id = p_empresa_id and c.bahia_id = b.id
                  and c.fecha = p_fecha
                  and c.estado not in ('cancelada', 'no_asistio')
                  and (p_hora, v_fin) overlaps
                      (c.hora_inicio, (c.hora_inicio + (c.duracion_min || ' minutes')::interval)::time))
         order by b.orden, b.nombre
         limit 1;
        if v_bahia is null then
            return jsonb_build_object('ok', false,
                'error', 'Sin cupo: todas las bahías están ocupadas a esa hora. Elige otra hora u otro día.');
        end if;
    end if;

    if coalesce(v_s.patente, '') <> '' then
        select id, cliente_id into v_veh, v_cli
          from taller_vehiculos
         where empresa_id = p_empresa_id
           and patente_norm = upper(regexp_replace(v_s.patente, '[^A-Za-z0-9]+', '', 'g'))
         limit 1;
    end if;

    v_res := fn_agendar_cita(
        p_empresa_id, p_fecha, p_hora, v_dur,
        v_cli, v_veh, v_bahia, p_mecanico_id,
        v_s.servicio, coalesce(v_s.motivo, 'Solicitud desde Mi Vehículo'),
        'web',
        case when v_cli is null then v_s.nombre end,
        case when v_veh is null then nullif(v_s.patente, '') end,
        v_s.telefono, null, null, p_usuario);

    if not (v_res->>'ok')::boolean then
        return v_res;
    end if;

    v_cita := (v_res->>'cita_id')::uuid;

    update taller_solicitudes_hora
       set estado = 'agendada', respondido_at = now(),
           notas = trim(coalesce(notas, '') || ' · cita ' || p_fecha || ' ' || p_hora)
     where id = p_solicitud_id;

    -- ¿Es otra fecha que la que pidió el cliente? Entonces es una propuesta.
    v_otra := v_s.fecha_preferida is not null and p_fecha <> v_s.fecha_preferida;

    perform fn_taller_emitir_evento(
        p_empresa_id, 'cita_agendada',
        case when v_otra then 'El taller te propone otra fecha' else 'Tu hora quedó agendada' end,
        case when v_otra
             then 'Para ese día no había cupo. Te propone el ' || to_char(p_fecha, 'DD/MM')
                  || ' a las ' || to_char(p_hora, 'HH24:MI') || '. Confírmala o cancélala en la app.'
             else to_char(p_fecha, 'DD/MM') || ' a las ' || to_char(p_hora, 'HH24:MI')
                  || '. Confírmala en la app.'
        end,
        null, null, v_veh, v_cli,
        jsonb_build_object('cita_id', v_cita, 'fecha', p_fecha, 'hora', p_hora,
                           'propuesta', v_otra));

    return jsonb_build_object('ok', true, 'cita_id', v_cita, 'propuesta', v_otra);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── 4 · El taller no tiene cupo: lo dice y el cliente se entera ─
create or replace function fn_solicitud_sin_cupo(
    p_empresa_id   uuid,
    p_solicitud_id uuid,
    p_mensaje      text default null,
    p_usuario      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_s   taller_solicitudes_hora%rowtype;
    v_veh uuid;
    v_cli uuid;
    v_msg text := nullif(btrim(coalesce(p_mensaje, '')), '');
begin
    perform public.taller_exigir_empresa(p_empresa_id);

    select * into v_s from taller_solicitudes_hora
     where id = p_solicitud_id and empresa_id = p_empresa_id for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Solicitud no encontrada.');
    end if;
    if v_s.estado = 'agendada' then
        return jsonb_build_object('ok', false, 'error', 'Esa solicitud ya está agendada.');
    end if;
    if length(coalesce(v_msg, '')) > 300 then
        return jsonb_build_object('ok', false, 'error', 'El mensaje puede tener hasta 300 caracteres.');
    end if;

    v_msg := coalesce(v_msg, 'El taller no tiene disponibilidad para esa fecha. Puedes pedir otra.');

    update taller_solicitudes_hora
       set estado = 'descartada', respuesta = v_msg, respondido_at = now()
     where id = p_solicitud_id;

    if coalesce(v_s.patente, '') <> '' then
        select id, cliente_id into v_veh, v_cli
          from taller_vehiculos
         where empresa_id = p_empresa_id
           and patente_norm = upper(regexp_replace(v_s.patente, '[^A-Za-z0-9]+', '', 'g'))
         limit 1;
    end if;

    perform fn_taller_emitir_evento(
        p_empresa_id, 'solicitud_sin_cupo',
        'El taller no puede atenderte en esa fecha', v_msg,
        null, null, v_veh, v_cli,
        jsonb_build_object('solicitud_id', p_solicitud_id));

    return jsonb_build_object('ok', true);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Permisos ────────────────────────────────────────────────────
revoke all on function fn_mv_solicitar_hora(uuid, jsonb) from public;
revoke all on function fn_mv_solicitudes(uuid) from public;
revoke all on function fn_solicitud_a_cita(uuid, uuid, date, time, integer, uuid, uuid, text) from public;
revoke all on function fn_solicitud_sin_cupo(uuid, uuid, text, text) from public;

grant execute on function fn_mv_solicitar_hora(uuid, jsonb) to authenticated;
grant execute on function fn_mv_solicitudes(uuid) to authenticated;
grant execute on function fn_solicitud_a_cita(uuid, uuid, date, time, integer, uuid, uuid, text) to anon, authenticated;
grant execute on function fn_solicitud_sin_cupo(uuid, uuid, text, text) to anon, authenticated;
