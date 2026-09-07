-- ================================================================
-- 21_mivehiculo_lectura.sql — ARM TALLER → MI VEHÍCULO
-- FASE 1b: lo que Mi Vehículo puede LEER y RESPONDER.
--
-- ⚠ REQUIERE sql/18, sql/19, sql/20.
--
-- ── Regla de privacidad (no negociable) ───────────────────────
-- El cliente NUNCA ve: costo del repuesto, margen, costo de mano de
-- obra interno, código de artículo (SKU), quién del taller tocó qué.
-- Estas funciones devuelven SOLO lo que el cliente tiene derecho a ver
-- y filtran por vínculo ACTIVO + permiso sobre el vehículo Mi Vehículo.
--
-- Todas son SECURITY DEFINER y se apoyan en auth.uid(): las llama el
-- cliente autenticado de Mi Vehículo. anon no las puede ejecutar.
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 0 — 'mi_vehiculo' como vía de aprobación válida
-- ════════════════════════════════════════════════════════════════
alter table taller_presupuestos drop constraint if exists taller_presupuestos_aprobado_via_check;
alter table taller_presupuestos add constraint taller_presupuestos_aprobado_via_check
    check (aprobado_via in ('presencial', 'telefono', 'whatsapp', 'email', 'mi_vehiculo', 'otro'));


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Helper: los vínculos activos del usuario actual
-- ════════════════════════════════════════════════════════════════

create or replace function fn_mv_links()
returns table (
    autodoc_vehicle_id uuid,
    taller_vehiculo_id uuid,
    empresa_id         uuid,
    vinculo_id         uuid,
    taller_nombre      text
)
language sql
stable
security definer
set search_path = public
as $$
    select v.autodoc_vehicle_id, v.taller_vehiculo_id, v.empresa_id, v.id, e.nombre
      from taller_vehiculo_vinculo v
      join empresas e on e.id = v.empresa_id
     where v.estado = 'activo'
       and v.autodoc_vehicle_id is not null
       and autodocumentos_can_view_vehicle(v.autodoc_vehicle_id)
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — "Mis talleres"
-- ════════════════════════════════════════════════════════════════
-- Los talleres con los que el usuario tiene vehículos vinculados,
-- con datos de contacto y un par de contadores.

create or replace function fn_mv_mis_talleres()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r jsonb;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;

    select coalesce(jsonb_agg(t order by t->>'taller'), '[]'::jsonb) into v_r
    from (
        select jsonb_build_object(
            'vinculo_id',   l.vinculo_id,
            'taller',       l.taller_nombre,
            'logo_url',     e.logo_url,
            'direccion',    cfg.direccion,
            'comuna',       cfg.comuna,
            'ciudad',       cfg.ciudad,
            'telefono',     cfg.telefono,
            'email',        cfg.email,
            'sitio_web',    cfg.sitio_web,
            'vehiculo', jsonb_build_object(
                'autodoc_vehicle_id', l.autodoc_vehicle_id,
                'patente', ve.patente, 'marca', ve.marca, 'modelo', ve.modelo),
            'ot_abiertas', (select count(*) from taller_ordenes o
                             where o.vehiculo_id = l.taller_vehiculo_id
                               and o.estado not in ('entregada', 'anulada')),
            'presupuestos_pendientes', (select count(*) from taller_presupuestos p
                             where p.vehiculo_id = l.taller_vehiculo_id
                               and p.estado = 'enviado')
        ) as t
        from fn_mv_links() l
        join empresas e         on e.id = l.empresa_id
        left join taller_config cfg on cfg.empresa_id = l.empresa_id
        left join taller_vehiculos ve on ve.id = l.taller_vehiculo_id
    ) s;

    return jsonb_build_object('ok', true, 'talleres', v_r);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Estado y línea de tiempo de las OT de un vehículo
-- ════════════════════════════════════════════════════════════════

