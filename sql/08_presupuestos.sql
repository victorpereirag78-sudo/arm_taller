-- ================================================================
-- 08_presupuestos.sql — ARM TALLER
-- El presupuesto como documento propio.
--
-- ⚠ REQUIERE sql/02_inventario.sql.
--
-- ── Por qué esto arregla un problema real ───────────────────────
-- Hasta ahora un presupuesto era una OT en estado 'presupuesto', y
-- agregarle un repuesto DESCONTABA STOCK. Un taller que cotiza 20
-- trabajos al día se descapitalizaba el inventario en el papel por
-- trabajos que nunca se hicieron.
--
-- Aquí el presupuesto NO toca el stock. El stock se mueve una sola
-- vez: cuando el presupuesto se aprueba y se convierte en orden de
-- trabajo (fn_convertir_presupuesto_ot).
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — El documento
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_presupuestos (
    id                uuid primary key default gen_random_uuid(),
    empresa_id        uuid not null,
    numero            integer,
    version           integer not null default 1,
    padre_id          uuid references taller_presupuestos(id),

    cliente_id        uuid,
    vehiculo_id       uuid,

    estado            text not null default 'borrador'
                      check (estado in ('borrador', 'enviado', 'aprobado', 'rechazado',
                                        'reemplazado', 'convertido', 'anulado')),

    fecha_emision     date not null default current_date,
    dias_validez      integer not null default 15,
    fecha_vencimiento date,

    kilometraje       integer,
    motivo            text,
    diagnostico       text,
    condiciones       text,
    observacion       text,

    descuento         numeric(12,2) not null default 0,
    neto              numeric(12,2) not null default 0,
    iva               numeric(12,2) not null default 0,
    total             numeric(12,2) not null default 0,
    costo             numeric(12,2) not null default 0,   -- costo de los repuestos cotizados

    enviado_at        timestamptz,
    aprobado_at       timestamptz,
    aprobado_via      text check (aprobado_via in
                      ('presencial', 'telefono', 'whatsapp', 'email', 'otro')),
    aprobado_por      text,        -- nombre de quien autorizó
    rechazado_at      timestamptz,
    motivo_rechazo    text,

    orden_id          uuid,        -- OT generada al convertirlo
    usuario_rut       text,
    created_at        timestamptz not null default now()
);

create index if not exists idx_presup_empresa
    on taller_presupuestos (empresa_id, estado, fecha_emision desc);

create index if not exists idx_presup_vehiculo
    on taller_presupuestos (vehiculo_id);


create table if not exists taller_presupuestos_items (
    id              uuid primary key default gen_random_uuid(),
    empresa_id      uuid not null,
    presupuesto_id  uuid not null references taller_presupuestos(id) on delete cascade,
    tipo            text not null default 'repuesto'
                    check (tipo in ('repuesto', 'mano_obra')),
    articulo_codigo text,
    descripcion     text not null,
    cantidad        numeric(12,2) not null check (cantidad > 0),
    precio_unitario numeric(12,2) not null default 0,
    costo_unitario  numeric(12,2) not null default 0,
    descuento       numeric(12,2) not null default 0,
    subtotal        numeric(12,2) not null default 0,
    -- Un ítem opcional se le muestra al cliente pero no suma al total:
    -- "además le recomendamos cambiar…". Si lo acepta, se desmarca.
    opcional        boolean not null default false,
    orden           integer not null default 0,
    created_at      timestamptz not null default now()
);

create index if not exists idx_presup_items on taller_presupuestos_items (presupuesto_id);


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Totales y costo, calculados en la base
-- ════════════════════════════════════════════════════════════════
-- Los precios van CON IVA incluido, igual que en ventas.
-- Los ítems opcionales NO suman.

create or replace function fn_trg_presup_totales()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_p     uuid := coalesce(new.presupuesto_id, old.presupuesto_id);
    v_bruto numeric(12,2);
    v_costo numeric(12,2);
    v_desc  numeric(12,2);
    v_total numeric(12,2);
    v_neto  numeric(12,2);
begin
    select coalesce(sum(subtotal) filter (where not opcional), 0),
           coalesce(sum(round(cantidad * costo_unitario)) filter (where not opcional), 0)
      into v_bruto, v_costo
      from taller_presupuestos_items
     where presupuesto_id = v_p;

    select coalesce(descuento, 0) into v_desc
      from taller_presupuestos where id = v_p;

    v_total := greatest(v_bruto - v_desc, 0);
    v_neto  := round(v_total / 1.19);

    update taller_presupuestos
       set neto  = v_neto,
           iva   = v_total - v_neto,
           total = v_total,
           costo = v_costo
     where id = v_p;

    return null;
