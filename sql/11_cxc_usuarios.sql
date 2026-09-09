-- ================================================================
-- 11_cxc_usuarios.sql — ARM TALLER
-- Cuentas por cobrar y gestión de usuarios del taller.
--
-- ⚠ REQUIERE sql/01 (pgcrypto) y sql/03 (caja y v_taller_ordenes_saldo).
--
-- ── Cuentas por cobrar ──────────────────────────────────────────
-- La deuda de los clientes viene de dos lados:
--   1. Órdenes entregadas con saldo pendiente (el taller entregó el
--      auto y quedó "te pago el viernes").
--   2. Documentos cargados a mano: convenios con flotas, fletes,
--      trabajos facturados aparte.
-- Los dos se ven en la misma lista, y todo cobro entra por la caja.
--
-- ── Usuarios ────────────────────────────────────────────────────
-- El admin del taller gestiona sus propios usuarios sin depender del
-- superadmin. Como crear o resetear contraseñas es sensible, cada
-- operación exige la contraseña del admin y la verifica en la base.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Documentos por cobrar cargados a mano
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_cuentas_cobrar (
    id                uuid primary key default gen_random_uuid(),
    empresa_id        uuid not null,
    cliente_id        uuid,

    tipo_documento    text default 'factura',
    numero_documento  text,
    descripcion       text,

    fecha_emision     date not null default current_date,
    fecha_vencimiento date,

    total             numeric(12,2) not null default 0,
    estado            text not null default 'pendiente'
                      check (estado in ('pendiente', 'cobrada', 'anulada', 'incobrable')),

    observacion       text,
    usuario_rut       text,
    created_at        timestamptz not null default now()
);

create index if not exists idx_cxc_empresa
    on taller_cuentas_cobrar (empresa_id, estado, fecha_vencimiento);

-- Los cobros son movimientos de caja: se enlazan por aquí
alter table taller_movimientos_caja
    add column if not exists cxc_id uuid;

create index if not exists idx_movcaja_cxc
    on taller_movimientos_caja (cxc_id) where cxc_id is not null;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — La deuda de los clientes, de los dos orígenes
-- ════════════════════════════════════════════════════════════════

create or replace view v_taller_cxc as
select
    x.*,
    case
        when x.fecha_vencimiento is null then 'sin_fecha'
        when x.fecha_vencimiento >= current_date then 'por_vencer'
        when current_date - x.fecha_vencimiento <= 30 then 'vencida_30'
        when current_date - x.fecha_vencimiento <= 60 then 'vencida_60'
        else 'vencida_mas_60'
    end as antiguedad,
    greatest(current_date - x.fecha_vencimiento, 0) as dias_vencida
from (
    -- ── 1. Órdenes entregadas con saldo ─────────────────────────
    select
        o.empresa_id,
        'orden'::text                       as origen,
        o.id                                as documento_id,
        o.id                                as orden_id,
        null::uuid                          as cxc_id,
        'OT ' || o.numero                   as documento,
        coalesce(o.motivo_ingreso, 'Orden de trabajo') as descripcion,
        o.cliente_id,
        c.nombre                            as cliente,
        c.telefono,
        o.fecha_entrega::date               as fecha_emision,
        o.fecha_entrega::date               as fecha_vencimiento,
        s.total,
        s.pagado,
        s.saldo
    from taller_ordenes o
    join v_taller_ordenes_saldo s on s.orden_id = o.id
    left join taller_clientes c on c.id = o.cliente_id
    where o.estado = 'entregada' and s.saldo > 0

    union all

    -- ── 2. Documentos cargados a mano ───────────────────────────
    select
        d.empresa_id,
        'documento'::text,
        d.id,
        null::uuid,
        d.id,
        coalesce(d.numero_documento, d.tipo_documento),
        coalesce(d.descripcion, d.tipo_documento),
        d.cliente_id,
        c.nombre,
        c.telefono,
        d.fecha_emision,
        d.fecha_vencimiento,
        coalesce(d.total, 0),
        coalesce(p.cobrado, 0),
        coalesce(d.total, 0) - coalesce(p.cobrado, 0)
    from taller_cuentas_cobrar d
    left join taller_clientes c on c.id = d.cliente_id
    left join lateral (
        select sum(case when m.tipo = 'ingreso' then m.monto else -m.monto end) as cobrado
          from taller_movimientos_caja m
         where m.cxc_id = d.id and m.motivo = 'cliente'
    ) p on true
    where d.estado not in ('anulada')
) x;


-- ── Resumen por cliente ─────────────────────────────────────────
create or replace view v_taller_clientes_saldo as
select
    empresa_id,
    cliente_id,
    max(cliente)                                              as cliente,
    max(telefono)                                             as telefono,
    count(*)                                                  as documentos,
    sum(saldo)                                                as saldo_total,
    sum(saldo) filter (where antiguedad like 'vencida%')      as saldo_vencido,
    min(fecha_vencimiento)                                    as mas_antiguo
