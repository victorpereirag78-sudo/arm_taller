-- ════════════════════════════════════════════════════════════════
-- 32 · Referido: al vincular, marcar de qué taller vino el cliente
-- ════════════════════════════════════════════════════════════════
-- Cuando el dueño de un auto acepta la invitación de un taller desde
-- Mi Vehículo, ese taller queda como "referente". Si el cliente después
-- paga su primer mes, Mi Vehículo (autodocumentos_admin_activar) le
-- genera al taller un bono único de $995.
--
-- Se hace acá (no en el front) para que valga también si el vínculo se
-- acepta por otro canal, y para que sea atómico con la vinculación.
--
-- Requiere que la migración 0008 de ARM-DocsCars ya esté aplicada
-- (autodocumentos_fn_set_referido). Si no existe, el vínculo igual
-- funciona: la llamada está protegida y falla en silencio.
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

-- Envoltorio protegido: si Mi Vehículo aún no tiene la función de
-- referido (migración 0008), no rompe la vinculación.
create or replace function fn_taller_marcar_referido(p_empresa_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    perform autodocumentos_fn_set_referido(p_empresa_id);
exception when others then
    raise warning 'fn_taller_marcar_referido: %', sqlerrm;
end;
$$;

grant execute on function fn_taller_marcar_referido(uuid) to anon, authenticated;


create or replace function fn_taller_vinculo_aceptar(
    p_token             uuid,
    p_autodoc_vehicle_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_vin    taller_vehiculo_vinculo%rowtype;
    v_uid    uuid := auth.uid();
    v_plate  text;
begin
    if v_uid is null then
        return jsonb_build_object('ok', false, 'error', 'Necesitas iniciar sesión en Mi Vehículo.');
    end if;

    if not autodocumentos_can_edit_vehicle(p_autodoc_vehicle_id) then
        return jsonb_build_object('ok', false,
            'error', 'No tienes permiso para vincular este vehículo.');
    end if;

    select * into v_vin
      from taller_vehiculo_vinculo
     where token_invitacion = p_token
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Invitación no encontrada.');
    end if;
    if v_vin.estado <> 'pendiente' then
        return jsonb_build_object('ok', false,
            'error', 'Esta invitación ya fue ' || v_vin.estado || '.');
    end if;
    if v_vin.invitacion_expira_at <= now() then
        return jsonb_build_object('ok', false, 'error', 'La invitación venció.');
    end if;

    -- La patente del vehículo Mi Vehículo tiene que ser la misma
    select fn_norm_patente(plate) into v_plate
      from autodocumentos_vehicles where id = p_autodoc_vehicle_id;

    if v_plate is null then
        return jsonb_build_object('ok', false, 'error', 'Vehículo de Mi Vehículo no encontrado.');
    end if;
    if v_plate <> v_vin.patente_norm then
        return jsonb_build_object('ok', false,
            'error', format('La patente no coincide: el taller registró %s y tú elegiste %s.',
                            v_vin.patente_norm, v_plate));
    end if;

    -- ¿Ya hay un vínculo activo para este mismo par?
    if exists (
        select 1 from taller_vehiculo_vinculo
         where taller_vehiculo_id = v_vin.taller_vehiculo_id
           and autodoc_vehicle_id = p_autodoc_vehicle_id
           and estado = 'activo') then
        update taller_vehiculo_vinculo set estado = 'rechazado' where id = v_vin.id;
        perform fn_taller_marcar_referido(v_vin.empresa_id);
        return jsonb_build_object('ok', true, 'nota', 'Ya estaba vinculado.');
    end if;

    update taller_vehiculo_vinculo
       set estado             = 'activo',
           autodoc_vehicle_id = p_autodoc_vehicle_id,
           autorizado_por     = v_uid::text,
           canal_autorizacion = 'mi_vehiculo',
           fecha_vinculacion  = now()
     where id = v_vin.id;

    perform fn_taller_marcar_referido(v_vin.empresa_id);

    return jsonb_build_object('ok', true, 'vinculo_id', v_vin.id);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;
