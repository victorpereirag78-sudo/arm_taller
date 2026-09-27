-- ════════════════════════════════════════════════════════════════
-- 43 · Alerta de vehículo robado en los talleres ARM
-- ════════════════════════════════════════════════════════════════
-- Si un vehículo con reporte de robo de Mi Vehículo (con "avisar a la
-- comunidad" activo: plan pagado, una alerta a la vez, 30 días — ver
-- ARM-Documentos-auto/supabase/migrations/0020) entra a un taller ARM:
--
--   · El TALLER ve un aviso rojo al escribir la patente en Recepción, en
--     la lista de Vehículos y en el detalle de la OT: "reporte de robo
--     activo desde X — no enfrentes al cliente, llama al 133". Nunca
--     datos del dueño.
--   · Al crear la OT (el auto está físicamente en el taller), el DUEÑO
--     recibe un push: "tu vehículo apareció en un taller de la red ARM en
--     <comuna>". No se le dice cuál taller, para que no vaya a enfrentar
--     a nadie: Carabineros puede pedirle el detalle a ARM Sistemas.
--   · Los ADMINISTRADORES de la plataforma (ARM Sistemas) reciben el
--     detalle completo (taller y N° de OT) para colaborar con la policía.
--   · Queda registrado como avistamiento (una vez por taller por día).
--
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

-- Un avistamiento puede venir de un taller (no de una persona).
alter table public.autodocumentos_theft_sightings
    alter column seen_by drop not null,
    add column if not exists taller_empresa_id uuid references public.empresas(id);

-- ¿Esta patente tiene un reporte de robo difundido y vigente?
create or replace function public.fn_taller_alerta_robo(p_empresa_id uuid, p_patente text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
    v_t record;
begin
    perform public.taller_exigir_empresa(p_empresa_id);
    if length(fn_norm_patente(p_patente)) < 5 then
        return jsonb_build_object('robado', false);
    end if;

    select t.stolen_at, t.comuna, t.region into v_t
      from autodocumentos_theft_reports t
      join autodocumentos_vehicles v on v.id = t.vehicle_id
     where t.status = 'activo' and t.broadcast
       and t.broadcast_at > now() - interval '30 days'
       and fn_norm_patente(v.plate) = fn_norm_patente(p_patente)
     order by t.stolen_at desc
     limit 1;

    if not found then
        return jsonb_build_object('robado', false);
    end if;
    return jsonb_build_object('robado', true, 'desde', v_t.stolen_at,
                              'comuna', v_t.comuna, 'region', v_t.region);
end;
$function$;

-- Vehículos de este taller con reporte de robo vigente (para la lista).
create or replace function public.fn_taller_alertas_robo_flota(p_empresa_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
    perform public.taller_exigir_empresa(p_empresa_id);
    return coalesce((
        select jsonb_agg(tv.id)
          from taller_vehiculos tv
         where tv.empresa_id = p_empresa_id
           and exists (
               select 1
                 from autodocumentos_theft_reports t
                 join autodocumentos_vehicles v on v.id = t.vehicle_id
                where t.status = 'activo' and t.broadcast
                  and t.broadcast_at > now() - interval '30 days'
                  and fn_norm_patente(v.plate) = tv.patente_norm)), '[]'::jsonb);
end;
$function$;

revoke all on function public.fn_taller_alerta_robo(uuid, text) from public;
revoke all on function public.fn_taller_alertas_robo_flota(uuid) from public;
grant execute on function public.fn_taller_alerta_robo(uuid, text) to anon, authenticated, service_role;
grant execute on function public.fn_taller_alertas_robo_flota(uuid) to anon, authenticated, service_role;

-- Al abrir una OT de un vehículo robado: avistamiento + avisos.
create or replace function public.fn_trg_ot_alerta_robo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_pat    text;
    v_t      record;
    v_comuna text;
    v_taller text;
    v_p      uuid;
begin
    begin
        select patente_norm into v_pat from taller_vehiculos where id = new.vehiculo_id;
        if v_pat is null then
            return new;
        end if;

        select t.id, t.vehicle_id, v.owner_id, upper(v.plate) as plate into v_t
          from autodocumentos_theft_reports t
          join autodocumentos_vehicles v on v.id = t.vehicle_id
         where t.status = 'activo' and t.broadcast
           and t.broadcast_at > now() - interval '30 days'
           and fn_norm_patente(v.plate) = v_pat
         limit 1;
        if not found then
            return new;
        end if;

        -- Una vez por taller por día.
        if exists (select 1 from autodocumentos_theft_sightings
                    where report_id = v_t.id and taller_empresa_id = new.empresa_id
                      and created_at > now() - interval '24 hours') then
            return new;
        end if;

        select nullif(btrim(comuna), '') into v_comuna from taller_config where empresa_id = new.empresa_id;
        select nombre into v_taller from empresas where id = new.empresa_id;

        insert into autodocumentos_theft_sightings (report_id, seen_by, taller_empresa_id, place)
        values (v_t.id, null, new.empresa_id,
                'Ingresó a un taller de la red ARM' || coalesce(' en ' || v_comuna, ''));

        for v_p in
            select v_t.owner_id
            union
            select a.user_id from autodocumentos_vehicle_access a
             where a.vehicle_id = v_t.vehicle_id and a.can_view_documents
        loop
            perform autodocumentos_push_encolar(
                v_p, '🔧 Tu vehículo apareció en un taller',
                v_t.plate || ' ingresó a un taller de la red ARM' || coalesce(' en ' || v_comuna, '')
                    || '. No vayas por tu cuenta: llama al 133 (Carabineros puede pedir el detalle a ARM Sistemas).',
                '/vehiculos/' || v_t.vehicle_id || '/robo', 'taller-robo-' || v_t.id, true);
        end loop;

        for v_p in select id from autodocumentos_profiles where is_admin loop
            perform autodocumentos_push_encolar(
                v_p, '🚨 Auto robado en un taller ARM',
                v_t.plate || ' · ' || coalesce(v_taller, 'taller') || coalesce(' · ' || v_comuna, '')
                    || ' · OT N° ' || new.numero,
                '/admin', 'admin-robo-' || v_t.id, true);
        end loop;
    exception when others then
        -- Nunca bloquear la OT del taller por esto.
        raise warning 'alerta de robo no registrada para OT %: %', new.numero, sqlerrm;
    end;
    return new;
end;
$function$;

revoke all on function public.fn_trg_ot_alerta_robo() from public, anon, authenticated;

drop trigger if exists trg_ot_alerta_robo on public.taller_ordenes;
create trigger trg_ot_alerta_robo
    after insert on public.taller_ordenes
    for each row execute function public.fn_trg_ot_alerta_robo();
