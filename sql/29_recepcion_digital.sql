-- ================================================================
-- 29_recepcion_digital.sql — ARM TALLER
-- FASE 2 punto 14: recepción digital con daños visibles.
--
-- Al recibir el vehículo, el taller deja constancia de en qué estado
-- entró: kilometraje y combustible (ya se guardaban), más los daños
-- visibles y una observación. Sin fotos como requisito.
--
-- Los daños viajan con la OT: son 1:1 con la recepción.
--   danos_recepcion = [{ "tipo": "rayon", "zona": "puerta_delantera_izq", "nota": "..." }, ...]
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================

alter table taller_ordenes
    add column if not exists danos_recepcion         jsonb not null default '[]',
    add column if not exists recepcion_observaciones text;

comment on column taller_ordenes.danos_recepcion is
    'Daños visibles al recepcionar. [{tipo, zona, nota}]. tipo ∈ rayon|abolladura|golpe|vidrio|espejo|neumatico|parachoques|luces|otro';


-- El historial mecánico de Mi Vehículo puede mostrar el estado de
-- ingreso: se agrega danos_recepcion a la lectura de la OT.
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
            'danos_recepcion', coalesce(o.danos_recepcion, '[]'::jsonb),
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

grant execute on function fn_mv_vehiculo_ot(uuid) to authenticated;


-- ── Verificación ────────────────────────────────────────────────
-- select numero, danos_recepcion from taller_ordenes where danos_recepcion <> '[]';
