-- ================================================================
-- 07_mantenciones.sql — ARM TALLER
-- Mantenciones programadas y vencimientos del vehículo.
--
-- ⚠ REQUIERE el esquema base (taller_vehiculos, taller_ordenes).
--
-- Un taller vive de que el cliente vuelva. El vehículo ya trae toda
-- la información para saber cuándo toca: el kilometraje vivo y el
-- historial de órdenes. Esto solo la convierte en una lista de
-- llamados para mañana.
--
-- Vence por LO QUE OCURRA PRIMERO: la fecha o el kilometraje. Un
-- taxi llega a los 10.000 km en dos meses; un auto de fin de semana,
-- en dos años. Por eso no basta con una de las dos.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Planes de mantención (las reglas del taller)
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_planes_mantencion (
    id           uuid primary key default gen_random_uuid(),
    empresa_id   uuid not null,
    nombre       text not null,
    descripcion  text,
    tipo         text not null default 'mantencion'
                 check (tipo in ('mantencion', 'documento', 'garantia')),
    cada_km      integer,     -- nulo = no depende del kilometraje
    cada_meses   integer,     -- nulo = no depende de la fecha
    aviso_km     integer not null default 1000,   -- cuánto antes avisar
    aviso_dias   integer not null default 30,
    activo       boolean not null default true,
    created_at   timestamptz not null default now(),
    constraint chk_plan_periodicidad check (cada_km is not null or cada_meses is not null)
);

create index if not exists idx_planes_empresa
    on taller_planes_mantencion (empresa_id, activo);


