-- ================================================================
-- 10_taller_admin.sql — ARM TALLER
-- Datos del taller y administración de talleres (superadmin).
--
-- ⚠ REQUIERE sql/01_seguridad_login.sql (usa pgcrypto y pass_hash).
--
-- ── Por qué NO se renombra 'empresas' ───────────────────────────
-- La tabla 'empresas' la comparte esta app con ARM Universal, y
-- 'empresas.tipo' es lo que distingue taller de telecom. Renombrarla
-- rompería el otro producto. Por eso todo lo propio del taller vive
-- en taller_config, y de 'empresas' solo se usan las columnas que ya
-- existían: nombre, slug, tipo, logo_url, modulos_activos, activo.
--
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Datos y parámetros propios del taller
-- ════════════════════════════════════════════════════════════════
-- Una fila por taller. Nada de esto toca la tabla compartida.

create table if not exists taller_config (
    empresa_id            uuid primary key,

    -- Datos que salen en presupuestos y documentos impresos
    rut                   text,
    giro                  text,
    direccion             text,
    comuna                text,
    ciudad                text,
    telefono              text,
    email                 text,
    sitio_web             text,

    -- Parámetros de operación
    iva_tasa              numeric(5,4) not null default 0.19,
    dias_validez_presupuesto integer not null default 15,
    condiciones_presupuesto  text,
    pie_documentos        text,

    updated_at            timestamptz not null default now()
);

comment on table taller_config is
    'Datos y parámetros de cada taller. La tabla empresas se comparte con ARM Universal y no se toca.';


