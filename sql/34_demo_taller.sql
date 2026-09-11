-- ════════════════════════════════════════════════════════════════
-- 34 · Datos de demostración para "Taller Demo"
-- ════════════════════════════════════════════════════════════════
-- Puebla la empresa demo (slug 'taller-demo', id 182f1cda-ea50-41eb-
-- a01e-df49b869ef92) con clientes, vehículos, personal, inventario,
-- órdenes en distintos estados, presupuestos, citas, una caja abierta,
-- ventas de mostrador y gastos — para mostrar la app con datos reales
-- en una demo de venta. No toca ninguna otra empresa.
--
-- Ejecutar UNA sola vez (no es idempotente: vuelve a insertar todo si
-- se corre de nuevo). Usa las RPC reales del sistema (fn_agendar_cita,
-- fn_abrir_caja, fn_registrar_venta, fn_taller_siguiente_numero) para
-- que los correlativos y el stock queden coherentes con el resto de
-- la app.
--
-- ⚠ REQUIERE sql/35 (fix de fn_registrar_venta) aplicado antes, si no
-- la sección de ventas de mostrador falla en silencio.
--
-- Ejecutar en: Supabase → SQL Editor
-- ════════════════════════════════════════════════════════════════

do $$
declare
  eid uuid := '182f1cda-ea50-41eb-a01e-df49b869ef92';

  -- clientes (los 2 primeros ya existían)
  c3 uuid; c4 uuid; c5 uuid; c6 uuid; c7 uuid; c8 uuid; c9 uuid; c10 uuid;

  -- vehículos (v1 CYBX30 / v2 FXRZ25 ya existían)
  v3 uuid; v4 uuid; v5 uuid; v6 uuid; v7 uuid; v8 uuid; v9 uuid; v10 uuid; v11 uuid; v12 uuid;

  -- personal
  e_jefe uuid; e_mec1 uuid; e_mec2 uuid; e_recep uuid;

  -- bahías
  b1 uuid; b2 uuid; b3 uuid;

  -- órdenes nuevas
  o4 uuid; o5 uuid; o6 uuid; o7 uuid; o8 uuid; o9 uuid; o10 uuid; o11 uuid; o12 uuid; o13 uuid; o14 uuid; o15 uuid;

  -- presupuestos
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid;

  -- caja / citas
  caja1 uuid;
  cita1 uuid; cita2 uuid; cita3 uuid; cita4 uuid; cita5 uuid;

  r jsonb;  -- resultado de las RPC
  n int;    -- numero de OT
