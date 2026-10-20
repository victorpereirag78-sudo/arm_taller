-- ════════════════════════════════════════════════════════════════
-- 44 · El presupuesto como punto de partida (cliente + vehículo + aviso)
-- ════════════════════════════════════════════════════════════════
-- Lo primero que hace un taller cuando llega un cliente es el presupuesto.
-- Antes había que crear el cliente, luego el vehículo y recién después el
-- presupuesto. Ahora el presupuesto se llena completo y de ahí salen el
-- cliente y el vehículo.
--
-- 1. fn_taller_presupuesto_crear: crea (o actualiza) el cliente y el
--    vehículo con lo que se escribió en el presupuesto y crea el
--    presupuesto, todo en una sola transacción. El N° se calcula con un
--    candado por taller (antes era max+1 en el navegador: dos pestañas
--    podían sacar el mismo N°).
-- 2. taller_presupuestos.canal_aviso: "cómo informar" de ESTE presupuesto
--    (app, WhatsApp, ambos, en persona). Si está vacío manda la preferencia
--    del cliente. fn_taller_emitir_evento lo lee del payload del evento.
-- 3. Enlace público (token_publico + url_publica): el cliente ve el
--    presupuesto completo —logo, datos, trabajo a realizar, valores— y lo
--    aprueba o rechaza desde WhatsApp sin instalar nada.
--    fn_presupuesto_publico / fn_presupuesto_publico_responder.
-- 4. fn_mv_vehiculo_presupuestos ahora entrega también el documento
--    completo para que la app lo despliegue.
-- 5. 'enlace' como vía de aprobación válida.
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

-- ── 1 · Columnas ────────────────────────────────────────────────
alter table taller_presupuestos add column if not exists token_publico text;
alter table taller_presupuestos add column if not exists url_publica   text;
alter table taller_presupuestos add column if not exists canal_aviso   text;

update taller_presupuestos
   set token_publico = encode(extensions.gen_random_bytes(16), 'hex')
 where token_publico is null;

alter table taller_presupuestos
    alter column token_publico set default encode(extensions.gen_random_bytes(16), 'hex');

create unique index if not exists ux_presup_token_publico
    on taller_presupuestos (token_publico);

alter table taller_presupuestos drop constraint if exists taller_presupuestos_canal_aviso_check;
alter table taller_presupuestos add constraint taller_presupuestos_canal_aviso_check
    check (canal_aviso is null or canal_aviso in ('auto', 'mi_vehiculo', 'whatsapp', 'ambos', 'ninguno'));

alter table taller_presupuestos drop constraint if exists taller_presupuestos_aprobado_via_check;
alter table taller_presupuestos add constraint taller_presupuestos_aprobado_via_check
    check (aprobado_via in ('presencial', 'telefono', 'whatsapp', 'email', 'mi_vehiculo', 'enlace', 'otro'));


