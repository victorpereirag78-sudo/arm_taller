-- ================================================================
-- 20_ot_estados.sql — ARM TALLER
-- FASE 1a punto 3: los 12 estados de la OT y la validación de
-- transiciones DENTRO de la base.
--
-- ⚠ REQUIERE sql/18 (usa taller_ot_estado_historial ya creado ahí).
--
-- ── Criterio: sin renombrar lo que ya funciona ─────────────────
-- Los 8 estados actuales de taller_ordenes se usan en 8 scripts SQL
-- (03, 04, 06, 08, 09, 11…) y en varios módulos JS. Renombrarlos sería
-- tocar todo eso. En vez de eso:
--   · Se CONSERVAN los 8 códigos actuales
--     (recepcion, diagnostico, presupuesto, aprobada,
--      reparacion, lista, entregada, anulada)
--   · Se AGREGAN los 4 que faltan del brief:
--     diagnostico_terminado, rechazado, esperando_repuestos, trabajo_terminado
-- La etiqueta que ve el usuario ("Recepcionado", "En diagnóstico", …)
-- vive en taller_ot_estados, así que la UI habla el idioma del brief
-- aunque el código interno sea corto.
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Catálogo de estados
-- ════════════════════════════════════════════════════════════════
-- Global por ahora (no por taller). La estructura permite volverlo
-- configurable por empresa más adelante sin migrar datos.

create table if not exists taller_ot_estados (
    codigo     text primary key,
    etiqueta   text not null,
    posicion   integer not null,
    categoria  text not null default 'general',
    es_final   boolean not null default false,
    activo     boolean not null default true
);

insert into taller_ot_estados (codigo, etiqueta, posicion, categoria, es_final) values
    ('recepcion',             'Recepcionado',          10,  'entrada',     false),
    ('diagnostico',           'En diagnóstico',        20,  'diagnostico', false),
    ('diagnostico_terminado', 'Diagnóstico terminado', 30,  'diagnostico', false),
    ('presupuesto',           'Esperando aprobación',  40,  'aprobacion',  false),
    ('aprobada',              'Aprobado',              50,  'aprobacion',  false),
    ('rechazado',             'Rechazado',             55,  'aprobacion',  false),
    ('esperando_repuestos',   'Esperando repuestos',   60,  'trabajo',     false),
    ('reparacion',            'En reparación',         70,  'trabajo',     false),
    ('trabajo_terminado',     'Trabajo terminado',     80,  'trabajo',     false),
    ('lista',                 'Listo para retirar',    90,  'cierre',      false),
    ('entregada',             'Entregado',             100, 'cierre',      true),
    ('anulada',               'Anulado',               999, 'cierre',      true)
on conflict (codigo) do update
    set etiqueta = excluded.etiqueta,
        posicion = excluded.posicion,
        categoria = excluded.categoria,
        es_final = excluded.es_final;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Grafo de transiciones permitidas
-- ════════════════════════════════════════════════════════════════
-- Regla: se avanza, se retrocede un paso, o se anula. No se salta de
-- 'recepcion' a 'entregada' sin pasar por el trabajo.

create table if not exists taller_ot_transiciones (
    desde text not null references taller_ot_estados(codigo),
    hasta text not null references taller_ot_estados(codigo),
    primary key (desde, hasta)
);

insert into taller_ot_transiciones (desde, hasta) values
    ('recepcion',             'diagnostico'),
    ('recepcion',             'presupuesto'),
    ('recepcion',             'reparacion'),
    ('recepcion',             'anulada'),

    ('diagnostico',           'diagnostico_terminado'),
    ('diagnostico',           'presupuesto'),
    ('diagnostico',           'reparacion'),
    ('diagnostico',           'anulada'),

    ('diagnostico_terminado', 'presupuesto'),
    ('diagnostico_terminado', 'aprobada'),
    ('diagnostico_terminado', 'reparacion'),
    ('diagnostico_terminado', 'anulada'),

    ('presupuesto',           'aprobada'),
    ('presupuesto',           'rechazado'),
    ('presupuesto',           'diagnostico'),
    ('presupuesto',           'anulada'),

    ('aprobada',              'esperando_repuestos'),
    ('aprobada',              'reparacion'),
    ('aprobada',              'presupuesto'),
    ('aprobada',              'anulada'),

    ('rechazado',             'presupuesto'),
    ('rechazado',             'diagnostico'),
    ('rechazado',             'anulada'),

    ('esperando_repuestos',   'reparacion'),
    ('esperando_repuestos',   'aprobada'),
    ('esperando_repuestos',   'anulada'),

    ('reparacion',            'trabajo_terminado'),
    ('reparacion',            'esperando_repuestos'),
    ('reparacion',            'aprobada'),
    ('reparacion',            'anulada'),

    ('trabajo_terminado',     'lista'),
    ('trabajo_terminado',     'reparacion'),
    ('trabajo_terminado',     'anulada'),

    ('lista',                 'entregada'),
    ('lista',                 'trabajo_terminado'),
    ('lista',                 'reparacion'),
    ('lista',                 'anulada')
