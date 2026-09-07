-- ================================================================
-- 18_integracion_fase1a.sql — ARM TALLER ↔ MI VEHÍCULO
-- FASE 1a (parte ADITIVA): nada de lo de aquí rompe la app actual.
--
-- Contiene:
--   1. Patente en formato canónico (columna generada + índice)
--   2. taller_vehiculo_vinculo — el enlace vehículo ↔ taller ↔ propietario
--   3. taller_ot_estado_historial — quién cambió el estado de la OT y cuándo
--
-- NO contiene (va en un script aparte, coordinado, con la app abierta):
--   · Aplicar sql/12, sql/13, sql/14
--   · El corte a RLS real por token (Etapa 2 de sql/14)
--   · Las RPC de invitar / aceptar / revocar vínculo (FASE 1a punto 2)
--   · La ampliación de estados de OT 8 → 12 (FASE 1a punto 3)
--
-- Idempotente: se puede correr más de una vez.
-- Ejecutar en: Supabase → SQL Editor
--
-- ⚠ Después de este script, vuelve a correr sql/12_permisos.sql
--   (o los grants explícitos del final ya lo dejan cubierto).
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Patente en formato canónico
-- ════════════════════════════════════════════════════════════════
-- taller_vehiculos ya tiene UNIQUE (empresa_id, patente). El problema
-- no es la unicidad por taller: es que "CY-BX-30", "cybx30" y "CYBX30"
-- son la misma patente escrita distinto. Para correlacionar el mismo
-- auto entre ARM Taller y Mi Vehículo (autodocumentos_vehicles.plate)
-- necesitamos UNA forma canónica: mayúsculas, sin separadores.
--
-- La columna es GENERATED: se llena sola, el front no cambia. Las
-- consultas actuales por `patente` siguen igual; las nuevas usan
-- `patente_norm`.

alter table taller_vehiculos
    add column if not exists patente_norm text
    generated always as (
        upper(regexp_replace(coalesce(patente, ''), '[^A-Za-z0-9]+', '', 'g'))
    ) stored;

-- Un mismo auto no debería estar dos veces en el MISMO taller aunque
-- la patente esté escrita distinto. (Entre talleres distintos SÍ puede
-- estar: es el mismo auto atendido en dos lados.)
create unique index if not exists ux_taller_veh_patente_norm
    on taller_vehiculos (empresa_id, patente_norm)
    where patente_norm <> '';

create index if not exists idx_taller_veh_patente_norm
    on taller_vehiculos (patente_norm)
    where patente_norm <> '';

-- Nota para el repo ARM-DocsCars (Mi Vehículo): agregar la columna
-- equivalente en autodocumentos_vehicles con una migración propia:
--   alter table autodocumentos_vehicles
--     add column plate_norm text generated always as
--       (upper(regexp_replace(coalesce(plate,''), '[^A-Za-z0-9]+', '', 'g'))) stored;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — El enlace vehículo ↔ taller ↔ propietario
-- ════════════════════════════════════════════════════════════════
-- Un vehículo del taller (taller_vehiculos) queda vinculado a un
-- vehículo de Mi Vehículo (autodocumentos_vehicles) tras que el
-- PROPIETARIO lo autorice. Mientras tanto vive como 'pendiente' con
-- un token de invitación que caduca.
--
-- autodoc_vehicle_id NO lleva FK a autodocumentos_vehicles a propósito:
-- los dos productos comparten base pero se mantienen desacoplados en el
-- esquema. La existencia y la propiedad del vehículo Mi Vehículo las
-- valida la Edge Function / RPC de "aceptar", con service role.

