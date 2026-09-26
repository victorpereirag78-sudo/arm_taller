-- ════════════════════════════════════════════════════════════════
-- 36 · Login de ARM Universal contra el hash (paso 1 de 2)
-- ════════════════════════════════════════════════════════════════
-- La tabla `usuarios` la comparten ARM Taller y ARM Universal. ARM Taller
-- ya entra con fn_login_taller (bcrypt dentro de Postgres), pero ARM
-- Universal seguía comparando la contraseña EN EL NAVEGADOR:
--   from('usuarios').select(...).eq('rut', rut).eq('pass', pass)
-- Eso obliga a guardar `pass` en texto plano y a dejarla legible con la
-- clave anon, que es pública (está en el config.js de cada app).
--
-- Esta función hace lo mismo que esa consulta, pero la comparación
-- ocurre en la base y contra `pass_hash`. Devuelve exactamente la forma
-- que usaba auth.js de ARM Universal (usuario + empresas embebida) para
-- que el cambio en el front sea mínimo.
--
-- ORDEN DE DESPLIEGUE (no saltarse):
--   1. Este script (aditivo: no cambia nada de lo que ya funciona).
--   2. Publicar ARM Universal con auth.js usando fn_login_universal.
--   3. sql/37_usuarios_sin_texto_plano.sql (borra `pass` y cierra columnas).
--
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

create or replace function public.fn_login_universal(
    p_rut  text,
    p_pass text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
    v_u  public.usuarios%rowtype;
    v_e  public.empresas%rowtype;
begin
    if coalesce(p_rut, '') = '' or coalesce(p_pass, '') = '' then
        return jsonb_build_object('ok', false, 'error', 'RUT o contraseña incorrectos.');
    end if;

    -- Un RUT puede tener cuenta en varias empresas. Igual que la consulta
    -- antigua, sirve cualquier cuenta activa cuya clave calce; se prefiere
    -- una empresa telecom (esto es ARM Universal) y activa, y a igualdad
    -- la más antigua, para que el resultado sea siempre el mismo.
    select u.* into v_u
      from public.usuarios u
      left join public.empresas e on e.id = u.empresa_id
     where u.rut = p_rut
       and u.activo
       and (
             (u.pass_hash is not null
              and u.pass_hash = extensions.crypt(p_pass, u.pass_hash))
          -- Transición: filas que aún no tienen hash (no debería haber).
          or (u.pass_hash is null and u.pass = p_pass)
       )
     order by (e.tipo is distinct from 'taller') desc,
              coalesce(e.activo, false) desc,
              u.created_at asc
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'RUT o contraseña incorrectos.');
    end if;

    select * into v_e from public.empresas where id = v_u.empresa_id;

    update public.usuarios set ultimo_acceso = now() where id = v_u.id;

    return jsonb_build_object(
        'ok', true,
        'usuario', jsonb_build_object(
            'id',          v_u.id,
            'empresa_id',  v_u.empresa_id,
            'empleado_id', v_u.empleado_id,
            'rut',         v_u.rut,
            'rol',         v_u.rol,
            'activo',      v_u.activo,
            'empresas', case when v_e.id is null then null else jsonb_build_object(
                'id',               v_e.id,
                'nombre',           v_e.nombre,
                'slug',             v_e.slug,
                'logo_url',         v_e.logo_url,
                'tiene_dth',        v_e.tiene_dth,
                'tiene_fibra',      v_e.tiene_fibra,
                'tiene_hfc',        v_e.tiene_hfc,
                'modulos_activos',  v_e.modulos_activos,
                'regiones_activas', v_e.regiones_activas,
                'activo',           v_e.activo
            ) end
        )
    );
end;
$function$;

revoke all on function public.fn_login_universal(text, text) from public;
grant execute on function public.fn_login_universal(text, text) to anon, authenticated, service_role;