end;
$$;

drop trigger if exists trg_presup_totales on taller_presupuestos_items;
create trigger trg_presup_totales
    after insert or update or delete on taller_presupuestos_items
    for each row execute function fn_trg_presup_totales();


-- ── El costo del repuesto se congela al cotizarlo ───────────────
create or replace function fn_trg_presup_item_costo()
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

drop trigger if exists trg_presup_item_costo on taller_presupuestos_items;
create trigger trg_presup_item_costo
    before insert on taller_presupuestos_items
    for each row execute function fn_trg_presup_item_costo();


-- ── Vencimiento automático a partir de los días de validez ──────
create or replace function fn_trg_presup_vencimiento()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    new.fecha_vencimiento :=
        coalesce(new.fecha_emision, current_date) + coalesce(new.dias_validez, 15);
    return new;
end;
$$;

drop trigger if exists trg_presup_vencimiento on taller_presupuestos;
create trigger trg_presup_vencimiento
    before insert or update of fecha_emision, dias_validez on taller_presupuestos
    for each row execute function fn_trg_presup_vencimiento();


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Vista con vigencia y margen
-- ════════════════════════════════════════════════════════════════
-- El margen antes de enviar es lo que evita cotizar bajo costo.

create or replace view v_taller_presupuestos as
select
    p.*,
    v.patente,
    v.marca,
    v.modelo,
    c.nombre   as cliente_nombre,
    c.telefono as cliente_telefono,
    c.email    as cliente_email,

    (p.fecha_vencimiento - current_date) as dias_para_vencer,

    (p.estado in ('borrador', 'enviado')
     and p.fecha_vencimiento < current_date) as vencido,

    coalesce(p.total, 0) - coalesce(p.costo, 0) as margen,
    case when coalesce(p.total, 0) > 0
         then round((coalesce(p.total, 0) - coalesce(p.costo, 0))
                    / coalesce(p.total, 0) * 100, 1)
         else 0 end as margen_pct,

    (select count(*) from taller_presupuestos_items i
      where i.presupuesto_id = p.id) as items

from taller_presupuestos p
left join taller_vehiculos v on v.id = p.vehiculo_id
left join taller_clientes  c on c.id = p.cliente_id;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Nueva versión
-- ════════════════════════════════════════════════════════════════
-- El cliente pide sacar un ítem o poner una marca más barata. En vez
-- de editar el documento que ya vio, se saca una versión nueva y la
-- anterior queda como 'reemplazado'. Así queda el rastro de qué se
-- cotizó primero.

