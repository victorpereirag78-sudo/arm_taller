-- ================================================================
-- 09b_agenda_constraint_opcional.sql — ARM TALLER
--
-- OPCIONAL. El sistema funciona sin esto.
--
-- fn_agendar_cita (script 09) ya impide que dos citas se pisen en la
-- misma bahía o con el mismo mecánico. Este archivo agrega la misma
-- regla a nivel de CONSTRAINT, para que la base la haga cumplir
-- aunque alguien inserte citas por fuera del RPC (un script, una
-- carga masiva, el editor SQL de Supabase).
--
-- Este archivo se ejecuta tal cual: no hay nada que descomentar.
--
-- ⚠ Si ya tienes citas cargadas que se solapan, el ALTER va a fallar
--   nombrando el conflicto. Arregla esas citas primero y vuelve a correr.
--
-- Ejecutar en: Supabase → SQL Editor (después del 09)
-- ================================================================

-- Necesaria para combinar '=' (uuid) con '&&' (rango) en un mismo índice GiST
create extension if not exists btree_gist;


-- ── Una bahía, un auto a la vez ─────────────────────────────────
-- make_interval() en vez de (texto)::interval: es IMMUTABLE sin
-- ninguna duda, que es lo que exige un índice de exclusión.
alter table taller_citas
    drop constraint if exists excl_citas_bahia;

alter table taller_citas
    add constraint excl_citas_bahia
    exclude using gist (
        bahia_id with =,
        tsrange(
            fecha + hora_inicio,
            fecha + hora_inicio + make_interval(mins => duracion_min)
        ) with &&
    )
    where (bahia_id is not null
           and estado not in ('cancelada', 'no_asistio'));


-- ── Un mecánico no se parte en dos ──────────────────────────────
alter table taller_citas
    drop constraint if exists excl_citas_mecanico;

alter table taller_citas
    add constraint excl_citas_mecanico
    exclude using gist (
        mecanico_id with =,
        tsrange(
            fecha + hora_inicio,
            fecha + hora_inicio + make_interval(mins => duracion_min)
        ) with &&
    )
    where (mecanico_id is not null
           and estado not in ('cancelada', 'no_asistio'));


-- ════════════════════════════════════════════════════════════════
-- SI NECESITAS DESHACERLO
-- ════════════════════════════════════════════════════════════════
-- alter table taller_citas drop constraint if exists excl_citas_bahia;
-- alter table taller_citas drop constraint if exists excl_citas_mecanico;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select conname from pg_constraint
--  where conrelid = 'taller_citas'::regclass and contype = 'x';
--
-- Buscar solapamientos existentes antes de aplicar:
--   select a.numero, b.numero, a.fecha, a.hora_inicio, b.hora_inicio
--     from taller_citas a
--     join taller_citas b
--       on a.id < b.id and a.bahia_id = b.bahia_id and a.fecha = b.fecha
--      and a.estado not in ('cancelada','no_asistio')
--      and b.estado not in ('cancelada','no_asistio')
--      and (a.hora_inicio, a.hora_inicio + make_interval(mins => a.duracion_min))
--          overlaps
--          (b.hora_inicio, b.hora_inicio + make_interval(mins => b.duracion_min));
