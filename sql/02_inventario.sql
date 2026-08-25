-- ================================================================
-- 02_inventario.sql — ARM TALLER
-- Inventario de repuestos con costo promedio ponderado y kardex.
--
-- Todo es idempotente: se puede correr más de una vez.
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Campos que le faltaban a taller_repuestos
-- ════════════════════════════════════════════════════════════════

alter table taller_repuestos
    add column if not exists precio_costo  numeric(12,2) not null default 0,
    add column if not exists stock_minimo  numeric(12,2) not null default 0,
    add column if not exists ubicacion     text,
    add column if not exists marca         text,
    add column if not exists categoria     text,
    add column if not exists codigo_oem    text,
    add column if not exists proveedor     text,
    add column if not exists notas         text;

comment on column taller_repuestos.precio_costo is
    'Costo promedio ponderado. Lo recalcula fn_entrada_stock_repuesto; no editar a mano salvo corrección.';
comment on column taller_repuestos.stock_minimo is
    'Bajo este nivel el repuesto aparece en las alertas de reposición.';

create index if not exists idx_taller_repuestos_empresa
    on taller_repuestos (empresa_id, activo);

create index if not exists idx_taller_repuestos_busqueda
    on taller_repuestos (empresa_id, nombre);


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Kardex: toda variación de stock deja rastro
-- ════════════════════════════════════════════════════════════════
-- Sin esto no se puede responder "¿por qué tengo 3 y no 7?", que es
-- la pregunta que más plata cuesta en un taller.

create table if not exists taller_movimientos_stock (
    id                uuid primary key default gen_random_uuid(),
    empresa_id        uuid not null,
    repuesto_id       uuid,
    codigo            text not null,
    tipo              text not null check (tipo in ('entrada', 'salida', 'ajuste')),
    motivo            text not null,   -- compra | orden_trabajo | venta | merma | inventario | devolucion | inicial
    cantidad          numeric(12,2) not null,   -- siempre positiva; el signo lo da 'tipo'
    stock_anterior    numeric(12,2),
    stock_resultante  numeric(12,2),
    costo_unitario    numeric(12,2),
    referencia        text,            -- N° de OT, de venta o de orden de compra
    observacion       text,
    usuario_rut       text,
    created_at        timestamptz not null default now()
);

create index if not exists idx_tms_empresa_codigo
    on taller_movimientos_stock (empresa_id, codigo, created_at desc);

create index if not exists idx_tms_empresa_fecha
    on taller_movimientos_stock (empresa_id, created_at desc);


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Entrada de mercadería con costo promedio ponderado
-- ════════════════════════════════════════════════════════════════
-- Fórmula:  costo_nuevo = (stock·costo_actual + cantidad·costo_compra)
--                         ────────────────────────────────────────────
--                                    stock + cantidad
--
-- Si compras 10 filtros a $3.000 y ya tenías 5 a $2.000, el costo
-- pasa a $2.667. Sin esto el margen que muestre el sistema es falso.

