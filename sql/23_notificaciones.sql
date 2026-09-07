-- ================================================================
-- 23_notificaciones.sql — ARM TALLER
-- FASE 1c: capa central de notificaciones (eventos → canales).
--
-- ⚠ REQUIERE sql/18, sql/20, sql/21.
--
-- ── La idea ───────────────────────────────────────────────────
-- UN solo lugar registra los eventos del taller (OT recepcionada,
-- presupuesto enviado, vehículo listo, …). Ese lugar decide por qué
-- canal avisar al cliente:
--     · Mi Vehículo  (si el vehículo está vinculado)
--     · WhatsApp      (si hay teléfono y no usa Mi Vehículo)
--     · ambos / ninguno   (preferencia del cliente)
-- Y deja una fila en la "bandeja de salida" (taller_notificaciones)
-- por cada canal. NADIE arma mensajes por canal a mano: el dispatcher
-- (Edge Function) toma las de WhatsApp; Mi Vehículo lee las suyas.
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Preferencia de canal del cliente
-- ════════════════════════════════════════════════════════════════
-- 'auto' = el sistema decide: Mi Vehículo si el auto está vinculado,
--          si no WhatsApp (si hay teléfono).

alter table taller_clientes
    add column if not exists canal_pref text not null default 'auto';

do $$
begin
    alter table taller_clientes drop constraint if exists taller_clientes_canal_pref_check;
    alter table taller_clientes add constraint taller_clientes_canal_pref_check
        check (canal_pref in ('auto', 'mi_vehiculo', 'whatsapp', 'ambos', 'ninguno'));
end $$;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — El log de eventos
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_notificacion_eventos (
    id             uuid primary key default gen_random_uuid(),
    empresa_id     uuid not null,
    tipo           text not null,
    orden_id       uuid,
    presupuesto_id uuid,
    vehiculo_id    uuid,
    cliente_id     uuid,
    titulo         text not null,
    detalle        text,
    payload        jsonb not null default '{}',
    creado_at      timestamptz not null default now()
);

create index if not exists idx_notif_ev_empresa
    on taller_notificacion_eventos (empresa_id, creado_at desc);
create index if not exists idx_notif_ev_orden
    on taller_notificacion_eventos (orden_id);


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — La bandeja de salida (una fila por canal)
-- ════════════════════════════════════════════════════════════════

create table if not exists taller_notificaciones (
    id            uuid primary key default gen_random_uuid(),
    evento_id     uuid not null references taller_notificacion_eventos(id) on delete cascade,
    empresa_id    uuid not null,
    canal         text not null check (canal in ('mi_vehiculo', 'whatsapp', 'email')),
    destinatario  text,          -- teléfono / autodoc_vehicle_id / email
    estado        text not null default 'pendiente'
                  check (estado in ('pendiente', 'enviado', 'error', 'descartado', 'leido')),
    intento       integer not null default 0,
    enviado_at    timestamptz,
    leido_at      timestamptz,
    error         text,
    proveedor_ref text,          -- id del mensaje en Meta / Twilio
    creado_at     timestamptz not null default now()
);

create index if not exists idx_notif_pendientes
    on taller_notificaciones (canal, creado_at) where estado = 'pendiente';
create index if not exists idx_notif_dest
    on taller_notificaciones (canal, destinatario);
create index if not exists idx_notif_evento
    on taller_notificaciones (evento_id);


-- ════════════════════════════════════════════════════════════════
-- PASO 4 — Emitir un evento y abanicarlo a los canales
-- ════════════════════════════════════════════════════════════════

