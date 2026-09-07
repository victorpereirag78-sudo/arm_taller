-- ================================================================
-- 27_agenda_conectada.sql — ARM TALLER
-- FASE 2: agenda conectada (12), confirmación de citas (13),
-- presupuestos perdidos (21).
--
-- ⚠ REQUIERE sql/09 (agenda), sql/23 (notificaciones), sql/25 (solicitudes).
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Solicitud de hora → cita real
-- ════════════════════════════════════════════════════════════════
-- El flujo del brief: Solicitud → Cita → Recepción → OT.
-- Esto hace el segundo paso: el taller toma una solicitud y la agenda.

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
    v_s   taller_solicitudes_hora%rowtype;
    v_veh uuid;
    v_cli uuid;
    v_res jsonb;
    v_cita uuid;
begin
    select * into v_s from taller_solicitudes_hora
     where id = p_solicitud_id and empresa_id = p_empresa_id
     for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Solicitud no encontrada.');
    end if;
    if v_s.estado = 'agendada' then
        return jsonb_build_object('ok', false, 'error', 'Esa solicitud ya está agendada.');
    end if;

    -- Resolver vehículo/cliente del taller por patente (si existe)
    if v_s.patente <> '' then
        select id, cliente_id into v_veh, v_cli
          from taller_vehiculos
         where empresa_id = p_empresa_id
           and patente_norm = upper(regexp_replace(v_s.patente, '[^A-Za-z0-9]+', '', 'g'))
         limit 1;
    end if;

    v_res := fn_agendar_cita(
        p_empresa_id, p_fecha, p_hora,
        coalesce(p_duracion, 60),
        v_cli, v_veh, p_bahia_id, p_mecanico_id,
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
       set estado = 'agendada', notas = trim(coalesce(notas, '') || ' · cita ' || p_fecha || ' ' || p_hora)
     where id = p_solicitud_id;

    -- Avisar al cliente
    perform fn_taller_emitir_evento(
        p_empresa_id, 'cita_agendada',
        'Tu hora quedó agendada',
        to_char(p_fecha, 'DD/MM') || ' a las ' || to_char(p_hora, 'HH24:MI'),
        null, null, v_veh, v_cli,
        jsonb_build_object('cita_id', v_cita, 'fecha', p_fecha, 'hora', p_hora));

    return jsonb_build_object('ok', true, 'cita_id', v_cita);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Confirmar / cancelar cita desde Mi Vehículo
-- ════════════════════════════════════════════════════════════════

create or replace function fn_mv_citas(p_autodoc_vehicle_id uuid)
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
    if not exists (select 1 from fn_mv_links() where autodoc_vehicle_id = p_autodoc_vehicle_id) then
        return jsonb_build_object('ok', false, 'error', 'Vehículo no vinculado.');
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
        'cita_id',  c.id,
        'taller',   e.nombre,
        'fecha',    c.fecha,
        'hora',     c.hora_inicio,
        'servicio', c.servicio,
        'motivo',   c.motivo,
        'estado',   c.estado,
        'puede_responder', c.estado in ('agendada', 'confirmada') and c.fecha >= current_date
    ) order by c.fecha, c.hora_inicio), '[]'::jsonb) into v_r
    from fn_mv_links() l
    join taller_citas c on c.vehiculo_id = l.taller_vehiculo_id
    join empresas e on e.id = c.empresa_id
    where l.autodoc_vehicle_id = p_autodoc_vehicle_id
      and c.fecha >= current_date - 1
      and c.estado not in ('completada', 'no_asistio');

    return jsonb_build_object('ok', true, 'citas', v_r);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


