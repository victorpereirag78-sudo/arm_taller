-- ════════════════════════════════════════════════════════════════
-- 33 · Fix — verificación de admin con RUT multiempresa
-- ════════════════════════════════════════════════════════════════
-- Mismo bug que sql/28 (fn_login_taller), ahora en las funciones que
-- piden "tu contraseña de administrador" para crear usuarios o resetear
-- contraseñas.
--
-- Un RUT de ARM Universal tiene cuenta en varias empresas (arm-sur,
-- comercial-pool, fibernet-rm, teleserv-universal…). Las funciones hacían
--     select * from usuarios where rut = p_rut and activo limit 1;
-- sin ORDER BY → Postgres devuelve una fila cualquiera. Si cae una que
-- no es 'admin', o una cuenta distinta con otro hash de contraseña, la
-- verificación falla aunque la clave sea correcta.
--
-- Arreglo: elegir la cuenta 'admin' correcta de forma determinista —
-- primero la del taller en cuestión, si no la de arm-sur (superadmin).
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════


-- ── fn_admin_de_taller (sql/11): resetear / editar / crear usuarios ──
create or replace function fn_admin_de_taller(
    p_rut text, p_pass text, p_empresa_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    v_u  usuarios%rowtype;
    v_e  empresas%rowtype;
    v_ok boolean;
begin
    -- La cuenta admin correcta para este RUT: la del taller objetivo,
    -- o si no, la de arm-sur (superadmin). Nunca una que no sea admin.
    select u.* into v_u
      from usuarios u
      join empresas e on e.id = u.empresa_id
     where u.rut = p_rut
       and u.activo = true
       and u.rol = 'admin'
     order by (u.empresa_id = p_empresa_id) desc,
              (e.slug = 'arm-sur')          desc,
              u.created_at asc
     limit 1;

    if not found then return false; end if;

    -- Verificar la contraseña contra esa cuenta
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


-- ── fn_es_superadmin (sql/10): crear talleres / usuarios desde el superadmin ──
create or replace function fn_es_superadmin(p_rut text, p_pass text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_u usuarios%rowtype;
begin
    select u.* into v_u
      from usuarios u
      join empresas e on e.id = u.empresa_id
     where u.rut = p_rut
       and u.activo = true
       and u.rol = 'admin'
       and e.slug = 'arm-sur'
     order by u.created_at asc
     limit 1;

    if not found then return false; end if;

    if v_u.pass_hash is not null then
        return v_u.pass_hash = extensions.crypt(p_pass, v_u.pass_hash);
    end if;
    return v_u.pass is not null and v_u.pass = p_pass;
end;
$$;


-- ── Verificación ────────────────────────────────────────────────
-- Reemplazá <TU_CLAVE> y el uuid de un taller para probar:
--   select fn_admin_de_taller('13489001-0', '<TU_CLAVE>',
--          (select id from empresas where tipo = 'taller' limit 1));  -- debe dar true
