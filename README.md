# ARM Taller

Plataforma SaaS multiempresa para administración de talleres mecánicos — ARM Sistemas.
Mismo patrón, misma instancia Supabase y mismo estilo visual que ARM Universal.

## Puesta en marcha

1. Repo GitHub `arm-taller` con estos archivos → conectar a Cloudflare Pages (sin build, output `/`).
2. Ejecutar el script SQL de setup (tablas `taller_`, `empresas.tipo`, funciones RPC) — ya aplicado.
   Luego, en orden, los scripts de `sql/` (ver "Migraciones SQL" más abajo).
3. Crear un taller de prueba y su usuario:

```sql
INSERT INTO empresas (nombre, slug, tipo, activo, modulos_activos)
VALUES ('Taller Demo', 'taller-demo', 'taller', true, '{}'::jsonb);

INSERT INTO usuarios (empresa_id, rut, pass, rol, activo)
VALUES ('<id de Taller Demo>', '11111111-1', 'demo123', 'admin', true);
```

4. Abrir `login.html` e ingresar con ese RUT.

### Desarrollo local

```bash
node tools/serve.js
```

Sirve el proyecto tal cual en `http://localhost:4173`, igual que Cloudflare Pages
(sin build). También está registrado en `.claude/launch.json`.

## Reglas de acceso

- Solo entran usuarios de empresas con `tipo='taller'`.
- Excepción: admin de la empresa `arm-sur` (superadmin ARM) para administrar talleres.
- Roles: `admin`, `jefe_taller`, `recepcion`, `mecanico`, `vendedor`, `bodeguero`,
  `cajero`, `contador`, `lector` (ver `ROL_MODULOS` en `config.js`).

## Módulos por taller

Cada taller decide con qué trabaja. El menú se arma cruzando **tres capas**:

```
MODULOS_CATALOGO          qué módulos existen y qué paneles aporta cada uno
      ×
empresas.modulos_activos  qué encendió ESTE taller (jsonb: { "inventario": true })
      ×
ROL_MODULOS               qué puede ver el rol del usuario
      =
appData.modulos           paneles que aparecen en el sidebar
```

- El panel **Admin › Módulos** enciende y apaga módulos con switches y escribe
  `empresas.modulos_activos`. El menú se rearma en caliente (`Auth.refrescarModulos`).
- Los módulos con `base: true` (núcleo y administración) no se pueden apagar.
- Los módulos declaran `requiere: []`. No se enciende uno al que le falte una
  dependencia, y apagar uno arrastra en cascada a los que dependían de él.
- Los paneles de módulos aún no construidos se **generan solos** desde `PANEL_INFO`:
  agregar un módulo al catálogo no requiere tocar `app.html`.

Para agregar un módulo nuevo:

1. Entrada en `MODULOS_CATALOGO` (`config.js`) con sus paneles, plan y dependencias.
2. Entrada por panel en `PANEL_INFO`, y el panel en los roles que corresponda en `ROL_MODULOS`.
3. Sección en `NAV_SECCIONES` e icono en `PANEL_ICONOS` (`app.js`).
4. `js/modulo-<nombre>.js` con patrón IIFE + `init()`, registrado en `PANEL_INIT`
   y en los `<script>` de `app.html`.

## Estructura

