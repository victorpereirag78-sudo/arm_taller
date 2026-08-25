-- ================================================================
-- 04_empleados_comisiones.sql — ARM TALLER
-- Personal del taller y cálculo de comisiones.
--
-- ⚠ REQUIERE sql/02_inventario.sql y sql/03_ventas_caja.sql.
--
-- Principio: la comisión se calcula SOBRE DOCUMENTOS CERRADOS.
-- Una OT solo comisiona cuando está 'entregada'; una venta, cuando
-- no está anulada. Y opcionalmente, solo cuando además está cobrada
-- (p_solo_cobrado), que es como debería trabajar un taller sano:
-- no se paga comisión por plata que todavía no llegó.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Empleados
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_empleados (
    id             uuid primary key default gen_random_uuid(),
    empresa_id     uuid not null,
    rut            text,
    nombre         text not null,
    cargo          text not null default 'mecanico',
    especialidad   text,
    telefono       text,
    email          text,
    fecha_ingreso  date,
    fecha_salida   date,
    tipo_contrato  text default 'indefinido'
                   check (tipo_contrato in ('indefinido', 'plazo_fijo', 'honorarios', 'part_time')),
    sueldo_base    numeric(12,2) default 0,
    tarifa_hora    numeric(12,2) default 0,
    notas          text,
    activo         boolean not null default true,
    created_at     timestamptz not null default now()
);

create unique index if not exists idx_empleados_rut
    on taller_empleados (empresa_id, rut) where rut is not null;

create index if not exists idx_empleados_empresa
    on taller_empleados (empresa_id, activo);

-- Quién ejecutó el trabajo / quién vendió
alter table taller_ordenes
    add column if not exists mecanico_id uuid references taller_empleados(id);

alter table taller_ordenes_items
    add column if not exists empleado_id uuid references taller_empleados(id);

alter table taller_ventas
    add column if not exists vendedor_id uuid references taller_empleados(id);

comment on column taller_ordenes_items.empleado_id is
    'Quién hizo ESTE trabajo. Si va nulo, comisiona el mecánico de la orden.';

create index if not exists idx_ordenes_mecanico on taller_ordenes (mecanico_id) where mecanico_id is not null;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — El costo del repuesto queda congelado en la venta
-- ════════════════════════════════════════════════════════════════
-- Sin esto no se puede comisionar sobre margen ni saber la
-- rentabilidad real: el costo del repuesto cambia con cada compra.

alter table taller_ventas_items
    add column if not exists costo_unitario numeric(12,2) default 0;

