-- ════════════════════════════════════════════════════════════════
-- 45 · «Mis talleres» entrega lo necesario para agendar hora
-- ════════════════════════════════════════════════════════════════
-- Mi Vehículo quiere un botón «Agendar hora» en cada taller vinculado.
-- Para pedir la hora necesita el empresa_id del taller (antes fn_mv_mis_talleres
-- no lo devolvía), y para armar el formulario, los servicios y el horario
-- que el taller publicó en su configuración.
--
-- Solo se agregan claves al JSON: las que ya existían no cambian, así que
-- las versiones anteriores de la app siguen funcionando.
-- El resto del flujo ya existía:
--   fn_mv_solicitar_hora (sql/25) → el taller la ve en su Agenda y la agenda
--   con fn_solicitud_a_cita (sql/27) → el cliente confirma o cancela desde la app
--   con fn_mv_cita_responder (sql/27).
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

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
            'empresa_id',   l.empresa_id,
            'taller',       l.taller_nombre,
            'logo_url',     e.logo_url,
            'direccion',    cfg.direccion,
            'comuna',       cfg.comuna,
            'ciudad',       cfg.ciudad,
            'telefono',     cfg.telefono,
            'whatsapp',     cfg.whatsapp,
            'email',        cfg.email,
            'sitio_web',    cfg.sitio_web,
            'horario',      cfg.horario,
            'servicios',    to_jsonb(coalesce(cfg.servicios, '{}'::text[])),
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

revoke all on function fn_mv_mis_talleres() from public;
grant execute on function fn_mv_mis_talleres() to authenticated;

-- VERIFICACIÓN (con sesión de un cliente de Mi Vehículo):
--   select fn_mv_mis_talleres();   -- cada taller trae empresa_id, servicios y horario
