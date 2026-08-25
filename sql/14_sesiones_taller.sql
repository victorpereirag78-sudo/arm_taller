-- ================================================================
-- 14_sesiones_taller.sql — ARM TALLER
-- ETAPA 1 de 2: identidad real del lado del servidor.
--
-- ⚠ REQUIERE 01, 12 y 13.
-- ⚠ ESTA ETAPA NO CAMBIA NINGUNA POLÍTICA. Es puramente aditiva:
--    si algo no funciona, la app sigue exactamente igual que hoy.
--
-- ── El problema ─────────────────────────────────────────────────
-- La clave publishable es anónima: todos los usuarios de todos los
-- talleres son el mismo rol 'anon'. Por eso el filtro por empresa_id
-- lo tiene que poner el navegador, y por eso se puede saltar.
--
-- ── La salida, sin migrar a Supabase Auth ───────────────────────
-- PostgREST expone las cabeceras HTTP a la base:
--     current_setting('request.headers', true)::json
--
-- Entonces:
--   1. fn_login_taller emite un TOKEN opaco y lo guarda en taller_sesiones
--   2. El navegador lo manda en la cabecera 'x-taller-token'
--   3. taller_empresa_actual() resuelve el empresa_id desde ese token,
--      DENTRO de Postgres, sin confiar en el front
--   4. (ETAPA 2) las políticas RLS filtran por esa función
--
-- Es el mismo patrón que ya usa emprendedores_fn_puede_leer(business_id)
-- en esta misma base: una función stable dentro del 'using'.
--
-- ── Cómo verificar que funciona (importante) ────────────────────-
-- Después de aplicar esto y actualizar el front, entra a la app y en
-- la consola del navegador corre:
--
--     await db.rpc('fn_diag_sesion').then(r => console.log(r.data))
--
-- Si devuelve  cabecera_recibida: true  y  el empresa_id correcto,
-- la Etapa 2 es segura. Si no, avísame y buscamos otra vía.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Tabla de sesiones
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_sesiones (
    token        uuid primary key default gen_random_uuid(),
    usuario_id   uuid not null,
    empresa_id   uuid not null,
    rut          text,
    rol          text,
    creada_at    timestamptz not null default now(),
    expira_at    timestamptz not null,
    revocada     boolean not null default false,
    user_agent   text
);

create index if not exists idx_sesiones_vigentes
    on taller_sesiones (token) where not revocada;

create index if not exists idx_sesiones_usuario
    on taller_sesiones (usuario_id, creada_at desc);

-- El token es una credencial: NADIE lo lee desde el cliente.
-- Solo lo tocan funciones security definer.
revoke all on table taller_sesiones from anon, authenticated;

alter table taller_sesiones enable row level security;
-- Sin políticas a propósito: la tabla queda cerrada para el cliente.


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Resolver la identidad desde la cabecera
-- ════════════════════════════════════════════════════════════════
-- 'stable' es clave: Postgres la evalúa UNA vez por consulta, no una
-- vez por fila. Sin eso, una tabla de 5.000 filas haría 5.000 lookups.

create or replace function taller_token_actual()
returns uuid
language plpgsql
stable
as $$
declare v_raw text;
begin
    -- Si no hay contexto de request (ej: SQL editor), no hay token
    begin
        v_raw := current_setting('request.headers', true)::json ->> 'x-taller-token';
    exception when others then
        return null;
    end;

    if v_raw is null or v_raw = '' then return null; end if;

    begin
        return v_raw::uuid;
    exception when others then
        return null;   -- token con formato inválido
    end;
end;
$$;


create or replace function taller_empresa_actual()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
    select s.empresa_id
      from taller_sesiones s
     where s.token = taller_token_actual()
       and not s.revocada
       and s.expira_at > now()
$$;


create or replace function taller_rol_actual()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select s.rol
      from taller_sesiones s
     where s.token = taller_token_actual()
       and not s.revocada
       and s.expira_at > now()
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Login que emite el token
-- ════════════════════════════════════════════════════════════════
-- Se elimina la versión de 2 parámetros para no dejar una sobrecarga
-- ambigua. La lógica de validación es idéntica al script 01: lo único
-- nuevo es que crea la sesión y devuelve su token.

drop function if exists fn_login_taller(text, text);

create function fn_login_taller(
    p_rut  text,
    p_pass text,
    p_dias integer default 1
) returns jsonb
language plpgsql
security definer
set search_path = public
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

    select * into v_usuario
      from usuarios
     where rut = p_rut and activo = true
     limit 1;

    if not found then
        return jsonb_build_object('ok', false, 'error', v_generico);
    end if;

    -- ── Contraseña ──────────────────────────────────────────────
    if v_usuario.pass_hash is not null then
        if v_usuario.pass_hash <> crypt(p_pass, v_usuario.pass_hash) then
            return jsonb_build_object('ok', false, 'error', v_generico);
        end if;
    elsif v_usuario.pass is not null and v_usuario.pass = p_pass then
        update usuarios
           set pass_hash = crypt(p_pass, gen_salt('bf', 10))
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
    -- Se limpian las vencidas de este usuario, para no acumular basura
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


-- ── Cerrar sesión ───────────────────────────────────────────────
create or replace function fn_cerrar_sesion()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_t uuid := taller_token_actual();
begin
    if v_t is null then
        return jsonb_build_object('ok', true, 'nota', 'sin sesión que cerrar');
    end if;
    update taller_sesiones set revocada = true where token = v_t;
    return jsonb_build_object('ok', true);
end;
$$;

revoke all on function fn_cerrar_sesion() from public;
grant execute on function fn_cerrar_sesion() to anon, authenticated;


