-- ================================================================
-- 06_reportes.sql — ARM TALLER
-- Rentabilidad, productividad y rotación.
--
-- ⚠ REQUIERE los scripts 02, 03, 04 y 05.
--
-- Aquí se responde lo que el dueño del taller no puede contestar hoy:
--   · ¿Cuánto gané de verdad este mes, después de repuestos y comisiones?
--   · ¿Qué órdenes me dejaron plata y cuáles trabajé gratis?
--   · ¿Qué mecánico produce y cuánto?
--   · ¿Cuánto capital tengo durmiendo en la bodega?
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Congelar el costo del repuesto en la orden de trabajo
-- ════════════════════════════════════════════════════════════════
-- Sin esto no hay rentabilidad posible: el costo del repuesto cambia
-- con cada compra, y una OT de marzo no puede valorizarse con el
-- costo de agosto. El trigger lo captura al momento de agregar el ítem,
-- así el front no necesita cambiar.

alter table taller_ordenes_items
    add column if not exists costo_unitario numeric(12,2) default 0;

create or replace function fn_trg_item_costo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.tipo = 'repuesto'
       and new.articulo_codigo is not null
       and coalesce(new.costo_unitario, 0) = 0 then
        select coalesce(precio_costo, 0) into new.costo_unitario
          from taller_repuestos
         where empresa_id = new.empresa_id and codigo = new.articulo_codigo;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_item_costo on taller_ordenes_items;
create trigger trg_item_costo
    before insert on taller_ordenes_items
    for each row execute function fn_trg_item_costo();


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Totales de la OT calculados en la base
-- ════════════════════════════════════════════════════════════════
-- Hasta ahora los sumaba el navegador. Ahora los recalcula un trigger
-- cada vez que cambian los ítems, y de paso agrega neto e IVA.
-- (El front sigue escribiendo los mismos valores: no estorba.)

alter table taller_ordenes
    add column if not exists neto numeric(12,2) default 0,
    add column if not exists iva  numeric(12,2) default 0;

create or replace function fn_trg_orden_totales()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_orden uuid := coalesce(new.orden_id, old.orden_id);
    v_rep   numeric(12,2);
    v_mo    numeric(12,2);
    v_total numeric(12,2);
    v_neto  numeric(12,2);
begin
    select coalesce(sum(subtotal) filter (where tipo = 'repuesto'), 0),
           coalesce(sum(subtotal) filter (where tipo = 'mano_obra'), 0)
      into v_rep, v_mo
      from taller_ordenes_items
     where orden_id = v_orden;

    v_total := v_rep + v_mo;
    v_neto  := round(v_total / 1.19);

    update taller_ordenes
       set total_repuestos = v_rep,
           total_mano_obra = v_mo,
           total           = v_total,
           neto            = v_neto,
           iva             = v_total - v_neto
     where id = v_orden;

    return null;
end;
$$;

drop trigger if exists trg_orden_totales on taller_ordenes_items;
create trigger trg_orden_totales
    after insert or update or delete on taller_ordenes_items
    for each row execute function fn_trg_orden_totales();


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Rentabilidad por orden de trabajo
-- ════════════════════════════════════════════════════════════════
-- El margen compara el total CON IVA contra el costo NETO de los
-- repuestos, que es como el taller mira su plata en la práctica.

create or replace view v_taller_ot_rentabilidad as
select
    o.empresa_id,
    o.id            as orden_id,
    o.numero,
    o.estado,
    o.fecha_entrega,
    o.cliente_id,
    o.vehiculo_id,
    o.mecanico_id,
    coalesce(o.total, 0)           as total,
    coalesce(o.total_repuestos, 0) as venta_repuestos,
    coalesce(o.total_mano_obra, 0) as mano_obra,
    coalesce(c.costo, 0)           as costo_repuestos,
    coalesce(o.total, 0) - coalesce(c.costo, 0) as margen,
    case when coalesce(o.total, 0) > 0
         then round(((coalesce(o.total, 0) - coalesce(c.costo, 0))
                     / coalesce(o.total, 0)) * 100, 1)
         else 0 end as margen_pct
from taller_ordenes o
left join lateral (
    select sum(round(i.cantidad * coalesce(i.costo_unitario, 0))) as costo
      from taller_ordenes_items i
     where i.orden_id = o.id and i.tipo = 'repuesto'
) c on true
where o.estado <> 'anulada';


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Rentabilidad por venta de mostrador
-- ════════════════════════════════════════════════════════════════