from v_taller_cxc
where saldo > 0
group by empresa_id, cliente_id;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Cobrar un documento cargado a mano
-- ════════════════════════════════════════════════════════════════
-- Las órdenes se cobran con fn_registrar_pago_orden (script 03).

create or replace function fn_cobrar_cuenta(
    p_empresa_id uuid,
    p_cxc_id     uuid,
    p_monto      numeric,
    p_medio_pago text default 'efectivo',
    p_caja_id    uuid default null,
    p_referencia text default null,
    p_usuario    text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_d      taller_cuentas_cobrar%rowtype;
    v_cobrado numeric(12,2);
    v_saldo   numeric(12,2);
begin
    if coalesce(p_monto, 0) <= 0 then
        return jsonb_build_object('ok', false, 'error', 'El monto debe ser mayor que cero.');
    end if;

    select * into v_d
      from taller_cuentas_cobrar
     where id = p_cxc_id and empresa_id = p_empresa_id
     for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Documento no encontrado.');
    end if;
    if v_d.estado = 'anulada' then
        return jsonb_build_object('ok', false, 'error', 'El documento está anulado.');
    end if;

    select coalesce(sum(case when tipo = 'ingreso' then monto else -monto end), 0)
      into v_cobrado
      from taller_movimientos_caja
     where cxc_id = p_cxc_id and motivo = 'cliente';

    v_saldo := coalesce(v_d.total, 0) - v_cobrado;

    if p_monto > v_saldo + 0.5 then
        return jsonb_build_object('ok', false,
            'error', format('El cobro (%s) supera el saldo pendiente (%s).', p_monto, v_saldo));
    end if;

    insert into taller_movimientos_caja (
        empresa_id, caja_id, tipo, motivo, medio_pago, monto,
        cxc_id, cliente_id, referencia, descripcion, usuario_rut)
    values (
        p_empresa_id,
        coalesce(p_caja_id, (select id from taller_cajas
                              where empresa_id = p_empresa_id and estado = 'abierta' limit 1)),
        'ingreso', 'cliente', p_medio_pago, p_monto,
        p_cxc_id, v_d.cliente_id,
        coalesce(p_referencia, v_d.numero_documento),
        'Cobro a cliente · ' || coalesce(v_d.descripcion, v_d.numero_documento, ''),
        p_usuario);

    if v_saldo - p_monto <= 0.5 then
        update taller_cuentas_cobrar set estado = 'cobrada' where id = p_cxc_id;
    end if;

    return jsonb_build_object('ok', true,
        'cobrado', v_cobrado + p_monto,
        'saldo',   v_saldo - p_monto,
        'total',   coalesce(v_d.total, 0));

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Usuarios del taller
-- ════════════════════════════════════════════════════════════════

-- Nunca expone pass ni pass_hash
create or replace view v_taller_usuarios as
select
    u.id,
    u.empresa_id,
    u.rut,
    u.rol,
    u.activo,
    u.empleado_id,
    u.ultimo_acceso,
    (u.pass_hash is not null) as pass_segura,
    e.nombre                  as empleado_nombre,
    e.cargo                   as empleado_cargo
from usuarios u
left join taller_empleados e on e.id = u.empleado_id;


-- ¿Este RUT+contraseña es admin de este taller? (o el superadmin ARM)
create or replace function fn_admin_de_taller(
    p_rut text, p_pass text, p_empresa_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_u usuarios%rowtype;
    v_e empresas%rowtype;
    v_ok boolean;
begin
    -- RUT multiempresa (ARM Universal): elegir la cuenta 'admin' correcta
    -- de forma determinista — la del taller objetivo, o si no la de arm-sur.
    -- Ver sql/33. Sin ORDER BY antes se elegía una fila cualquiera.
    select u.* into v_u
      from usuarios u
      join empresas e on e.id = u.empresa_id
     where u.rut = p_rut and u.activo = true and u.rol = 'admin'
     order by (u.empresa_id = p_empresa_id) desc,
              (e.slug = 'arm-sur')          desc,
              u.created_at asc
     limit 1;
    if not found then return false; end if;

    -- Verificar la contraseña
    if v_u.pass_hash is not null then
        v_ok := (v_u.pass_hash = extensions.crypt(p_pass, v_u.pass_hash));
    else
        v_ok := (v_u.pass is not null and v_u.pass = p_pass);
    end if;
    if not v_ok then return false; end if;

    -- Admin del propio taller, o superadmin de arm-sur
    if v_u.empresa_id = p_empresa_id then return true; end if;

    select * into v_e from empresas where id = v_u.empresa_id;
    return found and v_e.slug = 'arm-sur';
end;
$$;


-- ── Crear un usuario ────────────────────────────────────────────
create or replace function fn_usuario_crear(
    p_admin_rut   text,
    p_admin_pass  text,
    p_empresa_id  uuid,
    p_rut         text,
    p_pass        text,
    p_rol         text,
    p_empleado_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if not fn_admin_de_taller(p_admin_rut, p_admin_pass, p_empresa_id) then
        return jsonb_build_object('ok', false,
            'error', 'Tu contraseña no coincide, o no eres administrador de este taller.');
    end if;
    if length(coalesce(p_pass, '')) < 6 then
        return jsonb_build_object('ok', false,
            'error', 'La contraseña debe tener al menos 6 caracteres.');
    end if;
    if coalesce(trim(p_rut), '') = '' then
        return jsonb_build_object('ok', false, 'error', 'El RUT es obligatorio.');
    end if;
    if exists (select 1 from usuarios where rut = p_rut) then
        return jsonb_build_object('ok', false,
            'error', format('Ya existe un usuario con el RUT %s.', p_rut));
    end if;

    insert into usuarios (empresa_id, rut, pass_hash, rol, activo, empleado_id)
    values (p_empresa_id, p_rut, extensions.crypt(p_pass, extensions.gen_salt('bf', 10)),
            coalesce(p_rol, 'lector'), true, p_empleado_id);

    return jsonb_build_object('ok', true);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Cambiar rol, estado o empleado asociado ─────────────────────
create or replace function fn_usuario_actualizar(
    p_admin_rut   text,
    p_admin_pass  text,
    p_usuario_id  uuid,
    p_rol         text default null,
    p_activo      boolean default null,
    p_empleado_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_u      usuarios%rowtype;
    v_admins integer;
begin
    select * into v_u from usuarios where id = p_usuario_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Usuario no encontrado.');
    end if;
    if not fn_admin_de_taller(p_admin_rut, p_admin_pass, v_u.empresa_id) then
        return jsonb_build_object('ok', false,
            'error', 'Tu contraseña no coincide, o no eres administrador de este taller.');
    end if;

    -- No dejar el taller sin ningún admin activo
    if (coalesce(p_activo, v_u.activo) = false or coalesce(p_rol, v_u.rol) <> 'admin')
       and v_u.rol = 'admin' and v_u.activo then
        select count(*) into v_admins
          from usuarios
         where empresa_id = v_u.empresa_id and rol = 'admin'
           and activo = true and id <> p_usuario_id;

        if v_admins = 0 then
            return jsonb_build_object('ok', false,
                'error', 'Es el único administrador activo del taller. Nombra otro antes de cambiarlo.');
        end if;
    end if;

    update usuarios
       set rol         = coalesce(p_rol, rol),
           activo      = coalesce(p_activo, activo),
           empleado_id = case when p_empleado_id is null then empleado_id else p_empleado_id end
     where id = p_usuario_id;

    return jsonb_build_object('ok', true);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Desvincular el empleado asociado ────────────────────────────
create or replace function fn_usuario_desvincular_empleado(
    p_admin_rut  text,
    p_admin_pass text,
    p_usuario_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_u usuarios%rowtype;
begin
    select * into v_u from usuarios where id = p_usuario_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Usuario no encontrado.');
    end if;
    if not fn_admin_de_taller(p_admin_rut, p_admin_pass, v_u.empresa_id) then
        return jsonb_build_object('ok', false, 'error', 'Credenciales incorrectas.');
    end if;

    update usuarios set empleado_id = null where id = p_usuario_id;
    return jsonb_build_object('ok', true);
end;
$$;


-- ── Resetear la contraseña de otro usuario ──────────────────────
create or replace function fn_usuario_resetear_pass(
    p_admin_rut  text,
    p_admin_pass text,
    p_usuario_id uuid,
    p_pass_nueva text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_u usuarios%rowtype;
begin
    select * into v_u from usuarios where id = p_usuario_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Usuario no encontrado.');
    end if;
    if not fn_admin_de_taller(p_admin_rut, p_admin_pass, v_u.empresa_id) then
        return jsonb_build_object('ok', false,
            'error', 'Tu contraseña no coincide, o no eres administrador de este taller.');
    end if;
    if length(coalesce(p_pass_nueva, '')) < 6 then
        return jsonb_build_object('ok', false,
            'error', 'La contraseña debe tener al menos 6 caracteres.');
    end if;

    update usuarios
       set pass_hash = extensions.crypt(p_pass_nueva, extensions.gen_salt('bf', 10)),
           pass      = null
     where id = p_usuario_id;

    return jsonb_build_object('ok', true);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ── Permisos ────────────────────────────────────────────────────
do $$
declare f text;
begin
    foreach f in array array[
        'fn_cobrar_cuenta(uuid, uuid, numeric, text, uuid, text, text)',
        'fn_usuario_crear(text, text, uuid, text, text, text, uuid)',
        'fn_usuario_actualizar(text, text, uuid, text, boolean, uuid)',
        'fn_usuario_desvincular_empleado(text, text, uuid)',
        'fn_usuario_resetear_pass(text, text, uuid, text)'
    ] loop
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to anon, authenticated', f);
    end loop;

    -- Interna: no se expone al cliente
    execute 'revoke all on function fn_admin_de_taller(text, text, uuid) from public, anon, authenticated';
end $$;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select * from v_taller_cxc where empresa_id = '<id>' and saldo > 0
--  order by fecha_vencimiento;
-- select * from v_taller_clientes_saldo where empresa_id = '<id>';
-- select rut, rol, activo, pass_segura from v_taller_usuarios where empresa_id = '<id>';
