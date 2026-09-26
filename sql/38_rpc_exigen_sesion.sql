-- ════════════════════════════════════════════════════════════════
-- 38 · Las RPC del taller exigen la sesión del mismo taller
-- ════════════════════════════════════════════════════════════════
-- Auditoría 2026-09-25. Desde sql/26 las TABLAS taller_* están aisladas
-- por el token de sesión (x-taller-token → taller_empresa_actual()),
-- pero las RPC SECURITY DEFINER se saltan RLS y confiaban ciegamente en
-- el `p_empresa_id` que les manda el navegador. Con la clave anon
-- (pública) y el id de un taller (fn_directorio_talleres lo publica)
-- cualquiera podía mover stock, registrar ventas, abrir/cerrar caja o
-- leer reportes de cualquier taller. Además había funciones internas
-- expuestas a anon:
--   · fn_taller_wa_responder_presupuesto → aprobar/rechazar el presupuesto
--     de cualquier cliente sabiendo solo su teléfono.
--   · fn_taller_notif_pendientes_whatsapp → leer teléfonos y mensajes.
--   · fn_taller_emitir_evento / fn_taller_notif_marcar → inyectar o
--     manipular avisos a clientes.
--
-- Qué hace:
--   1. taller_exigir_empresa(p_empresa_id): corta si el taller pedido no
--      es el de la sesión. Deja pasar service_role, el SQL Editor/cron
--      (sin request de PostgREST) y las llamadas internas marcadas por
--      una función de confianza (arm.llamada_interna, transaccional).
--   2. Se inyecta `perform taller_exigir_empresa(p_empresa_id);` como
--      primera instrucción de cada RPC del taller. No se reescriben los
--      cuerpos a mano: se toma la definición viva y se le agrega esa
--      línea (idempotente: si ya la tiene, no la repite).
--   3. fn_mv_presupuesto_responder y fn_taller_wa_responder_presupuesto
--      llaman a fn_responder_presupuesto sin sesión de taller (vienen de
--      Mi Vehículo y de WhatsApp, y ya validaron al cliente): marcan la
--      llamada como interna.
--   4. fn_taller_vinculo_revocar: la vía "taller" ahora exige la sesión.
--   5. Funciones internas: sin EXECUTE para anon/authenticated.
--
-- No se tocan: fn_mv_solicitar_hora (pública a propósito: cualquier
-- usuario de Mi Vehículo pide hora en un taller del directorio),
-- fn_taller_siguiente_numero (SECURITY INVOKER: ya la aísla RLS),
-- fn_sesion_cambiar_taller (tiene su propio control de superadmin).
--
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

-- ── 1 · Guardia ─────────────────────────────────────────────────
-- ¿Contexto de confianza? Sí cuando:
--   · no es una petición de PostgREST (SQL Editor, pg_cron): PostgREST
--     siempre fija request.method; sin él no hay navegador de por medio;
--   · la petición viene con service_role (Edge Functions);
--   · una función de confianza marcó la llamada como interna dentro de
--     esta misma transacción (no se puede fijar desde PostgREST).
create or replace function public.taller_contexto_confiable()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
    select coalesce(current_setting('arm.llamada_interna', true), '') = 'on'
        or coalesce(current_setting('request.method', true), '') = ''
        or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
           = 'service_role';
$function$;

create or replace function public.taller_exigir_empresa(p_empresa_id uuid)
returns void
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
    if public.taller_contexto_confiable() then
        return;
    end if;

    if p_empresa_id is not null and p_empresa_id = public.taller_empresa_actual() then
        return;
    end if;

    raise exception 'Sesión de taller no válida para esta operación. Vuelve a iniciar sesión.'
        using errcode = '42501';
end;
$function$;

revoke all on function public.taller_contexto_confiable() from public;
revoke all on function public.taller_exigir_empresa(uuid) from public;
grant execute on function public.taller_contexto_confiable() to anon, authenticated, service_role;
grant execute on function public.taller_exigir_empresa(uuid) to anon, authenticated, service_role;

-- ── 2 · Inyectar la guardia en las RPC del taller ───────────────
do $$
declare
    v_fn   text;
    v_oid  oid;
    v_src  text;
    v_def  text;
    v_pos  int;
    v_new  text;
    v_hechas int := 0;
