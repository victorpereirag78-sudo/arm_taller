-- ════════════════════════════════════════════════════════════════
-- 37 · usuarios sin contraseñas en texto plano (paso 2 de 2)
-- ════════════════════════════════════════════════════════════════
-- Auditoría 2026-09-25: la tabla `usuarios` (compartida con ARM
-- Universal) tenía la policy `usuarios_permisiva` (anon, ALL, true) y 17
-- de 20 cuentas con la contraseña en texto plano en `pass`. Con la clave
-- anon —que es pública— cualquiera podía leer todas las contraseñas,
-- incluida la del superadmin, o reescribir el hash de cualquier cuenta.
--
-- REQUISITO: sql/36 aplicado y ARM Universal publicado con auth.js
-- usando fn_login_universal (commit 3ff44d2). Si se corre antes, el login
-- antiguo de ARM Universal deja de funcionar.
--
-- Qué hace:
--   1. Trigger en `usuarios`: todo `pass` que llegue (insert o update) se
--      convierte en pass_hash (bcrypt) y `pass` queda en null. ARM
--      Universal sigue creando usuarios y cambiando claves igual que
--      antes, pero la clave ya no se guarda legible.
--   2. El mismo trigger protege las cuentas de ARM Taller (empresas
--      tipo 'taller') y las de superadmin (admin de 'arm-sur'): desde el
--      navegador (roles anon/authenticated) no se pueden crear, modificar
--      ni borrar. Se administran con las RPC del taller, que verifican la
--      contraseña del administrador. Da un error claro en vez de fallar
--      en silencio.
--   3. Convierte las claves en texto plano que quedan y vacía `pass`.
--   4. anon/authenticated ya no pueden LEER `pass` ni `pass_hash`, ni
--      escribir `pass_hash` directamente.
--   5. v_taller_usuarios deja de leer pass_hash (con security_invoker
--      necesitaría ese permiso); todas las cuentas tienen hash.
--
-- Lo que NO resuelve (depende de rehacer la sesión de ARM Universal):
-- el resto de las cuentas de ARM Universal todavía se pueden modificar
-- con la clave anon, porque Universal no tiene identidad del lado del
-- servidor (no manda token como ARM Taller desde sql/14).
--
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

-- ── 1 y 2 · Trigger ─────────────────────────────────────────────
create or replace function public.usuarios_protegido(p_empresa_id uuid, p_rol text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
    select exists (
        select 1 from public.empresas e
         where e.id = p_empresa_id
           and (e.tipo = 'taller' or (e.slug = 'arm-sur' and p_rol = 'admin'))
    );
$function$;

revoke all on function public.usuarios_protegido(uuid, text) from public;

-- SECURITY INVOKER a propósito: current_user tiene que ser el rol de la
-- petición (anon/authenticated desde el navegador; postgres cuando lo
-- dispara una RPC SECURITY DEFINER como fn_usuario_resetear_pass).
create or replace function public.fn_trg_usuarios_seguridad()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
    if current_user in ('anon', 'authenticated') then
        if tg_op in ('UPDATE', 'DELETE')
           and public.usuarios_protegido(old.empresa_id, old.rol) then
            raise exception 'Esta cuenta se administra desde ARM Taller.'
                using errcode = '42501';
        end if;
        if tg_op in ('INSERT', 'UPDATE')
           and public.usuarios_protegido(new.empresa_id, new.rol) then
            raise exception 'Esta cuenta se administra desde ARM Taller.'
                using errcode = '42501';
        end if;
    end if;

    if tg_op = 'DELETE' then
        return old;
    end if;

    if new.pass is not null and new.pass <> '' then
        new.pass_hash := extensions.crypt(new.pass, extensions.gen_salt('bf'));
    end if;
    new.pass := null;
    return new;
end;
$function$;

drop trigger if exists trg_usuarios_seguridad on public.usuarios;
create trigger trg_usuarios_seguridad
    before insert or update or delete on public.usuarios
    for each row execute function public.fn_trg_usuarios_seguridad();

-- ── 3 · Convertir lo que queda en texto plano ───────────────────
-- (el trigger hace el hash; esto corre como postgres, sin restricciones)
update public.usuarios
   set pass = pass
 where pass is not null and pass <> '';

update public.usuarios set pass = null where pass = '';

-- ── 4 · Permisos por columna ────────────────────────────────────
revoke select, insert, update on public.usuarios from anon, authenticated;

grant select (id, empresa_id, empleado_id, rut, rol, activo,
              ultimo_acceso, created_at, nombre)
   on public.usuarios to anon, authenticated;

grant insert (id, empresa_id, empleado_id, rut, pass, rol, activo,
              ultimo_acceso, created_at, nombre)
   on public.usuarios to anon, authenticated;

grant update (empresa_id, empleado_id, rut, pass, rol, activo,
              ultimo_acceso, nombre)
   on public.usuarios to anon, authenticated;

-- ── 5 · Vista de usuarios del taller ────────────────────────────
create or replace view public.v_taller_usuarios
with (security_invoker = true) as
select u.id,
       u.empresa_id,
       u.rut,
       u.rol,
       u.activo,
       u.empleado_id,
       u.ultimo_acceso,
       true as pass_segura,   -- el trigger garantiza pass_hash en toda cuenta con clave
       e.nombre as empleado_nombre,
       e.cargo  as empleado_cargo
  from public.usuarios u
  left join public.taller_empleados e on e.id = u.empleado_id;

-- ── Verificación ────────────────────────────────────────────────
select count(*) filter (where pass is not null)      as con_texto_plano,   -- 0
       count(*) filter (where pass_hash is null)     as sin_hash,          -- 0
       has_column_privilege('anon', 'public.usuarios', 'pass', 'select')      as anon_lee_pass,       -- false
       has_column_privilege('anon', 'public.usuarios', 'pass_hash', 'select') as anon_lee_hash,       -- false
       has_column_privilege('anon', 'public.usuarios', 'pass_hash', 'update') as anon_escribe_hash    -- false
  from public.usuarios;
