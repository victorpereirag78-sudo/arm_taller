-- ════════════════════════════════════════════════════════════════
-- 35 · Fix — fn_registrar_venta insertaba en columnas inexistentes
-- ════════════════════════════════════════════════════════════════
-- Bug encontrado al cargar datos de demo (sql/34): toda venta de
-- mostrador con repuestos fallaba con
--   "column \"tipo\" of relation \"taller_ventas_items\" does not exist"
--
-- fn_registrar_venta insertaba `tipo` y `descuento` en
-- taller_ventas_items, pero esa tabla nunca tuvo esas columnas (solo
-- taller_ordenes_items y taller_presupuestos_items las tienen). Como
-- la función atrapa la excepción y devuelve {ok:false}, el módulo
-- Ventas quedaba roto en silencio para cualquier venta con ítems tipo
-- 'repuesto' — es decir, prácticamente todas.
--
-- El descuento por ítem igual se descuenta del subtotal antes de
-- guardarlo (ver v_sub); simplemente no se guarda aparte porque no hay
-- dónde. El campo v_tipo se sigue usando para decidir si hay que
-- descontar stock, solo dejó de insertarse en la tabla.
--
-- Aplicado y probado en la base con 3 ventas reales (repuesto, stock
-- decrementado, movimiento de caja generado).
--
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

create or replace function public.fn_registrar_venta(
    p_empresa_id        uuid,
    p_items             jsonb,
    p_medio_pago        text default 'efectivo',
    p_caja_id           uuid default null,
    p_cliente_id        uuid default null,
    p_descuento_global  numeric default 0,
    p_observacion       text default null,
    p_usuario           text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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

        -- taller_ventas_items no tiene columnas `tipo` ni `descuento` (a
        -- diferencia de ordenes_items / presupuestos_items): el fix es
        -- no intentar insertarlas.
        insert into taller_ventas_items (
            empresa_id, venta_id, articulo_codigo, descripcion,
            cantidad, precio_unitario, subtotal, costo_unitario)
        values (
            p_empresa_id, v_venta_id, v_codigo,
            coalesce(v_item ->> 'descripcion', 'Sin descripción'),
            v_cant,
            coalesce((v_item ->> 'precio_unitario')::numeric, 0),
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
$function$;
