-- ================================================================
-- 03_ventas_caja.sql — ARM TALLER
-- Venta de mostrador, caja diaria y pagos de clientes.
--
-- ⚠ REQUIERE sql/02_inventario.sql (usa taller_movimientos_stock).
--
-- Principio: una venta es UNA operación. O se graba la venta, se
-- descuenta el stock y entra la plata a la caja, o no pasa nada.
-- Por eso todo ocurre dentro de fn_registrar_venta y no en el front.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================

-- Revisa qué columnas tiene hoy taller_ventas antes de correr esto:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_name = 'taller_ventas' order by ordinal_position;


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Turnos de caja
-- ════════════════════════════════════════════════════════════════
-- Una caja es un turno: se abre con un monto inicial, recibe
-- movimientos y se cierra contando la plata real. La diferencia
-- entre lo contado y lo teórico es el descuadre del turno.

create table if not exists taller_cajas (
    id                uuid primary key default gen_random_uuid(),
    empresa_id        uuid not null,
    numero            integer,
    estado            text not null default 'abierta' check (estado in ('abierta', 'cerrada')),

    fecha_apertura    timestamptz not null default now(),
    usuario_apertura  text,
    monto_inicial     numeric(12,2) not null default 0,

    fecha_cierre      timestamptz,
    usuario_cierre    text,
    efectivo_teorico  numeric(12,2),   -- lo que el sistema dice que debe haber
    efectivo_contado  numeric(12,2),   -- lo que se contó de verdad
    diferencia        numeric(12,2),
    observacion       text,

    created_at        timestamptz not null default now()
);

create index if not exists idx_cajas_empresa_estado
    on taller_cajas (empresa_id, estado, fecha_apertura desc);

-- Una sola caja abierta por taller a la vez
create unique index if not exists idx_cajas_una_abierta
    on taller_cajas (empresa_id) where estado = 'abierta';


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Movimientos de caja (todo el dinero pasa por aquí)
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_movimientos_caja (
    id           uuid primary key default gen_random_uuid(),
    empresa_id   uuid not null,
    caja_id      uuid references taller_cajas(id),

    tipo         text not null check (tipo in ('ingreso', 'egreso')),
    motivo       text not null,   -- venta | orden_trabajo | abono | apertura | gasto | retiro | anulacion
    medio_pago   text not null default 'efectivo'
                 check (medio_pago in ('efectivo', 'debito', 'credito', 'transferencia', 'cheque', 'otro')),
    monto        numeric(12,2) not null check (monto >= 0),

    venta_id     uuid,
    orden_id     uuid,
    cliente_id   uuid,
    referencia   text,
    descripcion  text,
    usuario_rut  text,
    created_at   timestamptz not null default now()
);

create index if not exists idx_movcaja_caja    on taller_movimientos_caja (caja_id, created_at);
create index if not exists idx_movcaja_empresa on taller_movimientos_caja (empresa_id, created_at desc);
create index if not exists idx_movcaja_orden   on taller_movimientos_caja (orden_id) where orden_id is not null;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Ventas de mostrador
-- ════════════════════════════════════════════════════════════════
-- Los precios se manejan CON IVA incluido (como en mostrador):
--   total = suma de subtotales − descuento
--   neto  = round(total / 1.19)
--   iva   = total − neto

alter table taller_ventas
    add column if not exists numero        integer,
    add column if not exists cliente_id    uuid,
    add column if not exists caja_id       uuid,
    add column if not exists estado        text default 'pagada',
    add column if not exists medio_pago    text default 'efectivo',
    add column if not exists neto          numeric(12,2) default 0,
    add column if not exists iva           numeric(12,2) default 0,
    add column if not exists descuento     numeric(12,2) default 0,
    add column if not exists total         numeric(12,2) default 0,
    add column if not exists observacion   text,
    add column if not exists usuario_rut   text,
    add column if not exists anulada_at    timestamptz,
    add column if not exists anulada_por   text,
    add column if not exists created_at    timestamptz default now();

create index if not exists idx_ventas_empresa_fecha
    on taller_ventas (empresa_id, created_at desc);

create table if not exists taller_ventas_items (
    id              uuid primary key default gen_random_uuid(),
    empresa_id      uuid not null,
    venta_id        uuid not null references taller_ventas(id) on delete cascade,
    tipo            text not null default 'repuesto' check (tipo in ('repuesto', 'servicio')),
    articulo_codigo text,
    descripcion     text not null,
    cantidad        numeric(12,2) not null check (cantidad > 0),
    precio_unitario numeric(12,2) not null default 0,
    descuento       numeric(12,2) not null default 0,
    subtotal        numeric(12,2) not null default 0,
    created_at      timestamptz not null default now()
);