create or replace view v_taller_venta_rentabilidad as
select
    v.empresa_id,
    v.id      as venta_id,
    v.numero,
    v.created_at,
    v.vendedor_id,
    v.medio_pago,
    coalesce(v.total, 0) as total,
    coalesce(c.costo, 0) as costo,
    coalesce(v.total, 0) - coalesce(c.costo, 0) as margen,
    case when coalesce(v.total, 0) > 0
         then round(((coalesce(v.total, 0) - coalesce(c.costo, 0))
                     / coalesce(v.total, 0)) * 100, 1)
         else 0 end as margen_pct
from taller_ventas v
left join lateral (
    select sum(round(i.cantidad * coalesce(i.costo_unitario, 0))) as costo
      from taller_ventas_items i where i.venta_id = v.id
) c on true
where coalesce(v.estado, 'pagada') <> 'anulada';


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Rotación de repuestos y capital dormido
-- ════════════════════════════════════════════════════════════════
-- "Capital inmovilizado" es la plata que está quieta en la bodega.
-- Un repuesto sin salidas en 180 días con stock caro es plata muerta.

create or replace view v_taller_rotacion_repuestos as
select
    r.empresa_id,
    r.id as repuesto_id,
    r.codigo,
    r.nombre,
    r.marca,
    r.ubicacion,
    coalesce(r.stock, 0)        as stock,
    coalesce(r.precio_costo, 0) as precio_costo,
    round(coalesce(r.stock, 0) * coalesce(r.precio_costo, 0)) as capital_inmovilizado,
    coalesce(m.salidas_90, 0)   as salidas_90,
    m.ultima_salida,
    case when m.ultima_salida is null then null
         else (current_date - m.ultima_salida::date) end as dias_sin_salida,
    case
        when coalesce(r.stock, 0) <= 0            then 'sin_stock'
        when coalesce(m.salidas_90, 0) = 0        then 'dormido'
        when coalesce(m.salidas_90, 0) >= coalesce(r.stock, 0) then 'alta'
        else 'normal'
    end as rotacion
from taller_repuestos r
left join lateral (
    select sum(s.cantidad) as salidas_90,
           max(s.created_at) as ultima_salida
      from taller_movimientos_stock s
     where s.empresa_id = r.empresa_id
       and s.codigo = r.codigo
       and s.tipo = 'salida'
       and s.motivo in ('orden_trabajo', 'venta')
       and s.created_at >= now() - interval '90 days'
) m on true
where r.activo = true;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Resumen del periodo
-- ════════════════════════════════════════════════════════════════
-- Resultado OPERATIVO aproximado, no contabilidad: sirve para tomar
-- decisiones del taller, no para declarar impuestos.
--
--   margen bruto = ingresos − costo de los repuestos vendidos
--   resultado    = margen bruto − gastos − comisiones pagadas