create table if not exists taller_vehiculo_vinculo (
    id                  uuid primary key default gen_random_uuid(),
    empresa_id          uuid not null references empresas(id),

    taller_vehiculo_id  uuid not null references taller_vehiculos(id) on delete cascade,
    taller_cliente_id   uuid references taller_clientes(id),
    autodoc_vehicle_id  uuid,                 -- autodocumentos_vehicles.id (soft ref)
    patente_norm        text not null,

    estado              text not null default 'pendiente'
                        check (estado in ('pendiente', 'activo', 'revocado', 'rechazado')),

    token_invitacion    uuid not null default gen_random_uuid(),
    invitacion_expira_at timestamptz not null default now() + interval '7 days',

    -- Quién y cómo autorizó desde el lado del propietario
    autorizado_por      text,
    canal_autorizacion  text check (canal_autorizacion in
                        ('mi_vehiculo', 'presencial', 'telefono', 'whatsapp', 'email', 'otro')),

    fecha_vinculacion   timestamptz,          -- cuándo pasó a 'activo'
    revocado_por        text,
    revocado_motivo     text,

    creado_por          text,                 -- usuario_rut del taller que invitó
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- Un solo vínculo ACTIVO por par (vehículo del taller ↔ vehículo Mi Vehículo)
create unique index if not exists ux_vinculo_activo_par
    on taller_vehiculo_vinculo (taller_vehiculo_id, autodoc_vehicle_id)
    where estado = 'activo';

-- Una sola invitación PENDIENTE por vehículo del taller
create unique index if not exists ux_vinculo_pendiente
    on taller_vehiculo_vinculo (taller_vehiculo_id)
    where estado = 'pendiente';

create index if not exists idx_vinculo_token
    on taller_vehiculo_vinculo (token_invitacion) where estado = 'pendiente';

create index if not exists idx_vinculo_autodoc
    on taller_vehiculo_vinculo (autodoc_vehicle_id) where estado = 'activo';

create index if not exists idx_vinculo_empresa
    on taller_vehiculo_vinculo (empresa_id, estado);


-- updated_at automático
create or replace function fn_trg_vinculo_touch()
returns trigger
language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_vinculo_touch on taller_vehiculo_vinculo;
create trigger trg_vinculo_touch
    before update on taller_vehiculo_vinculo
    for each row execute function fn_trg_vinculo_touch();


-- Rellenar patente_norm desde el vehículo del taller si viene vacía
create or replace function fn_trg_vinculo_patente()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.patente_norm is null or new.patente_norm = '' then
        select patente_norm into new.patente_norm
          from taller_vehiculos where id = new.taller_vehiculo_id;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_vinculo_patente on taller_vehiculo_vinculo;
create trigger trg_vinculo_patente
    before insert or update on taller_vehiculo_vinculo
    for each row execute function fn_trg_vinculo_patente();


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Historial de estados de la OT
-- ════════════════════════════════════════════════════════════════
-- Cada cambio de estado de la OT deja rastro: estado anterior, nuevo,
-- momento y origen. El "quién" (usuario_rut) se llena bien cuando esté
-- aplicado sql/14 (taller_rut_actual()); hasta entonces queda null en
-- los cambios hechos directo por el cliente Supabase.

create table if not exists taller_ot_estado_historial (
    id               uuid primary key default gen_random_uuid(),
    empresa_id       uuid not null,
    orden_id         uuid not null references taller_ordenes(id) on delete cascade,
    estado_anterior  text,
    estado_nuevo     text not null,
    nota             text,
    usuario_rut      text,
    origen           text not null default 'sistema'
                     check (origen in ('taller', 'mi_vehiculo', 'whatsapp', 'sistema')),
    ts               timestamptz not null default now()
);

create index if not exists idx_ot_hist_orden
    on taller_ot_estado_historial (orden_id, ts);


create or replace function fn_trg_ot_estado_historial()
returns trigger
language plpgsql
set search_path = public
as $$
declare
    v_rut text;
begin
    -- Intento de resolver el usuario si sql/14 ya está aplicado
    begin
        v_rut := taller_rut_actual();
    exception when undefined_function then
        v_rut := null;
    end;

    if tg_op = 'INSERT' then
        insert into taller_ot_estado_historial
            (empresa_id, orden_id, estado_anterior, estado_nuevo, usuario_rut, origen)
        values (new.empresa_id, new.id, null, new.estado, v_rut, 'sistema');
        return new;
    end if;

    if new.estado is distinct from old.estado then
        insert into taller_ot_estado_historial
            (empresa_id, orden_id, estado_anterior, estado_nuevo, usuario_rut, origen)
        values (new.empresa_id, new.id, old.estado, new.estado, v_rut, 'sistema');
    end if;
    return new;
end;
$$;

drop trigger if exists trg_ot_estado_historial on taller_ordenes;
create trigger trg_ot_estado_historial
    after insert or update of estado on taller_ordenes
    for each row execute function fn_trg_ot_estado_historial();


-- Sembrar el estado actual de las OT que ya existen (una sola vez)
insert into taller_ot_estado_historial (empresa_id, orden_id, estado_anterior, estado_nuevo, origen)
select o.empresa_id, o.id, null, o.estado, 'sistema'
  from taller_ordenes o
 where not exists (
       select 1 from taller_ot_estado_historial h where h.orden_id = o.id);


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Permisos
-- ════════════════════════════════════════════════════════════════
-- Mismo criterio que el resto del núcleo del taller HOY: tablas
-- accesibles por anon/authenticated, sin RLS todavía. El corte a RLS
-- por token (sql/14 Etapa 2) las incluirá junto con las demás.

grant select, insert, update, delete on public.taller_vehiculo_vinculo   to anon, authenticated;
grant select, insert, update, delete on public.taller_ot_estado_historial to anon, authenticated;

-- Supabase activa RLS sola en las tablas nuevas de public. Hasta el
-- corte a RLS real (sql/13 + sql/14 Etapa 2), el núcleo del taller
-- corre con RLS desactivada: estas van al mismo nivel para no quedar
-- en deny-all para el cliente anon.
alter table public.taller_vehiculo_vinculo    disable row level security;
alter table public.taller_ot_estado_historial disable row level security;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select patente, patente_norm from taller_vehiculos order by patente_norm;
--
-- select numero, count(*) cambios
--   from taller_ordenes o
--   join taller_ot_estado_historial h on h.orden_id = o.id
--  group by numero order by numero;
--
-- -- Simular una invitación:
-- insert into taller_vehiculo_vinculo (empresa_id, taller_vehiculo_id, taller_cliente_id, creado_por)
-- select empresa_id, id, cliente_id, 'test'
--   from taller_vehiculos where patente_norm = 'CYBX30' limit 1;
-- select id, estado, patente_norm, token_invitacion, invitacion_expira_at
--   from taller_vehiculo_vinculo;
-- delete from taller_vehiculo_vinculo where creado_por = 'test';
