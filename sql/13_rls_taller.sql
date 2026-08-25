-- ================================================================
-- 13_rls_taller.sql — ARM TALLER
-- Políticas RLS para las tablas nuevas del taller.
--
-- ⚠ CORRER DESPUÉS del 12_permisos.sql. Sin esto, las tablas que
--   creamos en los scripts 02 a 11 NO devuelven nada, aunque tengan
--   el grant: Supabase les activó RLS automáticamente y una tabla
--   con RLS y cero políticas deniega todo.
--
-- ── Lee esto antes de ejecutar ──────────────────────────────────
-- La política que crea este script es PERMISIVA: deja que el rol
-- 'anon' lea y escriba. NO aísla un taller de otro.
--
-- No es un descuido: es lo único que puede hacer hoy la base, porque
-- la app usa la clave publishable sin JWT y Postgres no sabe quién
-- pregunta. El filtro por empresa_id lo sigue poniendo el navegador.
--
-- Es exactamente el mismo patrón que ya usa ARM Universal en sus 76
-- tablas (articulos_permisiva, ordenes_permisiva, usuarios_permisiva…
-- todas ALL / anon / using(true)). Este archivo NO empeora nada: pone
-- las tablas del taller al mismo nivel que el resto del sistema.
--
-- Lo que SÍ aporta: deja las 28 tablas de Taller uniformes. Hoy hay 8
-- sin RLS y 20 con RLS sin políticas. Después de esto, las 28 quedan
-- iguales, y la migración a Supabase Auth pasa a ser UN bucle que
-- cambia el cuerpo de la política, en vez de perseguir tabla por tabla.
--
-- ── El patrón correcto ya existe en esta misma base ─────────────
-- Los productos emprendedores_* y mascotas_* SÍ están bien hechos:
--   emprendedores_customers → using (emprendedores_fn_puede_leer(business_id))
--   mascotas_vacunas        → using (fn_puede_acceder_mascota(mascota_id))
--   pacientes               → using (id = auth.uid() OR medico_id = auth.uid())
-- Usan Supabase Auth con auth.uid() y funciones helper. Migrar Taller
-- es copiar ese patrón, no inventarlo.
--
-- El cierre de verdad está al final del archivo.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Política permisiva para cada tabla taller_*
-- ════════════════════════════════════════════════════════════════
-- Dinámico a propósito: cubre las tablas de hoy y las que agreguemos.
-- Se puede correr las veces que quieras.

do $$
declare
    r          record;
    v_creadas  integer := 0;
    v_saltadas integer := 0;
begin
    for r in
        select c.relname as tabla, c.oid
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind = 'r'
           and c.relname like 'taller\_%'
    loop
        -- Asegurar que RLS esté activo (si ya lo está, no pasa nada)
        execute format('alter table public.%I enable row level security', r.tabla);

        -- ¿Ya tiene una política nuestra?
        if exists (select 1 from pg_policies
                    where schemaname = 'public'
                      and tablename = r.tabla
                      and policyname = 'taller_app_acceso') then
            v_saltadas := v_saltadas + 1;
            continue;
        end if;

        execute format($p$
            create policy taller_app_acceso on public.%I
                for all
                to anon, authenticated
                using (true)
                with check (true)
        $p$, r.tabla);

        v_creadas := v_creadas + 1;
    end loop;

    raise notice 'Políticas creadas: % · ya existían: %', v_creadas, v_saltadas;
end $$;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Verificación
-- ════════════════════════════════════════════════════════════════
-- Después de correr esto, ninguna tabla taller_* debe decir
-- "🚫 BLOQUEADA". Si alguna lo dice, avísame.

select
    c.relname                                          as tabla,
    coalesce(p.n, 0)                                   as politicas,
    case when has_table_privilege('anon', c.oid, 'SELECT')
         then 'sí' else 'NO' end                       as grant_lee,
    case
        when not has_table_privilege('anon', c.oid, 'SELECT')
            then '❌ falta el grant — corre 12_permisos.sql'
        when c.relrowsecurity and coalesce(p.n, 0) = 0
            then '🚫 BLOQUEADA — sin políticas'
        else '✅ la app puede usarla'
    end                                                as estado
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join lateral (
    select count(*) as n from pg_policies
     where schemaname = 'public' and tablename = c.relname
) p on true
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname like 'taller\_%'
order by estado desc, c.relname;


-- ════════════════════════════════════════════════════════════════
-- EL CIERRE DE VERDAD — cuando migres a Supabase Auth
-- ════════════════════════════════════════════════════════════════
-- Hoy 'anon' es un rol anónimo: todos los usuarios de todos los
-- talleres son el mismo. Por eso la política no puede filtrar.
--
-- Cuando el login pase por Supabase Auth con empresa_id en los claims
-- del JWT (app_metadata), estas dos líneas reemplazan a la permisiva
-- y el aislamiento pasa a ser real:
--
--   drop policy taller_app_acceso on taller_ordenes;
--   create policy taller_propio on taller_ordenes
--     for all to authenticated
--     using (empresa_id = (auth.jwt() -> 'app_metadata' ->> 'empresa_id')::uuid)
--     with check (empresa_id = (auth.jwt() -> 'app_metadata' ->> 'empresa_id')::uuid);
--
-- Y se le quita el acceso a 'anon':
--
--   revoke all on all tables in schema public from anon;
--
-- El mismo bucle del PASO 1 sirve para aplicarlo a todas las tablas
-- de una vez, cambiando el cuerpo de la política.
--
-- ⚠ Las tablas taller_clientes, taller_ordenes, taller_ordenes_items,
--   taller_vehiculos, taller_repuestos, taller_ventas, taller_ventas_items
--   y taller_correlativos hoy NO tienen RLS activo (vienen del script
--   original). El PASO 1 se los activa junto con la política permisiva,
--   así quedan todas parejas y listas para el cambio de arriba.
