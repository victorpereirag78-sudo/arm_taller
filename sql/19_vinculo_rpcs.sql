-- ================================================================
-- 19_vinculo_rpcs.sql — ARM TALLER ↔ MI VEHÍCULO
-- FASE 1a punto 2: el handshake de vinculación.
--
-- ⚠ REQUIERE sql/18_integracion_fase1a.sql.
--
-- ── Por qué RPC y no Edge Function ─────────────────────────────
-- Los dos productos comparten la misma base Postgres. Una función
-- SECURITY DEFINER que se apoya en auth.uid() es el mismo patrón que
-- ya usan bien emprendedores_* y mascotas_* en esta instancia. La
-- Edge Function se reserva para lo que sí la necesita: las APIs de
-- lectura filtrada y el dispatcher de notificaciones (FASE 1b/1c).
--
-- ── Las cuatro operaciones ─────────────────────────────────────
--   invitar   — el TALLER genera el código (lado anon, como el resto de la app)
--   preview   — Mi Vehículo mira qué hay detrás del token, antes de aceptar
--   aceptar   — el PROPIETARIO (autenticado en Mi Vehículo) confirma
--   revocar   — cualquiera de los dos lados corta el vínculo
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- Helper — normaliza una patente igual que la columna generada del 18
-- ════════════════════════════════════════════════════════════════
create or replace function fn_norm_patente(p text)
returns text
language sql
immutable
as $$
    select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]+', '', 'g'))
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — invitar  (lado taller)
-- ════════════════════════════════════════════════════════════════
-- Reutiliza la invitación pendiente si sigue vigente; la refresca si
-- venció. No deja crear una segunda si el vehículo ya está vinculado.

