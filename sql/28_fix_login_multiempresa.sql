-- ================================================================
-- 28_fix_login_multiempresa.sql — ARM TALLER
-- Arregla el login cuando un RUT tiene cuenta en varias empresas.
--
-- ── El bug ────────────────────────────────────────────────────
-- ARM Universal es multiempresa: un mismo RUT puede ser usuario de
-- 'arm-sur', 'fibernet-rm', 'comercial-pool'… a la vez. El login del
-- taller hacía:
--     select * from usuarios where rut = p_rut and activo limit 1;
-- Sin ORDER BY, Postgres devuelve una fila cualquiera. Si le toca una
-- empresa telecom que no es arm-sur → "Este acceso es solo para
-- talleres", aunque el usuario SÍ tenga cuenta de taller / superadmin.
--
-- ── El arreglo ────────────────────────────────────────────────
-- Elegir la cuenta que sirve para entrar al taller, en este orden:
--   1. una empresa tipo = 'taller'
--   2. si no hay, arm-sur con rol admin (superadmin)
--   3. desempatar por la más antigua
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================

create or replace function fn_login_taller(
    p_rut  text,
    p_pass text,
    p_dias integer default 1
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_usuario     usuarios%rowtype;
    v_empresa     empresas%rowtype;
    v_superadmin  boolean;
    v_token       uuid;
    v_generico    constant text := 'RUT o contraseña incorrectos.';
begin
    if p_rut is null or p_pass is null or length(p_pass) = 0 then
        return jsonb_build_object('ok', false, 'error', v_generico);
    end if;

    -- Un RUT puede tener cuenta en varias empresas. Para entrar al
    -- taller, elegir la cuenta correcta (taller > superadmin arm-sur).
    select u.* into v_usuario
      from usuarios u
      join empresas e on e.id = u.empresa_id
     where u.rut = p_rut and u.activo = true
     order by (e.tipo = 'taller') desc,
              (e.slug = 'arm-sur' and u.rol = 'admin') desc,
              e.activo desc,
              u.created_at asc
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', v_generico);
    end if;

    -- ── Contraseña ──────────────────────────────────────────────
    if v_usuario.pass_hash is not null then
        if v_usuario.pass_hash <> extensions.crypt(p_pass, v_usuario.pass_hash) then
            return jsonb_build_object('ok', false, 'error', v_generico);
        end if;
    elsif v_usuario.pass is not null and v_usuario.pass = p_pass then
        update usuarios
           set pass_hash = extensions.crypt(p_pass, extensions.gen_salt('bf', 10))
         where id = v_usuario.id;
    else
        return jsonb_build_object('ok', false, 'error', v_generico);
    end if;

    -- ── Taller habilitado ───────────────────────────────────────
    select * into v_empresa from empresas where id = v_usuario.empresa_id;

    if not found or not v_empresa.activo then
        return jsonb_build_object('ok', false,
            'error', 'El taller no está habilitado. Contacta al administrador.');
    end if;

    v_superadmin := (v_empresa.slug = 'arm-sur' and v_usuario.rol = 'admin');

    if v_empresa.tipo is distinct from 'taller' and not v_superadmin then
        return jsonb_build_object('ok', false,
            'error', 'Este acceso es solo para talleres. Para telecom usa ARM Universal.');
    end if;

    -- ── Sesión ──────────────────────────────────────────────────
    delete from taller_sesiones
     where usuario_id = v_usuario.id and expira_at < now() - interval '7 days';

    insert into taller_sesiones (usuario_id, empresa_id, rut, rol, expira_at)
    values (v_usuario.id, v_usuario.empresa_id, v_usuario.rut, v_usuario.rol,
            now() + (greatest(coalesce(p_dias, 1), 1) || ' days')::interval)
    returning token into v_token;

    update usuarios set ultimo_acceso = now() where id = v_usuario.id;

    return jsonb_build_object(
        'ok', true,
        'token', v_token,
        'usuario', jsonb_build_object(
            'id',          v_usuario.id,
            'empresa_id',  v_usuario.empresa_id,
            'empleado_id', v_usuario.empleado_id,
            'rut',         v_usuario.rut,
            'rol',         v_usuario.rol
        ),
        'empresa', jsonb_build_object(
            'id',              v_empresa.id,
            'nombre',          v_empresa.nombre,
            'slug',            v_empresa.slug,
            'logo_url',        v_empresa.logo_url,
            'tipo',            v_empresa.tipo,
            'modulos_activos', coalesce(v_empresa.modulos_activos, '{}'::jsonb),
            'activo',          v_empresa.activo
        )
    );
end;
$$;

revoke all on function fn_login_taller(text, text, integer) from public;
grant execute on function fn_login_taller(text, text, integer) to anon, authenticated;

-- ── Verificación ────────────────────────────────────────────────
-- select fn_login_taller('<tu rut>', '<mala pass>', 1);   -- debe decir "incorrectos"
-- select fn_login_taller('<tu rut>', '<tu pass>', 1);      -- debe traer token + empresa
