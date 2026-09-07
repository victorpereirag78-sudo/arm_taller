-- ================================================================
-- 25_directorio_talleres.sql — ARM TALLER
-- FASE 1c punto 10: el taller aparece en el directorio de Mi Vehículo,
-- y el cliente puede pedir hora.
--
-- ⚠ REQUIERE sql/10 (taller_config).
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Perfil público del taller (extiende taller_config)
-- ════════════════════════════════════════════════════════════════

alter table taller_config
    add column if not exists descripcion    text,
    add column if not exists whatsapp       text,
    add column if not exists lat            double precision,
    add column if not exists lng            double precision,
    add column if not exists horario        text,
    add column if not exists servicios      text[] not null default '{}',
    add column if not exists especialidades text[] not null default '{}',
    add column if not exists marcas         text[] not null default '{}',
    add column if not exists publicado      boolean not null default false;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — El directorio (público: lo consume Mi Vehículo)
-- ════════════════════════════════════════════════════════════════

create or replace function fn_directorio_talleres(
    p_lat          double precision default null,
    p_lng          double precision default null,
    p_texto        text default null,
    p_especialidad text default null,
    p_marca        text default null,
    p_servicio     text default null,
    p_limite       integer default 100
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    with base as (
        select
            e.id as empresa_id, e.nombre, e.logo_url,
            c.descripcion, c.direccion, c.comuna, c.ciudad,
            c.telefono, c.whatsapp, c.email, c.sitio_web, c.horario,
            c.servicios, c.especialidades, c.marcas, c.lat, c.lng,
            case
              when p_lat is not null and p_lng is not null
                   and c.lat is not null and c.lng is not null
              then round((6371 * acos(least(1, greatest(-1,
                     cos(radians(p_lat)) * cos(radians(c.lat)) *
                     cos(radians(c.lng) - radians(p_lng)) +
                     sin(radians(p_lat)) * sin(radians(c.lat))))))::numeric, 1)
              else null
            end as distancia_km
        from taller_config c
        join empresas e on e.id = c.empresa_id
        where e.tipo = 'taller' and e.activo and c.publicado
          and (p_texto is null
               or e.nombre ilike '%' || p_texto || '%'
               or coalesce(c.comuna, '') ilike '%' || p_texto || '%'
               or coalesce(c.ciudad, '') ilike '%' || p_texto || '%')
          and (p_especialidad is null or c.especialidades @> array[p_especialidad])
          and (p_marca      is null or c.marcas         @> array[p_marca])
          and (p_servicio   is null or c.servicios      @> array[p_servicio])
    ),
    lim as (
        select * from base
        order by distancia_km nulls last, nombre
        limit greatest(coalesce(p_limite, 100), 1)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'empresa_id', empresa_id, 'nombre', nombre, 'logo_url', logo_url,
        'descripcion', descripcion, 'direccion', direccion,
        'comuna', comuna, 'ciudad', ciudad,
        'telefono', telefono, 'whatsapp', whatsapp, 'email', email,
        'sitio_web', sitio_web, 'horario', horario,
        'servicios', servicios, 'especialidades', especialidades, 'marcas', marcas,
        'lat', lat, 'lng', lng, 'distancia_km', distancia_km,
        'conectado_arm', true
    )), '[]'::jsonb)
    from lim
$$;


-- Valores para poblar los filtros (servicios / especialidades / marcas ya en uso)
create or replace function fn_directorio_filtros()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'servicios',      (select coalesce(jsonb_agg(distinct s order by s), '[]'::jsonb)
                             from taller_config c join empresas e on e.id = c.empresa_id,
                                  unnest(c.servicios) s
                            where e.tipo = 'taller' and e.activo and c.publicado),
        'especialidades', (select coalesce(jsonb_agg(distinct s order by s), '[]'::jsonb)
                             from taller_config c join empresas e on e.id = c.empresa_id,
                                  unnest(c.especialidades) s
                            where e.tipo = 'taller' and e.activo and c.publicado),
        'marcas',         (select coalesce(jsonb_agg(distinct s order by s), '[]'::jsonb)
                             from taller_config c join empresas e on e.id = c.empresa_id,
                                  unnest(c.marcas) s
                            where e.tipo = 'taller' and e.activo and c.publicado)
    )
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Solicitud de hora (Mi Vehículo → ARM Taller)
-- ════════════════════════════════════════════════════════════════
-- NO crea una cita ni una OT: es solo una solicitud que el taller
-- revisa. El flujo Solicitud → Cita → Recepción → OT es de la FASE 2.

create table if not exists taller_solicitudes_hora (
    id                 uuid primary key default gen_random_uuid(),
    empresa_id         uuid not null,
    autodoc_vehicle_id uuid,
    solicitante_uid    uuid,
    nombre             text,
    telefono           text,
    patente            text,
    vehiculo_desc      text,
    servicio           text,
    motivo             text,
    fecha_preferida    date,
    franja             text check (franja in ('manana', 'tarde', 'cualquiera')),
    estado             text not null default 'nueva'
                       check (estado in ('nueva', 'contactado', 'agendada', 'descartada')),
    notas              text,
    creado_at          timestamptz not null default now()
);

create index if not exists idx_solic_hora_empresa
    on taller_solicitudes_hora (empresa_id, estado, creado_at desc);


create or replace function fn_mv_solicitar_hora(
    p_empresa_id uuid,
    p_datos      jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
    v_id  uuid;
    v_nom text;
begin
    if v_uid is null then
        return jsonb_build_object('ok', false, 'error', 'Necesitas iniciar sesión.');
    end if;
    if not exists (select 1 from empresas
                    where id = p_empresa_id and tipo = 'taller' and activo) then
        return jsonb_build_object('ok', false, 'error', 'Taller no encontrado.');
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
        nullif(p_datos->>'fecha_preferida', '')::date,
        nullif(p_datos->>'franja', ''))
    returning id into v_id;

    return jsonb_build_object('ok', true, 'solicitud_id', v_id);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- Vista para el taller
create or replace view v_taller_solicitudes_hora as
select s.*,
       (s.estado = 'nueva') as sin_atender
from taller_solicitudes_hora s;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Permisos
-- ════════════════════════════════════════════════════════════════

grant select, insert, update, delete on public.taller_solicitudes_hora to anon, authenticated;
grant select on public.v_taller_solicitudes_hora to anon, authenticated;
alter table public.taller_solicitudes_hora disable row level security;

revoke all on function fn_directorio_talleres(double precision, double precision, text, text, text, text, integer) from public;
revoke all on function fn_directorio_filtros() from public;
revoke all on function fn_mv_solicitar_hora(uuid, jsonb) from public;
grant execute on function fn_directorio_talleres(double precision, double precision, text, text, text, text, integer) to anon, authenticated;
grant execute on function fn_directorio_filtros() to anon, authenticated;
grant execute on function fn_mv_solicitar_hora(uuid, jsonb) to authenticated;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- update taller_config set publicado = true,
--        servicios = array['Mantención','Frenos'], especialidades = array['Motos'],
--        marcas = array['Honda','Yamaha'], comuna = 'Maipú', ciudad = 'Santiago'
--  where empresa_id = '<id>';
-- select fn_directorio_talleres();
-- select fn_directorio_filtros();