create or replace function fn_taller_vinculo_invitar(
    p_empresa_id         uuid,
    p_taller_vehiculo_id uuid,
    p_usuario            text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_veh   taller_vehiculos%rowtype;
    v_vin   taller_vehiculo_vinculo%rowtype;
begin
    select * into v_veh
      from taller_vehiculos
     where id = p_taller_vehiculo_id and empresa_id = p_empresa_id;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Vehículo no encontrado en este taller.');
    end if;

    -- ¿Ya vinculado?
    select * into v_vin
      from taller_vehiculo_vinculo
     where taller_vehiculo_id = p_taller_vehiculo_id and estado = 'activo'
     limit 1;
    if found then
        return jsonb_build_object('ok', false,
            'error', 'Este vehículo ya está vinculado a un usuario de Mi Vehículo.');
    end if;

    -- ¿Invitación pendiente?
    select * into v_vin
      from taller_vehiculo_vinculo
     where taller_vehiculo_id = p_taller_vehiculo_id and estado = 'pendiente'
     limit 1;

    if found then
        if v_vin.invitacion_expira_at <= now() then
            update taller_vehiculo_vinculo
               set token_invitacion    = gen_random_uuid(),
                   invitacion_expira_at = now() + interval '7 days'
             where id = v_vin.id
            returning * into v_vin;
        end if;
    else
        insert into taller_vehiculo_vinculo (
            empresa_id, taller_vehiculo_id, taller_cliente_id, patente_norm, creado_por)
        values (
            p_empresa_id, p_taller_vehiculo_id, v_veh.cliente_id, v_veh.patente_norm, p_usuario)
        returning * into v_vin;
    end if;

    return jsonb_build_object(
        'ok', true,
        'vinculo_id',  v_vin.id,
        'token',       v_vin.token_invitacion,
        'expira_at',   v_vin.invitacion_expira_at,
        'patente',     v_veh.patente,
        'patente_norm', v_veh.patente_norm);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — preview  (lo mira Mi Vehículo antes de aceptar)
-- ════════════════════════════════════════════════════════════════
-- Solo datos para que el propietario reconozca de qué se trata.
-- Nada sensible del taller.

create or replace function fn_taller_vinculo_preview(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_vin taller_vehiculo_vinculo%rowtype;
    v_veh taller_vehiculos%rowtype;
    v_emp empresas%rowtype;
begin
    select * into v_vin from taller_vehiculo_vinculo where token_invitacion = p_token;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Invitación no encontrada.');
    end if;
    if v_vin.estado <> 'pendiente' then
        return jsonb_build_object('ok', false,
            'error', 'Esta invitación ya fue ' || v_vin.estado || '.');
    end if;
    if v_vin.invitacion_expira_at <= now() then
        return jsonb_build_object('ok', false, 'error', 'La invitación venció. Pídele al taller una nueva.');
    end if;

    select * into v_veh from taller_vehiculos where id = v_vin.taller_vehiculo_id;
    select * into v_emp from empresas where id = v_vin.empresa_id;

    return jsonb_build_object(
        'ok', true,
        'taller',       v_emp.nombre,
        'taller_logo',  v_emp.logo_url,
        'patente',      v_veh.patente,
        'patente_norm', v_veh.patente_norm,
        'marca',        v_veh.marca,
        'modelo',       v_veh.modelo,
        'anio',         v_veh.anio,
        'expira_at',    v_vin.invitacion_expira_at);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — aceptar  (el propietario, autenticado en Mi Vehículo)
-- ════════════════════════════════════════════════════════════════
-- Exige: sesión de Mi Vehículo + que el usuario pueda editar ESE
-- vehículo + que la patente calce. Sin las tres cosas, no vincula.

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
        return jsonb_build_object('ok', true, 'nota', 'Ya estaba vinculado.');
    end if;

    update taller_vehiculo_vinculo
       set estado             = 'activo',
           autodoc_vehicle_id = p_autodoc_vehicle_id,
           autorizado_por     = v_uid::text,
           canal_autorizacion = 'mi_vehiculo',
           fecha_vinculacion  = now()
     where id = v_vin.id;

    return jsonb_build_object('ok', true, 'vinculo_id', v_vin.id);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — rechazar  (el propietario dice "ese no es mi taller")
-- ════════════════════════════════════════════════════════════════

create or replace function fn_taller_vinculo_rechazar(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_vin taller_vehiculo_vinculo%rowtype;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Necesitas iniciar sesión en Mi Vehículo.');
    end if;

    select * into v_vin from taller_vehiculo_vinculo
     where token_invitacion = p_token and estado = 'pendiente' for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Invitación no encontrada o ya resuelta.');
    end if;

    update taller_vehiculo_vinculo set estado = 'rechazado' where id = v_vin.id;
    return jsonb_build_object('ok', true);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — revocar  (los dos lados pueden)
-- ════════════════════════════════════════════════════════════════
-- Taller: pasa su p_empresa_id (como el resto de la app hoy).
-- Mi Vehículo: autenticado, se valida por autodocumentos_can_edit_vehicle.

create or replace function fn_taller_vinculo_revocar(
    p_vinculo_id uuid,
    p_empresa_id uuid default null,
    p_motivo     text default null,
    p_por        text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_vin  taller_vehiculo_vinculo%rowtype;
    v_ok   boolean := false;
begin
    select * into v_vin from taller_vehiculo_vinculo where id = p_vinculo_id for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Vínculo no encontrado.');
    end if;
    if v_vin.estado <> 'activo' then
        return jsonb_build_object('ok', false, 'error', 'El vínculo no está activo.');
    end if;

    -- Autorización: taller por empresa_id, o propietario por permiso Mi Vehículo
    if p_empresa_id is not null and p_empresa_id = v_vin.empresa_id then
        v_ok := true;
    elsif auth.uid() is not null and v_vin.autodoc_vehicle_id is not null
          and autodocumentos_can_edit_vehicle(v_vin.autodoc_vehicle_id) then
        v_ok := true;
    end if;

    if not v_ok then
        return jsonb_build_object('ok', false, 'error', 'Sin permiso para revocar este vínculo.');
    end if;

    update taller_vehiculo_vinculo
       set estado          = 'revocado',
           revocado_por    = coalesce(p_por, auth.uid()::text),
           revocado_motivo = p_motivo
     where id = p_vinculo_id;

    return jsonb_build_object('ok', true);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Vista para el taller
-- ════════════════════════════════════════════════════════════════

create or replace view v_taller_vinculos as
select
    vi.*,
    ve.patente,
    ve.marca,
    ve.modelo,
    ve.anio,
    cl.nombre   as cliente_nombre,
    cl.telefono as cliente_telefono
from taller_vehiculo_vinculo vi
left join taller_vehiculos ve on ve.id = vi.taller_vehiculo_id
left join taller_clientes  cl on cl.id = vi.taller_cliente_id;


-- ════════════════════════════════════════════════════════════════
-- PASO 7 — Permisos
-- ════════════════════════════════════════════════════════════════

revoke all on function fn_taller_vinculo_invitar(uuid, uuid, text)   from public;
revoke all on function fn_taller_vinculo_preview(uuid)                from public;
revoke all on function fn_taller_vinculo_aceptar(uuid, uuid)         from public;
revoke all on function fn_taller_vinculo_rechazar(uuid)             from public;
revoke all on function fn_taller_vinculo_revocar(uuid, uuid, text, text) from public;

-- invitar / revocar: lado taller (anon, como el resto de la app hoy)
grant execute on function fn_taller_vinculo_invitar(uuid, uuid, text)   to anon, authenticated;
grant execute on function fn_taller_vinculo_revocar(uuid, uuid, text, text) to anon, authenticated;

-- preview: lo llama Mi Vehículo, puede ir sin sesión (solo lee por token)
grant execute on function fn_taller_vinculo_preview(uuid) to anon, authenticated;

-- aceptar / rechazar: SOLO con sesión de Mi Vehículo
grant execute on function fn_taller_vinculo_aceptar(uuid, uuid) to authenticated;
grant execute on function fn_taller_vinculo_rechazar(uuid)      to authenticated;

grant select on v_taller_vinculos to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- 1) Invitar (usa el id real de un vehículo y su empresa_id):
--   select fn_taller_vinculo_invitar(
--     (select empresa_id from taller_vehiculos where patente_norm='CYBX30' limit 1),
--     (select id from taller_vehiculos where patente_norm='CYBX30' limit 1),
--     'recepcion');
--
-- 2) Preview con el token que devolvió:
--   select fn_taller_vinculo_preview('<token>');
--
-- 3) Aceptar solo funciona desde Mi Vehículo (con JWT). Desde el SQL
--    editor auth.uid() es null y debe responder "Necesitas iniciar sesión".
--   select fn_taller_vinculo_aceptar('<token>', '<autodoc_vehicle_id>');
--
-- 4) Limpiar la prueba:
--   delete from taller_vehiculo_vinculo where creado_por = 'recepcion';