create or replace function fn_nueva_version_presupuesto(
    p_empresa_id     uuid,
    p_presupuesto_id uuid,
    p_usuario        text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_p     taller_presupuestos%rowtype;
    v_nuevo uuid;
begin
    select * into v_p
      from taller_presupuestos
     where id = p_presupuesto_id and empresa_id = p_empresa_id
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Presupuesto no encontrado.');
    end if;
    if v_p.estado in ('convertido', 'reemplazado') then
        return jsonb_build_object('ok', false,
            'error', 'Este presupuesto ya fue ' || v_p.estado || '.');
    end if;

    insert into taller_presupuestos (
        empresa_id, numero, version, padre_id, cliente_id, vehiculo_id,
        estado, fecha_emision, dias_validez, kilometraje,
        motivo, diagnostico, condiciones, observacion, descuento, usuario_rut)
    values (
        v_p.empresa_id, v_p.numero, v_p.version + 1, coalesce(v_p.padre_id, v_p.id),
        v_p.cliente_id, v_p.vehiculo_id,
        'borrador', current_date, v_p.dias_validez, v_p.kilometraje,
        v_p.motivo, v_p.diagnostico, v_p.condiciones, v_p.observacion,
        v_p.descuento, p_usuario)
    returning id into v_nuevo;

    insert into taller_presupuestos_items (
        empresa_id, presupuesto_id, tipo, articulo_codigo, descripcion,
        cantidad, precio_unitario, costo_unitario, descuento, subtotal, opcional, orden)
    select
        empresa_id, v_nuevo, tipo, articulo_codigo, descripcion,
        cantidad, precio_unitario, costo_unitario, descuento, subtotal, opcional, orden
      from taller_presupuestos_items
     where presupuesto_id = p_presupuesto_id;

    update taller_presupuestos set estado = 'reemplazado' where id = p_presupuesto_id;

    return jsonb_build_object('ok', true, 'presupuesto_id', v_nuevo,
        'version', v_p.version + 1);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Convertir en orden de trabajo
-- ════════════════════════════════════════════════════════════════
-- AQUÍ, y solo aquí, se mueve el stock. Es una operación atómica:
-- si falta un repuesto, no queda media OT creada.

create or replace function fn_convertir_presupuesto_ot(
    p_empresa_id     uuid,
    p_presupuesto_id uuid,
    p_usuario        text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_p       taller_presupuestos%rowtype;
    v_it      taller_presupuestos_items%rowtype;
    v_orden   uuid;
    v_numero  integer;
    v_rep     taller_repuestos%rowtype;
    v_nuevo   numeric(12,2);
begin
    select * into v_p
      from taller_presupuestos
     where id = p_presupuesto_id and empresa_id = p_empresa_id
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Presupuesto no encontrado.');
    end if;
    if v_p.estado = 'convertido' then
        return jsonb_build_object('ok', false,
            'error', 'Este presupuesto ya se convirtió en la OT correspondiente.');
    end if;
    if v_p.estado <> 'aprobado' then
        return jsonb_build_object('ok', false,
            'error', 'Solo se convierte un presupuesto aprobado. Registra primero la aprobación del cliente.');
    end if;
    if v_p.vehiculo_id is null then
        return jsonb_build_object('ok', false, 'error', 'El presupuesto no tiene vehículo asignado.');
    end if;

    -- Correlativo de orden
    begin
        v_numero := fn_taller_siguiente_numero(p_empresa_id, 'orden');
    exception when others then
        select coalesce(max(numero), 0) + 1 into v_numero
          from taller_ordenes where empresa_id = p_empresa_id;
    end;

    insert into taller_ordenes (
        empresa_id, numero, cliente_id, vehiculo_id, estado,
        kilometraje_ingreso, motivo_ingreso, diagnostico, usuario_creacion)
    values (
        p_empresa_id, v_numero, v_p.cliente_id, v_p.vehiculo_id, 'aprobada',
        v_p.kilometraje, v_p.motivo, v_p.diagnostico, p_usuario)
    returning id into v_orden;

    -- Ítems no opcionales → ítems de la OT, y ahí sí se descuenta stock
    for v_it in
        select * from taller_presupuestos_items
         where presupuesto_id = p_presupuesto_id and not opcional
         order by orden, created_at
    loop
        if v_it.tipo = 'repuesto' and v_it.articulo_codigo is not null then
            select * into v_rep
              from taller_repuestos
             where empresa_id = p_empresa_id and codigo = v_it.articulo_codigo
             for update;

            if not found then
                raise exception 'Repuesto no encontrado: %', v_it.articulo_codigo;
            end if;
            if coalesce(v_rep.stock, 0) < v_it.cantidad then
                raise exception 'Stock insuficiente de %: hay % y el presupuesto pide %',
                    v_rep.nombre, coalesce(v_rep.stock, 0), v_it.cantidad;
            end if;

            v_nuevo := v_rep.stock - v_it.cantidad;
            update taller_repuestos set stock = v_nuevo where id = v_rep.id;

            insert into taller_movimientos_stock (
                empresa_id, repuesto_id, codigo, tipo, motivo, cantidad,
                stock_anterior, stock_resultante, costo_unitario, referencia, usuario_rut)
            values (
                p_empresa_id, v_rep.id, v_it.articulo_codigo, 'salida', 'orden_trabajo',
                v_it.cantidad, v_rep.stock, v_nuevo, v_rep.precio_costo,
                'OT ' || v_numero, p_usuario);
        end if;

        insert into taller_ordenes_items (
            empresa_id, orden_id, tipo, articulo_codigo, descripcion,
            cantidad, precio_unitario, subtotal, costo_unitario)
        values (
            p_empresa_id, v_orden, v_it.tipo, v_it.articulo_codigo, v_it.descripcion,
            v_it.cantidad, v_it.precio_unitario, v_it.subtotal, v_it.costo_unitario);
    end loop;

    update taller_presupuestos
       set estado = 'convertido', orden_id = v_orden
     where id = p_presupuesto_id;

    return jsonb_build_object('ok', true, 'orden_id', v_orden, 'numero', v_numero);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Registrar la respuesta del cliente
-- ════════════════════════════════════════════════════════════════

create or replace function fn_responder_presupuesto(
    p_empresa_id     uuid,
    p_presupuesto_id uuid,
    p_respuesta      text,               -- aprobado | rechazado | enviado
    p_via            text default null,
    p_por            text default null,
    p_motivo         text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_p taller_presupuestos%rowtype;
begin
    select * into v_p
      from taller_presupuestos
     where id = p_presupuesto_id and empresa_id = p_empresa_id
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Presupuesto no encontrado.');
    end if;
    if v_p.estado in ('convertido', 'reemplazado') then
        return jsonb_build_object('ok', false,
            'error', 'Este presupuesto ya no admite cambios.');
    end if;

    if p_respuesta = 'enviado' then
        update taller_presupuestos
           set estado = 'enviado', enviado_at = now()
         where id = p_presupuesto_id;

    elsif p_respuesta = 'aprobado' then
        if coalesce(v_p.total, 0) <= 0 then
            return jsonb_build_object('ok', false,
                'error', 'No se puede aprobar un presupuesto sin monto.');
        end if;
        update taller_presupuestos
           set estado = 'aprobado', aprobado_at = now(),
               aprobado_via = p_via, aprobado_por = p_por
         where id = p_presupuesto_id;

    elsif p_respuesta = 'rechazado' then
        update taller_presupuestos
           set estado = 'rechazado', rechazado_at = now(), motivo_rechazo = p_motivo
         where id = p_presupuesto_id;

    else
        return jsonb_build_object('ok', false, 'error', 'Respuesta no válida.');
    end if;

    return jsonb_build_object('ok', true, 'estado', p_respuesta);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Tasa de conversión: cuánto de lo cotizado termina en trabajo ─
create or replace function fn_reporte_presupuestos(
    p_empresa_id uuid, p_desde date, p_hasta date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_r jsonb;
begin
    select jsonb_build_object(
        'ok', true,
        'emitidos',        count(*),
        'monto_emitido',   coalesce(sum(total), 0),
        'aprobados',       count(*) filter (where estado in ('aprobado', 'convertido')),
        'monto_aprobado',  coalesce(sum(total) filter (where estado in ('aprobado', 'convertido')), 0),
        'rechazados',      count(*) filter (where estado = 'rechazado'),
        'vencidos',        count(*) filter (where vencido),
        'tasa_conversion', case when count(*) > 0
                                then round(count(*) filter (where estado in ('aprobado', 'convertido'))
                                           * 100.0 / count(*), 1)
                                else 0 end
    ) into v_r
    from v_taller_presupuestos
    where empresa_id = p_empresa_id
      and estado <> 'reemplazado'
      and fecha_emision between p_desde and p_hasta;

    return coalesce(v_r, jsonb_build_object('ok', true));

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Permisos ────────────────────────────────────────────────────
do $$
declare f text;
begin
    foreach f in array array[
        'fn_nueva_version_presupuesto(uuid, uuid, text)',
        'fn_convertir_presupuesto_ot(uuid, uuid, text)',
        'fn_responder_presupuesto(uuid, uuid, text, text, text, text)',
        'fn_reporte_presupuestos(uuid, date, date)'
    ] loop
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to anon, authenticated', f);
    end loop;
end $$;


-- ════════════════════════════════════════════════════════════════
-- OPCIONAL — Migrar las OT que quedaron en estado 'presupuesto'
-- ════════════════════════════════════════════════════════════════
-- Esas órdenes YA descontaron stock, así que no se pueden convertir
-- en presupuestos sin devolverlo. Revísalas una por una:
--
--   select numero, fecha_ingreso, motivo_ingreso, total
--     from taller_ordenes
--    where empresa_id = '<id>' and estado = 'presupuesto';
--
-- Para las que no se van a ejecutar: anúlalas desde el módulo Órdenes
-- quitando sus ítems primero (así el stock se devuelve por RPC).


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select numero, version, estado, total, margen_pct, dias_para_vencer, vencido
--   from v_taller_presupuestos where empresa_id = '<id>' order by numero desc;
-- select fn_reporte_presupuestos('<id>', date '2026-08-01', date '2026-08-31');