create or replace function fn_mv_cita_responder(
    p_cita_id   uuid,
    p_respuesta text                -- 'confirmar' | 'cancelar'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_c taller_citas%rowtype; v_estado text;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;
    if p_respuesta not in ('confirmar', 'cancelar') then
        return jsonb_build_object('ok', false, 'error', 'Respuesta no válida.');
    end if;

    select * into v_c from taller_citas where id = p_cita_id for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Cita no encontrada.');
    end if;
    if not exists (select 1 from fn_mv_links() l where l.taller_vehiculo_id = v_c.vehiculo_id) then
        return jsonb_build_object('ok', false, 'error', 'Sin permiso sobre esta cita.');
    end if;
    if v_c.estado not in ('agendada', 'confirmada') then
        return jsonb_build_object('ok', false, 'error', 'Esta cita ya no admite cambios.');
    end if;

    v_estado := case when p_respuesta = 'confirmar' then 'confirmada' else 'cancelada' end;
    update taller_citas set estado = v_estado where id = p_cita_id;

    perform fn_taller_emitir_evento(
        v_c.empresa_id,
        case when p_respuesta = 'confirmar' then 'cita_confirmada_cliente' else 'cita_cancelada_cliente' end,
        case when p_respuesta = 'confirmar' then 'El cliente confirmó la cita' else 'El cliente canceló la cita' end,
        to_char(v_c.fecha, 'DD/MM') || ' ' || to_char(v_c.hora_inicio, 'HH24:MI'),
        null, null, v_c.vehiculo_id, v_c.cliente_id,
        jsonb_build_object('cita_id', p_cita_id));

    return jsonb_build_object('ok', true, 'estado', v_estado);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Recordatorios de cita (los emite el cron del dispatcher)
-- ════════════════════════════════════════════════════════════════

alter table taller_citas
    add column if not exists aviso_creada boolean not null default false,
    add column if not exists aviso_24h    boolean not null default false,
    add column if not exists aviso_2h     boolean not null default false;

create or replace function fn_taller_recordatorios_citas()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    c        taller_citas%rowtype;
    v_ahora  timestamptz := now();
    v_cuando timestamptz;
    n        integer := 0;
begin
    for c in
        select * from taller_citas
         where estado in ('agendada', 'confirmada')
           and fecha between current_date and current_date + 2
           and (not aviso_creada or not aviso_24h or not aviso_2h)
    loop
        v_cuando := (c.fecha + c.hora_inicio)::timestamptz;

        -- Aviso al crear (si es reciente y aún no se avisó)
        if not c.aviso_creada then
            perform fn_taller_emitir_evento(c.empresa_id, 'cita_recordatorio',
                'Tienes una hora agendada',
                to_char(c.fecha, 'DD/MM') || ' a las ' || to_char(c.hora_inicio, 'HH24:MI'),
                null, null, c.vehiculo_id, c.cliente_id,
                jsonb_build_object('cita_id', c.id, 'etapa', 'creada'));
            update taller_citas set aviso_creada = true where id = c.id;
            n := n + 1;
        end if;

        -- 24 h antes
        if not c.aviso_24h and v_cuando - v_ahora <= interval '24 hours'
           and v_cuando > v_ahora then
            perform fn_taller_emitir_evento(c.empresa_id, 'cita_recordatorio',
                'Tu hora es mañana',
                to_char(c.hora_inicio, 'HH24:MI') || ' — responde para confirmar',
                null, null, c.vehiculo_id, c.cliente_id,
                jsonb_build_object('cita_id', c.id, 'etapa', '24h'));
            update taller_citas set aviso_24h = true where id = c.id;
            n := n + 1;
        end if;

        -- 3 h antes
        if not c.aviso_2h and v_cuando - v_ahora <= interval '3 hours'
           and v_cuando > v_ahora then
            perform fn_taller_emitir_evento(c.empresa_id, 'cita_recordatorio',
                'Tu hora es hoy',
                'A las ' || to_char(c.hora_inicio, 'HH24:MI'),
                null, null, c.vehiculo_id, c.cliente_id,
                jsonb_build_object('cita_id', c.id, 'etapa', '2h'));
            update taller_citas set aviso_2h = true where id = c.id;
            n := n + 1;
        end if;
    end loop;

    return jsonb_build_object('ok', true, 'avisos', n);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Presupuestos perdidos (punto 21)
-- ════════════════════════════════════════════════════════════════

alter table taller_presupuestos
    add column if not exists motivo_rechazo_cat text;

do $$
begin
    alter table taller_presupuestos drop constraint if exists taller_presupuestos_motivo_rechazo_cat_check;
    alter table taller_presupuestos add constraint taller_presupuestos_motivo_rechazo_cat_check
        check (motivo_rechazo_cat is null or motivo_rechazo_cat in
            ('precio', 'postergado', 'no_responde', 'otro_taller', 'otro'));
end $$;

-- fn_responder_presupuesto sigue igual; el motivo_cat se guarda aparte
create or replace function fn_taller_presup_motivo_perdida(
    p_empresa_id     uuid,
    p_presupuesto_id uuid,
    p_categoria      text,
    p_detalle        text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    update taller_presupuestos
       set motivo_rechazo_cat = p_categoria,
           motivo_rechazo = coalesce(p_detalle, motivo_rechazo)
     where id = p_presupuesto_id and empresa_id = p_empresa_id;
    return jsonb_build_object('ok', found);
exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- Reporte de presupuestos, ahora con lo perdido
create or replace function fn_reporte_presupuestos(
    p_empresa_id uuid, p_desde date, p_hasta date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_r jsonb;
begin
    select jsonb_build_object(
        'ok', true,
        'emitidos',        count(*),
        'monto_emitido',   coalesce(sum(total), 0),
        'aprobados',       count(*) filter (where estado in ('aprobado', 'convertido')),
        'monto_aprobado',  coalesce(sum(total) filter (where estado in ('aprobado', 'convertido')), 0),
        'rechazados',      count(*) filter (where estado = 'rechazado'),
        'monto_perdido',   coalesce(sum(total) filter (where estado = 'rechazado'), 0),
        'vencidos',        count(*) filter (where vencido),
        'tasa_conversion', case when count(*) > 0
                                then round(count(*) filter (where estado in ('aprobado', 'convertido'))
                                           * 100.0 / count(*), 1)
                                else 0 end,
        'perdida_por_motivo', (
            select coalesce(jsonb_object_agg(coalesce(motivo_rechazo_cat, 'sin_motivo'), n), '{}'::jsonb)
              from (select motivo_rechazo_cat, count(*) n
                      from taller_presupuestos
                     where empresa_id = p_empresa_id and estado = 'rechazado'
                       and fecha_emision between p_desde and p_hasta
                     group by motivo_rechazo_cat) t)
    ) into v_r
    from v_taller_presupuestos
    where empresa_id = p_empresa_id
      and estado <> 'reemplazado'
      and fecha_emision between p_desde and p_hasta;

    return coalesce(v_r, jsonb_build_object('ok', true));
exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Permisos
-- ════════════════════════════════════════════════════════════════

revoke all on function fn_solicitud_a_cita(uuid, uuid, date, time, integer, uuid, uuid, text) from public;
revoke all on function fn_mv_citas(uuid) from public;
revoke all on function fn_mv_cita_responder(uuid, text) from public;
revoke all on function fn_taller_recordatorios_citas() from public;
revoke all on function fn_taller_presup_motivo_perdida(uuid, uuid, text, text) from public;

grant execute on function fn_solicitud_a_cita(uuid, uuid, date, time, integer, uuid, uuid, text) to anon, authenticated;
grant execute on function fn_taller_presup_motivo_perdida(uuid, uuid, text, text) to anon, authenticated;
grant execute on function fn_mv_citas(uuid) to authenticated;
grant execute on function fn_mv_cita_responder(uuid, text) to authenticated;
grant execute on function fn_taller_recordatorios_citas() to service_role;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select fn_taller_recordatorios_citas();
-- select fn_reporte_presupuestos('<id>', date '2026-09-01', date '2026-09-30');