begin
    foreach v_fn in array array[
        'fn_abrir_caja','fn_agenda_inicial','fn_agendar_cita','fn_ajustar_stock_repuesto',
        'fn_anular_compra','fn_anular_venta','fn_aplicar_planes_vehiculo','fn_aprobar_liquidacion',
        'fn_cerrar_caja','fn_cita_a_orden','fn_cobrar_cuenta','fn_completar_mantencion',
        'fn_convertir_presupuesto_ot','fn_descontar_stock_repuesto','fn_devolver_stock_repuesto',
        'fn_entrada_stock_repuesto','fn_generar_comisiones','fn_marcar_avisada',
        'fn_nueva_version_presupuesto','fn_pagar_cuenta','fn_pagar_liquidacion','fn_planes_sugeridos',
        'fn_recibir_compra','fn_registrar_pago_orden','fn_registrar_venta','fn_reporte_mecanicos',
        'fn_reporte_presupuestos','fn_reporte_resumen','fn_responder_presupuesto','fn_resumen_agenda',
        'fn_resumen_mantenciones','fn_solicitud_a_cita','fn_taller_config',
        'fn_taller_presup_motivo_perdida','fn_taller_vinculo_invitar'
    ] loop
        select p.oid, p.prosrc into v_oid, v_src
          from pg_proc p
          join pg_language l on l.oid = p.prolang
         where p.pronamespace = 'public'::regnamespace
           and p.proname = v_fn
           and l.lanname = 'plpgsql';
        if not found then
            raise exception 'No existe (o no es plpgsql): %', v_fn;
        end if;

        continue when position('taller_exigir_empresa' in v_src) > 0;

        v_pos := strpos(lower(v_src), 'begin');
        if v_pos = 0 then
            raise exception 'Sin BEGIN: %', v_fn;
        end if;

        v_new := left(v_src, v_pos + 4)
              || E'\n    perform public.taller_exigir_empresa(p_empresa_id);'
              || substr(v_src, v_pos + 5);

        v_def := pg_get_functiondef(v_oid);
        if strpos(v_def, v_src) = 0 then
            raise exception 'No se pudo ubicar el cuerpo de %', v_fn;
        end if;

        execute replace(v_def, v_src, v_new);
        v_hechas := v_hechas + 1;
    end loop;
    raise notice 'Guardia agregada a % funciones', v_hechas;
end $$;

-- fn_reporte_gastos es LANGUAGE sql: se pasa a plpgsql con la guardia.
create or replace function public.fn_reporte_gastos(p_empresa_id uuid, p_desde date, p_hasta date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
    perform public.taller_exigir_empresa(p_empresa_id);
    return (
        select jsonb_build_object(
                   'ok', true,
                   'total', coalesce(sum(monto), 0),
                   'cantidad', count(*),
                   'por_categoria', (
                       select coalesce(jsonb_object_agg(categoria, t), '{}'::jsonb)
                         from (select categoria, sum(monto) as t
                                 from taller_gastos
                                where empresa_id = p_empresa_id
                                  and fecha between p_desde and p_hasta
                                group by categoria) x))
          from taller_gastos
         where empresa_id = p_empresa_id
           and fecha between p_desde and p_hasta
    );
end;
$function$;

-- ── 3 · Llamadas internas de confianza ──────────────────────────
do $$
declare
    v_fn  text;
    v_oid oid;
    v_src text;
    v_pos int;
begin
    foreach v_fn in array array['fn_mv_presupuesto_responder', 'fn_taller_wa_responder_presupuesto'] loop
        select p.oid, p.prosrc into v_oid, v_src
          from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = v_fn;
        continue when position('arm.llamada_interna' in v_src) > 0;
        v_pos := strpos(lower(v_src), 'begin');
        execute replace(pg_get_functiondef(v_oid), v_src,
            left(v_src, v_pos + 4)
            || E'\n    -- Ya valida al cliente; fn_responder_presupuesto no exige sesión de taller.'
            || E'\n    perform set_config(''arm.llamada_interna'', ''on'', true);'
            || substr(v_src, v_pos + 5));
    end loop;
end $$;

-- ── 4 · Revocar vínculo: la vía "taller" exige la sesión ────────
do $$
declare
    v_oid oid;
    v_src text;
    v_old text := 'if p_empresa_id is not null and p_empresa_id = v_vin.empresa_id then';
    v_new text := 'if p_empresa_id is not null and p_empresa_id = v_vin.empresa_id'
               || ' and (p_empresa_id = taller_empresa_actual() or taller_contexto_confiable()) then';
begin
    select p.oid, p.prosrc into v_oid, v_src
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = 'fn_taller_vinculo_revocar';
    if position('taller_empresa_actual' in v_src) > 0 then
        return;
    end if;
    if position(v_old in v_src) = 0 then
        raise exception 'fn_taller_vinculo_revocar cambió: revisar a mano';
    end if;
    execute replace(pg_get_functiondef(v_oid), v_src, replace(v_src, v_old, v_new));
end $$;

-- ── 5 · Funciones internas: fuera del alcance del navegador ─────
do $$
declare
    r record;
begin
    for r in
        select p.oid::regprocedure as fn
          from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname in ('fn_taller_wa_responder_presupuesto',
                             'fn_taller_notif_pendientes_whatsapp',
                             'fn_taller_notif_marcar',
                             'fn_taller_emitir_evento',
                             'fn_taller_recordatorios_citas',
                             'fn_taller_marcar_referido')
    loop
        execute format('revoke all on function %s from public, anon, authenticated', r.fn);
        execute format('grant execute on function %s to service_role', r.fn);
    end loop;
end $$;

-- ── Verificación ────────────────────────────────────────────────
select p.proname,
       position('taller_exigir_empresa' in p.prosrc) > 0 as con_guardia,
       has_function_privilege('anon', p.oid, 'execute')  as anon_ejecuta
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and (p.proname like 'fn_taller_%' or p.proname in (
        'fn_abrir_caja','fn_registrar_venta','fn_ajustar_stock_repuesto','fn_reporte_gastos',
        'fn_responder_presupuesto','fn_mv_presupuesto_responder'))
 order by 1;
