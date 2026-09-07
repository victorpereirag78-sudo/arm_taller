-- ================================================================
-- 30_gastos.sql — ARM TALLER
-- FASE 2 punto 19: gestión de gastos + los engancha a Reportes (20).
--
-- ⚠ REQUIERE sql/06 (reportes). Recrea fn_reporte_resumen — si vuelves
--   a correr sql/06 después, vuelve a correr este.
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================

-- ════════════════════════════════════════════════════════════════
-- PASO 1 — El libro de gastos
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_gastos (
    id           uuid primary key default gen_random_uuid(),
    empresa_id   uuid not null,
    fecha        date not null default current_date,
    categoria    text not null check (categoria in (
                    'arriendo', 'electricidad', 'agua', 'internet', 'herramientas',
                    'insumos', 'combustible', 'sueldos', 'mantencion_local',
                    'marketing', 'impuestos', 'otros')),
    descripcion  text,
    monto        numeric(12,2) not null check (monto >= 0),
    proveedor    text,
    medio_pago   text check (medio_pago in
                    ('efectivo', 'transferencia', 'debito', 'credito', 'cheque', 'otro')),
    documento    text,
    usuario_rut  text,
    created_at   timestamptz not null default now()
);

create index if not exists idx_gastos_empresa
    on taller_gastos (empresa_id, fecha desc);

grant select, insert, update, delete on public.taller_gastos to anon, authenticated;

-- RLS por token si sql/14 ya está aplicado; si no, abierta como el resto
do $$
begin
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'taller_empresa_actual') then
        execute 'alter table public.taller_gastos enable row level security';
        execute 'drop policy if exists taller_propio on public.taller_gastos';
        execute $p$create policy taller_propio on public.taller_gastos
            for all to anon, authenticated
            using (empresa_id = taller_empresa_actual())
            with check (empresa_id = taller_empresa_actual())$p$;
    else
        execute 'alter table public.taller_gastos disable row level security';
    end if;
end $$;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Resumen de gastos por categoría (Reportes)
-- ════════════════════════════════════════════════════════════════

create or replace function fn_reporte_gastos(
    p_empresa_id uuid, p_desde date, p_hasta date
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'ok', true,
        'total', coalesce(sum(monto), 0),
        'cantidad', count(*),
        'por_categoria', (
            select coalesce(jsonb_object_agg(categoria, t), '{}'::jsonb)
              from (select categoria, sum(monto) as t
                      from taller_gastos
                     where empresa_id = p_empresa_id
                       and fecha between p_desde and p_hasta
                     group by categoria) x)
    )
    from taller_gastos
    where empresa_id = p_empresa_id
      and fecha between p_desde and p_hasta
$$;

grant execute on function fn_reporte_gastos(uuid, date, date) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Enganchar el libro al resultado del periodo
-- ════════════════════════════════════════════════════════════════
-- Idéntico a sql/06 salvo: v_gastos suma también taller_gastos
-- (sin doble-contar los que además pasaron por caja).

create or replace function fn_reporte_resumen(
    p_empresa_id uuid, p_desde date, p_hasta date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_hasta       date := p_hasta + 1;
    v_ot_total    numeric(12,2) := 0;
    v_ot_costo    numeric(12,2) := 0;
    v_ot_mo       numeric(12,2) := 0;
    v_ot_cant     integer := 0;
    v_vt_total    numeric(12,2) := 0;
    v_vt_costo    numeric(12,2) := 0;
    v_vt_cant     integer := 0;
    v_gastos      numeric(12,2) := 0;
    v_gastos_libro numeric(12,2) := 0;
    v_comisiones  numeric(12,2) := 0;
    v_por_cobrar  numeric(12,2) := 0;
    v_por_pagar   numeric(12,2) := 0;
    v_ingresos    numeric(12,2);
    v_costo       numeric(12,2);
    v_margen      numeric(12,2);
begin
    select coalesce(sum(total), 0), coalesce(sum(costo_repuestos), 0),
           coalesce(sum(mano_obra), 0), count(*)
      into v_ot_total, v_ot_costo, v_ot_mo, v_ot_cant
      from v_taller_ot_rentabilidad
     where empresa_id = p_empresa_id and estado = 'entregada'
       and fecha_entrega >= p_desde and fecha_entrega < v_hasta;

    select coalesce(sum(total), 0), coalesce(sum(costo), 0), count(*)
      into v_vt_total, v_vt_costo, v_vt_cant
      from v_taller_venta_rentabilidad
     where empresa_id = p_empresa_id
       and created_at >= p_desde and created_at < v_hasta;

    select coalesce(sum(monto) filter (where motivo = 'gasto'), 0),
           coalesce(sum(monto) filter (where motivo = 'comision'), 0)
      into v_gastos, v_comisiones
      from taller_movimientos_caja
     where empresa_id = p_empresa_id and tipo = 'egreso'
       and created_at >= p_desde and created_at < v_hasta;

    -- + libro de gastos, sin doble-contar los que ya pasaron por caja
    select coalesce(sum(g.monto), 0) into v_gastos_libro
      from taller_gastos g
     where g.empresa_id = p_empresa_id
       and g.fecha between p_desde and p_hasta
       and not exists (
           select 1 from taller_movimientos_caja mc
            where mc.empresa_id = p_empresa_id and mc.tipo = 'egreso' and mc.motivo = 'gasto'
              and mc.monto = g.monto and mc.created_at::date = g.fecha);
    v_gastos := v_gastos + v_gastos_libro;

    begin
        select coalesce(sum(saldo), 0) into v_por_cobrar
          from v_taller_ordenes_saldo where empresa_id = p_empresa_id and saldo > 0;
    exception when others then v_por_cobrar := 0; end;
    begin
        select coalesce(sum(saldo), 0) into v_por_pagar
          from v_taller_cxp_saldo where empresa_id = p_empresa_id and saldo > 0;
    exception when others then v_por_pagar := 0; end;

    v_ingresos := v_ot_total + v_vt_total;
    v_costo    := v_ot_costo + v_vt_costo;
    v_margen   := v_ingresos - v_costo;

    return jsonb_build_object(
        'ok', true, 'desde', p_desde, 'hasta', p_hasta,
        'ordenes_cantidad', v_ot_cant, 'ordenes_total', v_ot_total, 'ordenes_costo', v_ot_costo,
        'mano_obra', v_ot_mo,
        'ventas_cantidad', v_vt_cant, 'ventas_total', v_vt_total, 'ventas_costo', v_vt_costo,
        'ingresos', v_ingresos, 'costo_repuestos', v_costo, 'margen_bruto', v_margen,
        'margen_pct', case when v_ingresos > 0 then round(v_margen / v_ingresos * 100, 1) else 0 end,
        'gastos', v_gastos, 'comisiones', v_comisiones,
        'resultado', v_margen - v_gastos - v_comisiones,
        'ticket_promedio_ot', case when v_ot_cant > 0 then round(v_ot_total / v_ot_cant) else 0 end,
        'por_cobrar', v_por_cobrar, 'por_pagar', v_por_pagar);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Verificación ────────────────────────────────────────────────
-- select fn_reporte_gastos('<id>', date '2026-09-01', date '2026-09-30');
-- select fn_reporte_resumen('<id>', date '2026-09-01', date '2026-09-30');
