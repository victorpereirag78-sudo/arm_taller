-- ================================================================
-- 26_rls_etapa2.sql — ARM TALLER
-- EL CORTE: aislamiento real entre talleres por token de sesión.
--
-- ⚠ REQUIERE, EN ORDEN: sql/12, sql/13, sql/14 aplicados.
-- ⚠ CÓRRELO CON LA APP ABIERTA y prueba módulo por módulo después.
--    Si algo se rompe, el bloque ROLLBACK del final vuelve todo a la
--    política permisiva en un segundo.
--
-- ── Qué cambia ────────────────────────────────────────────────
-- Antes:  policy taller_app_acceso  →  using (true)      (anon ve todo)
-- Ahora:  policy taller_propio      →  using (empresa_id = taller_empresa_actual())
--
-- El cliente sigue siendo el rol 'anon' (clave publishable, sin JWT).
-- Lo que aísla es la política: sin un token válido en la cabecera
-- x-taller-token, taller_empresa_actual() devuelve NULL y no se ve
-- ninguna fila. Con token, solo el taller de esa sesión.
--
-- NO se hace 'revoke ... from anon': eso rompería ARM Universal, que
-- comparte la base y también usa 'anon'. El grant se queda; filtra la
-- política.
--
-- ── Tablas de configuración global ───────────────────────────
-- taller_ot_estados y taller_ot_transiciones NO tienen empresa_id
-- (son catálogo común). Se quedan con lectura abierta.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 0 — Chequeo previo (aborta si falta algo)
-- ════════════════════════════════════════════════════════════════
do $$
begin
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'taller_empresa_actual') then
        raise exception 'Falta sql/14 (taller_empresa_actual no existe). Aplica 12, 13 y 14 primero.';
    end if;
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and policyname = 'taller_app_acceso') then
        raise exception 'Falta sql/13 (no hay políticas taller_app_acceso). Aplícalo primero.';
    end if;
end $$;


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Reemplazar la política, tabla por tabla
-- ════════════════════════════════════════════════════════════════

do $$
declare
    r            record;
    tiene_emp    boolean;
    v_tok        integer := 0;
    v_glob       integer := 0;
begin
    for r in
        select c.oid, c.relname as tabla
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname like 'taller\_%'
           and c.relname <> 'taller_sesiones'   -- esa queda cerrada
    loop
        execute format('alter table public.%I enable row level security', r.tabla);

        select exists (
            select 1 from pg_attribute
             where attrelid = r.oid and attname = 'empresa_id' and not attisdropped
        ) into tiene_emp;

        execute format('drop policy if exists taller_app_acceso on public.%I', r.tabla);
        execute format('drop policy if exists taller_propio     on public.%I', r.tabla);

        if tiene_emp then
            execute format($p$
                create policy taller_propio on public.%I
                    for all to anon, authenticated
                    using      (empresa_id = taller_empresa_actual())
                    with check  (empresa_id = taller_empresa_actual())
            $p$, r.tabla);
            v_tok := v_tok + 1;
        else
            -- catálogo global (taller_ot_estados, taller_ot_transiciones):
            -- lectura para todos, escritura solo con token
            execute format($p$
                create policy taller_propio on public.%I
                    for select to anon, authenticated using (true)
            $p$, r.tabla);
            execute format($p$
                create policy taller_propio_w on public.%I
                    for all to anon, authenticated
                    using (taller_empresa_actual() is not null)
                    with check (taller_empresa_actual() is not null)
            $p$, r.tabla);
            v_glob := v_glob + 1;
        end if;
    end loop;

    raise notice 'Política por token: % tablas · catálogo global: %', v_tok, v_glob;
end $$;


-- ════════════════════════════════════════════════════════════════
-- PASO 1b — Las vistas v_taller_* respetan la RLS de sus tablas
-- ════════════════════════════════════════════════════════════════
-- Por defecto una vista corre con los permisos de su dueño (postgres)
-- y se salta la RLS de las tablas de abajo: v_taller_presupuestos
-- devolvería TODOS los talleres. security_invoker = true hace que la
-- vista use el rol y la RLS de quien consulta.

do $$
declare r record; v_n integer := 0;
begin
    for r in
        select c.relname as vista
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'v'
           and c.relname like 'v\_taller\_%'
    loop
        execute format('alter view public.%I set (security_invoker = true)', r.vista);
        v_n := v_n + 1;
    end loop;
    raise notice 'Vistas con security_invoker: %', v_n;
end $$;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Verificación
-- ════════════════════════════════════════════════════════════════
-- Cada tabla taller_* con empresa_id debe tener la política 'taller_propio';
-- taller_ot_estados / taller_ot_transiciones, 'taller_propio' (select) +
-- 'taller_propio_w'. Ninguna debe quedar con 'taller_app_acceso'.

select
    c.relname as tabla,
    string_agg(p.policyname, ', ' order by p.policyname) as politicas
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'taller\_%'
group by c.relname
order by c.relname;

-- La prueba de verdad es en la app: con la consola abierta,
--   await db.rpc('fn_diag_sesion').then(r => console.log(r.data))
-- debe decir  veredicto: 'Todo bien…'  y el empresa_id correcto.

-- En la app, con la consola abierta:
--   await db.rpc('fn_diag_sesion').then(r => console.log(r.data))
-- Debe decir  veredicto: 'Todo bien…'  y el empresa_id correcto.
-- Luego recorrer: Dashboard, Órdenes, Clientes, Vehículos, Inventario,
-- Ventas, Caja, Presupuestos, Agenda, Compras, CxC, CxP, Reportes,
-- Mantenciones, Comisiones, Empleados, Proveedores, Módulos, Mi taller.


-- ════════════════════════════════════════════════════════════════
-- ROLLBACK — si algo se rompió, corre SOLO este bloque
-- ════════════════════════════════════════════════════════════════
-- do $$
-- declare r record;
-- begin
--     for r in select c.relname as tabla from pg_class c
--       join pg_namespace n on n.oid = c.relnamespace
--      where n.nspname = 'public' and c.relkind = 'r'
--        and c.relname like 'taller\_%' and c.relname <> 'taller_sesiones'
--     loop
--         execute format('drop policy if exists taller_propio   on public.%I', r.tabla);
--         execute format('drop policy if exists taller_propio_w on public.%I', r.tabla);
--         execute format($p$create policy taller_app_acceso on public.%I
--             for all to anon, authenticated using (true) with check (true)$p$, r.tabla);
--     end loop;
--     for r in select c.relname as vista from pg_class c
--       join pg_namespace n on n.oid = c.relnamespace
--      where n.nspname='public' and c.relkind='v' and c.relname like 'v\_taller\_%'
--     loop execute format('alter view public.%I reset (security_invoker)', r.vista); end loop;
-- end $$;