create or replace function fn_mv_vehiculo_ot(p_autodoc_vehicle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r jsonb;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;
    if not exists (select 1 from fn_mv_links() where autodoc_vehicle_id = p_autodoc_vehicle_id) then
        return jsonb_build_object('ok', false, 'error', 'Vehículo no vinculado a ningún taller.');
    end if;

    select coalesce(jsonb_agg(ot order by (ot->>'fecha_ingreso') desc), '[]'::jsonb) into v_r
    from (
        select jsonb_build_object(
            'orden_numero',   o.numero,
            'taller',         l.taller_nombre,
            'estado',         o.estado,
            'estado_etiqueta', est.etiqueta,
            'estado_posicion', est.posicion,
            'es_final',       est.es_final,
            'motivo',         o.motivo_ingreso,
            'fecha_ingreso',  o.fecha_ingreso,
            'fecha_entrega',  o.fecha_entrega,
            'timeline', (
                select coalesce(jsonb_agg(jsonb_build_object(
                            'estado',   h.estado_nuevo,
                            'etiqueta', h.estado_etiqueta,
                            'ts',       h.ts) order by h.ts), '[]'::jsonb)
                  from v_taller_ot_timeline h
                 where h.orden_id = o.id)
        ) as ot
        from fn_mv_links() l
        join taller_ordenes o on o.vehiculo_id = l.taller_vehiculo_id
        left join taller_ot_estados est on est.codigo = o.estado
        where l.autodoc_vehicle_id = p_autodoc_vehicle_id
    ) s;

    return jsonb_build_object('ok', true, 'ordenes', v_r);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Presupuestos que el cliente puede ver / responder
-- ════════════════════════════════════════════════════════════════
-- Sin costo_unitario, sin SKU. Precios CON IVA (lo que paga el cliente).

create or replace function fn_mv_vehiculo_presupuestos(p_autodoc_vehicle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r jsonb;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;
    if not exists (select 1 from fn_mv_links() where autodoc_vehicle_id = p_autodoc_vehicle_id) then
        return jsonb_build_object('ok', false, 'error', 'Vehículo no vinculado a ningún taller.');
    end if;

    select coalesce(jsonb_agg(pr order by (pr->>'fecha_emision') desc), '[]'::jsonb) into v_r
    from (
        select jsonb_build_object(
            'presupuesto_id', p.id,
            'numero',         p.numero,
            'taller',         l.taller_nombre,
            'estado',         p.estado,
            'puede_responder', (p.estado = 'enviado'),
            'fecha_emision',  p.fecha_emision,
            'fecha_vencimiento', p.fecha_vencimiento,
            'motivo',         p.motivo,
            'diagnostico',    p.diagnostico,
            'condiciones',    p.condiciones,
            'neto',           p.neto,
            'iva',            p.iva,
            'total',          p.total,
            'items', (
                select coalesce(jsonb_agg(jsonb_build_object(
                            'descripcion',     i.descripcion,
                            'cantidad',        i.cantidad,
                            'precio_unitario', i.precio_unitario,
                            'subtotal',        i.subtotal,
                            'opcional',        i.opcional) order by i.orden, i.created_at), '[]'::jsonb)
                  from taller_presupuestos_items i
                 where i.presupuesto_id = p.id)
        ) as pr
        from fn_mv_links() l
        join taller_presupuestos p on p.vehiculo_id = l.taller_vehiculo_id
        where l.autodoc_vehicle_id = p_autodoc_vehicle_id
          and p.estado in ('enviado', 'aprobado', 'rechazado', 'convertido')
    ) s;

    return jsonb_build_object('ok', true, 'presupuestos', v_r);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — El cliente aprueba o rechaza
-- ════════════════════════════════════════════════════════════════

create or replace function fn_mv_presupuesto_responder(
    p_presupuesto_id uuid,
    p_respuesta      text,               -- 'aprobado' | 'rechazado'
    p_motivo         text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_p     taller_presupuestos%rowtype;
    v_uid   uuid := auth.uid();
    v_nom   text;
    v_res   jsonb;
begin
    if v_uid is null then
        return jsonb_build_object('ok', false, 'error', 'Necesitas iniciar sesión en Mi Vehículo.');
    end if;
    if p_respuesta not in ('aprobado', 'rechazado') then
        return jsonb_build_object('ok', false, 'error', 'Respuesta no válida.');
    end if;

    select * into v_p from taller_presupuestos where id = p_presupuesto_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Presupuesto no encontrado.');
    end if;

    -- El presupuesto tiene que ser de un vehículo vinculado a este usuario
    if not exists (
        select 1 from fn_mv_links() l where l.taller_vehiculo_id = v_p.vehiculo_id) then
        return jsonb_build_object('ok', false, 'error', 'No tienes permiso sobre este presupuesto.');
    end if;
    if v_p.estado <> 'enviado' then
        return jsonb_build_object('ok', false,
            'error', 'Este presupuesto ya no está pendiente de respuesta.');
    end if;

    select full_name into v_nom from autodocumentos_profiles where id = v_uid;

    v_res := fn_responder_presupuesto(
        v_p.empresa_id, p_presupuesto_id, p_respuesta,
        'mi_vehiculo', coalesce(nullif(trim(v_nom), ''), 'Cliente Mi Vehículo'), p_motivo);

    return v_res;

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Permisos (SOLO usuarios autenticados de Mi Vehículo)
-- ════════════════════════════════════════════════════════════════

revoke all on function fn_mv_links()                              from public;
revoke all on function fn_mv_mis_talleres()                       from public;
revoke all on function fn_mv_vehiculo_ot(uuid)                    from public;
revoke all on function fn_mv_vehiculo_presupuestos(uuid)          from public;
revoke all on function fn_mv_presupuesto_responder(uuid, text, text) from public;

grant execute on function fn_mv_mis_talleres()                    to authenticated;
grant execute on function fn_mv_vehiculo_ot(uuid)                 to authenticated;
grant execute on function fn_mv_vehiculo_presupuestos(uuid)       to authenticated;
grant execute on function fn_mv_presupuesto_responder(uuid, text, text) to authenticated;
-- fn_mv_links() es helper interno: no se expone


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- Desde el SQL editor auth.uid() es null → todas deben responder
-- "Sin sesión". La prueba real es desde Mi Vehículo con JWT:
--
--   select fn_mv_mis_talleres();
--   select fn_mv_vehiculo_ot('<autodoc_vehicle_id>');
--   select fn_mv_vehiculo_presupuestos('<autodoc_vehicle_id>');
--
-- Verificar que NINGÚN JSON de salida contiene costo_unitario, costo,
-- margen ni articulo_codigo.
