-- ================================================================
-- 09_agenda.sql — ARM TALLER
-- Agenda de citas por bahía y mecánico.
--
-- ⚠ REQUIERE el esquema base. Se integra con Empleados (04) y
--   Mantenciones (07) si están activos, pero no los exige.
--
-- ── Por qué la bahía y no solo la hora ──────────────────────────
-- Un taller no se llena de horas, se llena de espacio físico. Con
-- dos elevadores no importa que la agenda diga "9:00 libre": si los
-- dos están ocupados, el auto espera en la calle. Por eso la unidad
-- de capacidad es la BAHÍA, y la agenda bloquea choques ahí.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Bahías (puestos de trabajo)
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_bahias (
    id          uuid primary key default gen_random_uuid(),
    empresa_id  uuid not null,
    nombre      text not null,
    tipo        text not null default 'general'
                check (tipo in ('general', 'elevador', 'piso', 'alineacion',
                                'pintura', 'diagnostico', 'lavado')),
    orden       integer not null default 0,
    activo      boolean not null default true,
    created_at  timestamptz not null default now()
);

create index if not exists idx_bahias_empresa
    on taller_bahias (empresa_id, activo, orden);


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Horario del taller
-- ════════════════════════════════════════════════════════════════
-- Una fila por empresa. Define de dónde a dónde se puede agendar.

create table if not exists taller_config_agenda (
    empresa_id       uuid primary key,
    hora_apertura    time not null default '09:00',
    hora_cierre      time not null default '18:30',
    intervalo_min    integer not null default 30,   -- grilla de la agenda
    duracion_default integer not null default 60,
    -- 1 = lunes … 7 = domingo
    dias_habiles     integer[] not null default '{1,2,3,4,5,6}',
    updated_at       timestamptz not null default now()
);


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Citas
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_citas (
    id            uuid primary key default gen_random_uuid(),
    empresa_id    uuid not null,
    numero        integer,

    cliente_id    uuid,
    vehiculo_id   uuid,
    -- Para el que llama y todavía no está en la base
    cliente_texto text,
    patente_texto text,
    telefono      text,

    fecha         date not null,
    hora_inicio   time not null,
    duracion_min  integer not null default 60 check (duracion_min > 0),

    bahia_id      uuid references taller_bahias(id) on delete set null,
    mecanico_id   uuid,

    servicio      text,
    motivo        text,
    observacion   text,

    estado        text not null default 'agendada'
                  check (estado in ('agendada', 'confirmada', 'en_taller',
                                    'completada', 'no_asistio', 'cancelada')),
    origen        text not null default 'telefono'
                  check (origen in ('telefono', 'presencial', 'whatsapp',
                                    'email', 'web', 'mantencion')),

    mantencion_id uuid,     -- si nació de un recordatorio de mantención
    orden_id      uuid,     -- OT creada cuando el auto llegó

    recordado_at  timestamptz,
    usuario_rut   text,
    created_at    timestamptz not null default now()
);

create index if not exists idx_citas_empresa_fecha
    on taller_citas (empresa_id, fecha, hora_inicio);

create index if not exists idx_citas_bahia
    on taller_citas (bahia_id, fecha) where bahia_id is not null;

create index if not exists idx_citas_estado
    on taller_citas (empresa_id, estado, fecha);


-- ── La agenda, ya resuelta ──────────────────────────────────────
create or replace view v_taller_citas as
select
    c.*,
    (c.hora_inicio + (c.duracion_min || ' minutes')::interval)::time as hora_fin,

    b.nombre as bahia_nombre,
    b.tipo   as bahia_tipo,

    coalesce(cl.nombre, c.cliente_texto)  as cliente_nombre,
    coalesce(cl.telefono, c.telefono)     as cliente_telefono,
    coalesce(v.patente, c.patente_texto)  as patente,
    v.marca,
    v.modelo,
    v.kilometraje,

    (c.fecha - current_date) as dias_para,
    (c.fecha < current_date and c.estado in ('agendada', 'confirmada')) as atrasada

