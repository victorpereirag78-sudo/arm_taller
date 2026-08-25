-- ================================================================
-- 00_diagnostico.sql — ARM TALLER
-- Qué scripts están aplicados y qué falta.
--
-- No modifica nada: solo mira. Se puede correr cuantas veces quieras.
-- Ejecutar en: Supabase → SQL Editor y mirar el resultado.
-- ================================================================

with esperado(script, tipo, nombre) as (
  values
    ('01_seguridad_login','funcion','fn_login_taller'),
    ('01_seguridad_login','funcion','fn_cambiar_pass_taller'),
    ('02_inventario','tabla','taller_movimientos_stock'),
    ('02_inventario','vista','v_taller_reposicion'),
    ('02_inventario','funcion','fn_entrada_stock_repuesto'),
    ('02_inventario','funcion','fn_ajustar_stock_repuesto'),
    ('02_inventario','funcion','fn_descontar_stock_repuesto'),
    ('02_inventario','funcion','fn_devolver_stock_repuesto'),
    ('03_ventas_caja','tabla','taller_cajas'),
    ('03_ventas_caja','tabla','taller_movimientos_caja'),
    ('03_ventas_caja','tabla','taller_ventas_items'),
    ('03_ventas_caja','vista','v_taller_ordenes_saldo'),
    ('03_ventas_caja','funcion','fn_abrir_caja'),
    ('03_ventas_caja','funcion','fn_cerrar_caja'),
    ('03_ventas_caja','funcion','fn_registrar_venta'),
    ('03_ventas_caja','funcion','fn_anular_venta'),
    ('03_ventas_caja','funcion','fn_registrar_pago_orden'),
    ('04_empleados_comisiones','tabla','taller_empleados'),
    ('04_empleados_comisiones','tabla','taller_reglas_comision'),
    ('04_empleados_comisiones','tabla','taller_liquidaciones'),
    ('04_empleados_comisiones','tabla','taller_liquidaciones_detalle'),
    ('04_empleados_comisiones','funcion','fn_registrar_venta'),
    ('04_empleados_comisiones','funcion','fn_generar_comisiones'),
    ('04_empleados_comisiones','funcion','fn_aprobar_liquidacion'),
    ('04_empleados_comisiones','funcion','fn_pagar_liquidacion'),
    ('05_compras_cxp','tabla','taller_proveedores'),
    ('05_compras_cxp','tabla','taller_compras'),
    ('05_compras_cxp','tabla','taller_compras_items'),
    ('05_compras_cxp','tabla','taller_cuentas_pagar'),
    ('05_compras_cxp','vista','v_taller_cxp_saldo'),
    ('05_compras_cxp','vista','v_taller_proveedores_saldo'),
    ('05_compras_cxp','funcion','fn_recalcular_compra'),
    ('05_compras_cxp','funcion','fn_recibir_compra'),
    ('05_compras_cxp','funcion','fn_anular_compra'),
    ('05_compras_cxp','funcion','fn_pagar_cuenta'),
    ('06_reportes','vista','v_taller_ot_rentabilidad'),
    ('06_reportes','vista','v_taller_venta_rentabilidad'),
    ('06_reportes','vista','v_taller_rotacion_repuestos'),
    ('06_reportes','funcion','fn_reporte_resumen'),
    ('06_reportes','funcion','fn_reporte_mecanicos'),
    ('07_mantenciones','tabla','taller_planes_mantencion'),
    ('07_mantenciones','tabla','taller_mantenciones'),
    ('07_mantenciones','vista','v_taller_mantenciones_pendientes'),
    ('07_mantenciones','funcion','fn_planes_sugeridos'),
    ('07_mantenciones','funcion','fn_aplicar_planes_vehiculo'),
    ('07_mantenciones','funcion','fn_completar_mantencion'),
    ('07_mantenciones','funcion','fn_marcar_avisada'),
    ('07_mantenciones','funcion','fn_resumen_mantenciones'),
    ('08_presupuestos','tabla','taller_presupuestos'),
    ('08_presupuestos','tabla','taller_presupuestos_items'),
    ('08_presupuestos','vista','v_taller_presupuestos'),
    ('08_presupuestos','funcion','fn_nueva_version_presupuesto'),
    ('08_presupuestos','funcion','fn_convertir_presupuesto_ot'),
    ('08_presupuestos','funcion','fn_responder_presupuesto'),
    ('08_presupuestos','funcion','fn_reporte_presupuestos'),
    ('09_agenda','tabla','taller_bahias'),
    ('09_agenda','tabla','taller_config_agenda'),
    ('09_agenda','tabla','taller_citas'),
    ('09_agenda','vista','v_taller_citas'),
    ('09_agenda','funcion','fn_agendar_cita'),
    ('09_agenda','funcion','fn_cita_a_orden'),
    ('09_agenda','funcion','fn_resumen_agenda'),
    ('09_agenda','funcion','fn_agenda_inicial'),
    ('10_taller_admin','tabla','taller_config'),
    ('10_taller_admin','vista','v_taller_empresas'),
    ('10_taller_admin','funcion','fn_taller_config'),
    ('10_taller_admin','funcion','fn_es_superadmin'),
    ('10_taller_admin','funcion','unaccent_simple'),
    ('10_taller_admin','funcion','fn_crear_taller'),
    ('10_taller_admin','funcion','fn_crear_usuario_taller')
),
existente as (
  select c.relname as nombre,
         case c.relkind when 'r' then 'tabla' when 'v' then 'vista' end as tipo
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r','v')
  union all
  select p.proname, 'funcion'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
)
select
    e.script,
    count(*)                                        as objetos,
    count(x.nombre)                                 as creados,
    count(*) - count(x.nombre)                      as faltan,
    case when count(x.nombre) = count(*) then '✅ aplicado'
         when count(x.nombre) = 0       then '❌ NO ejecutado'
         else '⚠️ a medias' end                     as estado,
    string_agg(e.nombre, ', ') filter (where x.nombre is null) as le_falta
from esperado e
left join existente x on x.nombre = e.nombre and x.tipo = e.tipo
group by e.script
order by e.script;


-- ── Segunda consulta: columnas que agregan los scripts ──────────
-- Si una tabla existe pero le falta una columna, el módulo también falla.

select tabla, columna,
       case when exists (
           select 1 from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = t.tabla
              and c.column_name = t.columna) then '✅' else '❌ falta' end as estado
from (values
    ('usuarios','pass_hash'),
    ('taller_repuestos','precio_costo'),
    ('taller_repuestos','stock_minimo'),
    ('taller_ventas','numero'),
    ('taller_ventas','total'),
    ('taller_ventas','vendedor_id'),
    ('taller_ventas_items','costo_unitario'),
    ('taller_ordenes','mecanico_id'),
    ('taller_ordenes','neto'),
    ('taller_ordenes_items','costo_unitario'),
    ('taller_movimientos_caja','cxp_id')
) as t(tabla, columna)
order by 3 desc, 1, 2;
