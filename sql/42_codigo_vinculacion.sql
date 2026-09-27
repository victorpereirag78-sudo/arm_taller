-- ════════════════════════════════════════════════════════════════
-- 42 · Código corto de vinculación (para escribirlo a mano)
-- ════════════════════════════════════════════════════════════════
-- ARM Taller le decía al taller "el cliente ingresa el código de abajo",
-- pero el código era el token UUID (36 caracteres: imposible de dictar)
-- y Mi Vehículo no tenía dónde escribirlo: solo servía escanear el QR o
-- abrir el enlace.
--
-- Ahora cada invitación pendiente tiene además un código de 8
-- caracteres (letras y números sin 0/O ni 1/I; ~10^12 combinaciones),
-- que se muestra como "K7PQ-4XZ9". Mi Vehículo lo canjea con
-- fn_taller_vinculo_por_codigo → token, y sigue el flujo de siempre
-- (/vincular/:token: vista previa, elegir el vehículo por patente, aceptar).
-- El código se renueva junto con el token cuando la invitación vence.
--
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

alter table public.taller_vehiculo_vinculo add column if not exists codigo text;

create unique index if not exists taller_vinculo_codigo_pendiente
    on public.taller_vehiculo_vinculo (codigo) where estado = 'pendiente';

create or replace function public.fn_taller_codigo_vinculo()
returns text
language plpgsql
volatile
set search_path to ''
as $$
declare
    alfabeto constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 símbolos
    c text;
begin
    loop
        c := '';
        for i in 1..8 loop
            c := c || substr(alfabeto, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32), 1);
        end loop;
        exit when not exists (
            select 1 from public.taller_vehiculo_vinculo where codigo = c and estado = 'pendiente');
    end loop;
    return c;
end;
$$;

-- Código nuevo al crear la invitación y cada vez que se renueva el token.
create or replace function public.fn_trg_vinculo_codigo()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
    if tg_op = 'INSERT' then
        if new.codigo is null then
            new.codigo := public.fn_taller_codigo_vinculo();
        end if;
    elsif new.token_invitacion is distinct from old.token_invitacion then
        new.codigo := public.fn_taller_codigo_vinculo();
    end if;
    return new;
end;
$$;

drop trigger if exists trg_vinculo_codigo on public.taller_vehiculo_vinculo;
create trigger trg_vinculo_codigo
    before insert or update of token_invitacion on public.taller_vehiculo_vinculo
    for each row execute function public.fn_trg_vinculo_codigo();

update public.taller_vehiculo_vinculo
   set codigo = public.fn_taller_codigo_vinculo()
 where estado = 'pendiente' and codigo is null;

-- La invitación devuelve también el código.
create or replace function public.fn_taller_vinculo_invitar(
    p_empresa_id uuid, p_taller_vehiculo_id uuid, p_usuario text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_veh   taller_vehiculos%rowtype;
    v_vin   taller_vehiculo_vinculo%rowtype;
begin
    perform public.taller_exigir_empresa(p_empresa_id);
    select * into v_veh
      from taller_vehiculos
     where id = p_taller_vehiculo_id and empresa_id = p_empresa_id;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Vehículo no encontrado en este taller.');
    end if;

    select * into v_vin
      from taller_vehiculo_vinculo
     where taller_vehiculo_id = p_taller_vehiculo_id and estado = 'activo'
     limit 1;
    if found then
        return jsonb_build_object('ok', false,
            'error', 'Este vehículo ya está vinculado a un usuario de Mi Vehículo.');
    end if;

    select * into v_vin
      from taller_vehiculo_vinculo
     where taller_vehiculo_id = p_taller_vehiculo_id and estado = 'pendiente'
     limit 1;

    if found then
        if v_vin.invitacion_expira_at <= now() or v_vin.codigo is null then
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
        'vinculo_id',   v_vin.id,
        'token',        v_vin.token_invitacion,
        'codigo',       v_vin.codigo,
        'expira_at',    v_vin.invitacion_expira_at,
        'patente',      v_veh.patente,
        'patente_norm', v_veh.patente_norm);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

-- Mi Vehículo: código escrito a mano → token de la invitación.
create or replace function public.fn_taller_vinculo_por_codigo(p_codigo text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
    v_c   text := upper(regexp_replace(coalesce(p_codigo, ''), '[^A-Za-z0-9]', '', 'g'));
    v_vin taller_vehiculo_vinculo%rowtype;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Inicia sesión en Mi Vehículo.');
    end if;
    if length(v_c) <> 8 then
        return jsonb_build_object('ok', false, 'error', 'El código tiene 8 letras y números (ej: K7PQ-4XZ9).');
    end if;
    select * into v_vin from taller_vehiculo_vinculo where codigo = v_c and estado = 'pendiente';
    if not found then
        return jsonb_build_object('ok', false,
            'error', 'Ese código no existe o ya se usó. Revísalo o pídele al taller uno nuevo.');
    end if;
    if v_vin.invitacion_expira_at <= now() then
        return jsonb_build_object('ok', false, 'error', 'El código venció. Pídele al taller uno nuevo.');
    end if;
    return jsonb_build_object('ok', true, 'token', v_vin.token_invitacion);
end;
$function$;

revoke all on function public.fn_taller_vinculo_por_codigo(text) from public, anon;
grant execute on function public.fn_taller_vinculo_por_codigo(text) to authenticated;
revoke all on function public.fn_taller_codigo_vinculo() from public, anon, authenticated;

-- La vista del taller muestra el código.
create or replace view public.v_taller_vinculos
with (security_invoker = true) as
select vi.id,
       vi.empresa_id,
       vi.taller_vehiculo_id,
       vi.taller_cliente_id,
       vi.autodoc_vehicle_id,
       vi.patente_norm,
       vi.estado,
       vi.token_invitacion,
       vi.invitacion_expira_at,
       vi.autorizado_por,
       vi.canal_autorizacion,
       vi.fecha_vinculacion,
       vi.revocado_por,
       vi.revocado_motivo,
       vi.creado_por,
       vi.created_at,
       vi.updated_at,
       ve.patente,
       ve.marca,
       ve.modelo,
       ve.anio,
       cl.nombre   as cliente_nombre,
       cl.telefono as cliente_telefono,
       vi.codigo
  from public.taller_vehiculo_vinculo vi
  left join public.taller_vehiculos ve on ve.id = vi.taller_vehiculo_id
  left join public.taller_clientes cl on cl.id = vi.taller_cliente_id;