from taller_citas c
left join taller_bahias   b  on b.id  = c.bahia_id
left join taller_clientes cl on cl.id = c.cliente_id
left join taller_vehiculos v on v.id  = c.vehiculo_id;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Agendar, con bloqueo de choques
-- ════════════════════════════════════════════════════════════════
-- Dos autos no caben en el mismo elevador a la misma hora, y un
-- mecánico no se parte en dos. La base lo impide; no se confía en
-- que la persona mire bien la pantalla.

create or replace function fn_agendar_cita(
    p_empresa_id   uuid,
    p_fecha        date,
    p_hora         time,
    p_duracion     integer,
    p_cliente_id   uuid    default null,
    p_vehiculo_id  uuid    default null,
    p_bahia_id     uuid    default null,
    p_mecanico_id  uuid    default null,
    p_servicio     text    default null,
    p_motivo       text    default null,
    p_origen       text    default 'telefono',
    p_cliente_texto text   default null,
    p_patente_texto text   default null,
    p_telefono     text    default null,
    p_mantencion_id uuid   default null,
    p_cita_id      uuid    default null,   -- para reagendar la misma cita
    p_usuario      text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cfg     taller_config_agenda%rowtype;
    v_fin     time;
    v_choque  record;
    v_numero  integer;
    v_id      uuid;
    v_dow     integer;
begin
    if p_duracion is null or p_duracion <= 0 then
        return jsonb_build_object('ok', false, 'error', 'La duración debe ser mayor que cero.');
    end if;

    v_fin := (p_hora + (p_duracion || ' minutes')::interval)::time;

    -- ── Horario del taller ──────────────────────────────────────
    select * into v_cfg from taller_config_agenda where empresa_id = p_empresa_id;

    if found then
        v_dow := extract(isodow from p_fecha);
        if not (v_dow = any(v_cfg.dias_habiles)) then
            return jsonb_build_object('ok', false,
                'error', 'Ese día el taller no atiende.');
        end if;
        if p_hora < v_cfg.hora_apertura or v_fin > v_cfg.hora_cierre then
            return jsonb_build_object('ok', false,
                'error', format('El taller atiende de %s a %s.',
                    to_char(v_cfg.hora_apertura, 'HH24:MI'),
                    to_char(v_cfg.hora_cierre, 'HH24:MI')));
        end if;
    end if;

    -- ── Choque de bahía ─────────────────────────────────────────
    if p_bahia_id is not null then
        select c.id, c.hora_inicio, c.duracion_min,
               coalesce(cl.nombre, c.cliente_texto) as quien
          into v_choque
          from taller_citas c
          left join taller_clientes cl on cl.id = c.cliente_id
         where c.empresa_id = p_empresa_id
           and c.bahia_id = p_bahia_id
           and c.fecha = p_fecha
           and c.estado not in ('cancelada', 'no_asistio')
           and (p_cita_id is null or c.id <> p_cita_id)
           and (p_hora, v_fin) overlaps
               (c.hora_inicio, (c.hora_inicio + (c.duracion_min || ' minutes')::interval)::time)
         limit 1;

        if found then
            return jsonb_build_object('ok', false,
                'error', format('La bahía ya está ocupada a las %s por %s.',
                    to_char(v_choque.hora_inicio, 'HH24:MI'),
                    coalesce(v_choque.quien, 'otra cita')));
        end if;
    end if;

    -- ── Choque de mecánico ──────────────────────────────────────
    if p_mecanico_id is not null then
        select c.hora_inicio into v_choque
          from taller_citas c
         where c.empresa_id = p_empresa_id
           and c.mecanico_id = p_mecanico_id
           and c.fecha = p_fecha
           and c.estado not in ('cancelada', 'no_asistio')
           and (p_cita_id is null or c.id <> p_cita_id)
           and (p_hora, v_fin) overlaps
               (c.hora_inicio, (c.hora_inicio + (c.duracion_min || ' minutes')::interval)::time)
         limit 1;

        if found then
            return jsonb_build_object('ok', false,
                'error', format('Ese mecánico ya tiene una cita a las %s.',
                    to_char(v_choque.hora_inicio, 'HH24:MI')));
        end if;
    end if;

    -- ── Guardar ─────────────────────────────────────────────────
    if p_cita_id is not null then
        update taller_citas
           set fecha = p_fecha, hora_inicio = p_hora, duracion_min = p_duracion,
               bahia_id = p_bahia_id, mecanico_id = p_mecanico_id,
               servicio = p_servicio, motivo = p_motivo,
               cliente_id = p_cliente_id, vehiculo_id = p_vehiculo_id,
               origen = coalesce(p_origen, origen),
               cliente_texto = case when p_cliente_id is null then p_cliente_texto end,
               patente_texto = case when p_cliente_id is null
                                    then upper(nullif(p_patente_texto, '')) end,
               telefono      = case when p_cliente_id is null then p_telefono end
         where id = p_cita_id and empresa_id = p_empresa_id
        returning id, numero into v_id, v_numero;

        if v_id is null then
            return jsonb_build_object('ok', false, 'error', 'Cita no encontrada.');
        end if;
    else
        select coalesce(max(numero), 0) + 1 into v_numero
          from taller_citas where empresa_id = p_empresa_id;

        insert into taller_citas (
            empresa_id, numero, cliente_id, vehiculo_id, cliente_texto, patente_texto,
            telefono, fecha, hora_inicio, duracion_min, bahia_id, mecanico_id,
            servicio, motivo, origen, mantencion_id, usuario_rut)
        values (
            p_empresa_id, v_numero, p_cliente_id, p_vehiculo_id, p_cliente_texto,
            upper(nullif(p_patente_texto, '')), p_telefono,
            p_fecha, p_hora, p_duracion, p_bahia_id, p_mecanico_id,
            p_servicio, p_motivo, coalesce(p_origen, 'telefono'), p_mantencion_id, p_usuario)
        returning id into v_id;
    end if;

    return jsonb_build_object('ok', true, 'cita_id', v_id, 'numero', v_numero,
        'hora_fin', to_char(v_fin, 'HH24:MI'));

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — El auto llegó: cita → orden de trabajo
-- ════════════════════════════════════════════════════════════════

create or replace function fn_cita_a_orden(
    p_empresa_id uuid,
    p_cita_id    uuid,
    p_km         integer default null,
    p_usuario    text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_c      taller_citas%rowtype;
    v_numero integer;
    v_orden  uuid;
begin
    select * into v_c
      from taller_citas
     where id = p_cita_id and empresa_id = p_empresa_id
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Cita no encontrada.');
    end if;
    if v_c.orden_id is not null then
        return jsonb_build_object('ok', false,
            'error', 'Esta cita ya tiene una orden de trabajo.', 'orden_id', v_c.orden_id);
    end if;
    if v_c.vehiculo_id is null then
        return jsonb_build_object('ok', false,
            'error', 'La cita no tiene vehículo registrado. Recepciónalo desde Recepción.');
    end if;

    begin
        v_numero := fn_taller_siguiente_numero(p_empresa_id, 'orden');
    exception when others then
        select coalesce(max(numero), 0) + 1 into v_numero
          from taller_ordenes where empresa_id = p_empresa_id;
    end;

    insert into taller_ordenes (
        empresa_id, numero, cliente_id, vehiculo_id, estado,
        kilometraje_ingreso, motivo_ingreso, usuario_creacion)
    values (
        p_empresa_id, v_numero, v_c.cliente_id, v_c.vehiculo_id, 'recepcion',
        p_km, coalesce(v_c.motivo, v_c.servicio), p_usuario)
    returning id into v_orden;

    if p_km is not null then
        update taller_vehiculos set kilometraje = p_km where id = v_c.vehiculo_id;
    end if;

    update taller_citas
       set estado = 'en_taller', orden_id = v_orden
     where id = p_cita_id;

    return jsonb_build_object('ok', true, 'orden_id', v_orden, 'numero', v_numero);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Carga del día y tasa de inasistencia
-- ════════════════════════════════════════════════════════════════
-- La inasistencia es el costo invisible de un taller: la bahía queda
-- vacía y ya se rechazó a otro cliente para esa hora.

create or replace function fn_resumen_agenda(
    p_empresa_id uuid,
    p_fecha      date default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_f         date := coalesce(p_fecha, current_date);
    v_cfg       taller_config_agenda%rowtype;
    v_bahias    integer;
    v_capacidad numeric;
    v_ocupado   numeric;
    v_r         jsonb;
begin
    select * into v_cfg from taller_config_agenda where empresa_id = p_empresa_id;

    select count(*) into v_bahias
      from taller_bahias where empresa_id = p_empresa_id and activo = true;

    v_capacidad := case
        when found and v_bahias > 0
        then v_bahias * (extract(epoch from (v_cfg.hora_cierre - v_cfg.hora_apertura)) / 60)
        else 0 end;

    select coalesce(sum(duracion_min), 0) into v_ocupado
      from taller_citas
     where empresa_id = p_empresa_id and fecha = v_f
       and estado not in ('cancelada', 'no_asistio');

    select jsonb_build_object(
        'ok', true,
        'fecha', v_f,
        'citas',      count(*) filter (where estado not in ('cancelada')),
        'confirmadas',count(*) filter (where estado = 'confirmada'),
        'en_taller',  count(*) filter (where estado = 'en_taller'),
        'completadas',count(*) filter (where estado = 'completada'),
        'no_asistio', count(*) filter (where estado = 'no_asistio'),
        'sin_confirmar', count(*) filter (where estado = 'agendada'),
        'minutos_ocupados', v_ocupado,
        'minutos_capacidad', v_capacidad,
        'ocupacion_pct', case when v_capacidad > 0
                              then round(v_ocupado / v_capacidad * 100, 1) else 0 end
    ) into v_r
    from taller_citas
    where empresa_id = p_empresa_id and fecha = v_f;

    -- Inasistencia de los últimos 90 días
    select v_r || jsonb_build_object(
        'no_asistio_90', count(*) filter (where estado = 'no_asistio'),
        'cerradas_90',   count(*) filter (where estado in ('completada', 'no_asistio')),
        'tasa_inasistencia', case
            when count(*) filter (where estado in ('completada', 'no_asistio')) > 0
            then round(count(*) filter (where estado = 'no_asistio') * 100.0
                     / count(*) filter (where estado in ('completada', 'no_asistio')), 1)
            else 0 end)
      into v_r
      from taller_citas
     where empresa_id = p_empresa_id and fecha >= current_date - 90;

    return v_r;

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Bahías y horario por defecto, para no partir de cero ────────
create or replace function fn_agenda_inicial(p_empresa_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_creadas integer := 0;
begin
    insert into taller_config_agenda (empresa_id)
    values (p_empresa_id)
    on conflict (empresa_id) do nothing;

    if not exists (select 1 from taller_bahias where empresa_id = p_empresa_id) then
        insert into taller_bahias (empresa_id, nombre, tipo, orden) values
            (p_empresa_id, 'Bahía 1', 'elevador', 1),
            (p_empresa_id, 'Bahía 2', 'elevador', 2),
            (p_empresa_id, 'Bahía 3', 'piso', 3);
        v_creadas := 3;
    end if;

    return jsonb_build_object('ok', true, 'bahias_creadas', v_creadas);
end;
$$;


-- ── Permisos ────────────────────────────────────────────────────
do $$
declare f text;
begin
    foreach f in array array[
        'fn_agendar_cita(uuid, date, time, integer, uuid, uuid, uuid, uuid, text, text, text, text, text, text, uuid, uuid, text)',
        'fn_cita_a_orden(uuid, uuid, integer, text)',
        'fn_resumen_agenda(uuid, date)',
        'fn_agenda_inicial(uuid)'
    ] loop
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to anon, authenticated', f);
    end loop;
end $$;


-- ════════════════════════════════════════════════════════════════
-- OPCIONAL — Bloqueo de choques a nivel de constraint
-- ════════════════════════════════════════════════════════════════
-- fn_agendar_cita ya valida los solapamientos, así que el sistema
-- funciona sin nada más. Si además quieres que la BASE lo impida
-- aunque alguien inserte por fuera del RPC, ejecuta el archivo
-- sql/09b_agenda_constraint_opcional.sql — se corre tal cual, sin
-- descomentar nada.

-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select fn_agenda_inicial('<id del taller>');
-- select fn_resumen_agenda('<id del taller>');
-- select numero, fecha, hora_inicio, hora_fin, bahia_nombre, cliente_nombre, estado
--   from v_taller_citas where empresa_id = '<id>' order by fecha, hora_inicio;
