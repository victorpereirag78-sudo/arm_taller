-- ================================================================
-- 00c_auditoria_acceso.sql — ARM (Taller y Universal)
-- ¿Qué puede hacer cualquiera que tenga la clave publishable?
--
-- No modifica nada: solo mira.
--
-- ── Cómo leer el resultado ──────────────────────────────────────
-- La clave publishable (sb_publishable_...) está en config.js, que se
-- descarga al navegador: cualquiera que abra el código fuente la tiene.
-- Esa clave actúa como el rol 'anon'.
--
-- Para cada tabla, la pregunta es:
--   · ¿anon puede leerla?           → has_table_privilege SELECT
--   · ¿hay RLS que lo limite?       → relrowsecurity
--
-- Si LEE = sí y RLS = no, esa tabla está completamente expuesta:
-- se puede consultar entera desde fuera de la aplicación, sin importar
-- qué filtros ponga el front.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- 1. Foto general: cuántas tablas están expuestas
-- ════════════════════════════════════════════════════════════════

select
    case
        when c.relname like 'taller\_%'                    then 'ARM Taller'
        when c.relname in ('empresas', 'usuarios')         then 'COMPARTIDA'
        else 'otras (¿ARM Universal?)'
    end                                                     as producto,
    count(*)                                                as tablas,
    count(*) filter (
        where has_table_privilege('anon', c.oid, 'SELECT')
          and not c.relrowsecurity)                         as expuestas,
    count(*) filter (where c.relrowsecurity)                as con_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
group by 1
order by expuestas desc;


-- ════════════════════════════════════════════════════════════════
-- 2. Detalle tabla por tabla
-- ════════════════════════════════════════════════════════════════

select
    c.relname                                               as tabla,
    case when has_table_privilege('anon', c.oid, 'SELECT')
         then 'sí' else 'no' end                            as lee_anon,
    case when has_table_privilege('anon', c.oid, 'INSERT')
          or has_table_privilege('anon', c.oid, 'UPDATE')
          or has_table_privilege('anon', c.oid, 'DELETE')
         then 'sí' else 'no' end                            as escribe_anon,
    case when c.relrowsecurity then 'sí' else 'NO' end      as rls,
    (select count(*) from pg_policies p
      where p.schemaname = 'public' and p.tablename = c.relname) as politicas,
    case
        when not has_table_privilege('anon', c.oid, 'SELECT') then '🔒 cerrada'
        when c.relrowsecurity                                then '🛡 con RLS'
        else '⚠️ EXPUESTA — se lee entera desde fuera de la app'
    end                                                     as veredicto
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by
    case when has_table_privilege('anon', c.oid, 'SELECT')
              and not c.relrowsecurity then 0 else 1 end,
    c.relname;


-- ════════════════════════════════════════════════════════════════
-- 3. Lo más sensible: la tabla de usuarios
-- ════════════════════════════════════════════════════════════════
-- Si 'usuarios' es legible por anon, cualquiera puede listar los RUT
-- y roles de TODOS los talleres y empresas. Y si la columna 'pass'
-- todavía tiene texto plano, también las contraseñas.

select
    case when has_table_privilege('anon', 'public.usuarios', 'SELECT')
         then '⚠️ anon PUEDE leer la tabla usuarios'
         else '🔒 anon no puede leer la tabla usuarios' end  as acceso,
    (select count(*) from usuarios)                          as usuarios_totales,
    (select count(*) from usuarios where pass is not null
                                     and pass <> '')         as con_pass_en_texto_plano,
    (select count(*) from usuarios where pass_hash is not null) as con_hash;


-- ════════════════════════════════════════════════════════════════
-- QUÉ HACER CON ESTO
-- ════════════════════════════════════════════════════════════════
-- Si la consulta 2 muestra tablas ⚠️ EXPUESTAS (lo más probable),
-- el filtro por empresa_id que hace el navegador NO está protegiendo
-- nada frente a alguien que use la API directamente.
--
-- El arreglo NO es quitar los permisos: la app dejaría de funcionar.
-- El arreglo es que Postgres sepa QUIÉN pregunta, y eso requiere:
--
--   1. Migrar el login a Supabase Auth, con empresa_id en los claims
--      del JWT (app_metadata).
--   2. Activar RLS en cada tabla y crear la política:
--
--      alter table taller_ordenes enable row level security;
--      create policy taller_propio on taller_ordenes
--        for all to authenticated
--        using (empresa_id = (auth.jwt() -> 'app_metadata' ->> 'empresa_id')::uuid);
--
--   3. Quitar el acceso del rol anon a las tablas (queda solo
--      'authenticated', ya filtrado por la política).
--
-- Es una migración transversal: afecta a ARM Taller y a ARM Universal
-- por igual, porque comparten instancia, tablas y clave.
--
-- Mientras tanto, mitigaciones que NO son la solución pero ayudan:
--   · Rotar la clave publishable si se sospecha filtración.
--   · Cerrar 'usuarios' a anon (ver PASO 3 de 01_seguridad_login.sql),
--     coordinándolo antes con ARM Universal.
--   · Borrar el texto plano de 'usuarios.pass' una vez hasheado todo.
