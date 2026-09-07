-- ================================================================
-- 01_seguridad_login.sql — ARM TALLER
-- Saca la contraseña del navegador.
--
-- ANTES:  el front hacía  .from('usuarios').eq('rut', x).eq('pass', y)
--         → la contraseña viajaba en la URL, en texto plano, y la tabla
--           'usuarios' quedaba consultable con la clave publishable.
--
-- DESPUÉS: el front llama  rpc('fn_login_taller', { p_rut, p_pass })
--         → la comparación ocurre dentro de Postgres, contra un hash
--           bcrypt, y la función nunca devuelve el hash.
--
-- ⚠ IMPORTANTE: esta instancia Supabase la comparten ARM Universal y
--   ARM Taller. Los PASOS 1 y 2 son aditivos y NO rompen a Universal.
--   El PASO 3 (cerrar la tabla) sí lo afecta: está comentado a propósito.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Hash de contraseñas (aditivo, no rompe nada)
-- ════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

alter table usuarios
    add column if not exists pass_hash text;

-- Hashea las contraseñas que hoy están en texto plano.
-- Se puede correr varias veces: solo toca las que faltan.
update usuarios
   set pass_hash = extensions.crypt(pass, extensions.gen_salt('bf', 10))
 where pass_hash is null
   and pass is not null
   and pass <> '';

-- Cuántas quedaron pendientes (debería dar 0)
-- select count(*) from usuarios where pass_hash is null and activo = true;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — RPC de login (SECURITY DEFINER)
-- ════════════════════════════════════════════════════════════════
-- Devuelve { ok, error } o { ok, usuario, empresa }.
-- Nunca devuelve pass ni pass_hash.
-- Mensaje de error genérico a propósito: no revela si el RUT existe.

create or replace function fn_login_taller(p_rut text, p_pass text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions   -- pgcrypto vive en el schema extensions
as $$
declare
    v_usuario     usuarios%rowtype;
    v_empresa     empresas%rowtype;
    v_superadmin  boolean;
    v_generico    constant text := 'RUT o contraseña incorrectos.';
begin
    if p_rut is null or p_pass is null or length(p_pass) = 0 then
        return jsonb_build_object('ok', false, 'error', v_generico);
    end if;

    select * into v_usuario
      from usuarios
     where rut = p_rut
       and activo = true
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', v_generico);
    end if;

    -- ── Verificación de contraseña ──────────────────────────────
    if v_usuario.pass_hash is not null then
        if v_usuario.pass_hash <> extensions.crypt(p_pass, v_usuario.pass_hash) then
            return jsonb_build_object('ok', false, 'error', v_generico);
        end if;

    -- Usuario creado después del PASO 1 y aún sin hashear: se valida
    -- contra el texto plano y se migra en el acto. Este bloque se
    -- puede borrar cuando 'pass' ya no exista (ver PASO 3).
    elsif v_usuario.pass is not null and v_usuario.pass = p_pass then
        update usuarios
           set pass_hash = extensions.crypt(p_pass, extensions.gen_salt('bf', 10))
         where id = v_usuario.id;

    else
        return jsonb_build_object('ok', false, 'error', v_generico);
    end if;

    -- ── Empresa ─────────────────────────────────────────────────
    select * into v_empresa
      from empresas
     where id = v_usuario.empresa_id;

    if not found or not v_empresa.activo then
        return jsonb_build_object('ok', false,
            'error', 'El taller no está habilitado. Contacta al administrador.');
    end if;

    -- Solo talleres, salvo el superadmin de ARM que los administra
    v_superadmin := (v_empresa.slug = 'arm-sur' and v_usuario.rol = 'admin');

    if v_empresa.tipo is distinct from 'taller' and not v_superadmin then
        return jsonb_build_object('ok', false,
            'error', 'Este acceso es solo para talleres. Para telecom usa ARM Universal.');
    end if;

    update usuarios set ultimo_acceso = now() where id = v_usuario.id;

    return jsonb_build_object(
        'ok', true,
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

revoke all on function fn_login_taller(text, text) from public;
grant execute on function fn_login_taller(text, text) to anon, authenticated;


-- ── Cambio de contraseña (para el futuro panel Usuarios) ────────
create or replace function fn_cambiar_pass_taller(
    p_usuario_id uuid,
    p_pass_actual text,
    p_pass_nueva text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions   -- pgcrypto vive en el schema extensions
as $$
declare
    v_usuario usuarios%rowtype;
begin
    if length(coalesce(p_pass_nueva, '')) < 6 then
        return jsonb_build_object('ok', false,
            'error', 'La contraseña nueva debe tener al menos 6 caracteres.');
    end if;

    select * into v_usuario from usuarios where id = p_usuario_id and activo = true;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Usuario no encontrado.');
    end if;

    if v_usuario.pass_hash is not null then
        if v_usuario.pass_hash <> extensions.crypt(p_pass_actual, v_usuario.pass_hash) then
            return jsonb_build_object('ok', false, 'error', 'La contraseña actual no coincide.');
        end if;
    elsif v_usuario.pass is distinct from p_pass_actual then
        return jsonb_build_object('ok', false, 'error', 'La contraseña actual no coincide.');
    end if;

    update usuarios
       set pass_hash = extensions.crypt(p_pass_nueva, extensions.gen_salt('bf', 10)),
           pass      = null
     where id = p_usuario_id;

    return jsonb_build_object('ok', true);
end;
$$;

revoke all on function fn_cambiar_pass_taller(uuid, text, text) from public;
grant execute on function fn_cambiar_pass_taller(uuid, text, text) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Cerrar la tabla usuarios   ⚠ COORDINAR CON ARM UNIVERSAL
-- ════════════════════════════════════════════════════════════════
-- Mientras 'usuarios' sea legible con la clave publishable, cualquiera
-- puede listar RUTs y roles de TODOS los talleres. El login ya no lo
-- necesita (va por RPC), pero ARM Universal probablemente sí consulta
-- esta tabla directamente. Revisar allá ANTES de descomentar.
--
--   alter table usuarios enable row level security;
--   -- sin políticas para anon → nadie lee la tabla con la clave pública;
--   -- el login sigue funcionando porque fn_login_taller es SECURITY DEFINER.
--
-- Y una vez que ambos sistemas usen el RPC, borrar el texto plano:
--
--   update usuarios set pass = null where pass_hash is not null;
--   -- alter table usuarios drop column pass;


-- ════════════════════════════════════════════════════════════════
-- NOTA SOBRE AISLAMIENTO ENTRE TALLERES
-- ════════════════════════════════════════════════════════════════
-- Hoy TODA la app usa la clave publishable sin JWT: Postgres no sabe
-- qué empresa está consultando, así que el filtro por empresa_id lo
-- pone el front. Eso significa que un usuario con la consola abierta
-- puede leer datos de otros talleres.
--
-- El cierre real de ese hueco es migrar a Supabase Auth con el
-- empresa_id en los claims del JWT, y políticas RLS del estilo:
--
--   create policy taller_propio on taller_ordenes
--     for all to authenticated
--     using (empresa_id = (auth.jwt() -> 'app_metadata' ->> 'empresa_id')::uuid);
--
-- Es una migración transversal (afecta también a ARM Universal), por eso
-- no va en este script. Este archivo cierra el agujero más urgente:
-- las contraseñas.