create or replace function fn_taller_emitir_evento(
    p_empresa_id     uuid,
    p_tipo           text,
    p_titulo         text,
    p_detalle        text default null,
    p_orden_id       uuid default null,
    p_presupuesto_id uuid default null,
    p_vehiculo_id    uuid default null,
    p_cliente_id     uuid default null,
    p_payload        jsonb default '{}'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_evento   uuid;
    v_cli      taller_clientes%rowtype;
    v_autodoc  uuid;
    v_pref     text;
    v_mv       boolean;
    v_wa       boolean;
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

    v_pref := coalesce(v_cli.canal_pref, 'auto');
    if v_pref = 'ninguno' then
        return v_evento;
    end if;

    v_mv := (v_pref in ('mi_vehiculo', 'ambos'))
            or (v_pref = 'auto' and v_autodoc is not null);
    v_wa := (v_pref in ('whatsapp', 'ambos'))
            or (v_pref = 'auto' and v_autodoc is null and coalesce(v_cli.telefono, '') <> '');

    if v_mv and v_autodoc is not null then
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
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 5 — Triggers que emiten los eventos
-- ════════════════════════════════════════════════════════════════

-- ── OT cambia de estado ────────────────────────────────────────
create or replace function fn_trg_ot_evento_notif()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_titulo text;
    v_veh    text;
begin
    if tg_op <> 'UPDATE' or new.estado is not distinct from old.estado then
        return new;
    end if;

    select trim(coalesce(marca, '') || ' ' || coalesce(modelo, '')) into v_veh
      from taller_vehiculos where id = new.vehiculo_id;
    v_veh := coalesce(nullif(v_veh, ''), 'tu vehículo');

    v_titulo := case new.estado
        when 'recepcion'            then 'Recibimos ' || v_veh
        when 'diagnostico_terminado' then 'Terminamos el diagnóstico de ' || v_veh
        when 'presupuesto'          then 'Tienes un presupuesto por revisar'
        when 'esperando_repuestos'  then 'Estamos esperando repuestos para ' || v_veh
        when 'reparacion'           then v_veh || ' está en reparación'
        when 'trabajo_terminado'    then 'Terminamos el trabajo en ' || v_veh
        when 'lista'                then '¡' || v_veh || ' está listo para retirar!'
        when 'entregada'            then v_veh || ' fue entregado. ¡Gracias!'
        when 'anulada'              then 'Se anuló la orden de ' || v_veh
        else null
    end;

    if v_titulo is null then
        return new;   -- estado interno, no se avisa
    end if;

    perform fn_taller_emitir_evento(
        new.empresa_id, 'ot_' || new.estado, v_titulo,
        'Orden N° ' || new.numero,
        new.id, null, new.vehiculo_id, new.cliente_id,
        jsonb_build_object('orden_numero', new.numero, 'estado', new.estado));

    return new;
end;
$$;

drop trigger if exists trg_ot_evento_notif on taller_ordenes;
create trigger trg_ot_evento_notif
    after update of estado on taller_ordenes
    for each row execute function fn_trg_ot_evento_notif();


-- ── Presupuesto enviado al cliente ─────────────────────────────
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
            jsonb_build_object('numero', new.numero, 'total', new.total));
    end if;
    return new;
end;
$$;

drop trigger if exists trg_presup_evento_notif on taller_presupuestos;
create trigger trg_presup_evento_notif
    after update of estado on taller_presupuestos
    for each row execute function fn_trg_presup_evento_notif();


-- ════════════════════════════════════════════════════════════════
-- PASO 6 — Lectura desde Mi Vehículo (la "campanita")
-- ════════════════════════════════════════════════════════════════

