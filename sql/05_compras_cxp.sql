-- ================================================================
-- 05_compras_cxp.sql — ARM TALLER
-- Proveedores, órdenes de compra y cuentas por pagar.
--
-- ⚠ REQUIERE sql/02_inventario.sql y sql/03_ventas_caja.sql.
--
-- Cierra el otro lado del inventario: hasta ahora el stock solo
-- entraba a mano desde el módulo Inventario. Aquí entra por su
-- documento, con su costo, su proveedor y su deuda asociada.
--
-- ── IVA en compras (al revés que en ventas) ─────────────────────
-- El costo unitario de compra se registra NETO (sin IVA), como
-- viene en la factura del proveedor:
--     neto  = suma de (cantidad × costo_unitario)
--     iva   = round(neto × 0,19)      ← crédito fiscal
--     total = neto + iva              ← lo que se le debe al proveedor
-- El costo que entra al inventario es el NETO. Por eso el margen
-- del repuesto compara costo neto contra precio de venta con IVA.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Proveedores
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_proveedores (
    id               uuid primary key default gen_random_uuid(),
    empresa_id       uuid not null,
    rut              text,
    razon_social     text not null,
    nombre_fantasia  text,
    giro             text,
    contacto_nombre  text,
    telefono         text,
    email            text,
    direccion        text,
    ciudad           text,
    condicion_pago   text not null default 'contado'
                     check (condicion_pago in ('contado', 'credito')),
    dias_credito     integer not null default 0,
    notas            text,
    activo           boolean not null default true,
    created_at       timestamptz not null default now()
);

create unique index if not exists idx_proveedores_rut
    on taller_proveedores (empresa_id, rut) where rut is not null;

create index if not exists idx_proveedores_empresa
    on taller_proveedores (empresa_id, activo);


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Órdenes de compra
-- ════════════════════════════════════════════════════════════════
-- Flujo: borrador → emitida → recibida.
-- El stock se mueve SOLO al recibir, nunca al emitir.

create table if not exists taller_compras (
    id                uuid primary key default gen_random_uuid(),
    empresa_id        uuid not null,
    numero            integer,
    proveedor_id      uuid references taller_proveedores(id),

    estado            text not null default 'borrador'
                      check (estado in ('borrador', 'emitida', 'recibida', 'anulada')),

    fecha_emision     date not null default current_date,
    fecha_recepcion   timestamptz,
    fecha_vencimiento date,

    tipo_documento    text default 'factura'
                      check (tipo_documento in ('factura', 'boleta', 'guia', 'sin_documento')),
    numero_documento  text,

    condicion_pago    text not null default 'contado'
                      check (condicion_pago in ('contado', 'credito')),
    dias_credito      integer not null default 0,

    neto              numeric(12,2) not null default 0,
    iva               numeric(12,2) not null default 0,
    total             numeric(12,2) not null default 0,

    observacion       text,
    usuario_rut       text,
    created_at        timestamptz not null default now()
);

create index if not exists idx_compras_empresa
    on taller_compras (empresa_id, estado, fecha_emision desc);

create table if not exists taller_compras_items (
    id              uuid primary key default gen_random_uuid(),
    empresa_id      uuid not null,
    compra_id       uuid not null references taller_compras(id) on delete cascade,
    repuesto_codigo text,          -- nulo = insumo que no controla stock
    descripcion     text not null,
    cantidad        numeric(12,2) not null check (cantidad > 0),
    costo_unitario  numeric(12,2) not null default 0,   -- NETO
    subtotal        numeric(12,2) not null default 0,
    created_at      timestamptz not null default now()
);

create index if not exists idx_compras_items on taller_compras_items (compra_id);


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Cuentas por pagar
-- ════════════════════════════════════════════════════════════════
-- Una cuenta nace de una compra a crédito, pero también puede
-- cargarse a mano (arriendo, luz, servicios): por eso es su propia
-- tabla y no una vista sobre taller_compras.

create table if not exists taller_cuentas_pagar (
    id                uuid primary key default gen_random_uuid(),
    empresa_id        uuid not null,
    proveedor_id      uuid references taller_proveedores(id),
    compra_id         uuid references taller_compras(id),

    tipo_documento    text default 'factura',
    numero_documento  text,
    descripcion       text,

    fecha_emision     date not null default current_date,
    fecha_vencimiento date,

    total             numeric(12,2) not null default 0,
    estado            text not null default 'pendiente'
                      check (estado in ('pendiente', 'pagada', 'anulada')),

    observacion       text,
    usuario_rut       text,
    created_at        timestamptz not null default now()
);