create or replace function fn_entrada_stock_repuesto(
    p_empresa_id     uuid,
    p_codigo         text,
    p_cantidad       numeric,
    p_costo_unitario numeric default null,
    p_motivo         text    default 'compra',
    p_referencia     text    default null,
    p_usuario        text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rep    taller_repuestos%rowtype;
    v_nuevo  numeric(12,2);
    v_costo  numeric(12,2);
begin
    if p_cantidad is null or p_cantidad <= 0 then
        return jsonb_build_object('ok', false, 'error', 'La cantidad debe ser mayor que cero.');
    end if;

    -- FOR UPDATE: bloquea la fila hasta el commit, sin condiciones de carrera
    select * into v_rep
      from taller_repuestos
     where empresa_id = p_empresa_id and codigo = p_codigo
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Repuesto no encontrado: ' || p_codigo);
    end if;

    v_nuevo := coalesce(v_rep.stock, 0) + p_cantidad;

    -- Costo promedio ponderado (solo si vino un costo de compra)
    if p_costo_unitario is not null and p_costo_unitario >= 0 then
        v_costo := round(
            ((coalesce(v_rep.stock, 0) * coalesce(v_rep.precio_costo, 0))
             + (p_cantidad * p_costo_unitario)) / nullif(v_nuevo, 0), 2);
    else
        v_costo := v_rep.precio_costo;
    end if;

    update taller_repuestos
       set stock = v_nuevo, precio_costo = coalesce(v_costo, precio_costo)
     where id = v_rep.id;

    insert into taller_movimientos_stock (
        empresa_id, repuesto_id, codigo, tipo, motivo, cantidad,
        stock_anterior, stock_resultante, costo_unitario, referencia, usuario_rut)
    values (
        p_empresa_id, v_rep.id, p_codigo, 'entrada', p_motivo, p_cantidad,
        coalesce(v_rep.stock, 0), v_nuevo, p_costo_unitario, p_referencia, p_usuario);

    return jsonb_build_object('ok', true, 'stock', v_nuevo, 'precio_costo', coalesce(v_costo, v_rep.precio_costo));
end;
$$;

revoke all on function fn_entrada_stock_repuesto(uuid, text, numeric, numeric, text, text, text) from public;
grant execute on function fn_entrada_stock_repuesto(uuid, text, numeric, numeric, text, text, text) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Ajuste de inventario (toma física, mermas, correcciones)
-- ════════════════════════════════════════════════════════════════
-- Recibe el stock REAL contado y registra la diferencia con su motivo.
-- Nunca se edita 'stock' directamente desde el front.

create or replace function fn_ajustar_stock_repuesto(
    p_empresa_id  uuid,
    p_codigo      text,
    p_stock_real  numeric,
    p_motivo      text default 'inventario',
    p_observacion text default null,
    p_usuario     text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rep    taller_repuestos%rowtype;
    v_actual numeric(12,2);
    v_dif    numeric(12,2);
begin
    if p_stock_real is null or p_stock_real < 0 then
        return jsonb_build_object('ok', false, 'error', 'El stock no puede ser negativo.');
    end if;

    select * into v_rep
      from taller_repuestos
     where empresa_id = p_empresa_id and codigo = p_codigo
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Repuesto no encontrado: ' || p_codigo);
    end if;

    v_actual := coalesce(v_rep.stock, 0);
    v_dif    := p_stock_real - v_actual;

    if v_dif = 0 then
        return jsonb_build_object('ok', true, 'stock', v_actual, 'sin_cambio', true);
    end if;

    update taller_repuestos set stock = p_stock_real where id = v_rep.id;

    insert into taller_movimientos_stock (
        empresa_id, repuesto_id, codigo, tipo, motivo, cantidad,
        stock_anterior, stock_resultante, costo_unitario, observacion, usuario_rut)
    values (
        p_empresa_id, v_rep.id, p_codigo, 'ajuste', p_motivo, abs(v_dif),
        v_actual, p_stock_real, v_rep.precio_costo, p_observacion, p_usuario);

    return jsonb_build_object('ok', true, 'stock', p_stock_real, 'diferencia', v_dif);
end;
$$;

revoke all on function fn_ajustar_stock_repuesto(uuid, text, numeric, text, text, text) from public;
grant execute on function fn_ajustar_stock_repuesto(uuid, text, numeric, text, text, text) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Que las salidas por OT también queden en el kardex
-- ════════════════════════════════════════════════════════════════
-- ⚠ Este paso REEMPLAZA fn_descontar_stock_repuesto y
--   fn_devolver_stock_repuesto, que ya existen.
--
--   Revisa primero la definición actual:
--
--     select p.proname, pg_get_function_identity_arguments(p.oid) as args
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.proname like 'fn_%_stock_repuesto';
--
--   Si los tipos de los parámetros no son (uuid, text, numeric), ajusta
--   el DROP de abajo antes de correrlo. La lógica (bloqueo FOR UPDATE,
--   retorno {ok, error}) es la misma que ya usa el front: lo único que
--   se agrega es el registro en el kardex.

drop function if exists fn_descontar_stock_repuesto(uuid, text, numeric);

create function fn_descontar_stock_repuesto(
    p_empresa_id uuid,
    p_codigo     text,
    p_cantidad   numeric,
    p_referencia text default null,
    p_usuario    text default null,
    p_motivo     text default 'orden_trabajo'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_rep   taller_repuestos%rowtype;
    v_nuevo numeric(12,2);
begin
    if p_cantidad is null or p_cantidad <= 0 then
        return jsonb_build_object('ok', false, 'error', 'La cantidad debe ser mayor que cero.');
    end if;

    select * into v_rep
      from taller_repuestos
     where empresa_id = p_empresa_id and codigo = p_codigo
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Repuesto no encontrado: ' || p_codigo);
    end if;

    if coalesce(v_rep.stock, 0) < p_cantidad then
        return jsonb_build_object('ok', false,
            'error', format('Stock insuficiente de %s: hay %s y se piden %s',
                            v_rep.nombre, coalesce(v_rep.stock, 0), p_cantidad));
    end if;

    v_nuevo := v_rep.stock - p_cantidad;
    update taller_repuestos set stock = v_nuevo where id = v_rep.id;

    insert into taller_movimientos_stock (
        empresa_id, repuesto_id, codigo, tipo, motivo, cantidad,
        stock_anterior, stock_resultante, costo_unitario, referencia, usuario_rut)
    values (
        p_empresa_id, v_rep.id, p_codigo, 'salida', p_motivo, p_cantidad,
        v_rep.stock, v_nuevo, v_rep.precio_costo, p_referencia, p_usuario);

    return jsonb_build_object('ok', true, 'stock', v_nuevo);
end;
$$;

revoke all on function fn_descontar_stock_repuesto(uuid, text, numeric, text, text, text) from public;
grant execute on function fn_descontar_stock_repuesto(uuid, text, numeric, text, text, text) to anon, authenticated;


drop function if exists fn_devolver_stock_repuesto(uuid, text, numeric);

create function fn_devolver_stock_repuesto(
    p_empresa_id uuid,
    p_codigo     text,
    p_cantidad   numeric,
    p_referencia text default null,
    p_usuario    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    return fn_entrada_stock_repuesto(
        p_empresa_id, p_codigo, p_cantidad, null,
        'devolucion', p_referencia, p_usuario);
end;
$$;

revoke all on function fn_devolver_stock_repuesto(uuid, text, numeric, text, text) from public;
grant execute on function fn_devolver_stock_repuesto(uuid, text, numeric, text, text) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Vista de reposición (para el dashboard y las alertas)
-- ════════════════════════════════════════════════════════════════

create or replace view v_taller_reposicion as
select
    r.empresa_id,
    r.id,
    r.codigo,
    r.nombre,
    r.marca,
    r.ubicacion,
    r.proveedor,
    coalesce(r.stock, 0)        as stock,
    coalesce(r.stock_minimo, 0) as stock_minimo,
    greatest(coalesce(r.stock_minimo, 0) - coalesce(r.stock, 0), 0) as faltante,
    r.precio_costo,
    case when coalesce(r.stock, 0) <= 0 then 'sin_stock' else 'bajo_minimo' end as situacion
from taller_repuestos r
where r.activo = true
  and coalesce(r.stock, 0) <= coalesce(r.stock_minimo, 0);


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select count(*) from taller_movimientos_stock;
-- select * from v_taller_reposicion where empresa_id = '<id del taller>';