create or replace function fn_mv_novedades(p_autodoc_vehicle_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_r jsonb; v_n integer;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;
    if not exists (select 1 from fn_mv_links() where autodoc_vehicle_id = p_autodoc_vehicle_id) then
        return jsonb_build_object('ok', false, 'error', 'Vehículo no vinculado.');
    end if;

    select
        coalesce(jsonb_agg(jsonb_build_object(
            'id', n.id, 'tipo', e.tipo, 'titulo', e.titulo, 'detalle', e.detalle,
            'ts', e.creado_at, 'leido', n.estado = 'leido',
            'orden_id', e.orden_id, 'presupuesto_id', e.presupuesto_id
        ) order by e.creado_at desc), '[]'::jsonb),
        count(*) filter (where n.estado <> 'leido')
      into v_r, v_n
    from taller_notificaciones n
    join taller_notificacion_eventos e on e.id = n.evento_id
    where n.canal = 'mi_vehiculo'
      and n.destinatario = p_autodoc_vehicle_id::text;

    return jsonb_build_object('ok', true, 'novedades', v_r, 'no_leidas', coalesce(v_n, 0));

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


create or replace function fn_mv_novedad_leida(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_dest text;
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;

    select destinatario into v_dest
      from taller_notificaciones
     where id = p_id and canal = 'mi_vehiculo';
    if not found then
        return jsonb_build_object('ok', false, 'error', 'Novedad no encontrada.');
    end if;
    if not exists (
        select 1 from fn_mv_links() where autodoc_vehicle_id::text = v_dest) then
        return jsonb_build_object('ok', false, 'error', 'Sin permiso.');
    end if;

    update taller_notificaciones
       set estado = 'leido', leido_at = now()
     where id = p_id and estado <> 'leido';

    return jsonb_build_object('ok', true);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


create or replace function fn_mv_novedades_todas_leidas(p_autodoc_vehicle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        return jsonb_build_object('ok', false, 'error', 'Sin sesión.');
    end if;
    if not exists (select 1 from fn_mv_links() where autodoc_vehicle_id = p_autodoc_vehicle_id) then
        return jsonb_build_object('ok', false, 'error', 'Vehículo no vinculado.');
    end if;

    update taller_notificaciones
       set estado = 'leido', leido_at = now()
     where canal = 'mi_vehiculo'
       and destinatario = p_autodoc_vehicle_id::text
       and estado <> 'leido';

    return jsonb_build_object('ok', true);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 7 — Cola para el dispatcher de WhatsApp
-- ════════════════════════════════════════════════════════════════
-- La Edge Function 'notification-dispatch' (service role) llama esto,
-- envía por WhatsApp, y marca cada fila con fn_taller_notif_marcar.

create or replace function fn_taller_notif_pendientes_whatsapp(p_limite integer default 25)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'id',            n.id,
        'telefono',      n.destinatario,
        'titulo',        e.titulo,
        'detalle',       e.detalle,
        'tipo',          e.tipo,
        'taller',        emp.nombre,
        'orden_id',      e.orden_id,
        'presupuesto_id', e.presupuesto_id,
        'payload',       e.payload
    ) order by n.creado_at), '[]'::jsonb)
    from taller_notificaciones n
    join taller_notificacion_eventos e on e.id = n.evento_id
    join empresas emp on emp.id = n.empresa_id
    where n.canal = 'whatsapp' and n.estado = 'pendiente'
      and n.intento < 5
    limit greatest(coalesce(p_limite, 25), 1)
$$;


create or replace function fn_taller_notif_marcar(
    p_id           uuid,
    p_estado       text,               -- 'enviado' | 'error' | 'descartado'
    p_proveedor_ref text default null,
    p_error        text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_estado not in ('enviado', 'error', 'descartado') then
        return jsonb_build_object('ok', false, 'error', 'Estado no válido.');
    end if;

    update taller_notificaciones
       set estado        = p_estado,
           intento       = intento + 1,
           enviado_at    = case when p_estado = 'enviado' then now() else enviado_at end,
           proveedor_ref = coalesce(p_proveedor_ref, proveedor_ref),
           error         = p_error
     where id = p_id;

    return jsonb_build_object('ok', found);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;


-- ════════════════════════════════════════════════════════════════
-- PASO 8 — Permisos
-- ════════════════════════════════════════════════════════════════

grant select, insert, update, delete on public.taller_notificacion_eventos to anon, authenticated;
grant select, insert, update, delete on public.taller_notificaciones       to anon, authenticated;

alter table public.taller_notificacion_eventos disable row level security;
alter table public.taller_notificaciones       disable row level security;

revoke all on function fn_mv_novedades(uuid)                 from public;
revoke all on function fn_mv_novedad_leida(uuid)             from public;
revoke all on function fn_mv_novedades_todas_leidas(uuid)    from public;
grant execute on function fn_mv_novedades(uuid)              to authenticated;
grant execute on function fn_mv_novedad_leida(uuid)          to authenticated;
grant execute on function fn_mv_novedades_todas_leidas(uuid) to authenticated;

-- El dispatcher corre con service role; estas quedan fuera de anon.
revoke all on function fn_taller_emitir_evento(uuid, text, text, text, uuid, uuid, uuid, uuid, jsonb) from public;
revoke all on function fn_taller_notif_pendientes_whatsapp(integer) from public;
revoke all on function fn_taller_notif_marcar(uuid, text, text, text) from public;
grant execute on function fn_taller_emitir_evento(uuid, text, text, text, uuid, uuid, uuid, uuid, jsonb) to anon, authenticated, service_role;
grant execute on function fn_taller_notif_pendientes_whatsapp(integer) to service_role;
grant execute on function fn_taller_notif_marcar(uuid, text, text, text) to service_role;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- -- Mover una OT y ver el evento + la notificación generada:
-- update taller_ordenes set estado = 'lista' where numero = 1 and estado = 'trabajo_terminado';
-- select e.tipo, e.titulo, n.canal, n.estado, n.destinatario
--   from taller_notificacion_eventos e
--   join taller_notificaciones n on n.evento_id = e.id
--  order by e.creado_at desc limit 5;
