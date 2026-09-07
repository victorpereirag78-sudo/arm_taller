-- ================================================================
-- 24_whatsapp_inbound.sql — ARM TALLER
-- FASE 1c: respuestas que llegan POR WhatsApp.
--
-- ⚠ REQUIERE sql/08 (presupuestos), sql/23 (notificaciones).
--
-- El webhook de WhatsApp (Edge Function 'whatsapp-webhook', service
-- role) recibe "APRUEBO" / "RECHAZO" y llama a esta función. No hay
-- auth.uid(): la identidad se valida por el TELÉFONO contra el cliente
-- dueño del presupuesto.
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================

-- Normaliza un teléfono a solo dígitos (para comparar +56 9 xxxx vs 56xxxx)
create or replace function fn_norm_telefono(p text)
returns text language sql immutable as $$
    select regexp_replace(coalesce(p, ''), '\D', '', 'g')
$$;


create or replace function fn_taller_wa_responder_presupuesto(
    p_telefono       text,
    p_respuesta      text,               -- 'aprobado' | 'rechazado'
    p_presupuesto_id uuid default null,
    p_motivo         text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_tel text := fn_norm_telefono(p_telefono);
    v_p   taller_presupuestos%rowtype;
begin
    if p_respuesta not in ('aprobado', 'rechazado') then
        return jsonb_build_object('ok', false, 'error', 'Respuesta no válida.');
    end if;
    if length(v_tel) < 8 then
        return jsonb_build_object('ok', false, 'error', 'Teléfono no válido.');
    end if;

    -- Presupuesto puntual, o el último 'enviado' de un cliente con ese teléfono
    if p_presupuesto_id is not null then
        select p.* into v_p
          from taller_presupuestos p
          join taller_clientes c on c.id = p.cliente_id
         where p.id = p_presupuesto_id
           and right(fn_norm_telefono(c.telefono), 8) = right(v_tel, 8);
    else
        select p.* into v_p
          from taller_presupuestos p
          join taller_clientes c on c.id = p.cliente_id
         where p.estado = 'enviado'
           and right(fn_norm_telefono(c.telefono), 8) = right(v_tel, 8)
         order by p.enviado_at desc nulls last
         limit 1;
    end if;

    if not found then
        return jsonb_build_object('ok', false,
            'error', 'No encontramos un presupuesto pendiente para ese número.');
    end if;
    if v_p.estado <> 'enviado' then
        return jsonb_build_object('ok', false,
            'error', 'Ese presupuesto ya no está pendiente.');
    end if;

    return fn_responder_presupuesto(
        v_p.empresa_id, v_p.id, p_respuesta,
        'whatsapp', 'Cliente (WhatsApp)', p_motivo)
        || jsonb_build_object('presupuesto_id', v_p.id, 'numero', v_p.numero);

exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$$;

revoke all on function fn_taller_wa_responder_presupuesto(text, text, uuid, text) from public;
grant execute on function fn_taller_wa_responder_presupuesto(text, text, uuid, text) to service_role;


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- select fn_taller_wa_responder_presupuesto('+56 9 3403 9462', 'aprobado');
