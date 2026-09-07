-- ================================================================
-- 22_historial_mecanico.sql — ARM TALLER → MI VEHÍCULO
-- FASE 1b punto 7: al ENTREGAR una OT, el trabajo entra solo al
-- historial mecánico del vehículo en Mi Vehículo.
--
-- ⚠ REQUIERE sql/18, sql/20.
-- ⚠ TOCA la tabla autodocumentos_maintenance_records (Mi Vehículo).
--   Los cambios son ADITIVOS (dos columnas nullable + un índice).
--   Reflejar en el repo ARM-DocsCars (supabase/migrations) para que
--   sus tipos y su ARQUITECTURA.md queden al día.
--
-- ── Qué se envía y qué NO ─────────────────────────────────────
-- SÍ: taller, fecha, kilómetros, descripción del trabajo + ítems,
--     mano de obra / repuestos / total (lo que el cliente pagó).
-- NO: costo interno del repuesto, margen, SKU, quién del taller.
-- La autorización es el vínculo ACTIVO; sin él no se sincroniza nada
-- (cliente que no usa Mi Vehículo → el taller sigue igual).
--
-- Idempotente. Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Marca de origen en el historial de Mi Vehículo
-- ════════════════════════════════════════════════════════════════
alter table autodocumentos_maintenance_records add column if not exists source     text;
alter table autodocumentos_maintenance_records add column if not exists source_ref  text;

-- Un registro por OT: evita duplicar si el trigger corre dos veces
create unique index if not exists ux_amr_source
    on autodocumentos_maintenance_records (source, source_ref)
    where source is not null;


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — El trigger: OT entregada → registro en Mi Vehículo
-- ════════════════════════════════════════════════════════════════

create or replace function fn_trg_ot_a_historial_mv()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_autodoc   uuid;
    v_owner     uuid;
    v_taller    text;
    v_mecanico  text;
    v_desc      text;
begin
    -- Solo en la transición a 'entregada'
    if new.estado <> 'entregada' or coalesce(old.estado, '') = 'entregada' then
        return new;
    end if;

    -- ¿El vehículo está vinculado a un usuario de Mi Vehículo?
    select v.autodoc_vehicle_id into v_autodoc
      from taller_vehiculo_vinculo v
     where v.taller_vehiculo_id = new.vehiculo_id
       and v.estado = 'activo'
       and v.autodoc_vehicle_id is not null
     limit 1;
    if v_autodoc is null then
        return new;
    end if;

    -- ¿Ya sincronizada esta OT?
    if exists (
        select 1 from autodocumentos_maintenance_records
         where source = 'arm_taller' and source_ref = new.id::text) then
        return new;
    end if;

    select nombre   into v_taller   from empresas where id = new.empresa_id;
    select owner_id into v_owner    from autodocumentos_vehicles where id = v_autodoc;
    select nombre   into v_mecanico from taller_empleados where id = new.mecanico_id;

    v_desc := coalesce(nullif(trim(new.trabajos_realizados), ''),
                       nullif(trim(new.motivo_ingreso), ''),
                       'Trabajo realizado');
    v_desc := v_desc || coalesce((
        select E'\n\nDetalle:\n- ' || string_agg(i.descripcion, E'\n- ' order by i.id)
          from taller_ordenes_items i
         where i.orden_id = new.id), '');

    -- total_cost es columna generada en Mi Vehículo (labor + parts): no se inserta
    insert into autodocumentos_maintenance_records (
        vehicle_id, type, description, performed_at, mileage_km,
        workshop, mechanic, labor_cost, parts_cost,
        notes, created_by, source, source_ref)
    values (
        v_autodoc, 'reparacion', v_desc,
        coalesce(new.fecha_entrega::date, current_date),
        new.kilometraje_ingreso,
        v_taller, v_mecanico,
        coalesce(new.total_mano_obra, 0),
        coalesce(new.total_repuestos, 0),
        'Importado desde ARM Taller · OT N° ' || new.numero,
        v_owner, 'arm_taller', new.id::text);

    return new;

exception when others then
    -- Nunca bloquear la entrega de la OT por un problema al sincronizar
    raise warning 'historial MV no sincronizado para OT %: %', new.numero, sqlerrm;
    return new;
end;
$$;

drop trigger if exists trg_ot_a_historial_mv on taller_ordenes;
create trigger trg_ot_a_historial_mv
    after update of estado on taller_ordenes
    for each row execute function fn_trg_ot_a_historial_mv();


-- ════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════
-- Con un vínculo activo para el vehículo de la OT:
--   update taller_ordenes set estado = 'entregada' where numero = <n> and estado = 'lista';
--   select type, description, workshop, performed_at, mileage_km,
--          labor_cost, parts_cost, total_cost, source, source_ref
--     from autodocumentos_maintenance_records where source = 'arm_taller';
--
-- Correr el update de nuevo NO debe crear un segundo registro.
