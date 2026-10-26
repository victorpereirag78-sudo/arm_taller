-- ════════════════════════════════════════════════════════════════
-- 46 · Pedir hora al taller con el que ya estás vinculado
-- ════════════════════════════════════════════════════════════════
-- fn_mv_solicitar_hora (sql/25) solo aceptaba empresas con tipo = 'taller'
-- y respondía «Taller no encontrado.» a las demás. Pero un taller puede
-- usar ARM Taller dentro de una empresa de otro tipo (p. ej. «ARM Sur SpA»,
-- tipo 'telecom'): el vínculo con Mi Vehículo funciona, el seguimiento y los
-- presupuestos también, y solo fallaba el botón «Agendar hora».
--
-- Ahora la solicitud se acepta si la empresa está activa y, además,
--   · es del directorio (tipo = 'taller'), o
--   · el usuario tiene un vínculo ACTIVO con ella (fn_mv_links).
-- Lo demás queda igual.
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

create or replace function fn_mv_solicitar_hora(
    p_empresa_id uuid,
    p_datos      jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid uuid := auth.uid();
    v_id  uuid;
    v_nom text;
begin
    if v_uid is null then
        return jsonb_build_object('ok', false, 'error', 'Necesitas iniciar sesión.');
    end if;
    if not exists (select 1 from empresas
                    where id = p_empresa_id and activo
                      and (tipo = 'taller'
                           or exists (select 1 from fn_mv_links() l
                                       where l.empresa_id = p_empresa_id))) then
        return jsonb_build_object('ok', false, 'error', 'Taller no encontrado.');
    end if;

    select full_name into v_nom from autodocumentos_profiles where id = v_uid;

    insert into taller_solicitudes_hora (
        empresa_id, autodoc_vehicle_id, solicitante_uid, nombre, telefono,
        patente, vehiculo_desc, servicio, motivo, fecha_preferida, franja)
    values (
        p_empresa_id,
        nullif(p_datos->>'autodoc_vehicle_id', '')::uuid,
        v_uid,
        coalesce(p_datos->>'nombre', v_nom),
        p_datos->>'telefono',
        upper(regexp_replace(coalesce(p_datos->>'patente', ''), '[^A-Za-z0-9]+', '', 'g')),
        p_datos->>'vehiculo_desc',
        p_datos->>'servicio',
        p_datos->>'motivo',
        nullif(p_datos->>'fecha_preferida', '')::date,
        nullif(p_datos->>'franja', ''))
    returning id into v_id;

    return jsonb_build_object('ok', true, 'solicitud_id', v_id);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

revoke all on function fn_mv_solicitar_hora(uuid, jsonb) from public;
grant execute on function fn_mv_solicitar_hora(uuid, jsonb) to authenticated;
