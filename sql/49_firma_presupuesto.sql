-- ================================================================
-- 49_firma_presupuesto.sql — ARM TALLER
-- Firma en línea: el cliente firma con el dedo (o el mouse) al aprobar
-- el presupuesto desde el enlace de WhatsApp.
--
-- Qué pasa cuando firma:
--   1. La firma (PNG pequeño) queda guardada en el presupuesto, con la hora.
--   2. El presupuesto pasa a "aprobado" (vía 'enlace', con su nombre).
--   3. Se convierte solo en orden de trabajo: el vehículo queda ingresado
--      al flujo del taller (presupuesto "convertido"). Si no se puede
--      (por ejemplo falta stock de un repuesto), queda "aprobado" con la
--      firma y el taller lo convierte a mano, igual que antes.
--   4. El documento (taller, enlace público y Mi Vehículo) muestra la firma.
--
-- La firma NO va a Storage: pesa ~5-15 KB y vive junto al presupuesto,
-- así viaja con el documento sin permisos extra.
--
-- Idempotente: se puede correr más de una vez.
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ── 1 · Columnas ────────────────────────────────────────────────
alter table taller_presupuestos
    add column if not exists firma_imagen text,
    add column if not exists firma_at     timestamptz;

alter table taller_presupuestos drop constraint if exists taller_presupuestos_firma_check;
alter table taller_presupuestos add constraint taller_presupuestos_firma_check
    check (firma_imagen is null
           or (firma_imagen like 'data:image/png;base64,%' and length(firma_imagen) <= 150000));

comment on column taller_presupuestos.firma_imagen is
    'Firma del cliente al aprobar por el enlace público: data URL PNG (máx. ~110 KB).';


-- ── 2 · El documento trae la firma ──────────────────────────────
-- Mismo cuerpo que sql/44; lo nuevo son 'firma' y 'firma_at'.
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
        'firma',          p.firma_imagen,
        'firma_at',       p.firma_at,
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


-- ── 3 · Aprobar por el enlace, con firma ────────────────────────
-- Cambia la firma de la función (suma p_firma): se elimina la versión de
-- 4 parámetros para que PostgREST no vea dos candidatas.
drop function if exists public.fn_presupuesto_publico_responder(text, text, text, text);

create or replace function public.fn_presupuesto_publico_responder(
    p_token     text,
    p_respuesta text,
    p_por       text default null,
    p_motivo    text default null,
    p_firma     text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_p     taller_presupuestos%rowtype;
    v_por   text := nullif(btrim(coalesce(p_por, '')), '');
    v_res   jsonb;
    v_conv  jsonb;
begin
    -- Ya valida con el token; las RPC que llama no exigen sesión de taller.
    perform set_config('arm.llamada_interna', 'on', true);

    if coalesce(length(p_token), 0) < 16 then
        return jsonb_build_object('ok', false, 'error', 'Enlace no válido.');
    end if;
    if p_respuesta not in ('aprobado', 'rechazado') then
        return jsonb_build_object('ok', false, 'error', 'Respuesta no válida.');
    end if;

    select * into v_p from taller_presupuestos where token_publico = p_token for update;
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

    -- Aprobar exige firma: es la constancia de quién autorizó.
    if p_respuesta = 'aprobado' then
        if p_firma is null
           or p_firma not like 'data:image/png;base64,%'
           or length(p_firma) > 150000
           or length(p_firma) < 400 then
            return jsonb_build_object('ok', false, 'error', 'Falta tu firma para aprobar.');
        end if;
        update taller_presupuestos
           set firma_imagen = p_firma, firma_at = now()
         where id = v_p.id;
    end if;

    v_res := fn_responder_presupuesto(
        v_p.empresa_id, v_p.id, p_respuesta, 'enlace',
        coalesce(v_por, 'Cliente (enlace)'), nullif(btrim(coalesce(p_motivo, '')), ''));

    if coalesce((v_res->>'ok')::boolean, false) = false then
        -- fn_responder_presupuesto no pudo: que la firma no quede huérfana
        update taller_presupuestos set firma_imagen = null, firma_at = null where id = v_p.id;
        return v_res;
    end if;

    -- Aprobado y firmado → entra al taller como orden de trabajo.
    if p_respuesta = 'aprobado' then
        v_conv := fn_convertir_presupuesto_ot(v_p.empresa_id, v_p.id, 'firma-cliente');
        v_res := v_res || jsonb_build_object(
            'convertido', coalesce((v_conv->>'ok')::boolean, false),
            'orden_numero', v_conv->'numero',
            'aviso', case when coalesce((v_conv->>'ok')::boolean, false) then null
                          else v_conv->>'error' end);
    end if;

    return v_res;
exception when others then
    return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

revoke all on function public.fn_presupuesto_publico_responder(text, text, text, text, text) from public;
grant execute on function public.fn_presupuesto_publico_responder(text, text, text, text, text)
    to anon, authenticated;


-- ── Verificación ────────────────────────────────────────────────
-- select column_name from information_schema.columns
--  where table_name = 'taller_presupuestos' and column_name like 'firma%';   -- 2 filas
-- select proname, pronargs from pg_proc where proname = 'fn_presupuesto_publico_responder';  -- 1 fila, 5 args