```
login.html                Login (brand panel + formulario, RUT + pass)
app.html                  Shell: sidebar colapsable, topbar, paneles
css/login.css             = Universal (textual)
css/app.css               = Universal + paleta y componentes tll- del taller
js/config.js              Supabase, MODULOS_CATALOGO, ROL_MODULOS, PANEL_INFO
js/auth.js                = Universal + validación tipo='taller' (claves tll_)
js/login.js               = Universal (textual: RUT, recordar, validaciones)
js/utils.js               Formato, validaciones (RUT/patente/email/tel), modal, toast
js/app.js                 Menú dinámico, paneles autogenerados, sidebar
js/modulo-dashboard.js    KPIs + órdenes en curso
js/modulo-recepcion.js    Puerta de entrada: cliente + vehículo + motivo → OT/presupuesto
js/modulo-ordenes.js      OT: ítems, stock vía RPC, flujo de estados
js/modulo-clientes.js     CRUD de clientes
js/modulo-vehiculos.js    CRUD de vehículos + historial por patente
js/modulo-inventario.js   Repuestos, stock, costo promedio y kardex
js/modulo-ventas.js       Venta de mostrador (POS) con IVA y anulación
js/modulo-caja.js         Turnos de caja, cobro de órdenes y arqueo
js/modulo-empleados.js    Ficha del personal y sus reglas de comisión
js/modulo-comisiones.js   Liquidación mensual: generar, aprobar y pagar
js/modulo-proveedores.js  Proveedores, condición de pago y estado de cuenta
js/modulo-compras.js      Órdenes de compra y recepción de mercadería
js/modulo-cxp.js          Cuentas por pagar, antigüedad y pagos
js/modulo-reportes.js     Resultado del periodo, productividad y rotación
js/modulo-mantenciones.js Recordatorios por km o fecha y contacto al cliente
js/modulo-presupuestos.js Cotizaciones con vigencia, versiones, margen e impresión
js/modulo-agenda.js       Tablero de citas por bahía, con bloqueo de choques
js/modulo-taller.js       Datos del taller y administración de talleres (superadmin)
js/modulo-modulos.js      Activación de módulos del taller
sql/                      Migraciones (ejecutar en Supabase → SQL Editor)
tools/serve.js            Servidor estático para desarrollo local
index.html                LEGACY — login por email, no usar (ver Pendientes)
```

## Migraciones SQL

Ejecutar en Supabase → SQL Editor, en orden. Son idempotentes.

| Archivo | Qué hace | Ojo |
|---|---|---|
| `sql/01_seguridad_login.sql` | Hashea las contraseñas (bcrypt) y crea `fn_login_taller`, para que la comparación ocurra dentro de Postgres y no en el navegador | El PASO 3 cierra la tabla `usuarios`: coordinar con ARM Universal antes |
| `sql/02_inventario.sql` | Campos de inventario, tabla `taller_movimientos_stock` (kardex), RPC de entrada / ajuste y vista de reposición | El PASO 5 **reemplaza** `fn_descontar_stock_repuesto` y `fn_devolver_stock_repuesto`: revisar la firma actual antes |
| `sql/03_ventas_caja.sql` | Turnos de caja, movimientos de dinero, ventas de mostrador, pagos de órdenes y vista de saldos | Requiere el 02. Agrega columnas a `taller_ventas`: revisar su estructura actual antes |
| `sql/04_empleados_comisiones.sql` | Empleados, reglas de comisión, liquidaciones y su pago desde caja | Requiere el 02 y el 03. Reemplaza `fn_registrar_venta` (misma firma) para congelar el costo del repuesto vendido |
| `sql/05_compras_cxp.sql` | Proveedores, órdenes de compra, recepción de mercadería, cuentas por pagar y antigüedad de la deuda | Requiere el 02 y el 03 |
| `sql/06_reportes.sql` | Vistas de rentabilidad y rotación, resumen del periodo y productividad. Además: triggers que congelan el costo del repuesto en la OT y calculan sus totales en la base | Requiere el 02, 03, 04 y 05 |
| `sql/07_mantenciones.sql` | Planes de mantención, mantenciones por vehículo, lista de pendientes y reagendado automático | Solo requiere el esquema base |
| `sql/08_presupuestos.sql` | El presupuesto como documento propio: vigencia, versiones, aprobación y conversión a OT | Requiere el 02. **Arregla el stock que se descontaba al cotizar** |
| `sql/09_agenda.sql` | Bahías, horario del taller, citas con bloqueo de choques y paso de cita a OT | Solo requiere el esquema base |
| `sql/09b_agenda_constraint_opcional.sql` | **Opcional.** Lleva el bloqueo de choques a nivel de constraint | Se ejecuta tal cual. Falla si ya hay citas solapadas |
| `sql/10_taller_admin.sql` | Datos del taller (`taller_config`), creación de talleres y usuarios, lista para el superadmin | Requiere el 01 (usa pgcrypto) |
| `sql/11_cxc_usuarios.sql` | Cuentas por cobrar (órdenes con saldo + documentos) y gestión de usuarios del taller | Requiere el 01 y el 03 |
| `sql/12_permisos.sql` | **Correr SIEMPRE al final.** Otorga select/insert/update/delete sobre las tablas y vistas `taller_*` a `anon` | Sin esto: `42501 permission denied for view`. Es dinámico: re-ejecutar tras cada script nuevo |

