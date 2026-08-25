-- ================================================================
-- 12_permisos.sql — ARM TALLER
-- Permisos de lectura y escritura sobre tablas y vistas.
--
-- ── Por qué hace falta ──────────────────────────────────────────
-- Los scripts 01 a 11 otorgan permisos EXPLÍCITOS a las funciones
-- (grant execute), pero no a las tablas ni a las vistas: asumieron
-- que los privilegios por defecto de Supabase los cubrían. En un
-- proyecto donde esos defaults no están, el resultado es:
--
--     42501 · permission denied for view v_taller_citas
--
-- Las RPC funcionan (tienen su grant), las vistas no. Este script
-- lo corrige de una vez para todo.
--
-- ── Es dinámico a propósito ─────────────────────────────────────
-- Recorre todo lo que se llame taller_* o v_taller_*, así que:
--   · se puede correr las veces que quieras
--   · sirve también para los scripts que agreguemos después
-- Vuelve a ejecutarlo cada vez que apliques un script nuevo.
--
-- Ejecutar en: Supabase → SQL Editor (AL FINAL, después de los demás)
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Acceso al esquema
-- ════════════════════════════════════════════════════════════════

grant usage on schema public to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Tablas y vistas del taller
-- ════════════════════════════════════════════════════════════════
-- Tablas: lectura y escritura. Vistas: solo lectura (son de consulta).

do $$
declare
    r        record;
    v_tablas integer := 0;
    v_vistas integer := 0;
begin
    for r in
        select c.relname as nombre, c.relkind as tipo
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind in ('r', 'v', 'm')
           and (c.relname like 'taller\_%' or c.relname like 'v\_taller\_%')
    loop
        if r.tipo = 'r' then
            execute format(
                'grant select, insert, update, delete on public.%I to anon, authenticated',
                r.nombre);
            v_tablas := v_tablas + 1;
        else
            execute format('grant select on public.%I to anon, authenticated', r.nombre);
            v_vistas := v_vistas + 1;
        end if;
    end loop;

    raise notice 'Permisos aplicados: % tablas, % vistas', v_tablas, v_vistas;
end $$;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Tablas compartidas con ARM Universal
-- ════════════════════════════════════════════════════════════════
-- 'empresas' la lee el panel Mi taller y la escribe el panel Módulos.
-- Otorgar permisos es ADITIVO: no le quita nada a ARM Universal.
-- 'usuarios' solo se lee a través de la vista v_taller_usuarios y de
-- las RPC (que son security definer), así que aquí no se toca.

grant select, update on public.empresas to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Que los objetos futuros nazcan con permisos
-- ════════════════════════════════════════════════════════════════
-- Sin esto, cada script nuevo obliga a volver a correr este archivo.
-- Solo aplica a lo que cree el rol postgres de aquí en adelante.

alter default privileges in schema public
    grant select, insert, update, delete on tables to anon, authenticated;

alter default privileges in schema public
    grant execute on functions to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — corre esto y revisa que no quede ningún ❌
-- ════════════════════════════════════════════════════════════════

select
    c.relname                                        as objeto,
    case c.relkind when 'r' then 'tabla' when 'v' then 'vista' end as tipo,
    case when has_table_privilege('anon', c.oid, 'SELECT')
         then '✅' else '❌ sin acceso' end          as lee_anon,
    case when c.relkind <> 'r' then '—'
         when has_table_privilege('anon', c.oid, 'INSERT')
         then '✅' else '❌ no puede escribir' end   as escribe_anon
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'v')
  and (c.relname like 'taller\_%' or c.relname like 'v\_taller\_%'
       or c.relname in ('empresas', 'usuarios'))
order by lee_anon desc, c.relkind, c.relname;


-- ════════════════════════════════════════════════════════════════
-- NOTA DE SEGURIDAD — leer antes de dormir tranquilo
-- ════════════════════════════════════════════════════════════════
-- Esto le da al rol 'anon' acceso de lectura y escritura a las tablas
-- del taller. Es lo que la app necesita hoy para funcionar, porque
-- usa la clave publishable sin JWT y el filtro por empresa_id lo pone
-- el front.
--
-- Dicho derecho: NO hay aislamiento real entre talleres. Cualquiera
-- con la clave publishable y la consola abierta puede leer y escribir
-- datos de otros talleres. Este script no empeora eso —así funcionaba
-- ya el núcleo— pero tampoco lo arregla.
--
-- El cierre de verdad es migrar a Supabase Auth con empresa_id en los
-- claims del JWT y políticas RLS del estilo:
--
--   alter table taller_ordenes enable row level security;
--   create policy taller_propio on taller_ordenes
--     for all to authenticated
--     using (empresa_id = (auth.jwt() -> 'app_metadata' ->> 'empresa_id')::uuid);
--
-- Ver la nota al final de 01_seguridad_login.sql.