-- Misma firma que en el 03: esto REEMPLAZA la función, no crea otra.
-- Único cambio: guarda el costo del repuesto al momento de venderlo.
create or replace function fn_registrar_venta(
    p_empresa_id       uuid,
    p_items            jsonb,
    p_medio_pago       text    default 'efectivo',
    p_caja_id          uuid    default null,
    p_cliente_id       uuid    default null,
    p_descuento_global numeric default 0,
    p_observacion      text    default null,
    p_usuario          text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_item       jsonb;
    v_venta_id   uuid;
    v_numero     integer;
    v_total      numeric(12,2) := 0;
    v_neto       numeric(12,2);
    v_iva        numeric(12,2);
    v_desc       numeric(12,2) := coalesce(p_descuento_global, 0);
    v_sub        numeric(12,2);
    v_cant       numeric(12,2);
    v_codigo     text;
    v_tipo       text;
    v_rep        taller_repuestos%rowtype;
    v_nuevo      numeric(12,2);
    v_costo      numeric(12,2);
    v_vendedor   uuid;
begin
    if p_items is null or jsonb_array_length(p_items) = 0 then
        return jsonb_build_object('ok', false, 'error', 'La venta no tiene ítems.');
    end if;

    begin
        v_numero := fn_taller_siguiente_numero(p_empresa_id, 'venta');
    exception when others then
        select coalesce(max(numero), 0) + 1 into v_numero
          from taller_ventas where empresa_id = p_empresa_id;
    end;

    -- El vendedor sale del RUT del usuario que cobró
    select id into v_vendedor
      from taller_empleados
     where empresa_id = p_empresa_id and rut = p_usuario and activo = true
     limit 1;

    insert into taller_ventas (
        empresa_id, numero, cliente_id, caja_id, estado, medio_pago,
        descuento, observacion, usuario_rut, vendedor_id)
    values (
        p_empresa_id, v_numero, p_cliente_id, p_caja_id, 'pagada', p_medio_pago,
        v_desc, p_observacion, p_usuario, v_vendedor)
    returning id into v_venta_id;

    for v_item in select * from jsonb_array_elements(p_items)
    loop
        v_cant := coalesce((v_item ->> 'cantidad')::numeric, 0);
        if v_cant <= 0 then
            raise exception 'Cantidad inválida en el ítem %', v_item ->> 'descripcion';
        end if;

        v_tipo   := coalesce(v_item ->> 'tipo', 'repuesto');
        v_codigo := v_item ->> 'codigo';
        v_costo  := 0;

        -- Stock, con bloqueo de fila
        if v_tipo = 'repuesto' and v_codigo is not null then
            select * into v_rep
              from taller_repuestos
             where empresa_id = p_empresa_id and codigo = v_codigo
             for update;

            if not found then
                raise exception 'Repuesto no encontrado: %', v_codigo;
            end if;
            if coalesce(v_rep.stock, 0) < v_cant then
                raise exception 'Stock insuficiente de %: hay % y se venden %',
                    v_rep.nombre, coalesce(v_rep.stock, 0), v_cant;
            end if;

            v_costo := coalesce(v_rep.precio_costo, 0);
            v_nuevo := v_rep.stock - v_cant;
            update taller_repuestos set stock = v_nuevo where id = v_rep.id;

            insert into taller_movimientos_stock (
                empresa_id, repuesto_id, codigo, tipo, motivo, cantidad,
                stock_anterior, stock_resultante, costo_unitario, referencia, usuario_rut)
            values (
                p_empresa_id, v_rep.id, v_codigo, 'salida', 'venta', v_cant,
                v_rep.stock, v_nuevo, v_costo, 'Venta ' || v_numero, p_usuario);
        end if;

        v_sub := round(v_cant * coalesce((v_item ->> 'precio_unitario')::numeric, 0))
                 - coalesce((v_item ->> 'descuento')::numeric, 0);
        if v_sub < 0 then v_sub := 0; end if;
        v_total := v_total + v_sub;

        insert into taller_ventas_items (
            empresa_id, venta_id, tipo, articulo_codigo, descripcion,
            cantidad, precio_unitario, descuento, subtotal, costo_unitario)
        values (
            p_empresa_id, v_venta_id, v_tipo, v_codigo,
            coalesce(v_item ->> 'descripcion', 'Sin descripción'),
            v_cant,
            coalesce((v_item ->> 'precio_unitario')::numeric, 0),
            coalesce((v_item ->> 'descuento')::numeric, 0),
            v_sub, v_costo);
    end loop;

    v_total := greatest(v_total - v_desc, 0);
    v_neto  := round(v_total / 1.19);
    v_iva   := v_total - v_neto;

    update taller_ventas
       set total = v_total, neto = v_neto, iva = v_iva
     where id = v_venta_id;

    if v_total > 0 then
        insert into taller_movimientos_caja (
            empresa_id, caja_id, tipo, motivo, medio_pago, monto,
            venta_id, cliente_id, referencia, descripcion, usuario_rut)
        values (
            p_empresa_id, p_caja_id, 'ingreso', 'venta', p_medio_pago, v_total,
            v_venta_id, p_cliente_id, 'Venta ' || v_numero,
            'Venta de mostrador N° ' || v_numero, p_usuario);
    end if;

    return jsonb_build_object('ok', true, 'venta_id', v_venta_id,
        'numero', v_numero, 'total', v_total, 'neto', v_neto, 'iva', v_iva);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Reglas de comisión
-- ════════════════════════════════════════════════════════════════
-- Bases disponibles:
--   mano_obra      % sobre la mano de obra de las OT que ejecutó
--   total_ot       % sobre el total de las OT donde fue el mecánico
--   repuestos_ot   % sobre los repuestos de esas OT
--   total_venta    % sobre el total de las ventas de mostrador que hizo
--   margen_venta   % sobre el MARGEN de esas ventas (lo correcto para
--                  vendedores: si regalan descuento, comisionan menos)

create table if not exists taller_reglas_comision (
    id            uuid primary key default gen_random_uuid(),
    empresa_id    uuid not null,
    empleado_id   uuid not null references taller_empleados(id) on delete cascade,
    nombre        text not null,
    base          text not null check (base in
                  ('mano_obra', 'total_ot', 'repuestos_ot', 'total_venta', 'margen_venta')),
    porcentaje    numeric(6,3) not null check (porcentaje >= 0 and porcentaje <= 100),
    activo        boolean not null default true,
    created_at    timestamptz not null default now()
);

create index if not exists idx_reglas_empresa on taller_reglas_comision (empresa_id, activo);


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Liquidaciones
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_liquidaciones (
    id             uuid primary key default gen_random_uuid(),
    empresa_id     uuid not null,
    empleado_id    uuid not null references taller_empleados(id),
    periodo        text not null,           -- 'YYYY-MM'
    estado         text not null default 'borrador'
                   check (estado in ('borrador', 'aprobada', 'pagada')),
    total_base     numeric(12,2) not null default 0,
    total_comision numeric(12,2) not null default 0,
    solo_cobrado   boolean not null default false,
    generada_at    timestamptz not null default now(),
    aprobada_at    timestamptz,
    pagada_at      timestamptz,
    pagada_por     text,
    observacion    text
);

create unique index if not exists idx_liq_empleado_periodo
    on taller_liquidaciones (empresa_id, empleado_id, periodo);

create table if not exists taller_liquidaciones_detalle (
    id                uuid primary key default gen_random_uuid(),
    empresa_id        uuid not null,
    liquidacion_id    uuid not null references taller_liquidaciones(id) on delete cascade,
    regla_id          uuid references taller_reglas_comision(id) on delete set null,
    origen            text not null,     -- orden | venta
    documento_id      uuid,
    documento_numero  text,
    fecha             date,
    descripcion       text,
    base              numeric(12,2) not null default 0,
    porcentaje        numeric(6,3)  not null default 0,
    comision          numeric(12,2) not null default 0
);

create index if not exists idx_liq_det on taller_liquidaciones_detalle (liquidacion_id);


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Generar las comisiones de un periodo
-- ════════════════════════════════════════════════════════════════
-- Regenera solo las liquidaciones en 'borrador'. Una liquidación ya
-- aprobada o pagada no se toca nunca: es un compromiso con la persona.

create or replace function fn_generar_comisiones(
    p_empresa_id   uuid,
    p_periodo      text,                      -- 'YYYY-MM'
    p_solo_cobrado boolean default false,
    p_usuario      text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_desde     date;
    v_hasta     date;
    v_regla     record;
    v_liq_id    uuid;
    v_estado    text;
    v_saltadas  integer := 0;
    v_generadas integer := 0;
    v_total     numeric(12,2) := 0;
begin
    if p_periodo !~ '^\d{4}-\d{2}$' then
        return jsonb_build_object('ok', false, 'error', 'Periodo inválido, usa YYYY-MM.');
    end if;

    v_desde := to_date(p_periodo || '-01', 'YYYY-MM-DD');
    v_hasta := v_desde + interval '1 month';

    for v_regla in
        select r.*, e.nombre as empleado_nombre
          from taller_reglas_comision r
          join taller_empleados e on e.id = r.empleado_id
         where r.empresa_id = p_empresa_id and r.activo = true and e.activo = true
    loop
        -- Liquidación del empleado para el periodo
        select id, estado into v_liq_id, v_estado
          from taller_liquidaciones
         where empresa_id = p_empresa_id
           and empleado_id = v_regla.empleado_id
           and periodo = p_periodo;

        if found and v_estado <> 'borrador' then
            v_saltadas := v_saltadas + 1;
            continue;
        end if;

        if not found then
            insert into taller_liquidaciones (empresa_id, empleado_id, periodo, solo_cobrado)
            values (p_empresa_id, v_regla.empleado_id, p_periodo, p_solo_cobrado)
            returning id into v_liq_id;
        else
            update taller_liquidaciones
               set generada_at = now(), solo_cobrado = p_solo_cobrado
             where id = v_liq_id;
            delete from taller_liquidaciones_detalle
             where liquidacion_id = v_liq_id and regla_id = v_regla.id;
        end if;

        -- ── Bases sobre órdenes de trabajo ──────────────────────
        if v_regla.base in ('mano_obra', 'repuestos_ot', 'total_ot') then

            insert into taller_liquidaciones_detalle (
                empresa_id, liquidacion_id, regla_id, origen,
                documento_id, documento_numero, fecha, descripcion,
                base, porcentaje, comision)
            select
                p_empresa_id, v_liq_id, v_regla.id, 'orden',
                o.id, 'OT ' || o.numero, o.fecha_entrega::date,
                v_regla.nombre,
                x.base,
                v_regla.porcentaje,
                round(x.base * v_regla.porcentaje / 100)
            from taller_ordenes o
            cross join lateral (
                select case v_regla.base
                    when 'total_ot' then coalesce(o.total, 0)
                    when 'mano_obra' then coalesce((
                        select sum(i.subtotal) from taller_ordenes_items i
                         where i.orden_id = o.id and i.tipo = 'mano_obra'
                           and coalesce(i.empleado_id, o.mecanico_id) = v_regla.empleado_id), 0)
                    when 'repuestos_ot' then coalesce((
                        select sum(i.subtotal) from taller_ordenes_items i
                         where i.orden_id = o.id and i.tipo = 'repuesto'), 0)
                end as base
            ) x
            where o.empresa_id = p_empresa_id
              and o.estado = 'entregada'
              and o.fecha_entrega >= v_desde
              and o.fecha_entrega <  v_hasta
              and (v_regla.base = 'mano_obra' or o.mecanico_id = v_regla.empleado_id)
              and x.base > 0
              and (not p_solo_cobrado or coalesce((
                    select s.saldo from v_taller_ordenes_saldo s where s.orden_id = o.id), 0) <= 0);

        -- ── Bases sobre ventas de mostrador ─────────────────────
        else
            insert into taller_liquidaciones_detalle (
                empresa_id, liquidacion_id, regla_id, origen,
                documento_id, documento_numero, fecha, descripcion,
                base, porcentaje, comision)
            select
                p_empresa_id, v_liq_id, v_regla.id, 'venta',
                v.id, 'Venta ' || v.numero, v.created_at::date,
                v_regla.nombre,
                y.base,
                v_regla.porcentaje,
                round(y.base * v_regla.porcentaje / 100)
            from taller_ventas v
            cross join lateral (
                select case v_regla.base
                    when 'total_venta' then coalesce(v.total, 0)
                    when 'margen_venta' then coalesce((
                        select sum(i.subtotal - round(i.cantidad * coalesce(i.costo_unitario, 0)))
                          from taller_ventas_items i where i.venta_id = v.id), 0)
                end as base
            ) y
            where v.empresa_id = p_empresa_id
              and coalesce(v.estado, 'pagada') <> 'anulada'
              and v.created_at >= v_desde
              and v.created_at <  v_hasta
              and v.vendedor_id = v_regla.empleado_id
              and y.base > 0;
        end if;

        v_generadas := v_generadas + 1;
    end loop;

    -- Totales por liquidación
    update taller_liquidaciones l
       set total_base     = coalesce(d.base, 0),
           total_comision = coalesce(d.comision, 0)
      from (
        select liquidacion_id, sum(base) as base, sum(comision) as comision
          from taller_liquidaciones_detalle group by liquidacion_id
      ) d
     where d.liquidacion_id = l.id
       and l.empresa_id = p_empresa_id
       and l.periodo = p_periodo
       and l.estado = 'borrador';

    -- Las que quedaron sin movimientos
    update taller_liquidaciones l
       set total_base = 0, total_comision = 0
     where l.empresa_id = p_empresa_id and l.periodo = p_periodo and l.estado = 'borrador'
       and not exists (select 1 from taller_liquidaciones_detalle d where d.liquidacion_id = l.id);

    select coalesce(sum(total_comision), 0) into v_total
      from taller_liquidaciones
     where empresa_id = p_empresa_id and periodo = p_periodo;

    return jsonb_build_object('ok', true,
        'reglas_aplicadas', v_generadas,
        'liquidaciones_protegidas', v_saltadas,
        'total_comisiones', v_total);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Aprobar y pagar
-- ════════════════════════════════════════════════════════════════

create or replace function fn_aprobar_liquidacion(
    p_empresa_id uuid, p_liquidacion_id uuid, p_usuario text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_liq taller_liquidaciones%rowtype;
begin
    select * into v_liq from taller_liquidaciones
     where id = p_liquidacion_id and empresa_id = p_empresa_id for update;

    if not found then return jsonb_build_object('ok', false, 'error', 'Liquidación no encontrada.'); end if;
    if v_liq.estado <> 'borrador' then
        return jsonb_build_object('ok', false, 'error', 'Solo se aprueban liquidaciones en borrador.');
    end if;

    update taller_liquidaciones set estado = 'aprobada', aprobada_at = now()
     where id = p_liquidacion_id;

    return jsonb_build_object('ok', true);
end;
$$;


-- Pagar deja el egreso en la caja abierta: la comisión es plata que sale.
create or replace function fn_pagar_liquidacion(
    p_empresa_id     uuid,
    p_liquidacion_id uuid,
    p_medio_pago     text default 'efectivo',
    p_caja_id        uuid default null,
    p_usuario        text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
    v_liq taller_liquidaciones%rowtype;
    v_emp taller_empleados%rowtype;
begin
    select * into v_liq from taller_liquidaciones
     where id = p_liquidacion_id and empresa_id = p_empresa_id for update;

    if not found then return jsonb_build_object('ok', false, 'error', 'Liquidación no encontrada.'); end if;
    if v_liq.estado = 'pagada' then
        return jsonb_build_object('ok', false, 'error', 'Esta liquidación ya está pagada.');
    end if;
    if v_liq.estado <> 'aprobada' then
        return jsonb_build_object('ok', false, 'error', 'Apruébala antes de pagarla.');
    end if;
    if coalesce(v_liq.total_comision, 0) <= 0 then
        return jsonb_build_object('ok', false, 'error', 'La liquidación no tiene monto que pagar.');
    end if;

    select * into v_emp from taller_empleados where id = v_liq.empleado_id;

    insert into taller_movimientos_caja (
        empresa_id, caja_id, tipo, motivo, medio_pago, monto,
        referencia, descripcion, usuario_rut)
    values (
        p_empresa_id,
        coalesce(p_caja_id, (select id from taller_cajas
                              where empresa_id = p_empresa_id and estado = 'abierta' limit 1)),
        'egreso', 'comision', p_medio_pago, v_liq.total_comision,
        'Comisión ' || v_liq.periodo,
        'Comisión ' || v_liq.periodo || ' · ' || coalesce(v_emp.nombre, ''),
        p_usuario);

    update taller_liquidaciones
       set estado = 'pagada', pagada_at = now(), pagada_por = p_usuario
     where id = p_liquidacion_id;

    return jsonb_build_object('ok', true, 'monto', v_liq.total_comision);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Permisos ────────────────────────────────────────────────────
do $$
declare f text;
begin
    foreach f in array array[
        'fn_generar_comisiones(uuid, text, boolean, text)',
        'fn_aprobar_liquidacion(uuid, uuid, text)',
        'fn_pagar_liquidacion(uuid, uuid, text, uuid, text)'
    ] loop
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to anon, authenticated', f);
    end loop;
end $$;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select * from taller_liquidaciones where empresa_id = '<id>' order by periodo desc;
-- select * from taller_liquidaciones_detalle where liquidacion_id = '<id>';
