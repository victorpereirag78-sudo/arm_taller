-- ================================================================
-- 17_fix_usuarios_taller.sql — ARM TALLER
-- Tres arreglos para que la creación de usuarios del taller funcione.
-- La tabla `usuarios` se comparte con ARM Universal; los tres cambios
-- son ADITIVOS y no afectan a Universal.
--
-- Idempotente: se puede correr más de una vez.
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- 1 — crypt()/gen_salt() no se encontraban
-- ════════════════════════════════════════════════════════════════
-- pgcrypto está en el schema `extensions`; varias funciones fijaban
-- `search_path = public` y por eso fallaban con
--   "function crypt(text, text) does not exist".
--
-- En los fuentes (01, 10, 11, 14) las llamadas ya quedaron como
-- `extensions.crypt(...)` / `extensions.gen_salt(...)`. Este bloque
-- repara lo que ya está creado en la base, por si quedó una versión
-- vieja de alguna función.

do $$
declare
    r record;
    n int := 0;
begin
    for r in
        select p.oid::regprocedure as fn
          from pg_proc p
          join pg_namespace nsp on nsp.oid = p.pronamespace
         where nsp.nspname = 'public'
           and p.prosrc ~* '(crypt|gen_salt)\s*\('
           and not exists (
               select 1
                 from unnest(coalesce(p.proconfig, '{}'::text[])) c
                where lower(c) like 'search_path=%'
                  and lower(c) like '%extensions%'
           )
    loop
        execute format('alter function %s set search_path = public, extensions', r.fn);
        raise notice 'search_path arreglado: %', r.fn;
        n := n + 1;
    end loop;
    raise notice '% función(es) actualizada(s)', n;
end $$;


-- ════════════════════════════════════════════════════════════════
-- 2 — usuarios.pass ya no es obligatorio
-- ════════════════════════════════════════════════════════════════
-- Es la columna de texto plano en camino a eliminarse (ver
-- 01_seguridad_login.sql, PASO 3). fn_usuario_crear / fn_crear_taller
-- solo insertan pass_hash, así que con pass NOT NULL reventaban.
-- Universal puede seguir insertando pass sin problema.

alter table usuarios alter column pass drop not null;


-- ════════════════════════════════════════════════════════════════
-- 3 — El CHECK de rol acepta los roles del taller
-- ════════════════════════════════════════════════════════════════
-- usuarios_rol_check solo permitía los roles de ARM Universal, así
-- que crear un vendedor / cajero / jefe_taller fallaba con
--   "violates check constraint usuarios_rol_check".
-- Se agregan los roles del taller (ver js/config.js → ROL_MODULOS).

alter table usuarios drop constraint if exists usuarios_rol_check;

alter table usuarios add constraint usuarios_rol_check check (rol = any (array[
    -- ARM Universal
    'admin', 'rrhh', 'despacho-dth', 'despacho-fibra', 'logistica', 'ingreso',
    'tecnico-n1', 'venta-instalacion', 'flota', 'panol', 'lector', 'gestion', 'supervisor',
    -- ARM Taller
    'jefe_taller', 'recepcion', 'mecanico', 'vendedor', 'bodeguero', 'cajero', 'contador'
]));


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- Ninguna función con crypt() sin extensions en el search_path:
--   select p.oid::regprocedure, array_to_string(p.proconfig,' | ')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and p.prosrc ~* '(crypt|gen_salt)\s*\('
--      and not exists (select 1 from unnest(coalesce(p.proconfig,'{}'::text[])) c
--                       where lower(c) like 'search_path=%' and lower(c) like '%extensions%');
--
-- Crear un usuario de prueba y borrarlo:
--   select fn_usuario_crear('<rut admin>', '<pass admin>', '<empresa_id>',
--                           '11111111-2', 'prueba123', 'vendedor', null);
--   delete from usuarios where rut = '11111111-2';