-- ── 2 · El canal del presupuesto manda sobre el del cliente ─────
-- Mismo cuerpo que sql/39; lo único nuevo es v_pref, que primero mira
-- payload->>'canal'.
create or replace function public.fn_taller_emitir_evento(
    p_empresa_id     uuid,
    p_tipo           text,
    p_titulo         text,
    p_detalle        text default null,
    p_orden_id       uuid default null,
    p_presupuesto_id uuid default null,
    p_vehiculo_id    uuid default null,
    p_cliente_id     uuid default null,
    p_payload        jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_evento     uuid;
    v_cli        taller_clientes%rowtype;
    v_autodoc    uuid;
    v_mv_activo  boolean := false;
    v_pref       text;
    v_mv         boolean;
    v_wa         boolean;
begin
    insert into taller_notificacion_eventos (
        empresa_id, tipo, orden_id, presupuesto_id, vehiculo_id, cliente_id,
        titulo, detalle, payload)
    values (
        p_empresa_id, p_tipo, p_orden_id, p_presupuesto_id, p_vehiculo_id, p_cliente_id,
        p_titulo, p_detalle, coalesce(p_payload, '{}'))
    returning id into v_evento;

    if p_cliente_id is not null then
        select * into v_cli from taller_clientes where id = p_cliente_id;
    end if;

    if p_vehiculo_id is not null then
        select autodoc_vehicle_id into v_autodoc
          from taller_vehiculo_vinculo
         where taller_vehiculo_id = p_vehiculo_id
           and estado = 'activo' and autodoc_vehicle_id is not null
         limit 1;
    end if;

    -- ¿El dueño puede ver Mi Vehículo? (bloqueada = muro de pago)
    if v_autodoc is not null then
        select autodocumentos_fn_estado_suscripcion(v.owner_id) <> 'bloqueada'
          into v_mv_activo
          from autodocumentos_vehicles v
         where v.id = v_autodoc;
        v_mv_activo := coalesce(v_mv_activo, false);
    end if;

    -- El canal elegido para este aviso (p. ej. el del presupuesto) manda
    -- sobre la preferencia general del cliente.
    v_pref := coalesce(nullif(p_payload->>'canal', ''), v_cli.canal_pref, 'auto');
    if v_pref = 'ninguno' then
        return v_evento;
    end if;

    v_mv := (v_pref in ('mi_vehiculo', 'ambos', 'auto')) and v_autodoc is not null;
    v_wa := (v_pref in ('whatsapp', 'ambos'))
            or (v_pref in ('auto', 'mi_vehiculo') and not v_mv_activo);

    if v_mv then
        insert into taller_notificaciones (evento_id, empresa_id, canal, destinatario)
        values (v_evento, p_empresa_id, 'mi_vehiculo', v_autodoc::text);
    end if;

    if v_wa and coalesce(v_cli.telefono, '') <> '' then
        insert into taller_notificaciones (evento_id, empresa_id, canal, destinatario)
        values (v_evento, p_empresa_id, 'whatsapp', v_cli.telefono);
    end if;

    return v_evento;

exception when others then
    -- Un evento que falla nunca debe voltear la transacción del taller
    raise warning 'no se pudo emitir evento % : %', p_tipo, sqlerrm;
    return null;
end;
$function$;

revoke all on function public.fn_taller_emitir_evento(uuid, text, text, text, uuid, uuid, uuid, uuid, jsonb)
    from public, anon, authenticated;
grant execute on function public.fn_taller_emitir_evento(uuid, text, text, text, uuid, uuid, uuid, uuid, jsonb)
    to service_role;


-- ── 2b · El aviso de "presupuesto enviado" lleva canal y enlace ─
create or replace function fn_trg_presup_evento_notif()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.estado = 'enviado' and coalesce(old.estado, '') <> 'enviado' then
        perform fn_taller_emitir_evento(
            new.empresa_id, 'presupuesto_enviado',
            'Tienes un presupuesto por aprobar',
            coalesce('Total ' || to_char(new.total, 'FM999G999G999'), null),
            null, new.id, new.vehiculo_id, new.cliente_id,
            jsonb_build_object(
                'numero', new.numero,
                'total',  new.total,
                'token',  new.token_publico,
                'url',    new.url_publica,
                'canal',  nullif(new.canal_aviso, '')));
    end if;
    return new;
end;
$$;


-- ── 3 · Crear el presupuesto desde cero ─────────────────────────
create or replace function public.fn_taller_presupuesto_crear(
    p_empresa_id  uuid,
    p_cliente     jsonb,
    p_vehiculo    jsonb,
    p_km          integer default null,
    p_validez     integer default 15,
    p_motivo      text    default null,
    p_diagnostico text    default null,
    p_canal       text    default null,
    p_usuario     text    default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_cli_id   uuid;
    v_veh_id   uuid;
    v_pat      text;
    v_numero   integer;
    v_id       uuid;
    v_nombre   text := nullif(btrim(coalesce(p_cliente->>'nombre', '')), '');
    v_rut      text := nullif(upper(replace(btrim(coalesce(p_cliente->>'rut', '')), '.', '')), '');
    v_tel      text := nullif(btrim(coalesce(p_cliente->>'telefono', '')), '');
    v_email    text := nullif(btrim(coalesce(p_cliente->>'email', '')), '');
    v_dir      text := nullif(btrim(coalesce(p_cliente->>'direccion', '')), '');
    v_marca    text := nullif(btrim(coalesce(p_vehiculo->>'marca', '')), '');
    v_modelo   text := nullif(btrim(coalesce(p_vehiculo->>'modelo', '')), '');
    v_anio     integer := nullif(p_vehiculo->>'anio', '')::integer;
    v_color    text := nullif(btrim(coalesce(p_vehiculo->>'color', '')), '');
    v_vin      text := nullif(btrim(coalesce(p_vehiculo->>'vin', '')), '');
    v_canal    text := nullif(btrim(coalesce(p_canal, '')), '');
begin
    perform public.taller_exigir_empresa(p_empresa_id);

    v_pat := upper(regexp_replace(coalesce(p_vehiculo->>'patente', ''), '[^A-Za-z0-9]+', '', 'g'));

    if v_nombre is null then
        return jsonb_build_object('ok', false, 'error', 'El nombre del cliente es obligatorio.');
    end if;
    if v_pat = '' then
        return jsonb_build_object('ok', false, 'error', 'La patente es obligatoria.');
    end if;
    if nullif(btrim(coalesce(p_motivo, '')), '') is null then
        return jsonb_build_object('ok', false, 'error', 'Describe qué se está cotizando.');
    end if;
    if v_canal is not null and v_canal not in ('auto', 'mi_vehiculo', 'whatsapp', 'ambos', 'ninguno') then
        return jsonb_build_object('ok', false, 'error', 'Canal de aviso no válido.');
    end if;

    -- ── Cliente: por id, luego por RUT; si no existe se crea ──────
    if nullif(p_cliente->>'id', '') is not null then
        select id into v_cli_id from taller_clientes
         where id = (p_cliente->>'id')::uuid and empresa_id = p_empresa_id;
    end if;
    if v_cli_id is null and v_rut is not null then
        select id into v_cli_id from taller_clientes
         where empresa_id = p_empresa_id and rut = v_rut;
    end if;

    if v_cli_id is not null then
        update taller_clientes
           set nombre    = v_nombre,
               rut       = coalesce(v_rut, rut),
               telefono  = coalesce(v_tel, telefono),
               email     = coalesce(v_email, email),
               direccion = coalesce(v_dir, direccion),
               activo    = true
         where id = v_cli_id;
    else
        insert into taller_clientes (empresa_id, nombre, rut, tipo, telefono, email, direccion,
                                     canal_pref, activo)
        values (p_empresa_id, v_nombre, v_rut, 'persona', v_tel, v_email, v_dir,
                coalesce(v_canal, 'auto'), true)
        returning id into v_cli_id;
    end if;

    -- ── Vehículo: por patente normalizada; si no existe se crea ───
    select id into v_veh_id from taller_vehiculos
     where empresa_id = p_empresa_id and patente_norm = v_pat;

    if v_veh_id is not null then
        update taller_vehiculos
           set cliente_id  = v_cli_id,
               marca       = coalesce(v_marca, marca),
               modelo      = coalesce(v_modelo, modelo),
               anio        = coalesce(v_anio, anio),
               color       = coalesce(v_color, color),
               vin         = coalesce(v_vin, vin),
               kilometraje = coalesce(p_km, kilometraje),
               activo      = true
         where id = v_veh_id;
    else
        insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio,
                                      color, kilometraje, vin, activo)
        values (p_empresa_id, v_cli_id, v_pat, v_marca, v_modelo, v_anio,
                v_color, coalesce(p_km, 0), v_vin, true)
        returning id into v_veh_id;
    end if;

    -- ── Presupuesto (N° correlativo con candado por taller) ───────
    perform pg_advisory_xact_lock(hashtextextended('presupuesto:' || p_empresa_id::text, 0));
    select coalesce(max(numero), 0) + 1 into v_numero
      from taller_presupuestos where empresa_id = p_empresa_id;

    insert into taller_presupuestos (
        empresa_id, numero, version, cliente_id, vehiculo_id, estado,
        fecha_emision, dias_validez, kilometraje, motivo, diagnostico,
        canal_aviso, usuario_rut)
    values (
        p_empresa_id, v_numero, 1, v_cli_id, v_veh_id, 'borrador',
        current_date, greatest(coalesce(p_validez, 15), 1), p_km,
        btrim(p_motivo), nullif(btrim(coalesce(p_diagnostico, '')), ''),
        v_canal, p_usuario)
    returning id into v_id;

    return jsonb_build_object('ok', true, 'presupuesto_id', v_id, 'numero', v_numero,
                              'cliente_id', v_cli_id, 'vehiculo_id', v_veh_id);

exception
    when unique_violation then
        return jsonb_build_object('ok', false,
            'error', 'Ya existe otro cliente con ese RUT o un vehículo con esa patente. Revisa los datos.');
    when others then
        return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

revoke all on function public.fn_taller_presupuesto_crear(uuid, jsonb, jsonb, integer, integer, text, text, text, text)
    from public;
grant execute on function public.fn_taller_presupuesto_crear(uuid, jsonb, jsonb, integer, integer, text, text, text, text)
    to anon, authenticated, service_role;


-- ── 4 · El documento completo (helper interno) ──────────────────
-- Lo que ve el cliente: datos del taller con logo, cliente, vehículo,
-- trabajo y valores. Sin costos, sin margen, sin códigos internos.
create or replace function public.fn_presupuesto_documento(p_presupuesto_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
    select jsonb_build_object(
        'presupuesto_id', p.id,
        'numero',         p.numero,
        'version',        p.version,
        'estado',         p.estado,
        'vencido',        (p.estado in ('borrador', 'enviado') and p.fecha_vencimiento < current_date),
        'puede_responder', (p.estado = 'enviado' and p.fecha_vencimiento >= current_date),
        'fecha_emision',  p.fecha_emision,
        'fecha_vencimiento', p.fecha_vencimiento,
        'dias_validez',   p.dias_validez,
        'kilometraje',    p.kilometraje,
        'motivo',         p.motivo,
        'diagnostico',    p.diagnostico,
        'condiciones',    coalesce(nullif(p.condiciones, ''), cfg.condiciones_presupuesto),
        'neto',           p.neto,
        'iva',            p.iva,
        'total',          p.total,
        'aprobado_por',   p.aprobado_por,
        'aprobado_at',    p.aprobado_at,
        'taller', jsonb_build_object(
            'nombre',     e.nombre,
            'logo_url',   e.logo_url,
            'rut',        cfg.rut,
            'giro',       cfg.giro,
            'direccion',  cfg.direccion,
            'comuna',     cfg.comuna,
            'ciudad',     cfg.ciudad,
            'telefono',   cfg.telefono,
            'whatsapp',   cfg.whatsapp,
            'email',      cfg.email,
            'sitio_web',  cfg.sitio_web,
            'pie',        cfg.pie_documentos),
        'cliente', jsonb_build_object(
            'nombre',     c.nombre,
            'rut',        c.rut,
            'telefono',   c.telefono,
            'email',      c.email,
            'direccion',  c.direccion),
        'vehiculo', jsonb_build_object(
            'patente',    v.patente,
            'marca',      v.marca,
            'modelo',     v.modelo,
            'anio',       v.anio,
            'color',      v.color,
            'vin',        v.vin),
        'items', (
            select coalesce(jsonb_agg(jsonb_build_object(
                       'tipo',            i.tipo,
                       'descripcion',     i.descripcion,
                       'cantidad',        i.cantidad,
                       'precio_unitario', i.precio_unitario,
                       'subtotal',        i.subtotal,
                       'opcional',        i.opcional) order by i.orden, i.created_at), '[]'::jsonb)
              from taller_presupuestos_items i
             where i.presupuesto_id = p.id)
    )
    from taller_presupuestos p
    left join empresas        e   on e.id = p.empresa_id
    left join taller_config   cfg on cfg.empresa_id = p.empresa_id
    left join taller_clientes c   on c.id = p.cliente_id
    left join taller_vehiculos v  on v.id = p.vehiculo_id
    where p.id = p_presupuesto_id;
$function$;

revoke all on function public.fn_presupuesto_documento(uuid) from public, anon, authenticated;
grant execute on function public.fn_presupuesto_documento(uuid) to service_role;


-- ── 5 · Enlace público (WhatsApp / correo) ──────────────────────
create or replace function public.fn_presupuesto_publico(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_id uuid; v_estado text;
begin
    if coalesce(length(p_token), 0) < 16 then
        return jsonb_build_object('ok', false, 'error', 'Enlace no válido.');
    end if;

    select id, estado into v_id, v_estado
      from taller_presupuestos where token_publico = p_token;

    if v_id is null or v_estado in ('borrador', 'anulado') then
        return jsonb_build_object('ok', false, 'error', 'Este presupuesto no está disponible.');
    end if;

    return jsonb_build_object('ok', true, 'presupuesto', fn_presupuesto_documento(v_id));
exception when others then
    return jsonb_build_object('ok', false, 'error', 'No se pudo cargar el presupuesto.');
end;
$function$;

create or replace function public.fn_presupuesto_publico_responder(
    p_token     text,
    p_respuesta text,
    p_por       text default null,
    p_motivo    text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_p taller_presupuestos%rowtype; v_por text := nullif(btrim(coalesce(p_por, '')), '');
begin
    -- Ya valida con el token; fn_responder_presupuesto no exige sesión de taller.
    perform set_config('arm.llamada_interna', 'on', true);

    if coalesce(length(p_token), 0) < 16 then
        return jsonb_build_object('ok', false, 'error', 'Enlace no válido.');
    end if;
    if p_respuesta not in ('aprobado', 'rechazado') then
        return jsonb_build_object('ok', false, 'error', 'Respuesta no válida.');
    end if;

    select * into v_p from taller_presupuestos where token_publico = p_token;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Presupuesto no encontrado.');
    end if;
    if v_p.estado <> 'enviado' then
        return jsonb_build_object('ok', false, 'error',
            'Este presupuesto ya no está pendiente de respuesta.');
    end if;
    if v_p.fecha_vencimiento < current_date then
        return jsonb_build_object('ok', false, 'error',
            'Este presupuesto venció. Pídele al taller uno actualizado.');
    end if;

    return fn_responder_presupuesto(
        v_p.empresa_id, v_p.id, p_respuesta, 'enlace',
        coalesce(v_por, 'Cliente (enlace)'), nullif(btrim(coalesce(p_motivo, '')), ''));
exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

revoke all on function public.fn_presupuesto_publico(text) from public;
revoke all on function public.fn_presupuesto_publico_responder(text, text, text, text) from public;
grant execute on function public.fn_presupuesto_publico(text) to anon, authenticated;
grant execute on function public.fn_presupuesto_publico_responder(text, text, text, text) to anon, authenticated;


-- ── 6 · Mi Vehículo (la app) recibe el documento completo ───────
-- Mismas claves de siempre + 'documento'. Quien no lo use no nota nada.
create or replace function public.fn_mv_vehiculo_presupuestos(p_autodoc_vehicle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_r jsonb;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;
    if not exists (select 1 from fn_mv_links() where autodoc_vehicle_id = p_autodoc_vehicle_id) then
        return jsonb_build_object('ok', false, 'error', 'Vehículo no vinculado a ningún taller.');
    end if;

    select coalesce(jsonb_agg(pr order by (pr->>'fecha_emision') desc, (pr->>'numero')::int desc), '[]'::jsonb)
      into v_r
    from (
        select jsonb_build_object(
            'presupuesto_id', p.id,
            'numero',         p.numero,
            'taller',         l.taller_nombre,
            'estado',         p.estado,
            'puede_responder', (p.estado = 'enviado'),
            'fecha_emision',  p.fecha_emision,
            'fecha_vencimiento', p.fecha_vencimiento,
            'motivo',         p.motivo,
            'diagnostico',    p.diagnostico,
            'condiciones',    p.condiciones,
            'neto',           p.neto,
            'iva',            p.iva,
            'total',          p.total,
            'items', (
                select coalesce(jsonb_agg(jsonb_build_object(
                            'descripcion',     i.descripcion,
                            'cantidad',        i.cantidad,
                            'precio_unitario', i.precio_unitario,
                            'subtotal',        i.subtotal,
                            'opcional',        i.opcional) order by i.orden, i.created_at), '[]'::jsonb)
                  from taller_presupuestos_items i
                 where i.presupuesto_id = p.id),
            'documento',      fn_presupuesto_documento(p.id)
        ) as pr
        from fn_mv_links() l
        join taller_presupuestos p on p.vehiculo_id = l.taller_vehiculo_id
        where l.autodoc_vehicle_id = p_autodoc_vehicle_id
          and p.estado in ('enviado', 'aprobado', 'rechazado', 'convertido')
    ) s;

    return jsonb_build_object('ok', true, 'presupuestos', v_r);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

revoke all on function public.fn_mv_vehiculo_presupuestos(uuid) from public, anon;
grant execute on function public.fn_mv_vehiculo_presupuestos(uuid) to authenticated;


-- ── 7 · Reenviar un presupuesto que ya está enviado ─────────────
-- El trigger de aviso solo salta al pasar a 'enviado'. Si el cliente no
-- vio el mensaje, el taller lo reenvía (opcionalmente por otro canal).
-- Devuelve por qué canales salió (vacío = no le llega por ningún lado).
create or replace function public.fn_taller_presupuesto_reenviar(
    p_empresa_id     uuid,
    p_presupuesto_id uuid,
    p_canal          text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_p       taller_presupuestos%rowtype;
    v_canal   text := nullif(btrim(coalesce(p_canal, '')), '');
    v_evento  uuid;
    v_canales jsonb;
begin
    perform public.taller_exigir_empresa(p_empresa_id);

    select * into v_p from taller_presupuestos
     where id = p_presupuesto_id and empresa_id = p_empresa_id;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Presupuesto no encontrado.');
    end if;
    if v_p.estado <> 'enviado' then
        return jsonb_build_object('ok', false, 'error', 'Solo se reenvía un presupuesto que está enviado.');
    end if;
    if v_canal is not null and v_canal not in ('auto', 'mi_vehiculo', 'whatsapp', 'ambos', 'ninguno') then
        return jsonb_build_object('ok', false, 'error', 'Canal de aviso no válido.');
    end if;

    if v_canal is not null then
        update taller_presupuestos set canal_aviso = v_canal where id = v_p.id;
    else
        v_canal := nullif(v_p.canal_aviso, '');
    end if;

    v_evento := fn_taller_emitir_evento(
        v_p.empresa_id, 'presupuesto_enviado',
        'Tienes un presupuesto por aprobar',
        coalesce('Total ' || to_char(v_p.total, 'FM999G999G999'), null),
        null, v_p.id, v_p.vehiculo_id, v_p.cliente_id,
        jsonb_build_object('numero', v_p.numero, 'total', v_p.total,
                           'token', v_p.token_publico, 'url', v_p.url_publica,
                           'canal', v_canal, 'reenvio', true));

    if v_evento is null then
        return jsonb_build_object('ok', false, 'error', 'No se pudo registrar el aviso.');
    end if;

    select coalesce(jsonb_agg(canal order by canal), '[]'::jsonb) into v_canales
      from taller_notificaciones where evento_id = v_evento;

    return jsonb_build_object('ok', true, 'canales', v_canales);
exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

revoke all on function public.fn_taller_presupuesto_reenviar(uuid, uuid, text) from public;
grant execute on function public.fn_taller_presupuesto_reenviar(uuid, uuid, text)
    to anon, authenticated, service_role;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select numero, token_publico, canal_aviso from taller_presupuestos limit 3;
-- select fn_presupuesto_publico('<token de un presupuesto enviado>');
-- select fn_presupuesto_publico('basura');   -- → Enlace no válido.