on conflict (desde, hasta) do nothing;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Ampliar el CHECK de taller_ordenes.estado
-- ════════════════════════════════════════════════════════════════
-- Aditivo: los 8 valores actuales siguen válidos, se suman 4.
-- No hay datos que migrar (todo lo existente ya calza).

alter table taller_ordenes drop constraint if exists taller_ordenes_estado_check;

alter table taller_ordenes add constraint taller_ordenes_estado_check
    check (estado in (
        'recepcion', 'diagnostico', 'diagnostico_terminado', 'presupuesto',
        'aprobada', 'rechazado', 'esperando_repuestos', 'reparacion',
        'trabajo_terminado', 'lista', 'entregada', 'anulada'));

alter table taller_ordenes alter column estado set default 'recepcion';


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Validar la transición en la base
-- ════════════════════════════════════════════════════════════════
-- Hoy esto solo lo revisa js/modulo-ordenes.js (_transicionValida).
-- Con este trigger, un update directo por la API tampoco puede saltar
-- el flujo. Fail-open: si el grafo está vacío (config a medias), no
-- bloquea — el taller nunca debe quedar sin poder mover una OT.

create or replace function fn_trg_ot_valida_transicion()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.estado is distinct from old.estado then
        if exists (select 1 from taller_ot_transiciones)
           and not exists (
               select 1 from taller_ot_transiciones
                where desde = old.estado and hasta = new.estado) then
            raise exception
                'Transición de OT no permitida: % → %', old.estado, new.estado
                using errcode = 'check_violation';
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_ot_valida_transicion on taller_ordenes;
create trigger trg_ot_valida_transicion
    before update of estado on taller_ordenes
    for each row execute function fn_trg_ot_valida_transicion();


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Vista de línea de tiempo de la OT
-- ════════════════════════════════════════════════════════════════
-- El historial (sql/18) + la etiqueta legible + la posición, listo
-- para pintar el timeline tanto en ARM Taller como en Mi Vehículo.

create or replace view v_taller_ot_timeline as
select
    h.id,
    h.empresa_id,
    h.orden_id,
    o.numero          as orden_numero,
    h.estado_anterior,
    h.estado_nuevo,
    e.etiqueta        as estado_etiqueta,
    e.posicion        as estado_posicion,
    e.categoria       as estado_categoria,
    h.nota,
    h.usuario_rut,
    h.origen,
    h.ts
from taller_ot_estado_historial h
join taller_ordenes o    on o.id = h.orden_id
left join taller_ot_estados e on e.codigo = h.estado_nuevo;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Permisos
-- ════════════════════════════════════════════════════════════════

grant select, insert, update, delete on public.taller_ot_estados       to anon, authenticated;
grant select, insert, update, delete on public.taller_ot_transiciones  to anon, authenticated;
grant select on public.v_taller_ot_timeline to anon, authenticated;

-- Supabase activa RLS automáticamente en las tablas nuevas de public.
-- Hasta el corte a RLS real (sql/13 + sql/14 Etapa 2) el núcleo del
-- taller corre con RLS desactivada; estas tablas van al mismo nivel
-- para no quedar en deny-all. sql/13 las vuelve a activar con su
-- política permisiva cuando se aplique.
alter table public.taller_ot_estados            disable row level security;
alter table public.taller_ot_transiciones       disable row level security;

-- Idem para las tablas del script 18 (mismo motivo)
alter table public.taller_vehiculo_vinculo      disable row level security;
alter table public.taller_ot_estado_historial   disable row level security;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select codigo, etiqueta, posicion from taller_ot_estados order by posicion;
--
-- select desde, array_agg(hasta order by hasta) as puede_ir_a
--   from taller_ot_transiciones group by desde order by desde;
--
-- -- Transición válida (debe pasar):
-- update taller_ordenes set estado = 'diagnostico'
--  where numero = 2 and estado = 'recepcion'
--    and empresa_id = (select empresa_id from taller_ordenes where numero = 2 limit 1);
--
-- -- Transición inválida (debe fallar con "Transición de OT no permitida"):
-- update taller_ordenes set estado = 'entregada'
--  where numero = 2 and estado = 'diagnostico';
--
-- -- Volver atrás para dejar la prueba como estaba:
-- update taller_ordenes set estado = 'recepcion' where numero = 2;
--
-- select * from v_taller_ot_timeline where orden_numero = 2 order by ts;