-- ── Planes típicos, para que el taller no parta de cero ─────────
-- Se cargan desde el módulo con el botón "Cargar planes sugeridos".
create or replace function fn_planes_sugeridos(p_empresa_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_creados integer := 0;
    v_plan    record;
begin
    for v_plan in
        select * from (values
            ('Cambio de aceite y filtro', 'mantencion', 10000,  6,  1000, 30),
            ('Rotación de neumáticos',    'mantencion', 10000,  null, 1000, 30),
            ('Filtro de aire',            'mantencion', 20000,  12, 2000, 30),
            ('Pastillas de freno',        'mantencion', 30000,  null, 3000, 30),
            ('Líquido de frenos',         'mantencion', null,   24, null, 45),
            ('Correa de distribución',    'mantencion', 80000,  null, 5000, 60),
            ('Bujías',                    'mantencion', 40000,  null, 3000, 30),
            ('Revisión técnica',          'documento',  null,   12, null, 45),
            ('Permiso de circulación',    'documento',  null,   12, null, 45),
            ('Seguro obligatorio (SOAP)', 'documento',  null,   12, null, 45)
        ) as t(nombre, tipo, cada_km, cada_meses, aviso_km, aviso_dias)
    loop
        if not exists (select 1 from taller_planes_mantencion
                        where empresa_id = p_empresa_id and nombre = v_plan.nombre) then
            insert into taller_planes_mantencion
                (empresa_id, nombre, tipo, cada_km, cada_meses, aviso_km, aviso_dias)
            values (p_empresa_id, v_plan.nombre, v_plan.tipo, v_plan.cada_km,
                    v_plan.cada_meses, coalesce(v_plan.aviso_km, 0), v_plan.aviso_dias);
            v_creados := v_creados + 1;
        end if;
    end loop;

    return jsonb_build_object('ok', true, 'creados', v_creados);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Mantenciones programadas por vehículo
-- ════════════════════════════════════════════════════════════════
-- La periodicidad se copia del plan al programar: si mañana el taller
-- cambia el plan, las mantenciones ya agendadas no se mueven solas.

create table if not exists taller_mantenciones (
    id             uuid primary key default gen_random_uuid(),
    empresa_id     uuid not null,
    vehiculo_id    uuid not null references taller_vehiculos(id) on delete cascade,
    plan_id        uuid references taller_planes_mantencion(id) on delete set null,

    tipo           text not null default 'mantencion',
    descripcion    text not null,

    cada_km        integer,
    cada_meses     integer,
    aviso_km       integer not null default 1000,
    aviso_dias     integer not null default 30,

    ultima_fecha   date,
    ultimo_km      integer,
    proxima_fecha  date,
    proximo_km     integer,

    estado         text not null default 'programada'
                   check (estado in ('programada', 'completada', 'cancelada')),

    orden_id       uuid,          -- OT que la cumplió
    avisado_at     timestamptz,   -- última vez que se contactó al cliente
    notas          text,
    created_at     timestamptz not null default now()
);

create index if not exists idx_mant_empresa_estado
    on taller_mantenciones (empresa_id, estado, proxima_fecha);

create index if not exists idx_mant_vehiculo
    on taller_mantenciones (vehiculo_id, estado);

-- Una misma mantención no se agenda dos veces para el mismo vehículo
create unique index if not exists idx_mant_unica_programada
    on taller_mantenciones (vehiculo_id, plan_id)
    where estado = 'programada' and plan_id is not null;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — La lista de llamados
-- ════════════════════════════════════════════════════════════════
-- Vence por lo que ocurra primero: fecha o kilometraje.

create or replace view v_taller_mantenciones_pendientes as
select
    m.empresa_id,
    m.id            as mantencion_id,
    m.vehiculo_id,
    m.plan_id,
    m.tipo,
    m.descripcion,
    m.ultima_fecha,
    m.ultimo_km,
    m.proxima_fecha,
    m.proximo_km,
    m.avisado_at,
    m.notas,

    v.patente,
    v.marca,
    v.modelo,
    coalesce(v.kilometraje, 0) as km_actual,

    c.id       as cliente_id,
    c.nombre   as cliente,
    c.telefono,
    c.email,

    case when m.proxima_fecha is null then null
         else (m.proxima_fecha - current_date) end as dias_restantes,
    case when m.proximo_km is null then null
         else (m.proximo_km - coalesce(v.kilometraje, 0)) end as km_restantes,

    -- Vencida / por vencer / vigente
    case
        when (m.proxima_fecha is not null and m.proxima_fecha < current_date)
          or (m.proximo_km   is not null and coalesce(v.kilometraje, 0) >= m.proximo_km)
            then 'vencida'
        when (m.proxima_fecha is not null and m.proxima_fecha - current_date <= m.aviso_dias)
          or (m.proximo_km   is not null and m.proximo_km - coalesce(v.kilometraje, 0) <= m.aviso_km)
            then 'por_vencer'
        else 'vigente'
    end as situacion,

    case
        when (m.proxima_fecha is not null and m.proxima_fecha < current_date)
          or (m.proximo_km   is not null and coalesce(v.kilometraje, 0) >= m.proximo_km)
            then 0
        when (m.proxima_fecha is not null and m.proxima_fecha - current_date <= m.aviso_dias)
          or (m.proximo_km   is not null and m.proximo_km - coalesce(v.kilometraje, 0) <= m.aviso_km)
            then 1
        else 2
    end as prioridad,

    -- Qué lo gatilla: sirve para redactar el aviso al cliente
    case
        when m.proximo_km is not null and m.proxima_fecha is not null then
            case when (m.proximo_km - coalesce(v.kilometraje, 0)) <= 0
                   or ((m.proximo_km - coalesce(v.kilometraje, 0)) / 50.0)
                      < (m.proxima_fecha - current_date)
                 then 'km' else 'fecha' end
        when m.proximo_km is not null then 'km'
        else 'fecha'
    end as gatillo

from taller_mantenciones m
join taller_vehiculos v on v.id = m.vehiculo_id
left join taller_clientes c on c.id = v.cliente_id
where m.estado = 'programada'
  and v.activo = true;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Programar mantenciones a un vehículo
-- ════════════════════════════════════════════════════════════════
-- Aplica todos los planes activos que ese vehículo aún no tenga.
-- Se llama al registrar un vehículo o desde el módulo, en lote.

create or replace function fn_aplicar_planes_vehiculo(
    p_empresa_id  uuid,
    p_vehiculo_id uuid,
    p_km_base     integer default null,
    p_fecha_base  date    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_veh     taller_vehiculos%rowtype;
    v_plan    taller_planes_mantencion%rowtype;
    v_km      integer;
    v_fecha   date;
    v_creados integer := 0;
begin
    select * into v_veh
      from taller_vehiculos
     where id = p_vehiculo_id and empresa_id = p_empresa_id;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Vehículo no encontrado.');
    end if;

    v_km    := coalesce(p_km_base, v_veh.kilometraje, 0);
    v_fecha := coalesce(p_fecha_base, current_date);

    for v_plan in
        select * from taller_planes_mantencion
         where empresa_id = p_empresa_id and activo = true
    loop
        if exists (select 1 from taller_mantenciones
                    where vehiculo_id = p_vehiculo_id
                      and plan_id = v_plan.id
                      and estado = 'programada') then
            continue;
        end if;

        insert into taller_mantenciones (
            empresa_id, vehiculo_id, plan_id, tipo, descripcion,
            cada_km, cada_meses, aviso_km, aviso_dias,
            ultima_fecha, ultimo_km, proxima_fecha, proximo_km)
        values (
            p_empresa_id, p_vehiculo_id, v_plan.id, v_plan.tipo, v_plan.nombre,
            v_plan.cada_km, v_plan.cada_meses, v_plan.aviso_km, v_plan.aviso_dias,
            v_fecha, v_km,
            case when v_plan.cada_meses is not null
                 then v_fecha + (v_plan.cada_meses || ' months')::interval end,
            case when v_plan.cada_km is not null then v_km + v_plan.cada_km end);

        v_creados := v_creados + 1;
    end loop;

    return jsonb_build_object('ok', true, 'creados', v_creados);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Completar una mantención y agendar la siguiente
-- ════════════════════════════════════════════════════════════════
-- El ciclo se cierra solo: se marca hecha y queda la próxima en la
-- lista. Si no se reagenda, el taller pierde al cliente en silencio.

create or replace function fn_completar_mantencion(
    p_empresa_id    uuid,
    p_mantencion_id uuid,
    p_km            integer default null,
    p_fecha         date    default null,
    p_orden_id      uuid    default null,
    p_notas         text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_m       taller_mantenciones%rowtype;
    v_km      integer;
    v_fecha   date;
    v_nueva   uuid;
begin
    select * into v_m
      from taller_mantenciones
     where id = p_mantencion_id and empresa_id = p_empresa_id
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Mantención no encontrada.');
    end if;
    if v_m.estado <> 'programada' then
        return jsonb_build_object('ok', false, 'error', 'Esta mantención ya no está programada.');
    end if;

    v_fecha := coalesce(p_fecha, current_date);
    select coalesce(p_km, kilometraje, 0) into v_km
      from taller_vehiculos where id = v_m.vehiculo_id;

    update taller_mantenciones
       set estado = 'completada',
           ultima_fecha = v_fecha,
           ultimo_km = v_km,
           orden_id = p_orden_id,
           notas = coalesce(p_notas, notas)
     where id = p_mantencion_id;

    -- Reagendar la siguiente vuelta
    if v_m.cada_km is not null or v_m.cada_meses is not null then
        insert into taller_mantenciones (
            empresa_id, vehiculo_id, plan_id, tipo, descripcion,
            cada_km, cada_meses, aviso_km, aviso_dias,
            ultima_fecha, ultimo_km, proxima_fecha, proximo_km)
        values (
            v_m.empresa_id, v_m.vehiculo_id, v_m.plan_id, v_m.tipo, v_m.descripcion,
            v_m.cada_km, v_m.cada_meses, v_m.aviso_km, v_m.aviso_dias,
            v_fecha, v_km,
            case when v_m.cada_meses is not null
                 then v_fecha + (v_m.cada_meses || ' months')::interval end,
            case when v_m.cada_km is not null then v_km + v_m.cada_km end)
        returning id into v_nueva;
    end if;

    return jsonb_build_object('ok', true, 'siguiente_id', v_nueva,
        'ultimo_km', v_km, 'ultima_fecha', v_fecha);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Registrar que se contactó al cliente ────────────────────────
create or replace function fn_marcar_avisada(
    p_empresa_id    uuid,
    p_mantencion_id uuid,
    p_nota          text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    update taller_mantenciones
       set avisado_at = now(),
           notas = case when p_nota is null or p_nota = '' then notas
                        else coalesce(notas || ' | ', '') ||
                             to_char(now(), 'DD-MM-YYYY') || ': ' || p_nota end
     where id = p_mantencion_id and empresa_id = p_empresa_id and estado = 'programada';

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Mantención no encontrada.');
    end if;
    return jsonb_build_object('ok', true);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Resumen para el dashboard
-- ════════════════════════════════════════════════════════════════

create or replace function fn_resumen_mantenciones(p_empresa_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_r jsonb;
begin
    select jsonb_build_object(
        'ok', true,
        'vencidas',    count(*) filter (where situacion = 'vencida'),
        'por_vencer',  count(*) filter (where situacion = 'por_vencer'),
        'vigentes',    count(*) filter (where situacion = 'vigente'),
        'sin_avisar',  count(*) filter (where situacion in ('vencida', 'por_vencer')
                                          and avisado_at is null),
        'sin_telefono',count(*) filter (where situacion in ('vencida', 'por_vencer')
                                          and coalesce(telefono, '') = '')
    ) into v_r
    from v_taller_mantenciones_pendientes
    where empresa_id = p_empresa_id;

    return coalesce(v_r, jsonb_build_object('ok', true));

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Permisos ────────────────────────────────────────────────────
do $$
declare f text;
begin
    foreach f in array array[
        'fn_planes_sugeridos(uuid)',
        'fn_aplicar_planes_vehiculo(uuid, uuid, integer, date)',
        'fn_completar_mantencion(uuid, uuid, integer, date, uuid, text)',
        'fn_marcar_avisada(uuid, uuid, text)',
        'fn_resumen_mantenciones(uuid)'
    ] loop
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to anon, authenticated', f);
    end loop;
end $$;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select fn_planes_sugeridos('<id del taller>');
-- select * from v_taller_mantenciones_pendientes
--  where empresa_id = '<id>' order by prioridad, dias_restantes nulls last;