Mientras no se apliquen, el front sigue funcionando:

- `auth.js` detecta que `fn_login_taller` no existe y usa el login antiguo (con un aviso en consola).
- Órdenes reintenta `fn_descontar_stock_repuesto` con la firma de 3 parámetros.
- Cada módulo avisa en pantalla qué script SQL le falta, con el código y el mensaje
  real de Postgres (helper `errorCarga` en utils.js).
- Los scripts 01-11 otorgan `grant execute` a sus funciones pero NO a sus tablas y
  vistas: de eso se encarga el `12`. Si agregas un script, vuelve a correr el 12.
- El selector de mecánico en la OT solo aparece si hay empleados cargados, para no
  mandar `mecanico_id` a una columna que todavía no existe.

## Reglas del stock

El stock **nunca** se modifica con un `update` directo. Toda variación pasa por
una RPC que bloquea la fila (`for update`) y deja el movimiento en el kardex:

| Operación | RPC | Quién la usa |
|---|---|---|
| Entrada de mercadería | `fn_entrada_stock_repuesto` | Inventario (compra, devolución, carga inicial) |
| Ajuste por conteo real | `fn_ajustar_stock_repuesto` | Inventario (toma de inventario, merma, corrección) |
| Salida | `fn_descontar_stock_repuesto` | Órdenes de trabajo, Ventas |
| Reverso de salida | `fn_devolver_stock_repuesto` | Órdenes (al quitar un ítem) |

El costo es **promedio ponderado** y lo recalcula la RPC de entrada. Editarlo a
mano en el formulario solo sirve para corregir una carga mal hecha.

## Reglas del dinero

- **Una venta es una sola operación.** `fn_registrar_venta` graba la venta, sus
  ítems, descuenta el stock y registra la entrada en caja dentro de la misma
  transacción. Si falta stock de un ítem, no queda media venta grabada.
- **IVA**: los precios se manejan **con IVA incluido** (mostrador chileno).
  `neto = round(total / 1,19)` e `iva = total − neto`, calculados en la base.
- **Una sola caja abierta por taller**, garantizado por índice único parcial.
- **El arqueo cuenta solo efectivo.** Débito, crédito y transferencia se
  registran como movimiento pero no están en el cajón, así que no entran en el
  teórico del cierre.
- **Una OT con saldo pendiente avisa antes de entregarse.** El taller puede
  entregar a crédito, pero de forma consciente (`v_taller_ordenes_saldo`).
- Si el taller no tiene activo el módulo **Caja**, Ventas cobra igual con
  `caja_id` nulo y Órdenes no pide confirmación de cobro.

## Taller vs. empresa

La tabla `empresas` **no se renombra**: la comparte esta app con ARM Universal y
`empresas.tipo` es lo que distingue taller de telecom. Todo lo propio del taller
vive en `taller_config`; de `empresas` solo se usan las columnas que ya existían
(`nombre`, `slug`, `tipo`, `logo_url`, `modulos_activos`, `activo`).

En la interfaz sí se habla de **taller**, que es lo que el usuario es.

### Superadmin

El admin de `arm-sur` ve en **Admin › Mi taller** una segunda pestaña con todos
los talleres: crearlos, activarlos, asignarles módulos y **entrar a trabajar en
uno** (`Auth.entrarComoTaller`). Mientras está adentro, una barra amarilla lo
deja en evidencia y permite volver.

Crear talleres y usuarios genera credenciales, así que `fn_crear_taller` y
`fn_crear_usuario_taller` exigen la contraseña del superadmin y **la verifican
dentro de Postgres**. Sin ella no crean nada, aunque alguien llame la RPC directo.

## Reglas de la agenda

- **La unidad de capacidad es la BAHÍA, no la hora.** Con dos elevadores no
  importa que la agenda diga "9:00 libre" si los dos están ocupados: el auto
  espera en la calle. Por eso el tablero es una columna por bahía.
- **Los choques los bloquea la base**, no la vista. `fn_agendar_cita` valida
  solapamiento de bahía y de mecánico antes de guardar, y respeta el horario y
  los días hábiles de `taller_config_agenda`. Al final del script queda, comentada,
  la `exclude` constraint por si se quiere blindar también contra inserts directos.
- **Se puede agendar a alguien que no está en la base** (`cliente_texto`,
  `patente_texto`): el que llama por teléfono no siempre es cliente todavía.
  Al llegar el auto se registra de verdad en Recepción.