-- ── El superadmin cambia de taller sin volver a loguearse ───────
-- Emite un token nuevo apuntando a otro taller. Solo funciona si la
-- sesión actual es de un admin de arm-sur: lo verifica la base.

create or replace function fn_sesion_cambiar_taller(p_empresa_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_s     taller_sesiones%rowtype;
    v_e     empresas%rowtype;
    v_orig  empresas%rowtype;
    v_token uuid;
begin
    select * into v_s
      from taller_sesiones
     where token = taller_token_actual() and not revocada and expira_at > now();

    if not found then
        return jsonb_build_object('ok', false, 'error', 'Sesión no válida.');
    end if;

    select * into v_orig from empresas where id = v_s.empresa_id;
    if not found or v_orig.slug <> 'arm-sur' or v_s.rol <> 'admin' then
        return jsonb_build_object('ok', false,
            'error', 'Solo el superadmin puede cambiar de taller.');
    end if;

    select * into v_e from empresas where id = p_empresa_id and tipo = 'taller' and activo;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Taller no encontrado o inactivo.');
    end if;

    insert into taller_sesiones (usuario_id, empresa_id, rut, rol, expira_at)
    values (v_s.usuario_id, p_empresa_id, v_s.rut, v_s.rol, v_s.expira_at)
    returning token into v_token;

    return jsonb_build_object('ok', true, 'token', v_token,
        'empresa', jsonb_build_object(
            'id', v_e.id, 'nombre', v_e.nombre, 'slug', v_e.slug,
            'logo_url', v_e.logo_url, 'tipo', v_e.tipo, 'activo', v_e.activo,
            'modulos_activos', coalesce(v_e.modulos_activos, '{}'::jsonb)));
end;
$$;

revoke all on function fn_sesion_cambiar_taller(uuid) from public;
grant execute on function fn_sesion_cambiar_taller(uuid) to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — DIAGNÓSTICO: ¿llega la cabecera?
-- ════════════════════════════════════════════════════════════════
-- Esta es LA función que decide si la Etapa 2 es viable.
-- Se llama desde la consola del navegador, con la app abierta:
--
--     await db.rpc('fn_diag_sesion').then(r => console.log(r.data))
--
-- Lo que queremos ver:
--     cabecera_recibida: true
--     token_valido:      true
--     empresa_id:        <el id de tu taller>

create or replace function fn_diag_sesion()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_headers json;
    v_raw     text;
    v_token   uuid := taller_token_actual();
    v_emp     uuid := taller_empresa_actual();
begin
    begin
        v_headers := current_setting('request.headers', true)::json;
        v_raw     := v_headers ->> 'x-taller-token';
    exception when others then
        v_headers := null;
    end;

    return jsonb_build_object(
        'ok', true,
        'hay_contexto_request', v_headers is not null,
        'cabecera_recibida',    v_raw is not null,
        'cabecera_valor',       case when v_raw is null then null
                                     else left(v_raw, 8) || '…' end,
        'token_valido',         v_token is not null and v_emp is not null,
        'empresa_id',           v_emp,
        'rol',                  taller_rol_actual(),
        'sesiones_vigentes',    (select count(*) from taller_sesiones
                                  where not revocada and expira_at > now()),
        'veredicto',
            case
                when v_headers is null
                    then 'Sin contexto de request (¿lo corriste desde el SQL editor?). Pruébalo desde la app.'
                when v_raw is null
                    then 'La cabecera x-taller-token NO llega. Revisa config.js.'
                when v_emp is null
                    then 'La cabecera llega pero el token no resuelve: vencido, revocado o inexistente. Vuelve a iniciar sesión.'
                else 'Todo bien: la base sabe quién pregunta. La Etapa 2 es segura.'
            end
    );
end;
$$;

revoke all on function fn_diag_sesion() from public;
grant execute on function fn_diag_sesion() to anon, authenticated;


-- Permisos de las funciones de identidad (las usan las políticas)
grant execute on function taller_token_actual()   to anon, authenticated;
grant execute on function taller_empresa_actual() to anon, authenticated;
grant execute on function taller_rol_actual()     to anon, authenticated;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN EN EL SQL EDITOR
-- ════════════════════════════════════════════════════════════════
-- Aquí no hay cabeceras, así que taller_empresa_actual() da null.
-- Eso es lo esperado. Lo único que se comprueba desde aquí:

select
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'fn_login_taller')      as versiones_de_login,
    (select count(*) from information_schema.tables
      where table_schema = 'public' and table_name = 'taller_sesiones')  as tabla_sesiones,
    taller_empresa_actual()                                              as empresa_sin_cabecera;

-- versiones_de_login debe ser 1. Si sale 2, quedó una sobrecarga
-- antigua y hay que borrarla:
--   drop function fn_login_taller(text, text);


-- ════════════════════════════════════════════════════════════════
-- LO QUE VIENE (ETAPA 2) — todavía NO ejecutar
-- ════════════════════════════════════════════════════════════════
-- Cuando fn_diag_sesion confirme desde la app, la Etapa 2 reemplaza
-- la política permisiva del script 13 por esta, en las 28 tablas:
--
--   drop policy taller_app_acceso on taller_ordenes;
--   create policy taller_propio on taller_ordenes
--     for all to anon, authenticated
--     using      (empresa_id = taller_empresa_actual())
--     with check (empresa_id = taller_empresa_actual());
--
-- A partir de ahí, sin token válido no se ve ni se escribe NADA, y
-- con token solo se ve el taller de esa sesión. El filtro deja de
-- depender del navegador.
--
-- Nota: el token es una credencial de sesión, como una cookie. Si
-- alguien la roba, accede a ESE taller — no a todos. Hoy la clave
-- publishable da acceso a todo, así que el salto es grande.