begin

  -- ── 1 · Perfil público (para el directorio de talleres) ─────────
  insert into taller_config (empresa_id, rut, giro, direccion, comuna, ciudad,
    telefono, email, sitio_web, descripcion, whatsapp, lat, lng, horario,
    servicios, especialidades, marcas, publicado)
  values (eid, '76.555.444-3', 'Mantención y reparación de vehículos automotores',
    'Av. Providencia 1234, local 3', 'Providencia', 'Santiago',
    '+56 2 2345 6789', 'contacto@tallerdemo.cl', 'https://tallerdemo.cl',
    'Taller multimarca con más de 10 años de experiencia. Mecánica general, frenos, suspensión y mantenciones programadas.',
    '+56912345678', -33.4263, -70.6122,
    'Lunes a viernes 9:00–18:30 · Sábado 9:30–14:00',
    array['Mantención','Frenos','Suspensión','Diagnóstico computarizado','Neumáticos','Aire acondicionado'],
    array['Motor','Frenos y suspensión','Eléctrico'],
    array['Toyota','Chevrolet','Hyundai','Nissan','Kia','Suzuki','Mazda','Ford','Volkswagen','Peugeot','MG'],
    true)
  on conflict (empresa_id) do update set
    direccion = excluded.direccion, comuna = excluded.comuna, ciudad = excluded.ciudad,
    telefono = excluded.telefono, email = excluded.email, sitio_web = excluded.sitio_web,
    descripcion = excluded.descripcion, whatsapp = excluded.whatsapp,
    lat = excluded.lat, lng = excluded.lng, horario = excluded.horario,
    servicios = excluded.servicios, especialidades = excluded.especialidades,
    marcas = excluded.marcas, publicado = true;

  -- ── 2 · Personal ──────────────────────────────────────────────
  insert into taller_empleados (empresa_id, rut, nombre, cargo, especialidad, telefono, email, fecha_ingreso, tarifa_hora)
  values (eid, '15111222-3', 'Marcelo Rojas', 'jefe_taller', 'Gestión de taller', '+56911112222', 'marcelo@tallerdemo.cl', current_date - 900, 12000)
  returning id into e_jefe;

  insert into taller_empleados (empresa_id, rut, nombre, cargo, especialidad, telefono, email, fecha_ingreso, tarifa_hora)
  values (eid, '16222333-4', 'Diego Muñoz', 'mecanico', 'Motor y frenos', '+56922223333', 'diego@tallerdemo.cl', current_date - 620, 9000)
  returning id into e_mec1;

  insert into taller_empleados (empresa_id, rut, nombre, cargo, especialidad, telefono, email, fecha_ingreso, tarifa_hora)
  values (eid, '17333444-5', 'Patricio Vidal', 'mecanico', 'Suspensión y eléctrico', '+56933334444', 'patricio@tallerdemo.cl', current_date - 400, 9000)
  returning id into e_mec2;

  insert into taller_empleados (empresa_id, rut, nombre, cargo, telefono, email, fecha_ingreso, tarifa_hora)
  values (eid, '18444555-6', 'Camila Torres', 'recepcion', '+56944445555', 'camila@tallerdemo.cl', current_date - 250, 6500)
  returning id into e_recep;

  -- ── 3 · Bahías ────────────────────────────────────────────────
  insert into taller_bahias (empresa_id, nombre, tipo, orden) values (eid, 'Bahía 1', 'general', 1) returning id into b1;
  insert into taller_bahias (empresa_id, nombre, tipo, orden) values (eid, 'Bahía 2', 'general', 2) returning id into b2;
  insert into taller_bahias (empresa_id, nombre, tipo, orden) values (eid, 'Elevador', 'elevador', 3) returning id into b3;

  -- ── 4 · Proveedores ───────────────────────────────────────────
  insert into taller_proveedores (empresa_id, rut, razon_social, nombre_fantasia, giro, contacto_nombre, telefono, email, condicion_pago, dias_credito)
  values
    (eid, '78111222-9', 'Repuestos Andina Ltda.', 'Andina Repuestos', 'Venta de repuestos automotrices', 'Rodrigo Paz', '+56223334444', 'ventas@andina.cl', 'credito', 30),
    (eid, '79222333-0', 'Distribuidora Central de Lubricantes SpA', 'Lubricantes Central', 'Distribución de lubricantes y filtros', 'Ana Ibarra', '+56224445555', 'contacto@lubricantescentral.cl', 'credito', 15),
    (eid, '80333444-1', 'Neumáticos del Sur Ltda.', 'Neumáticos del Sur', 'Venta e instalación de neumáticos', 'Héctor Soto', '+56225556666', 'pedidos@neumsur.cl', 'contado', 0);

  -- ── 5 · Inventario ────────────────────────────────────────────
  update taller_repuestos set precio_costo = 4200 where empresa_id = eid and codigo = 'ACE-10W40';
  update taller_repuestos set precio_costo = 3800 where empresa_id = eid and codigo = 'FIL-001';
  update taller_repuestos set precio_costo = 15000 where empresa_id = eid and codigo = 'PAS-DEL';

  insert into taller_repuestos (empresa_id, codigo, nombre, categoria, stock, stock_minimo, precio_costo, precio_venta, unidad)
  values
    (eid, 'FIL-AIRE-01', 'Filtro de aire', 'filtros', 22, 5, 4500, 7990, 'unidad'),
    (eid, 'FIL-COMB-01', 'Filtro de combustible', 'filtros', 14, 5, 5200, 8990, 'unidad'),
    (eid, 'PAS-TRA', 'Pastillas de freno traseras', 'frenos', 9, 4, 15000, 28990, 'juego'),
    (eid, 'DIS-DEL', 'Disco de freno delantero (par)', 'frenos', 4, 3, 32000, 54990, 'par'),
    (eid, 'AMO-DEL', 'Amortiguador delantero', 'suspension', 3, 4, 28000, 47990, 'unidad'),
    (eid, 'COR-DIST', 'Correa de distribución', 'motor', 2, 3, 18000, 32990, 'unidad'),
    (eid, 'BAT-60AH', 'Batería 60Ah', 'electrico', 6, 2, 42000, 69990, 'unidad'),
    (eid, 'BUJ-4', 'Set de bujías (4 uds)', 'motor', 11, 3, 9000, 15990, 'set'),
    (eid, 'LIQ-FRENO', 'Líquido de frenos DOT4', 'lubricantes', 16, 5, 2800, 5990, 'litro'),
    (eid, 'REF-VERDE', 'Refrigerante verde', 'lubricantes', 20, 5, 3200, 6990, 'litro'),
    (eid, 'NEU-17565', 'Neumático 175/65 R14', 'neumaticos', 8, 4, 32000, 54990, 'unidad'),
    (eid, 'ROD-DEL', 'Rodamiento de rueda delantero', 'suspension', 5, 2, 11000, 19990, 'unidad'),
    (eid, 'KIT-EMB', 'Kit de embrague completo', 'motor', 1, 2, 65000, 109990, 'kit'),
    (eid, 'ESC-DEL', 'Set de escobillas delanteras', 'otros', 25, 8, 3500, 6990, 'set'),
    (eid, 'ACE-5W30', 'Aceite sintético 5W30 (litro)', 'lubricantes', 3, 10, 4200, 11990, 'litro');

  -- ── 6 · Clientes ──────────────────────────────────────────────
  insert into taller_clientes (empresa_id, rut, nombre, telefono, email, direccion, tipo, canal_pref)
  values (eid, '9876543-2', 'Roberto Fernández', '+56987654321', 'roberto.fernandez@gmail.com', 'Los Aromos 456, Ñuñoa', 'persona', 'whatsapp')
  returning id into c3;

  insert into taller_clientes (empresa_id, rut, nombre, telefono, email, direccion, tipo, canal_pref)
  values (eid, '8765432-1', 'Marcela Contreras', '+56976543210', 'marcela.contreras@gmail.com', 'Pasaje Las Flores 89, La Florida', 'persona', 'mi_vehiculo')
  returning id into c4;

  insert into taller_clientes (empresa_id, rut, nombre, telefono, email, direccion, tipo, canal_pref)
  values (eid, '7654321-0', 'Jorge Espinoza', '+56965432109', 'jorge.espinoza@hotmail.com', 'Camino a Melipilla 3200, Maipú', 'persona', 'auto')
  returning id into c5;

  insert into taller_clientes (empresa_id, rut, nombre, telefono, email, direccion, tipo, canal_pref)
  values (eid, '76123456-7', 'Transportes Rápido Ltda.', '+56954321098', 'flota@transportesrapido.cl', 'Panamericana Norte 8900, Quilicura', 'empresa', 'auto')
  returning id into c6;

  insert into taller_clientes (empresa_id, rut, nombre, telefono, email, direccion, tipo, canal_pref)
  values (eid, '77234567-8', 'Constructora Lomas del Sur SpA', '+56943210987', 'operaciones@lomasdelsur.cl', 'Av. Vitacura 4500, of. 602', 'empresa', 'whatsapp')
  returning id into c7;

  insert into taller_clientes (empresa_id, rut, nombre, telefono, email, direccion, tipo, canal_pref)
  values (eid, '6543210-9', 'Paula Reyes', '+56932109876', 'paula.reyes@gmail.com', 'Los Castaños 120, San Miguel', 'persona', 'ambos')
  returning id into c8;

  insert into taller_clientes (empresa_id, rut, nombre, telefono, email, direccion, tipo, canal_pref)
  values (eid, '5432109-8', 'Andrés Molina', '+56921098765', 'andres.molina@gmail.com', 'Bilbao 2340, Providencia', 'persona', 'auto')
  returning id into c9;

  insert into taller_clientes (empresa_id, rut, nombre, telefono, email, direccion, tipo, canal_pref)
  values (eid, '4321098-7', 'Ignacia Bravo', '+56910987654', 'ignacia.bravo@gmail.com', 'Manuel Montt 780, Providencia', 'persona', 'mi_vehiculo')
  returning id into c10;

  -- ── 7 · Vehículos ─────────────────────────────────────────────
  insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio, color, kilometraje)
  values (eid, c3, 'HJKL56', 'Chevrolet', 'Sail', 2017, 'Gris', 95000) returning id into v3;
  insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio, color, kilometraje)
  values (eid, c4, 'MNPQ78', 'Hyundai', 'Accent', 2019, 'Blanco', 62000) returning id into v4;
  insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio, color, kilometraje)
  values (eid, c5, 'RSTU90', 'Suzuki', 'Alto', 2015, 'Rojo', 110000) returning id into v5;
  insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio, color, kilometraje)
  values (eid, c5, 'VWXY12', 'Kia', 'Rio', 2020, 'Negro', 38000) returning id into v6;
  insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio, color, kilometraje)
  values (eid, c6, 'ZABC34', 'Nissan', 'NP300', 2018, 'Blanco', 145000) returning id into v7;
  insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio, color, kilometraje)
  values (eid, c6, 'DEFG56', 'Nissan', 'NP300', 2016, 'Blanco', 178000) returning id into v8;
  insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio, color, kilometraje)
  values (eid, c7, 'HIJK78', 'Ford', 'Ranger', 2019, 'Gris', 88000) returning id into v9;
  insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio, color, kilometraje)
  values (eid, c8, 'LMNO90', 'Toyota', 'Yaris', 2021, 'Azul', 21000) returning id into v10;
  insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio, color, kilometraje)
  values (eid, c9, 'PQRS12', 'Mazda', '3', 2018, 'Gris', 76000) returning id into v11;
  insert into taller_vehiculos (empresa_id, cliente_id, patente, marca, modelo, anio, color, kilometraje)
  values (eid, c10, 'TUVW34', 'Volkswagen', 'Gol', 2014, 'Blanco', 132000) returning id into v12;

  -- ── 8 · Órdenes de trabajo (variedad de estados) ───────────────
  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso,
      fecha_ingreso, danos_recepcion, recepcion_observaciones)
  values (eid, n, v3, c3, 'recepcion', 95000, 'Ruido metálico al frenar',
      now() - interval '1 day',
      '[{"tipo":"rayon","zona":"lateral_izq","nota":"rayón superficial puerta trasera"},{"tipo":"abolladura","zona":"capo","nota":null}]'::jsonb,
      'Cliente indica ruido metálico al frenar, revisar pastillas y disco.')
  returning id into o4;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, fecha_ingreso, recepcion_observaciones)
  values (eid, n, v10, c8, 'recepcion', 21000, 'Mantención 20.000 km', now() - interval '3 hours', 'Vehículo al día con mantenciones anteriores.')
  returning id into o5;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, diagnostico, fecha_ingreso)
  values (eid, n, v4, c4, 'diagnostico_terminado', 62000, 'Chillido en el motor al partir en frío',
      'Correa de distribución con desgaste visible y fisuras. Requiere cambio urgente para evitar daño mayor al motor.',
      now() - interval '4 days')
  returning id into o6;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, diagnostico, fecha_ingreso)
  values (eid, n, v5, c5, 'aprobada', 110000, 'Vehículo se va de cola en curvas', 'Amortiguadores delanteros gastados, filtración de aceite visible.', now() - interval '5 days')
  returning id into o7;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, diagnostico, fecha_ingreso)
  values (eid, n, v7, c6, 'esperando_repuestos', 145000, 'Revisión preventiva flota', 'Amortiguadores traseros al límite de vida útil.', now() - interval '6 days')
  returning id into o8;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, diagnostico, mecanico_id, fecha_ingreso)
  values (eid, n, v6, c5, 'reparacion', 38000, 'Ruido al frenar', 'Pastillas delanteras gastadas.', e_mec1, now() - interval '3 days')
  returning id into o9;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, diagnostico, mecanico_id, fecha_ingreso)
  values (eid, n, v9, c7, 'trabajo_terminado', 88000, 'Mantención programada', 'Cambio de aceite, filtro de aire y ajuste general.', e_mec2, now() - interval '7 days')
  returning id into o10;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, diagnostico,
      trabajos_realizados, mecanico_id, fecha_ingreso, fecha_entrega, danos_recepcion)
  values (eid, n, v8, c6, 'entregada', 178000, 'Ruido al frenar, flota', 'Pastillas y disco delantero desgastados.',
      'Se reemplazaron pastillas y disco de freno delantero. Prueba de ruta sin novedad.', e_mec1,
      now() - interval '20 days', now() - interval '18 days',
      '[{"tipo":"parachoques","zona":"frontal","nota":"parachoques con grieta previa a la recepción"}]'::jsonb)
  returning id into o11;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, diagnostico,
      trabajos_realizados, mecanico_id, fecha_ingreso, fecha_entrega)
  values (eid, n, v11, c9, 'entregada', 76000, 'Mantención mayor', 'Aceite vencido, filtro y bujías con desgaste.',
      'Mantención mayor: cambio de aceite, filtro de aire, filtro de aceite y set de bujías.', e_mec2,
      now() - interval '14 days', now() - interval '13 days')
  returning id into o12;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, diagnostico,
      trabajos_realizados, mecanico_id, fecha_ingreso, fecha_entrega, danos_recepcion)
  values (eid, n, v12, c10, 'entregada', 132000, 'No enciende', 'Batería descargada y con más de 4 años de uso.',
      'Cambio de batería y revisión general del sistema eléctrico. Sin fugas de corriente detectadas.', e_mec1,
      now() - interval '35 days', now() - interval '33 days',
      '[{"tipo":"neumatico","zona":"lateral_der","nota":"neumático desgastado, no relacionado al trabajo realizado"}]'::jsonb)
  returning id into o13;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, fecha_ingreso)
  values (eid, n, v3, c3, 'anulada', 95000, 'Ruido en suspensión — cliente desistió', now() - interval '10 days')
  returning id into o14;

  n := fn_taller_siguiente_numero(eid, 'orden');
  insert into taller_ordenes (empresa_id, numero, vehiculo_id, cliente_id, estado, kilometraje_ingreso, motivo_ingreso, diagnostico, fecha_ingreso)
  values (eid, n, v4, c4, 'rechazado', 62000, 'Cotización cambio de amortiguadores', 'Amortiguadores traseros con fuga menor.', now() - interval '8 days')
  returning id into o15;

  -- ── 9 · Ítems de las órdenes (los totales los recalcula el trigger) ──
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, descripcion, cantidad, precio_unitario, subtotal, empleado_id)
  values (eid, o6, 'mano_obra', 'Diagnóstico correa de distribución', 1, 15000, 15000, e_mec1);

  insert into taller_ordenes_items (empresa_id, orden_id, tipo, descripcion, cantidad, precio_unitario, subtotal, empleado_id)
  values (eid, o7, 'mano_obra', 'Mano de obra — cambio de amortiguadores', 1, 15000, 15000, e_mec2);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o7, 'repuesto', 'AMO-DEL', 'Amortiguador delantero', 2, 47990, 95980);

  insert into taller_ordenes_items (empresa_id, orden_id, tipo, descripcion, cantidad, precio_unitario, subtotal, empleado_id)
  values (eid, o8, 'mano_obra', 'Diagnóstico suspensión trasera', 1, 15000, 15000, e_mec2);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o8, 'repuesto', 'AMO-DEL', 'Amortiguador (pendiente de stock)', 1, 47990, 47990);

  insert into taller_ordenes_items (empresa_id, orden_id, tipo, descripcion, cantidad, precio_unitario, subtotal, costo_unitario, empleado_id)
  values (eid, o9, 'mano_obra', 'Mano de obra — cambio de pastillas', 3, 12000, 36000, 7000, e_mec1);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o9, 'repuesto', 'PAS-DEL', 'Pastillas de freno delanteras', 1, 34990, 34990);

  insert into taller_ordenes_items (empresa_id, orden_id, tipo, descripcion, cantidad, precio_unitario, subtotal, costo_unitario, empleado_id)
  values (eid, o10, 'mano_obra', 'Mano de obra — mantención', 2, 12000, 24000, 7000, e_mec2);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o10, 'repuesto', 'FIL-AIRE-01', 'Filtro de aire', 1, 7990, 7990);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o10, 'repuesto', 'ACE-10W40', 'Aceite 10W40', 4, 9990, 39960);

  insert into taller_ordenes_items (empresa_id, orden_id, tipo, descripcion, cantidad, precio_unitario, subtotal, costo_unitario, empleado_id)
  values (eid, o11, 'mano_obra', 'Mano de obra — pastillas y disco delantero', 2, 12000, 24000, 7000, e_mec1);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o11, 'repuesto', 'PAS-DEL', 'Pastillas de freno delanteras', 1, 34990, 34990);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o11, 'repuesto', 'DIS-DEL', 'Disco de freno delantero (par)', 1, 54990, 54990);

  insert into taller_ordenes_items (empresa_id, orden_id, tipo, descripcion, cantidad, precio_unitario, subtotal, costo_unitario, empleado_id)
  values (eid, o12, 'mano_obra', 'Mano de obra — mantención mayor', 1.5, 12000, 18000, 7000, e_mec2);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o12, 'repuesto', 'ACE-10W40', 'Aceite 10W40', 4, 9990, 39960);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o12, 'repuesto', 'FIL-001', 'Filtro de aceite', 1, 8990, 8990);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o12, 'repuesto', 'BUJ-4', 'Set de bujías', 1, 15990, 15990);

  insert into taller_ordenes_items (empresa_id, orden_id, tipo, descripcion, cantidad, precio_unitario, subtotal, costo_unitario, empleado_id)
  values (eid, o13, 'mano_obra', 'Mano de obra — cambio de batería', 1, 15000, 15000, 8000, e_mec1);
  insert into taller_ordenes_items (empresa_id, orden_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal)
  values (eid, o13, 'repuesto', 'BAT-60AH', 'Batería 60Ah', 1, 69990, 69990);

  -- ── 10 · Presupuestos ───────────────────────────────────────────
  n := coalesce((select max(numero) from taller_presupuestos where empresa_id = eid), 0) + 1;
  insert into taller_presupuestos (empresa_id, numero, cliente_id, vehiculo_id, orden_id, estado, fecha_emision, dias_validez, motivo, diagnostico, enviado_at, usuario_rut)
  values (eid, n, c4, v4, o6, 'enviado', current_date - 3, 15, 'Cambio de correa de distribución', 'Correa con fisuras visibles, cambio urgente.', now() - interval '3 days', '11111111-1')
  returning id into p1;
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p1, 'mano_obra', 'Mano de obra — cambio de correa', 1, 25000, 25000, 1);
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p1, 'repuesto', 'COR-DIST', 'Correa de distribución', 1, 32990, 32990, 2);

  n := coalesce((select max(numero) from taller_presupuestos where empresa_id = eid), 0) + 1;
  insert into taller_presupuestos (empresa_id, numero, cliente_id, vehiculo_id, orden_id, estado, fecha_emision, dias_validez, motivo, diagnostico,
      enviado_at, aprobado_at, aprobado_via, aprobado_por, usuario_rut)
  values (eid, n, c5, v5, o7, 'aprobado', current_date - 5, 15, 'Cambio de amortiguadores delanteros', 'Amortiguadores gastados, filtración de aceite.',
      now() - interval '5 days', now() - interval '2 days', 'whatsapp', 'Jorge Espinoza (cliente)', '11111111-1')
  returning id into p2;
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p2, 'mano_obra', 'Mano de obra — cambio de amortiguadores', 1, 20000, 20000, 1);
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p2, 'repuesto', 'AMO-DEL', 'Amortiguador delantero', 2, 47990, 95980, 2);

  n := coalesce((select max(numero) from taller_presupuestos where empresa_id = eid), 0) + 1;
  insert into taller_presupuestos (empresa_id, numero, cliente_id, vehiculo_id, orden_id, estado, fecha_emision, dias_validez, motivo, diagnostico,
      enviado_at, rechazado_at, motivo_rechazo_cat, motivo_rechazo, usuario_rut)
  values (eid, n, c6, v7, o8, 'rechazado', current_date - 6, 15, 'Cambio de amortiguadores traseros — flota', 'Amortiguadores traseros al límite de vida útil.',
      now() - interval '6 days', now() - interval '1 day', 'precio', 'El cliente indica que en otro taller le cotizaron más barato.', '11111111-1')
  returning id into p3;
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p3, 'mano_obra', 'Mano de obra — cambio de amortiguadores', 1, 18000, 18000, 1);
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p3, 'repuesto', 'AMO-DEL', 'Amortiguador trasero', 2, 47990, 95980, 2);

  n := coalesce((select max(numero) from taller_presupuestos where empresa_id = eid), 0) + 1;
  insert into taller_presupuestos (empresa_id, numero, cliente_id, vehiculo_id, estado, fecha_emision, dias_validez, motivo, diagnostico,
      enviado_at, rechazado_at, motivo_rechazo_cat, motivo_rechazo, usuario_rut)
  values (eid, n, c9, v11, 'rechazado', current_date - 9, 15, 'Kit de embrague completo', 'Embrague patina en pendientes, requiere cambio.',
      now() - interval '9 days', now() - interval '6 days', 'no_responde', 'Cliente no volvió a contactar al taller.', '11111111-1')
  returning id into p4;
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p4, 'mano_obra', 'Mano de obra — cambio de kit de embrague', 1, 40000, 40000, 1);
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p4, 'repuesto', 'KIT-EMB', 'Kit de embrague completo', 1, 109990, 109990, 2);

  n := coalesce((select max(numero) from taller_presupuestos where empresa_id = eid), 0) + 1;
  insert into taller_presupuestos (empresa_id, numero, cliente_id, vehiculo_id, orden_id, estado, fecha_emision, dias_validez, motivo, diagnostico,
      enviado_at, aprobado_at, aprobado_via, aprobado_por, usuario_rut)
  values (eid, n, c10, v12, o13, 'convertido', current_date - 35, 15, 'Batería y revisión eléctrica', 'Batería descargada, más de 4 años de uso.',
      now() - interval '35 days', now() - interval '34 days', 'presencial', 'Ignacia Bravo (cliente)', '11111111-1')
  returning id into p5;
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p5, 'mano_obra', 'Mano de obra — cambio de batería', 1, 15000, 15000, 1);
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p5, 'repuesto', 'BAT-60AH', 'Batería 60Ah', 1, 69990, 69990, 2);

  n := coalesce((select max(numero) from taller_presupuestos where empresa_id = eid), 0) + 1;
  insert into taller_presupuestos (empresa_id, numero, cliente_id, vehiculo_id, estado, fecha_emision, dias_validez, motivo, diagnostico, enviado_at, usuario_rut)
  values (eid, n, c3, v3, 'enviado', current_date - 1, 14, 'Pastillas y disco delantero', 'Ruido metálico al frenar, disco con rayado profundo.', now() - interval '1 day', '11111111-1')
  returning id into p6;
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p6, 'mano_obra', 'Mano de obra — pastillas y disco', 1, 15000, 15000, 1);
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p6, 'repuesto', 'PAS-DEL', 'Pastillas de freno delanteras', 1, 34990, 34990, 2);
  insert into taller_presupuestos_items (empresa_id, presupuesto_id, tipo, articulo_codigo, descripcion, cantidad, precio_unitario, subtotal, orden)
  values (eid, p6, 'repuesto', 'DIS-DEL', 'Disco de freno delantero (par)', 1, 54990, 54990, 3);

  -- ── 11 · Agenda ───────────────────────────────────────────────
  r := fn_agendar_cita(eid, current_date + 2, '10:00', 60, c8, v10, b1, e_mec1, 'Mantención 20.000 km', null, 'telefono', null, null, null, null, null, '11111111-1');
  cita1 := (r ->> 'cita_id')::uuid;

  r := fn_agendar_cita(eid, current_date + 1, '15:30', 45, c9, v11, b2, e_mec2, 'Revisión de ruido en suspensión', null, 'whatsapp', null, null, null, null, null, '11111111-1');
  cita2 := (r ->> 'cita_id')::uuid;

  r := fn_agendar_cita(eid, current_date + 4, '09:00', 30, null, null, null, null, 'Cotización cambio de embrague', null, 'web', 'Marisol Peña (nueva)', 'BBCC11', '+56911223344', null, null, '11111111-1');
  cita3 := (r ->> 'cita_id')::uuid;

  r := fn_agendar_cita(eid, current_date - 3, '11:00', 30, c4, v4, b1, e_mec1, 'Diagnóstico correa de distribución', null, 'presencial', null, null, null, null, null, '11111111-1');
  cita4 := (r ->> 'cita_id')::uuid;
  if cita4 is not null then update taller_citas set estado = 'completada' where id = cita4; end if;

  r := fn_agendar_cita(eid, current_date - 1, '16:00', 30, c6, v7, b3, e_mec2, 'Diagnóstico amortiguadores flota', null, 'telefono', null, null, null, null, null, '11111111-1');
  cita5 := (r ->> 'cita_id')::uuid;
  if cita5 is not null then update taller_citas set estado = 'no_asistio' where id = cita5; end if;

  -- ── 12 · Caja y ventas de mostrador ─────────────────────────────
  r := fn_abrir_caja(eid, 50000, '11111111-1');
  caja1 := (r ->> 'caja_id')::uuid;

  if caja1 is not null then
    perform fn_registrar_venta(eid,
      '[{"tipo":"repuesto","codigo":"ACE-10W40","descripcion":"Aceite 10W40","cantidad":4,"precio_unitario":9990},
        {"tipo":"repuesto","codigo":"FIL-001","descripcion":"Filtro de aceite","cantidad":1,"precio_unitario":8990}]'::jsonb,
      'efectivo', caja1, c8, 0, 'Mantención de mostrador', '11111111-1');

    perform fn_registrar_venta(eid,
      '[{"tipo":"repuesto","codigo":"BUJ-4","descripcion":"Set de bujías","cantidad":1,"precio_unitario":15990}]'::jsonb,
      'debito', caja1, null, 0, null, '11111111-1');

    perform fn_registrar_venta(eid,
      '[{"tipo":"repuesto","codigo":"ESC-DEL","descripcion":"Set de escobillas delanteras","cantidad":2,"precio_unitario":6990},
        {"tipo":"repuesto","codigo":"LIQ-FRENO","descripcion":"Líquido de frenos DOT4","cantidad":1,"precio_unitario":5990}]'::jsonb,
      'transferencia', caja1, c3, 0, null, '11111111-1');
  end if;

  -- ── 13 · Gastos ──────────────────────────────────────────────
  insert into taller_gastos (empresa_id, fecha, categoria, descripcion, monto, medio_pago, usuario_rut) values
    (eid, current_date - 2,  'arriendo',         'Arriendo del local — mes en curso', 450000, 'transferencia', '11111111-1'),
    (eid, current_date - 4,  'electricidad',     'Cuenta de luz',                       89000, 'transferencia', '11111111-1'),
    (eid, current_date - 4,  'agua',             'Cuenta de agua',                      32000, 'transferencia', '11111111-1'),
    (eid, current_date - 6,  'internet',         'Internet y telefonía',                45000, 'debito',        '11111111-1'),
    (eid, current_date - 10, 'herramientas',     'Compresor de aire nuevo',            120000, 'credito',       '11111111-1'),
    (eid, current_date - 12, 'insumos',          'Trapos, desengrasante, guantes',      35000, 'efectivo',      '11111111-1'),
    (eid, current_date - 15, 'combustible',      'Bencina camioneta de repuestos',      60000, 'efectivo',      '11111111-1'),
    (eid, current_date - 30, 'sueldos',          'Sueldos del mes anterior',          1800000, 'transferencia', '11111111-1'),
    (eid, current_date - 20, 'marketing',        'Publicidad redes sociales',           40000, 'debito',        '11111111-1'),
    (eid, current_date - 40, 'impuestos',        'Patente municipal',                   95000, 'transferencia', '11111111-1');

  raise notice 'Demo cargada: % clientes nuevos, % vehículos nuevos, % órdenes nuevas, % presupuestos, % citas, % ventas',
    8, 10, 12, 6, 5, 3;
end $$;