create or replace function fn_reporte_resumen(
    p_empresa_id uuid,
    p_desde      date,
    p_hasta      date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_hasta       date := p_hasta + 1;   -- exclusivo
    v_ot_total    numeric(12,2) := 0;
    v_ot_costo    numeric(12,2) := 0;
    v_ot_mo       numeric(12,2) := 0;
    v_ot_cant     integer := 0;
    v_vt_total    numeric(12,2) := 0;
    v_vt_costo    numeric(12,2) := 0;
    v_vt_cant     integer := 0;
    v_gastos      numeric(12,2) := 0;
    v_comisiones  numeric(12,2) := 0;
    v_por_cobrar  numeric(12,2) := 0;
    v_por_pagar   numeric(12,2) := 0;
    v_ingresos    numeric(12,2);
    v_costo       numeric(12,2);
    v_margen      numeric(12,2);
begin
    -- Órdenes entregadas en el periodo
    select coalesce(sum(total), 0), coalesce(sum(costo_repuestos), 0),
           coalesce(sum(mano_obra), 0), count(*)
      into v_ot_total, v_ot_costo, v_ot_mo, v_ot_cant
      from v_taller_ot_rentabilidad
     where empresa_id = p_empresa_id
       and estado = 'entregada'
       and fecha_entrega >= p_desde
       and fecha_entrega <  v_hasta;

    -- Ventas de mostrador
    select coalesce(sum(total), 0), coalesce(sum(costo), 0), count(*)
      into v_vt_total, v_vt_costo, v_vt_cant
      from v_taller_venta_rentabilidad
     where empresa_id = p_empresa_id
       and created_at >= p_desde
       and created_at <  v_hasta;

    -- Gastos y comisiones efectivamente pagados
    select coalesce(sum(monto) filter (where motivo = 'gasto'), 0),
           coalesce(sum(monto) filter (where motivo = 'comision'), 0)
      into v_gastos, v_comisiones
      from taller_movimientos_caja
     where empresa_id = p_empresa_id
       and tipo = 'egreso'
       and created_at >= p_desde
       and created_at <  v_hasta;

    -- Deuda vigente (foto de hoy, no del periodo)
    begin
        select coalesce(sum(saldo), 0) into v_por_cobrar
          from v_taller_ordenes_saldo
         where empresa_id = p_empresa_id and saldo > 0;
    exception when others then v_por_cobrar := 0; end;

    begin
        select coalesce(sum(saldo), 0) into v_por_pagar
          from v_taller_cxp_saldo
         where empresa_id = p_empresa_id and saldo > 0;
    exception when others then v_por_pagar := 0; end;

    v_ingresos := v_ot_total + v_vt_total;
    v_costo    := v_ot_costo + v_vt_costo;
    v_margen   := v_ingresos - v_costo;

    return jsonb_build_object(
        'ok', true,
        'desde', p_desde, 'hasta', p_hasta,
        'ordenes_cantidad',   v_ot_cant,
        'ordenes_total',      v_ot_total,
        'ordenes_costo',      v_ot_costo,
        'mano_obra',          v_ot_mo,
        'ventas_cantidad',    v_vt_cant,
        'ventas_total',       v_vt_total,
        'ventas_costo',       v_vt_costo,
        'ingresos',           v_ingresos,
        'costo_repuestos',    v_costo,
        'margen_bruto',       v_margen,
        'margen_pct',         case when v_ingresos > 0
                                   then round(v_margen / v_ingresos * 100, 1) else 0 end,
        'gastos',             v_gastos,
        'comisiones',         v_comisiones,
        'resultado',          v_margen - v_gastos - v_comisiones,
        'ticket_promedio_ot', case when v_ot_cant > 0
                                   then round(v_ot_total / v_ot_cant) else 0 end,
        'por_cobrar',         v_por_cobrar,
        'por_pagar',          v_por_pagar);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 7 — Productividad por mecánico
-- ════════════════════════════════════════════════════════════════

create or replace function fn_reporte_mecanicos(
    p_empresa_id uuid,
    p_desde      date,
    p_hasta      date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_res jsonb;
begin
    select coalesce(jsonb_agg(x order by x.mano_obra desc), '[]'::jsonb) into v_res
    from (
        select
            e.id                              as empleado_id,
            e.nombre,
            e.especialidad,
            count(r.orden_id)                 as ordenes,
            coalesce(sum(r.total), 0)         as facturado,
            coalesce(sum(r.mano_obra), 0)     as mano_obra,
            coalesce(sum(r.margen), 0)        as margen,
            case when count(r.orden_id) > 0
                 then round(coalesce(sum(r.total), 0) / count(r.orden_id))
                 else 0 end                   as ticket_promedio
        from taller_empleados e
        join v_taller_ot_rentabilidad r
          on r.mecanico_id = e.id
         and r.estado = 'entregada'
         and r.fecha_entrega >= p_desde
         and r.fecha_entrega <  p_hasta + 1
        where e.empresa_id = p_empresa_id
        group by e.id, e.nombre, e.especialidad
    ) x;

    return jsonb_build_object('ok', true, 'mecanicos', v_res);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Permisos ────────────────────────────────────────────────────
do $$
declare f text;
begin
    foreach f in array array[
        'fn_reporte_resumen(uuid, date, date)',
        'fn_reporte_mecanicos(uuid, date, date)'
    ] loop
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to anon, authenticated', f);
    end loop;
end $$;


-- ════════════════════════════════════════════════════════════════
-- OPCIONAL — Rellenar el costo de los ítems ya existentes
-- ════════════════════════════════════════════════════════════════
-- El trigger solo actúa sobre ítems nuevos. Para que los reportes
-- históricos no muestren margen 100%, se puede cargar el costo ACTUAL
-- del repuesto en los ítems viejos. Es una aproximación: el costo real
-- de esas órdenes ya no se puede recuperar.
--
--   update taller_ordenes_items i
--      set costo_unitario = coalesce(r.precio_costo, 0)
--     from taller_repuestos r
--    where r.empresa_id = i.empresa_id
--      and r.codigo = i.articulo_codigo
--      and i.tipo = 'repuesto'
--      and coalesce(i.costo_unitario, 0) = 0;

-- Y recalcular los totales de todas las órdenes:
--   update taller_ordenes o set total = o.total;  -- no dispara el trigger
--   -- mejor: tocar un ítem de cada orden, o correr el update de arriba
--   --        y luego recalcular con una consulta manual.


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select fn_reporte_resumen('<id>', date '2026-08-01', date '2026-08-31');
-- select * from v_taller_rotacion_repuestos
--  where empresa_id = '<id>' and rotacion = 'dormido'
--  order by capital_inmovilizado desc;