create index if not exists idx_cxp_empresa
    on taller_cuentas_pagar (empresa_id, estado, fecha_vencimiento);

-- Los pagos a proveedor son movimientos de caja: se enlazan por aquí
alter table taller_movimientos_caja
    add column if not exists cxp_id       uuid,
    add column if not exists proveedor_id uuid;

create index if not exists idx_movcaja_cxp
    on taller_movimientos_caja (cxp_id) where cxp_id is not null;


-- ── Saldo y antigüedad de cada documento por pagar ──────────────
create or replace view v_taller_cxp_saldo as
select
    c.empresa_id,
    c.id            as cxp_id,
    c.proveedor_id,
    c.compra_id,
    c.tipo_documento,
    c.numero_documento,
    c.descripcion,
    c.fecha_emision,
    c.fecha_vencimiento,
    c.estado,
    coalesce(c.total, 0) as total,
    coalesce(p.pagado, 0) as pagado,
    coalesce(c.total, 0) - coalesce(p.pagado, 0) as saldo,
    case
        when c.fecha_vencimiento is null then 'sin_fecha'
        when c.fecha_vencimiento >= current_date then 'por_vencer'
        when current_date - c.fecha_vencimiento <= 30 then 'vencida_30'
        when current_date - c.fecha_vencimiento <= 60 then 'vencida_60'
        else 'vencida_mas_60'
    end as antiguedad,
    greatest(current_date - c.fecha_vencimiento, 0) as dias_vencida
from taller_cuentas_pagar c
left join lateral (
    select sum(case when m.tipo = 'egreso' then m.monto else -m.monto end) as pagado
      from taller_movimientos_caja m
     where m.cxp_id = c.id and m.motivo = 'proveedor'
) p on true
where c.estado <> 'anulada';


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Recalcular los totales de una compra
-- ════════════════════════════════════════════════════════════════