- **"Llegó" crea la OT** (`fn_cita_a_orden`) y deja la cita en `en_taller`,
  enlazada a la orden.
- **La inasistencia se mide.** Es el costo invisible del taller: la bahía queda
  vacía y ya se rechazó a otro cliente para esa hora. El KPI muestra la tasa de
  los últimos 90 días y se pone en rojo sobre 15%.
- La ocupación del día compara minutos agendados contra
  bahías activas × horas de atención.

## Reglas de los presupuestos

- **Un presupuesto NO toca el stock.** El stock se mueve una sola vez, al
  convertirlo en orden de trabajo (`fn_convertir_presupuesto_ot`). Antes del
  script 08 un presupuesto era una OT en estado `presupuesto` y cotizar
  descontaba inventario: un taller que cotizaba 20 trabajos al día se
  descapitalizaba el stock en el papel por trabajos que nunca se hicieron.
- **Solo se convierte un presupuesto aprobado.** Y la aprobación exige registrar
  **quién autorizó y por qué vía** (presencial, teléfono, WhatsApp, email). Si
  después hay reclamo, eso es lo único que respalda al taller.
- **Versiones, no ediciones.** Si el cliente pide sacar un ítem, se saca una
  versión nueva y la anterior queda como `reemplazado`. Así se conserva qué se
  cotizó primero.
- **Ítems opcionales**: se le muestran al cliente pero no suman al total
  ("además le recomendamos…"). Al aceptarlos se desmarcan y entran al total.
- **El margen se ve siempre mientras se cotiza**, ítem por ítem y en el total, y
  avisa en rojo si se está cotizando bajo el costo de los repuestos. En la
  impresión al cliente el margen **no aparece**.
- Se puede cotizar un repuesto sin stock: para eso está el módulo Compras. Solo
  avisa.
- Si el módulo está activo, el botón **"Generar presupuesto"** de Recepción crea
  un presupuesto de verdad en vez de una OT en estado `presupuesto`.

## Reglas de las mantenciones

- **Vence por lo que ocurra primero: fecha o kilometraje.** Un taxi llega a los
  10.000 km en dos meses; un auto de fin de semana, en dos años. Por eso un plan
  puede definir `cada_km`, `cada_meses` o ambos.
- **La periodicidad se copia del plan al programar.** Si mañana el taller cambia
  el plan, las mantenciones ya agendadas no se mueven solas.
- **Al marcar una mantención hecha se agenda la siguiente** (`fn_completar_mantencion`),
  tomando la fecha y el kilometraje reales del servicio. Si no se reagenda, el
  taller pierde al cliente en silencio.
- **El sistema NO envía nada solo.** Prepara el mensaje según el gatillo (km o
  fecha) y el tipo (mantención o documento), y abre WhatsApp o el teléfono para
  que la persona lo revise y lo mande. Avisarle a un cliente equivocado cuesta
  más caro que no avisarle.
- Un índice único impide agendar dos veces el mismo plan al mismo vehículo.
- Los documentos del vehículo (revisión técnica, permiso de circulación, SOAP)
  usan el mismo mecanismo, con `tipo = 'documento'`.

## Reglas de los reportes

- **El costo del repuesto se congela al agregarlo a la OT** (trigger `trg_item_costo`).
  Sin eso una orden de marzo se valorizaría con el costo de agosto y el margen sería
  ficción. El front no cambió: lo hace la base.
- **Los totales de la OT los calcula un trigger** (`trg_orden_totales`), junto con
  neto e IVA. El navegador sigue escribiendo los mismos valores; ya no es la
  fuente de verdad.
- **El resultado es OPERATIVO, no contable**:
  `margen bruto = ingresos − costo de repuestos` y
  `resultado = margen bruto − gastos − comisiones pagadas`.
  No incluye sueldos fijos, arriendo ni depreciación, salvo que se carguen como
  gasto en Caja. Sirve para decidir, no para declarar impuestos.
- **La deuda mostrada es la foto de hoy**, no del periodo seleccionado.
- **Capital dormido** = stock sin salidas por venta u OT en 90 días, valorizado al
  costo. Es la plata que el taller tiene detenida en la bodega.