-- ── Crea la fila de config si falta, y la devuelve ──────────────
create or replace function fn_taller_config(p_empresa_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_cfg taller_config%rowtype;
begin
    insert into taller_config (empresa_id)
    values (p_empresa_id)
    on conflict (empresa_id) do nothing;

    select * into v_cfg from taller_config where empresa_id = p_empresa_id;

    return jsonb_build_object('ok', true, 'config', to_jsonb(v_cfg));
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Verificación de superadmin
-- ════════════════════════════════════════════════════════════════
-- Sin JWT, la base no sabe quién llama. Las operaciones que crean
-- credenciales piden la contraseña del superadmin y la verifican
-- AQUÍ DENTRO. No es cosmético: si la clave no calza, no se crea nada.

create or replace function fn_es_superadmin(p_rut text, p_pass text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions   -- pgcrypto vive en el schema extensions
as $$
declare v_u usuarios%rowtype;
begin
    -- RUT multiempresa: si hubiera más de una cuenta admin en arm-sur,
    -- elegir siempre la misma (la más antigua). Ver sql/33.
    select u.* into v_u
      from usuarios u
      join empresas e on e.id = u.empresa_id
     where u.rut = p_rut and u.activo = true
       and u.rol = 'admin' and e.slug = 'arm-sur'
     order by u.created_at asc
     limit 1;

    if not found then return false; end if;

    if v_u.pass_hash is not null then
        return v_u.pass_hash = extensions.crypt(p_pass, v_u.pass_hash);
    end if;
    return v_u.pass is not null and v_u.pass = p_pass;
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Crear un taller con su usuario administrador
-- ════════════════════════════════════════════════════════════════

-- Quita acentos sin depender de la extensión unaccent
create or replace function unaccent_simple(p text)
returns text
language sql
immutable
as $func$
    select translate(coalesce(p, ''),
                     'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
                     'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC');
$func$;


create or replace function fn_crear_taller(
    p_admin_rut     text,     -- credenciales del superadmin
    p_admin_pass    text,
    p_nombre        text,
    p_slug          text,
    p_usuario_rut   text,     -- admin del taller nuevo
    p_usuario_pass  text,
    p_modulos       jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions   -- pgcrypto vive en el schema extensions
as $$
declare
    v_empresa_id uuid;
    v_slug       text;
begin
    if not fn_es_superadmin(p_admin_rut, p_admin_pass) then
        return jsonb_build_object('ok', false,
            'error', 'Credenciales de superadmin incorrectas.');
    end if;

    if coalesce(trim(p_nombre), '') = '' then
        return jsonb_build_object('ok', false, 'error', 'El nombre del taller es obligatorio.');
    end if;
    if length(coalesce(p_usuario_pass, '')) < 6 then
        return jsonb_build_object('ok', false,
            'error', 'La contraseña del administrador debe tener al menos 6 caracteres.');
    end if;

    -- slug: minúsculas, sin acentos ni espacios
    v_slug := lower(regexp_replace(
                unaccent_simple(coalesce(nullif(trim(p_slug), ''), p_nombre)),
                '[^a-zA-Z0-9]+', '-', 'g'));
    v_slug := trim(both '-' from v_slug);

    if exists (select 1 from empresas where slug = v_slug) then
        return jsonb_build_object('ok', false,
            'error', format('Ya existe un taller con el identificador "%s".', v_slug));
    end if;
    if exists (select 1 from usuarios where rut = p_usuario_rut) then
        return jsonb_build_object('ok', false,
            'error', format('Ya existe un usuario con el RUT %s.', p_usuario_rut));
    end if;

    insert into empresas (nombre, slug, tipo, activo, modulos_activos)
    values (trim(p_nombre), v_slug, 'taller', true, coalesce(p_modulos, '{}'::jsonb))
    returning id into v_empresa_id;

    insert into usuarios (empresa_id, rut, pass_hash, rol, activo)
    values (v_empresa_id, p_usuario_rut, extensions.crypt(p_usuario_pass, extensions.gen_salt('bf', 10)), 'admin', true);

    insert into taller_config (empresa_id) values (v_empresa_id)
    on conflict (empresa_id) do nothing;

    return jsonb_build_object('ok', true, 'empresa_id', v_empresa_id, 'slug', v_slug);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Crear usuarios dentro de un taller
-- ════════════════════════════════════════════════════════════════

create or replace function fn_crear_usuario_taller(
    p_admin_rut    text,
    p_admin_pass   text,
    p_empresa_id   uuid,
    p_rut          text,
    p_pass         text,
    p_rol          text,
    p_empleado_id  uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions   -- pgcrypto vive en el schema extensions
as $$
begin
    if not fn_es_superadmin(p_admin_rut, p_admin_pass) then
        return jsonb_build_object('ok', false,
            'error', 'Credenciales de superadmin incorrectas.');
    end if;
    if length(coalesce(p_pass, '')) < 6 then
        return jsonb_build_object('ok', false,
            'error', 'La contraseña debe tener al menos 6 caracteres.');
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


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Lista de talleres para el superadmin
-- ════════════════════════════════════════════════════════════════

create or replace view v_taller_empresas as
select
    e.id,
    e.nombre,
    e.slug,
    e.activo,
    e.logo_url,
    coalesce(e.modulos_activos, '{}'::jsonb) as modulos_activos,
    (select count(*) from jsonb_each(coalesce(e.modulos_activos, '{}'::jsonb)) x
      where x.value = 'true'::jsonb)                       as modulos_activos_n,
    (select count(*) from usuarios u
      where u.empresa_id = e.id and u.activo = true)       as usuarios,
    (select max(u.ultimo_acceso) from usuarios u
      where u.empresa_id = e.id)                           as ultimo_acceso,
    (select count(*) from taller_ordenes o
      where o.empresa_id = e.id)                           as ordenes,
    c.rut,
    c.telefono,
    c.ciudad
from empresas e
left join taller_config c on c.empresa_id = e.id
where e.tipo = 'taller';


-- ── Permisos ────────────────────────────────────────────────────
do $$
declare f text;
begin
    foreach f in array array[
        'fn_taller_config(uuid)',
        'fn_crear_taller(text, text, text, text, text, text, jsonb)',
        'fn_crear_usuario_taller(text, text, uuid, text, text, text, uuid)'
    ] loop
        execute format('revoke all on function %s from public', f);
        execute format('grant execute on function %s to anon, authenticated', f);
    end loop;

    -- fn_es_superadmin es interna: no se expone al cliente
    execute 'revoke all on function fn_es_superadmin(text, text) from public, anon, authenticated';
end $$;


-- ════════════════════════════════════════════════════════════════
-- NOTA DE SEGURIDAD
-- ════════════════════════════════════════════════════════════════
-- fn_crear_taller y fn_crear_usuario_taller crean CREDENCIALES. Por
-- eso exigen la contraseña del superadmin y la verifican dentro de
-- Postgres: aunque alguien llame la RPC con la clave publishable, sin
-- esa contraseña no crea nada.
--
-- El resto de la app sigue sin aislamiento real entre talleres hasta
-- que se migre a Supabase Auth con empresa_id en el JWT (ver la nota
-- al final de 01_seguridad_login.sql).


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select * from v_taller_empresas order by nombre;
-- select fn_taller_config('<id del taller>');
