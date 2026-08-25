-- ================================================================
-- 00d_politicas_rls.sql — ARM (Taller y Universal)
-- ¿Qué dicen realmente las políticas RLS?
--
-- No modifica nada: solo mira.
--
-- ── Por qué hace falta ──────────────────────────────────────────
-- "Tiene RLS activo" no significa "está protegido". Hay tres casos
-- muy distintos que se ven iguales por fuera:
--
--   1. RLS + política que filtra   → protegido de verdad
--   2. RLS + política 'using(true)'→ RLS decorativo, no filtra nada
--   3. RLS + CERO políticas        → deniega TODO (la tabla queda muerta
--                                    para anon: devuelve vacío y los
--                                    insert fallan)
--
-- El caso 3 es el que tienen ahora todas las tablas taller_* nuevas:
-- Supabase activa RLS solo en las tablas nuevas del esquema público,
-- y los scripts 02 a 11 nunca crearon políticas.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- 1. El veredicto corregido, tabla por tabla
-- ════════════════════════════════════════════════════════════════

select
    c.relname                                               as tabla,
    case when c.relrowsecurity then 'sí' else 'NO' end      as rls,
    coalesce(p.n, 0)                                        as politicas,
    case when has_table_privilege('anon', c.oid, 'SELECT')
         then 'sí' else 'no' end                            as grant_lee,
    case
        when not c.relrowsecurity
             and has_table_privilege('anon', c.oid, 'SELECT')
            then '⚠️ ABIERTA — sin RLS, se lee entera'
        when not c.relrowsecurity
            then '🔒 sin grant'
        when coalesce(p.n, 0) = 0
            then '🚫 BLOQUEADA — RLS sin políticas: no devuelve nada'
        when p.permisiva_total
            then '⚠️ RLS DECORATIVO — la política no filtra (using true)'
        else '🛡 protegida — la política filtra'
    end                                                     as veredicto_real
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join lateral (
    select count(*) as n,
           bool_or(coalesce(pol.qual, 'true') in ('true', '(true)')) as permisiva_total
      from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = c.relname
) p on true
where n.nspname = 'public' and c.relkind = 'r'
order by
    case
        when not c.relrowsecurity and has_table_privilege('anon', c.oid, 'SELECT') then 1
        when c.relrowsecurity and coalesce(p.n,0) = 0 then 2
        when p.permisiva_total then 3
        else 4
    end,
    c.relname;


-- ════════════════════════════════════════════════════════════════
-- 2. El texto exacto de cada política
-- ════════════════════════════════════════════════════════════════
-- Esto es lo que decide todo: si el 'using' dice 'true', el RLS no
-- está filtrando nada. Si menciona empresa_id o auth.jwt(), sí.

select
    tablename                     as tabla,
    policyname                    as politica,
    cmd                           as operacion,
    array_to_string(roles, ', ')  as roles,
    qual                          as condicion_lectura,
    with_check                    as condicion_escritura
from pg_policies
where schemaname = 'public'
order by
    case when coalesce(qual, 'true') in ('true', '(true)') then 0 else 1 end,
    tablename, policyname;


-- ════════════════════════════════════════════════════════════════
-- 3. Resumen: ¿cuántas políticas filtran de verdad?
-- ════════════════════════════════════════════════════════════════

select
    case
        when coalesce(qual, 'true') in ('true', '(true)')
            then 'no filtra (using true)'
        when qual ilike '%auth.jwt%' or qual ilike '%auth.uid%'
            then 'filtra por JWT'
        when qual ilike '%empresa_id%'
            then 'filtra por empresa_id'
        else 'otra condición'
    end                          as tipo,
    count(*)                     as politicas,
    count(distinct tablename)    as tablas,
    string_agg(distinct tablename, ', ' order by tablename) as cuales
from pg_policies
where schemaname = 'public'
group by 1
order by 2 desc;


-- ════════════════════════════════════════════════════════════════
-- QUÉ HACER SEGÚN EL RESULTADO
-- ════════════════════════════════════════════════════════════════
--
-- Si la consulta 3 dice que casi todas "no filtran (using true)":
--   → Universal tiene RLS decorativo. Está igual de expuesto que
--     Taller, solo que no se nota en el diagnóstico anterior.
--     La migración a Supabase Auth es necesaria en los dos productos.
--
-- Si dice que filtran por JWT o por empresa_id:
--   → Universal ya resolvió esto y hay un patrón que copiar en Taller.
--     Mándame el texto de una de esas políticas y armo las de taller_*
--     con la misma lógica.
--
-- En cualquiera de los dos casos, las tablas 🚫 BLOQUEADAS hay que
-- arreglarlas ya: hoy no devuelven nada. Ver sql/13_rls_taller.sql.