create index if not exists idx_ventas_items_venta on taller_ventas_items (venta_id);


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Abrir y cerrar caja
-- ════════════════════════════════════════════════════════════════

create or replace function fn_abrir_caja(
    p_empresa_id    uuid,
    p_monto_inicial numeric default 0,
    p_usuario       text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caja   taller_cajas%rowtype;
    v_numero integer;
begin
    select * into v_caja
      from taller_cajas
     where empresa_id = p_empresa_id and estado = 'abierta'
     limit 1;

    if found then
        return jsonb_build_object('ok', false,
            'error', 'Ya hay una caja abierta. Ciérrala antes de abrir otra.',
            'caja_id', v_caja.id);
    end if;

    select coalesce(max(numero), 0) + 1 into v_numero
      from taller_cajas where empresa_id = p_empresa_id;

    insert into taller_cajas (empresa_id, numero, monto_inicial, usuario_apertura)
    values (p_empresa_id, v_numero, coalesce(p_monto_inicial, 0), p_usuario)
    returning * into v_caja;

    -- El monto inicial queda como movimiento, para que el arqueo cuadre
    if coalesce(p_monto_inicial, 0) > 0 then
        insert into taller_movimientos_caja (
            empresa_id, caja_id, tipo, motivo, medio_pago, monto, descripcion, usuario_rut)
        values (
            p_empresa_id, v_caja.id, 'ingreso', 'apertura', 'efectivo',
            p_monto_inicial, 'Fondo inicial de caja', p_usuario);
    end if;

    return jsonb_build_object('ok', true, 'caja_id', v_caja.id, 'numero', v_caja.numero);
end;
$$;


create or replace function fn_cerrar_caja(
    p_empresa_id       uuid,
    p_caja_id          uuid,
    p_efectivo_contado numeric,
    p_observacion      text default null,
    p_usuario          text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_caja    taller_cajas%rowtype;
    v_teorico numeric(12,2);
    v_dif     numeric(12,2);
begin
    select * into v_caja
      from taller_cajas
     where id = p_caja_id and empresa_id = p_empresa_id
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Caja no encontrada.');
    end if;
    if v_caja.estado = 'cerrada' then
        return jsonb_build_object('ok', false, 'error', 'Esta caja ya está cerrada.');
    end if;

    -- Teórico = solo EFECTIVO. Tarjetas y transferencias no están en el cajón.
    select coalesce(sum(case when tipo = 'ingreso' then monto else -monto end), 0)
      into v_teorico
      from taller_movimientos_caja
     where caja_id = p_caja_id and medio_pago = 'efectivo';

    v_dif := coalesce(p_efectivo_contado, 0) - v_teorico;

    update taller_cajas
       set estado           = 'cerrada',
           fecha_cierre     = now(),
           usuario_cierre   = p_usuario,
           efectivo_teorico = v_teorico,
           efectivo_contado = coalesce(p_efectivo_contado, 0),
           diferencia       = v_dif,
           observacion      = p_observacion
     where id = p_caja_id;

    return jsonb_build_object('ok', true,
        'teorico', v_teorico, 'contado', coalesce(p_efectivo_contado, 0), 'diferencia', v_dif);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Registrar una venta (atómica)
-- ════════════════════════════════════════════════════════════════
-- p_items: [{ "tipo":"repuesto", "codigo":"FIL-001", "descripcion":"...",
--             "cantidad":2, "precio_unitario":5900, "descuento":0 }, ...]
--
-- Si un repuesto no tiene stock, la función falla completa: no queda
-- media venta grabada. Eso es lo que no se puede garantizar desde el front.

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
    v_rep        taller_repuestos%rowtype;
    v_nuevo      numeric(12,2);
begin
    if p_items is null or jsonb_array_length(p_items) = 0 then
        return jsonb_build_object('ok', false, 'error', 'La venta no tiene ítems.');
    end if;

    -- ── 1. Correlativo ──────────────────────────────────────────
    begin
        v_numero := fn_taller_siguiente_numero(p_empresa_id, 'venta');
    exception when others then
        select coalesce(max(numero), 0) + 1 into v_numero
          from taller_ventas where empresa_id = p_empresa_id;
    end;

    -- ── 2. Cabecera (los totales se completan al final) ─────────
    insert into taller_ventas (
        empresa_id, numero, cliente_id, caja_id, estado, medio_pago,
        descuento, observacion, usuario_rut)
    values (
        p_empresa_id, v_numero, p_cliente_id, p_caja_id, 'pagada', p_medio_pago,
        v_desc, p_observacion, p_usuario)
    returning id into v_venta_id;

    -- ── 3. Ítems + stock ────────────────────────────────────────
    for v_item in select * from jsonb_array_elements(p_items)
    loop
        v_cant := coalesce((v_item ->> 'cantidad')::numeric, 0);
        if v_cant <= 0 then
            raise exception 'Cantidad inválida en el ítem %', v_item ->> 'descripcion';
        end if;

        v_sub := round(v_cant * coalesce((v_item ->> 'precio_unitario')::numeric, 0))
                 - coalesce((v_item ->> 'descuento')::numeric, 0);
        if v_sub < 0 then v_sub := 0; end if;
        v_total := v_total + v_sub;

        insert into taller_ventas_items (
            empresa_id, venta_id, tipo, articulo_codigo, descripcion,
            cantidad, precio_unitario, descuento, subtotal)
        values (
            p_empresa_id, v_venta_id,
            coalesce(v_item ->> 'tipo', 'repuesto'),
            v_item ->> 'codigo',
            coalesce(v_item ->> 'descripcion', 'Sin descripción'),
            v_cant,
            coalesce((v_item ->> 'precio_unitario')::numeric, 0),
            coalesce((v_item ->> 'descuento')::numeric, 0),
            v_sub);

        -- Descuento de stock, con bloqueo de fila
        if coalesce(v_item ->> 'tipo', 'repuesto') = 'repuesto' then
            v_codigo := v_item ->> 'codigo';
            if v_codigo is not null then
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

                v_nuevo := v_rep.stock - v_cant;
                update taller_repuestos set stock = v_nuevo where id = v_rep.id;

                insert into taller_movimientos_stock (
                    empresa_id, repuesto_id, codigo, tipo, motivo, cantidad,
                    stock_anterior, stock_resultante, costo_unitario, referencia, usuario_rut)
                values (
                    p_empresa_id, v_rep.id, v_codigo, 'salida', 'venta', v_cant,
                    v_rep.stock, v_nuevo, v_rep.precio_costo,
                    'Venta ' || v_numero, p_usuario);
            end if;
        end if;
    end loop;

    -- ── 4. Totales (precios con IVA incluido) ───────────────────
    v_total := greatest(v_total - v_desc, 0);
    v_neto  := round(v_total / 1.19);
    v_iva   := v_total - v_neto;

    update taller_ventas
       set total = v_total, neto = v_neto, iva = v_iva
     where id = v_venta_id;

    -- ── 5. Entrada de dinero ────────────────────────────────────
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


-- ── Anular una venta: devuelve stock y saca la plata de la caja ──
create or replace function fn_anular_venta(
    p_empresa_id uuid,
    p_venta_id   uuid,
    p_motivo     text default null,
    p_usuario    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_venta taller_ventas%rowtype;
    v_it    taller_ventas_items%rowtype;
    v_rep   taller_repuestos%rowtype;
    v_nuevo numeric(12,2);
begin
    select * into v_venta
      from taller_ventas
     where id = p_venta_id and empresa_id = p_empresa_id
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Venta no encontrada.');
    end if;
    if v_venta.estado = 'anulada' then
        return jsonb_build_object('ok', false, 'error', 'Esta venta ya está anulada.');
    end if;

    for v_it in select * from taller_ventas_items where venta_id = p_venta_id
    loop
        if v_it.tipo = 'repuesto' and v_it.articulo_codigo is not null then
            select * into v_rep
              from taller_repuestos
             where empresa_id = p_empresa_id and codigo = v_it.articulo_codigo
             for update;

            if found then
                v_nuevo := coalesce(v_rep.stock, 0) + v_it.cantidad;
                update taller_repuestos set stock = v_nuevo where id = v_rep.id;

                insert into taller_movimientos_stock (
                    empresa_id, repuesto_id, codigo, tipo, motivo, cantidad,
                    stock_anterior, stock_resultante, costo_unitario, referencia, usuario_rut)
                values (
                    p_empresa_id, v_rep.id, v_it.articulo_codigo, 'entrada', 'anulacion',
                    v_it.cantidad, coalesce(v_rep.stock, 0), v_nuevo, v_rep.precio_costo,
                    'Anula venta ' || coalesce(v_venta.numero::text, ''), p_usuario);
            end if;
        end if;
    end loop;

    -- Contraasiento en caja (en la caja abierta, no en la del turno original)
    if coalesce(v_venta.total, 0) > 0 then
        insert into taller_movimientos_caja (
            empresa_id, caja_id, tipo, motivo, medio_pago, monto,
            venta_id, cliente_id, referencia, descripcion, usuario_rut)
        values (
            p_empresa_id,
            (select id from taller_cajas where empresa_id = p_empresa_id and estado = 'abierta' limit 1),
            'egreso', 'anulacion', coalesce(v_venta.medio_pago, 'efectivo'), v_venta.total,
            p_venta_id, v_venta.cliente_id,
            'Anula venta ' || coalesce(v_venta.numero::text, ''),
            coalesce(p_motivo, 'Anulación de venta'), p_usuario);
    end if;

    update taller_ventas
       set estado = 'anulada', anulada_at = now(), anulada_por = p_usuario,
           observacion = coalesce(observacion || ' | ', '') || 'ANULADA: ' || coalesce(p_motivo, 's/motivo')
     where id = p_venta_id;

    return jsonb_build_object('ok', true);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Pagos de órdenes de trabajo
-- ════════════════════════════════════════════════════════════════
-- Una OT se paga con uno o varios abonos. El saldo sale de
-- total de la OT menos lo ya pagado.

create or replace function fn_registrar_pago_orden(
    p_empresa_id uuid,
    p_orden_id   uuid,
    p_monto      numeric,
    p_medio_pago text default 'efectivo',
    p_caja_id    uuid default null,
    p_usuario    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_orden   taller_ordenes%rowtype;
    v_pagado  numeric(12,2);
    v_saldo   numeric(12,2);
begin
    if coalesce(p_monto, 0) <= 0 then
        return jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor que cero.');
    end if;

    select * into v_orden
      from taller_ordenes
     where id = p_orden_id and empresa_id = p_empresa_id
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Orden no encontrada.');
    end if;
    if v_orden.estado = 'anulada' then
        return jsonb_build_object('ok', false, 'error', 'La orden está anulada.');
    end if;

    select coalesce(sum(case when tipo = 'ingreso' then monto else -monto end), 0)
      into v_pagado
      from taller_movimientos_caja
     where orden_id = p_orden_id and motivo in ('orden_trabajo', 'abono');

    v_saldo := coalesce(v_orden.total, 0) - v_pagado;

    if p_monto > v_saldo + 0.5 then
        return jsonb_build_object('ok', false,
            'error', format('El pago (%s) supera el saldo pendiente (%s).', p_monto, v_saldo));
    end if;

    insert into taller_movimientos_caja (
        empresa_id, caja_id, tipo, motivo, medio_pago, monto,
        orden_id, cliente_id, referencia, descripcion, usuario_rut)
    values (
        p_empresa_id, p_caja_id, 'ingreso', 'orden_trabajo', p_medio_pago, p_monto,
        p_orden_id, v_orden.cliente_id, 'OT ' || v_orden.numero,
        'Pago de orden N° ' || v_orden.numero, p_usuario);

    return jsonb_build_object('ok', true,
        'pagado', v_pagado + p_monto,
        'saldo',  v_saldo - p_monto,
        'total',  coalesce(v_orden.total, 0));

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Saldo pendiente por orden (para Caja y para entregar la OT) ──
create or replace view v_taller_ordenes_saldo as
select
    o.empresa_id,
    o.id            as orden_id,
    o.numero,
    o.estado,
    o.cliente_id,
    coalesce(o.total, 0) as total,
    coalesce((
        select sum(case when m.tipo = 'ingreso' then m.monto else -m.monto end)
          from taller_movimientos_caja m
         where m.orden_id = o.id and m.motivo in ('orden_trabajo', 'abono')
    ), 0) as pagado,
    coalesce(o.total, 0) - coalesce((
        select sum(case when m.tipo = 'ingreso' then m.monto else -m.monto end)
          from taller_movimientos_caja m
         where m.orden_id = o.id and m.motivo in ('orden_trabajo', 'abono')
    ), 0) as saldo
from taller_ordenes o
where o.estado <> 'anulada';


-- ── Permisos ────────────────────────────────────────────────────
do $$
declare f text;
begin
    foreach f in array array[
        'fn_abrir_caja(uuid, numeric, text)',
        'fn_cerrar_caja(uuid, uuid, numeric, text, text)',
        'fn_registrar_venta(uuid, jsonb, text, uuid, uuid, numeric, text, text)',
        'fn_anular_venta(uuid, uuid, text, text)',
        'fn_registrar_pago_orden(uuid, uuid, numeric, text, uuid, text)'
    ] loop
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to anon, authenticated', f);
    end loop;
end $$;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select * from taller_cajas where empresa_id = '<id>' order by numero desc;
-- select * from v_taller_ordenes_saldo where empresa_id = '<id>' and saldo > 0;