create or replace function fn_recalcular_compra(p_compra_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_neto numeric(12,2);
begin
    select coalesce(sum(subtotal), 0) into v_neto
      from taller_compras_items where compra_id = p_compra_id;

    update taller_compras
       set neto  = v_neto,
           iva   = round(v_neto * 0.19),
           total = v_neto + round(v_neto * 0.19)
     where id = p_compra_id;
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Recibir la mercadería
-- ════════════════════════════════════════════════════════════════
-- Sube el stock de cada ítem con costo promedio ponderado (reusa
-- fn_entrada_stock_repuesto del 02, para no duplicar esa lógica),
-- y si la compra es a crédito deja la cuenta por pagar creada.

create or replace function fn_recibir_compra(
    p_empresa_id uuid,
    p_compra_id  uuid,
    p_usuario    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_compra  taller_compras%rowtype;
    v_it      taller_compras_items%rowtype;
    v_res     jsonb;
    v_venc    date;
    v_cxp_id  uuid;
    v_subidos integer := 0;
begin
    select * into v_compra
      from taller_compras
     where id = p_compra_id and empresa_id = p_empresa_id
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Compra no encontrada.');
    end if;
    if v_compra.estado = 'recibida' then
        return jsonb_build_object('ok', false, 'error', 'Esta compra ya fue recibida.');
    end if;
    if v_compra.estado = 'anulada' then
        return jsonb_build_object('ok', false, 'error', 'La compra está anulada.');
    end if;
    if not exists (select 1 from taller_compras_items where compra_id = p_compra_id) then
        return jsonb_build_object('ok', false, 'error', 'La compra no tiene ítems.');
    end if;

    perform fn_recalcular_compra(p_compra_id);
    select * into v_compra from taller_compras where id = p_compra_id;

    -- ── Stock, ítem por ítem ────────────────────────────────────
    for v_it in select * from taller_compras_items where compra_id = p_compra_id
    loop
        if v_it.repuesto_codigo is not null then
            v_res := fn_entrada_stock_repuesto(
                p_empresa_id, v_it.repuesto_codigo, v_it.cantidad,
                v_it.costo_unitario, 'compra',
                'OC ' || coalesce(v_compra.numero::text, ''), p_usuario);

            if not coalesce((v_res ->> 'ok')::boolean, false) then
                raise exception 'Ítem %: %', v_it.descripcion, v_res ->> 'error';
            end if;
            v_subidos := v_subidos + 1;
        end if;
    end loop;

    -- ── Vencimiento ─────────────────────────────────────────────
    v_venc := coalesce(
        v_compra.fecha_vencimiento,
        case when v_compra.condicion_pago = 'credito'
             then current_date + coalesce(v_compra.dias_credito, 0)
             else current_date end);

    update taller_compras
       set estado = 'recibida', fecha_recepcion = now(), fecha_vencimiento = v_venc
     where id = p_compra_id;

    -- ── Cuenta por pagar ────────────────────────────────────────
    select id into v_cxp_id from taller_cuentas_pagar where compra_id = p_compra_id;

    if v_cxp_id is null and coalesce(v_compra.total, 0) > 0 then
        insert into taller_cuentas_pagar (
            empresa_id, proveedor_id, compra_id, tipo_documento, numero_documento,
            descripcion, fecha_emision, fecha_vencimiento, total, usuario_rut)
        values (
            p_empresa_id, v_compra.proveedor_id, p_compra_id,
            coalesce(v_compra.tipo_documento, 'factura'), v_compra.numero_documento,
            'Compra N° ' || coalesce(v_compra.numero::text, ''),
            v_compra.fecha_emision, v_venc, v_compra.total, p_usuario)
        returning id into v_cxp_id;
    end if;

    return jsonb_build_object('ok', true,
        'items_en_stock', v_subidos,
        'total', v_compra.total,
        'cxp_id', v_cxp_id,
        'vencimiento', v_venc);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Anular una compra (devuelve el stock si ya estaba recibida) ──
create or replace function fn_anular_compra(
    p_empresa_id uuid,
    p_compra_id  uuid,
    p_motivo     text default null,
    p_usuario    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_compra taller_compras%rowtype;
    v_it     taller_compras_items%rowtype;
    v_rep    taller_repuestos%rowtype;
    v_nuevo  numeric(12,2);
    v_pagado numeric(12,2);
begin
    select * into v_compra
      from taller_compras where id = p_compra_id and empresa_id = p_empresa_id for update;

    if not found then return jsonb_build_object('ok', false, 'error', 'Compra no encontrada.'); end if;
    if v_compra.estado = 'anulada' then
        return jsonb_build_object('ok', false, 'error', 'Esta compra ya está anulada.');
    end if;

    -- No se anula algo que ya se pagó: primero hay que revertir el pago
    select coalesce(sum(case when m.tipo = 'egreso' then m.monto else -m.monto end), 0)
      into v_pagado
      from taller_movimientos_caja m
      join taller_cuentas_pagar c on c.id = m.cxp_id
     where c.compra_id = p_compra_id and m.motivo = 'proveedor';

    if v_pagado > 0 then
        return jsonb_build_object('ok', false,
            'error', format('La compra tiene %s pagados al proveedor. Revierte el pago antes de anularla.', v_pagado));
    end if;

    if v_compra.estado = 'recibida' then
        for v_it in select * from taller_compras_items where compra_id = p_compra_id
        loop
            if v_it.repuesto_codigo is not null then
                select * into v_rep
                  from taller_repuestos
                 where empresa_id = p_empresa_id and codigo = v_it.repuesto_codigo
                 for update;

                if found then
                    if coalesce(v_rep.stock, 0) < v_it.cantidad then
                        raise exception 'No se puede anular: de % ya se consumieron unidades (hay %, la compra trajo %)',
                            v_rep.nombre, coalesce(v_rep.stock, 0), v_it.cantidad;
                    end if;

                    v_nuevo := v_rep.stock - v_it.cantidad;
                    update taller_repuestos set stock = v_nuevo where id = v_rep.id;

                    insert into taller_movimientos_stock (
                        empresa_id, repuesto_id, codigo, tipo, motivo, cantidad,
                        stock_anterior, stock_resultante, costo_unitario, referencia, usuario_rut)
                    values (
                        p_empresa_id, v_rep.id, v_it.repuesto_codigo, 'salida', 'anulacion',
                        v_it.cantidad, v_rep.stock, v_nuevo, v_it.costo_unitario,
                        'Anula OC ' || coalesce(v_compra.numero::text, ''), p_usuario);
                end if;
            end if;
        end loop;
    end if;

    update taller_cuentas_pagar set estado = 'anulada' where compra_id = p_compra_id;

    update taller_compras
       set estado = 'anulada',
           observacion = coalesce(observacion || ' | ', '') || 'ANULADA: ' || coalesce(p_motivo, 's/motivo')
     where id = p_compra_id;

    return jsonb_build_object('ok', true);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Pagar a un proveedor
-- ════════════════════════════════════════════════════════════════
-- Admite pagos parciales. Sale por la caja abierta, igual que
-- cualquier otro egreso, para que el arqueo cuadre.

create or replace function fn_pagar_cuenta(
    p_empresa_id uuid,
    p_cxp_id     uuid,
    p_monto      numeric,
    p_medio_pago text default 'transferencia',
    p_caja_id    uuid default null,
    p_referencia text default null,
    p_usuario    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cxp    taller_cuentas_pagar%rowtype;
    v_pagado numeric(12,2);
    v_saldo  numeric(12,2);
begin
    if coalesce(p_monto, 0) <= 0 then
        return jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor que cero.');
    end if;

    select * into v_cxp
      from taller_cuentas_pagar
     where id = p_cxp_id and empresa_id = p_empresa_id
     for update;

    if not found then return jsonb_build_object('ok', false, 'error', 'Documento no encontrado.'); end if;
    if v_cxp.estado = 'anulada' then
        return jsonb_build_object('ok', false, 'error', 'El documento está anulado.');
    end if;

    select coalesce(sum(case when tipo = 'egreso' then monto else -monto end), 0)
      into v_pagado
      from taller_movimientos_caja
     where cxp_id = p_cxp_id and motivo = 'proveedor';

    v_saldo := coalesce(v_cxp.total, 0) - v_pagado;

    if p_monto > v_saldo + 0.5 then
        return jsonb_build_object('ok', false,
            'error', format('El pago (%s) supera el saldo pendiente (%s).', p_monto, v_saldo));
    end if;

    insert into taller_movimientos_caja (
        empresa_id, caja_id, tipo, motivo, medio_pago, monto,
        cxp_id, proveedor_id, referencia, descripcion, usuario_rut)
    values (
        p_empresa_id,
        coalesce(p_caja_id, (select id from taller_cajas
                              where empresa_id = p_empresa_id and estado = 'abierta' limit 1)),
        'egreso', 'proveedor', p_medio_pago, p_monto,
        p_cxp_id, v_cxp.proveedor_id,
        coalesce(p_referencia, v_cxp.numero_documento),
        'Pago a proveedor · ' || coalesce(v_cxp.descripcion, v_cxp.numero_documento, ''),
        p_usuario);

    if v_saldo - p_monto <= 0.5 then
        update taller_cuentas_pagar set estado = 'pagada' where id = p_cxp_id;
    end if;

    return jsonb_build_object('ok', true,
        'pagado', v_pagado + p_monto,
        'saldo',  v_saldo - p_monto,
        'total',  coalesce(v_cxp.total, 0));

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Estado de cuenta por proveedor ──────────────────────────────
create or replace view v_taller_proveedores_saldo as
select
    p.empresa_id,
    p.id as proveedor_id,
    p.razon_social,
    count(s.cxp_id) filter (where s.saldo > 0)                as documentos_pendientes,
    coalesce(sum(s.saldo) filter (where s.saldo > 0), 0)      as saldo_total,
    coalesce(sum(s.saldo) filter (where s.saldo > 0
             and s.antiguedad like 'vencida%'), 0)            as saldo_vencido
from taller_proveedores p
left join v_taller_cxp_saldo s on s.proveedor_id = p.id
group by p.empresa_id, p.id, p.razon_social;


-- ── Permisos ────────────────────────────────────────────────────
do $$
declare f text;
begin
    foreach f in array array[
        'fn_recalcular_compra(uuid)',
        'fn_recibir_compra(uuid, uuid, text)',
        'fn_anular_compra(uuid, uuid, text, text)',
        'fn_pagar_cuenta(uuid, uuid, numeric, text, uuid, text, text)'
    ] loop
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to anon, authenticated', f);
    end loop;
end $$;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select * from v_taller_cxp_saldo where empresa_id = '<id>' and saldo > 0
--  order by fecha_vencimiento;
-- select * from v_taller_proveedores_saldo where empresa_id = '<id>';