- Los ítems anteriores al 06 quedan con costo 0 (margen 100%). El script trae, al
  final y comentado, un `update` para rellenarlos con el costo actual — es una
  aproximación, el costo real de esas órdenes ya no se puede recuperar.

## Reglas de las compras

- **El stock se mueve solo al recibir.** Emitir una orden de compra no toca el
  inventario; `fn_recibir_compra` sube cada ítem con costo promedio ponderado
  (reusa `fn_entrada_stock_repuesto`), deja el kardex y crea la cuenta por pagar.
- **IVA al revés que en ventas.** Los costos de compra se registran **netos**, como
  vienen en la factura del proveedor: `neto = Σ(cantidad × costo)`,
  `iva = round(neto × 0,19)` (crédito fiscal), `total = neto + iva`.
  El costo que entra al inventario es el **neto** — por eso el margen del repuesto
  compara costo neto contra precio de venta con IVA.
- **Un ítem sin `repuesto_codigo` es un insumo**: entra al costo del documento pero
  no controla stock (fletes, consumibles).
- **Se puede comprar un repuesto que no está en el catálogo**: se crea con stock 0
  al agregarlo a la OC, y la recepción le pone las unidades y el costo.
- **El vencimiento sale de la condición del proveedor** (contado, o crédito a N días).
- **Una compra pagada no se anula.** Primero hay que revertir el pago. Y al anular
  una compra recibida, si el stock ya se consumió, la operación falla en vez de
  dejar el inventario en negativo.

## Reglas de las comisiones

- **Se comisiona sobre documentos cerrados.** Una OT solo entra cuando está
  `entregada`; una venta, cuando no está anulada. Nada de comisionar presupuestos.
- **Opción "solo lo ya cobrado"**: deja fuera las órdenes entregadas con saldo
  pendiente. Es la forma sana de trabajar — no se paga comisión por plata que no llegó.
- **Una liquidación aprobada o pagada no se recalcula nunca.** Regenerar el periodo
  solo toca las que están en `borrador`: una cifra ya comprometida con la persona
  no cambia sola.
- **El vendedor se resuelve por RUT**: `taller_ventas.usuario_rut` ↔
  `taller_empleados.rut`. Si el empleado no tiene RUT cargado, sus ventas no comisionan.
- **El mecánico sale de la OT** (`mecanico_id`), y un ítem de mano de obra puede
  tener su propio `empleado_id` si lo ejecutó otra persona.
- **Pagar una liquidación es un egreso de caja** (motivo `comision`): la comisión
  es plata que sale, y tiene que aparecer en el arqueo.

Bases de cálculo disponibles: `mano_obra`, `total_ot`, `repuestos_ot`,
`total_venta` y `margen_venta`. Para vendedores conviene **margen**: si regalan
descuento, comisionan menos.

## Convenciones heredadas

- Toda query filtra por `empresa_id` (`window.appData.usuario.empresa_id`).
- Cache-busting `?v=YYYYMMDD` en scripts y CSS.
- Stock SOLO vía RPC `fn_descontar_stock_repuesto`; correlativos vía `fn_taller_siguiente_numero`.
- Supabase JS v2: try/catch con await; >1000 filas → `.range()`.
- Todo dato que venga de la BD pasa por `esc()` antes de entrar a `innerHTML`.

## Pendientes conocidos

- **Permisos del front**: `ROL_MODULOS` y `modulos_activos` son UI, no seguridad.
  Un usuario puede editar su sesión en localStorage y mostrarse paneles de más;
  lo único que lo detiene de verdad son las políticas RLS.
- **Aislamiento entre talleres**: la app usa la clave publishable sin JWT, así que
  Postgres no sabe qué empresa consulta y el filtro por `empresa_id` lo pone el
  front. El cierre real es migrar a Supabase Auth con `empresa_id` en los claims
  (nota al final de `sql/01_seguridad_login.sql`).
- **OT antiguas en estado `presupuesto`**: las creadas antes del script 08 ya
  descontaron stock. No se migran solas — revísalas una por una (el 08 trae la
  consulta al final).
- **Totales de las OT**: se siguen calculando y escribiendo desde el cliente, y
  sin IVA. Las ventas ya lo hacen bien en la base (`fn_registrar_venta`); falta
  llevar las órdenes al mismo modelo.
- `index.html` + `css/estilos.css` son de la primera versión (login por email) y
  no corresponden al flujo actual.
