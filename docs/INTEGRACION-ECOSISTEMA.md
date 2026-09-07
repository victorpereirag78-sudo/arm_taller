# Integración ARM Taller ↔ Mi Vehículo ↔ WhatsApp — Auditoría y plan

> Fecha: 2026-09-07 · Estado: auditoría previa, **sin código escrito todavía**.
> Base de datos auditada: proyecto Supabase `ARMuniversal` (`rhggndoqjnlzmfxsllto`).

Este documento responde a la "REGLA FINAL" del brief: qué existe, qué se reutiliza,
qué se modifica, qué tablas nuevas, qué relaciones, qué APIs, prioridades, riesgos
y orden de implementación. **Leer antes de tocar código.**

---

## 0. Panorama

- **Una sola base Supabase compartida por ~13 productos**. Convención de aislamiento:
  el prefijo de tabla (`taller_`, `autodocumentos_`, `drive_`, `mifran_`, `mascotas_`,
  `emprendedores_`, `mendez_`, más el ARM Universal legacy sin prefijo).
- **ARM Taller = tablas `taller_*`**. **Mi Vehículo (rebautizado "ARM-DocsCars") =
  tablas `autodocumentos_*`**. Hoy **no existe ninguna relación** entre ambos: ni FK,
  ni función, ni columna.
- **ARM Taller está casi vacío en lo operativo**: 4 OT, 3 clientes, 3 vehículos, 1 caja,
  0 presupuestos, 0 citas. Lo único cargado en serio: 1.923 repuestos (Zona Motos Pro).
  → **Momento ideal para integrar**: casi nada que migrar ni que romper.
- **Mi Vehículo también está temprano**: 1 vehículo, 3 perfiles, 4 documentos.

### Estado real de las migraciones (verificado en la base, 2026-09-07)

- **`sql/12`, `sql/13` y `sql/14` NO están aplicados** (aunque están escritos y
  versionados). En la base: no existe `taller_sesiones`, `fn_login_taller` sigue
  siendo la versión de 2 parámetros, no existe `taller_empresa_actual()`.
- **`config.js` YA envía el header `x-taller-token`** cuando hay token guardado →
  el front está listo para el modelo del script 14; falta correr el SQL.
- **Ninguna tabla `taller_*` tiene políticas RLS.** 19 tienen RLS activa y 0
  políticas (deny-all para `anon` — por eso los módulos nuevos muestran "faltan
  permisos"); 8 tienen RLS desactivada y están **totalmente abiertas**
  (`taller_clientes`, `taller_vehiculos`, `taller_ordenes`, `taller_ordenes_items`,
  `taller_repuestos`, `taller_ventas`, `taller_ventas_items`, `taller_correlativos`).
- **Las FKs internas del taller YA existen**: `taller_ordenes.{cliente_id, vehiculo_id,
  mecanico_id, empresa_id}`, `taller_vehiculos.{cliente_id, empresa_id}`.
- **`taller_vehiculos` YA tiene `UNIQUE (empresa_id, patente)`** y `taller_clientes`
  `UNIQUE (empresa_id, rut)`. Lo que falta es **normalización de formato** de la
  patente y la **correlación entre productos**, no la unicidad por taller.
- La patente `CYBX30` aparece en dos talleres distintos (`182f…` y `37063…`): **no
  es un duplicado**, es el mismo auto físico atendido en dos talleres — justo el
  caso que la integración debe soportar. También está en `autodocumentos_vehicles`.
- `usuarios.pass_hash` existe (script 01 aplicado). `sql/15-17` aplicados.

---

## 1. Qué ya existe y se reutiliza (reutilización alta)

### Lado ARM Taller

| Necesidad del brief | Ya construido |
|---|---|
| Cliente / Vehículo / OT | `taller_clientes`, `taller_vehiculos` (con `patente`), `taller_ordenes` (`estado`, `kilometraje_ingreso`, `nivel_combustible`, `motivo_ingreso`, `diagnostico`, `mecanico_id`), `taller_ordenes_items` |
| Estados de OT (pt. 3) | 8 estados + transiciones validadas en `js/modulo-ordenes.js` (`_transicionValida`, mapa `TRANSICIONES`) |
| Presupuestos conectados (pts. 6, 10, 21) | `taller_presupuestos` + `taller_presupuestos_items`: **modelo muy completo** — versiones (`fn_nueva_version_presupuesto`), vigencia, `fn_responder_presupuesto(aprobado/rechazado + vía + quién + motivo)`, `fn_convertir_presupuesto_ot` (único punto donde se mueve stock), `fn_reporte_presupuestos` (tasa de conversión) |
| Agenda conectada (pt. 12) | `taller_citas` + `taller_bahias` + `taller_config_agenda`: anti-choque en BD (`fn_agendar_cita`), `cliente_texto`/`patente_texto` para quien no está en el sistema, `fn_cita_a_orden` — el flujo "Solicitud→Cita→OT" ya está modelado |
| Confirmación de citas (pt. 13) | KPI de inasistencia, estados de cita |
| WhatsApp como canal (pt. 7) | `js/modulo-mantenciones.js` **ya arma el mensaje y abre WhatsApp / teléfono** manualmente. Filosofía explícita: "el sistema NO envía nada solo" |
| Recepción digital (pt. 14) | `js/modulo-recepcion.js` — puerta de entrada cliente+vehículo+motivo → OT/presupuesto |
| Inventario ↔ OT (pt. 15) | Stock **solo** vía RPC (`fn_descontar_stock_repuesto`), kardex en `taller_movimientos_stock`, costo promedio ponderado, triggers que congelan costo y totales |
| OT ↔ Caja (pt. 16) | `taller_cajas`, `taller_movimientos_caja`, `fn_registrar_venta` atómica, vista `v_taller_ordenes_saldo` (OT con saldo avisa antes de entregarse) |
| Cuentas por pagar (pt. 18) | `taller_cuentas_pagar` **ya existe** (vacía) |
| Mantenciones / historial (pt. 5) | `taller_planes_mantencion`, `taller_mantenciones`, `fn_completar_mantencion` (reagenda la siguiente) |
| Identidad del lado servidor | `sql/14_sesiones_taller.sql` — token opaco en header `x-taller-token`, `taller_sesiones`, `taller_empresa_actual()`. **Etapa 1 hecha; la Etapa 2 (RLS real) está pendiente** |
| Datos y ficha del taller (pts. 10, 23) | `taller_config` (`rut`, `giro`, `direccion`, `comuna`, `ciudad`, `telefono`, `email`, `sitio_web`, textos de documentos) |

### Lado Mi Vehículo (`autodocumentos_*`)

| Necesidad del brief | Ya construido |
|---|---|
| Un vehículo con varios usuarios autorizados (pt. 1) | `autodocumentos_vehicle_access` (`role` dueño/conductor, `can_view_documents`, `can_edit`) — modelo de autorización revocable ya funcionando |
| Historial mecánico automático (pt. 5) | `autodocumentos_maintenance_records`: `vehicle_id`, `workshop` (texto), `mechanic`, `labor_cost`, `parts_cost`, `total_cost`, `payment_method`, `next_due_date`, `next_due_mileage_km`, `notes`. **La forma ya está** — hoy el taller es texto libre |
| Vencimientos / recordatorios (pts. 4, 13) | `autodocumentos_reminders` (por fecha y/o km) |
| Documentos del vehículo | `autodocumentos_vehicle_documents` + `_versions` + Storage privado con URLs firmadas |
| Puerta pública sin sesión | Edge Function `qr-verificar` con `service role` + rate limiting — **el patrón exacto** para el puente con el taller |
| Planes / suscripciones (pt. 25) | `autodocumentos_plans` (6 seed), `autodocumentos_subscriptions`, `autodocumentos_payments`, `autodocumentos_admin_asignar_plan` |
| Aislamiento de datos | RLS estricta: `autodocumentos_can_view_vehicle()` / `can_edit_vehicle()`, todas `SECURITY DEFINER` con `search_path=''` |

**Conclusión:** el modelo de datos que propone el brief (`vehicle_workshops`,
`work_order_status_history`, `estimates`, `mechanical_history`, `notification_events`…)
**coincide en ~80% con lo ya construido**. No se reconstruye: se **puentea y completa**.

---

## 2. Qué hay que modificar (no reemplazar)

1. **Estados de OT: mapear 8 → 12, sin botar los 8.**
   Hoy: `recepcion, diagnostico, presupuesto, aprobada, reparacion, lista, entregada, anulada`.
   Brief pide 12. Faltan: `en_diagnostico` vs `diagnostico_terminado`,
   `esperando_aprobacion`, `rechazado`, `esperando_repuestos`.
   Cambiar el `check` rompe el CSS de badges (`.tll-badge.<estado>`) y `_transicionValida`.
   → migración con mapeo explícito viejo→nuevo.

2. **Mover la validación de transiciones del front a la BD.**
   Hoy vive solo en `js/modulo-ordenes.js`. Requisito para que Mi Vehículo / WhatsApp
   no puedan saltarse el flujo.

3. **Vehículo: NO fusionar `taller_vehiculos` con `autodocumentos_vehicles`.**
   Distinta convención (`patente`/`plate`, español/inglés), distinto dueño de datos,
   distinto auth. Se correlacionan por **patente normalizada** vía tabla puente.

4. **Patente: hay `unique (empresa_id, patente)` pero sin normalización de formato.**
   Riesgo de vincular el auto equivocado si un lado guarda `CY-BX-30` y el otro
   `CYBX30`. Forzar formato canónico (mayúsculas, sin guiones ni espacios) con
   trigger/columna generada en `taller_vehiculos` y coordinar con
   `autodocumentos_vehicles.plate` **antes** de conectar. La correlación se valida
   además contra marca/modelo, no solo patente.

5. **Historial mecánico: escribir en la tabla que ya existe**
   (`autodocumentos_maintenance_records`), agregándole `source` + `source_work_order_id`,
   en vez de crear una tabla paralela.

6. **`taller_config`: extender, no duplicar** — agregar `lat`, `lng`, `horario` (jsonb),
   `servicios` (text[]), `especialidades` (text[]), `publicado` (bool) para el directorio.

---

## 3. Tablas nuevas realmente necesarias (mínimo)

| Tabla | Para | Campos clave |
|---|---|---|
| `taller_ot_estado_historial` | pts. 3, 9 | `orden_id`, `estado_anterior`, `estado_nuevo`, `usuario_rut`, `ts`, `nota` |
| `taller_vehiculo_vinculo` | pts. 1, 2, 11 — **corazón de la integración** | `empresa_id`, `taller_vehiculo_id`, `autodoc_vehicle_id`, `cliente_id`, `estado` (`pendiente`/`activo`/`revocado`), `token_invitacion`, `autorizado_por`, `fecha_vinculacion`, `fecha_actualizacion` |
| `taller_notificacion_eventos` | pts. 7, 8 | `empresa_id`, `tipo_evento`, `orden_id`/`presupuesto_id`, `payload` jsonb, `creado_at`, `procesado_at` |
| `taller_notificaciones` | pts. 7, 8 | `evento_id`, `canal` (`mi_vehiculo`/`whatsapp`/`email`), `destinatario`, `estado` (`pendiente`/`enviado`/`error`), `enviado_at`, `error` |
| `taller_gastos` | pt. 19 (FASE 2) | `empresa_id`, `categoria`, `monto`, `fecha`, `descripcion`, `usuario_rut` |
| `taller_cierres_caja` | pt. 17 (FASE 2) | `caja_id`, `fondo_inicial`, `esperado`, `contado`, `diferencia`, `usuario_rut`, `cerrado_at` |

- **Preferencia de canal (pt. 7):** columna `canal_pref` en `taller_clientes`
  (`mi_vehiculo`/`whatsapp`/`ambos`/`ninguno`), no tabla aparte.
- **Directorio de talleres (pts. 10, 23):** extender `taller_config`, no tabla nueva.
- `taller_cuentas_pagar` **ya existe** — no crear.

---

## 4. Relaciones a crear

- `taller_vehiculos.patente_norm` ↔ `autodocumentos_vehicles.plate_norm`
  (correlación lógica, **sin FK entre productos**).
- `taller_vehiculo_vinculo.autodoc_vehicle_id` → `autodocumentos_vehicles.id`.
- `taller_vehiculo_vinculo.taller_vehiculo_id` → `taller_vehiculos.id`.
- `taller_ot_estado_historial.orden_id` → `taller_ordenes.id`.
- `autodocumentos_maintenance_records.source_work_order_id` → `taller_ordenes.id` (nullable).

> Las FKs internas del taller (`taller_ordenes` y `taller_vehiculos` → clientes/
> vehículos/empleados/empresas) **ya existen**; no hay que crearlas.

---

## 5. El problema de fondo: dos modelos de autenticación incompatibles

**Es el ~60% del riesgo y del trabajo — no las tablas.**

| | ARM Taller | Mi Vehículo |
|---|---|---|
| Identidad | tabla propia `usuarios`, RUT + `pass_hash` (bcrypt) | Supabase Auth (`auth.users`, `auth.uid()`) |
| Cliente Supabase | clave `anon`, **sin JWT** | JWT real por usuario |
| Aislamiento | filtro `empresa_id` **en el navegador** | RLS estricta `SECURITY DEFINER` |
| **RLS en tablas core** | 🔴 **DESACTIVADO** en `taller_clientes`, `taller_vehiculos`, `taller_ordenes`, `taller_ordenes_items`, `taller_ventas`, `taller_correlativos`, `taller_repuestos` | activado en todo |

El linter de Supabase lo marca **crítico**: con la anon key, cualquiera lee o
modifica **todas** las filas de esas tablas, de todos los talleres.

**Decisión de arquitectura recomendada:**
No unificar los dos auth a la fuerza (rompería el login del taller).
El puente son **Edge Functions con `service role`** como frontera entre los dos
mundos — el mismo patrón que Mi Vehículo ya usa para el QR. Ningún front toca
tablas del otro producto directamente. Toda la lógica de canal (Mi Vehículo /
WhatsApp / email) vive detrás de **una sola** capa de eventos.

---

## 6. APIs / endpoints necesarios (Edge Functions)

| Función | Quién llama | Qué hace |
|---|---|---|
| `taller-link/invitar` | ARM Taller | genera código/QR de vinculación para un vehículo |
| `taller-link/aceptar` | Mi Vehículo (usuario autenticado) | canjea el código, crea el vínculo `activo` |
| `taller-link/revocar` | ambos | pasa el vínculo a `revocado` |
| `mivehiculo/ot/:vehicle_id` | Mi Vehículo | estado actual + timeline, **filtrado** (sin costos ni márgenes) |
| `mivehiculo/presupuesto/:id` (GET) | Mi Vehículo | detalle del presupuesto, precios con IVA, **sin costo/margen** |
| `mivehiculo/presupuesto/:id/responder` (POST) | Mi Vehículo | aprobar/rechazar → `fn_responder_presupuesto` |
| `mivehiculo/cita/solicitar` (POST) | Mi Vehículo | crea **solicitud**, nunca OT directa |
| `talleres` (GET) | Mi Vehículo | directorio público (`taller_config` con `publicado=true`) |
| `notification-dispatch` | cron / trigger | consume `taller_notificacion_eventos`, decide canal, encola en `taller_notificaciones` |
| `whatsapp-send` | dispatcher | envía vía Meta Cloud API o Twilio |
| `whatsapp-webhook` | Meta/Twilio | recibe respuestas del cliente (aprobar presupuesto por WhatsApp, confirmar cita) |

---

## 7. Prioridades (lectura del brief + realidad del código)

La **FASE 1** del brief tiene 14 puntos: es demasiado para un tramo. Se subdivide:

### FASE 1a — Cimientos (no negociable, sin UI nueva)
0a. ✅ **`sql/12`, `sql/13`, `sql/14` aplicados.** El front ya estaba listo (`auth.js` +
   `config.js` con `x-taller-token`). `fn_diag_sesion` desde la app → "Todo bien".
   ⚠ Bug encontrado al aplicar: `fn_login_taller` elegía la cuenta al azar cuando un RUT
   tiene cuenta en varias empresas → **`sql/28_fix_login_multiempresa.sql`** (aplicado;
   parcheado también en la fuente `sql/14`). Ver [[login-taller-crypt-bug]].
0b. ✅ **Etapa 2 de RLS — `sql/26_rls_etapa2.sql` aplicado.** `taller_app_acceso` (`using(true)`)
   → `taller_propio` (`empresa_id = taller_empresa_actual()`) en las 34 tablas con `empresa_id`;
   `taller_ot_estados`/`taller_ot_transiciones` = `taller_propio` (select abierto) + `taller_propio_w`;
   `taller_sesiones` cerrada. `security_invoker=true` en las vistas `v_taller_*`. **Sin `revoke
   from anon`** (rompería ARM Universal): aísla la política, no el grant.
   **Verificado:** con token → solo el taller de la sesión; sin token → 0 filas; 0 fuga entre
   talleres. Los 19 paneles recorridos sin problema.

**→ FASE 1 COMPLETA.**
0c. ✅ Patente canónica: `taller_vehiculos.patente_norm` (columna generada) + índice único. `sql/18`.
1. ✅ Puente de identidad: resuelto vía RPC `SECURITY DEFINER` + `auth.uid()` (no hace falta Edge Function para el handshake). `sql/19`.
2. ✅ `taller_vehiculo_vinculo` + RPCs `invitar` / `preview` / `aceptar` / `rechazar` / `revocar` + vista `v_taller_vinculos`. `sql/18` + `sql/19`. Probado por SQL (falta `aceptar` real desde Mi Vehículo con sesión).
3. ✅ Estados de OT 8→12 (aditivo, sin renombrar los 8 actuales) + `taller_ot_estados` / `taller_ot_transiciones` (config en BD) + trigger `trg_ot_valida_transicion` (fail-open) + trigger de historial + vista `v_taller_ot_timeline`. `sql/18` + `sql/20`. JS: `config.js` (labels/clases/fallback), `modulo-ordenes.js` (carga estados desde BD), `modulo-dashboard.js`, `modulo-vehiculos.js`, `css/app.css` (+4 badges). Probado por SQL y en el navegador (sin login).

> **Gotcha confirmado para 0a/0b:** Supabase activa RLS sola en toda tabla nueva de
> `public`. Los scripts 18 y 20 la vuelven a desactivar en sus tablas para igualarlas
> al núcleo actual. Cuando se aplique `sql/13`, su loop las reactiva con la permisiva.

### FASE 1b — Primer flujo visible
4. ✅ Timeline de OT — vista `v_taller_ot_timeline` (`sql/20`).
5. ✅ **Backend** de lectura para Mi Vehículo (`sql/21`): `fn_mv_mis_talleres()`,
   `fn_mv_vehiculo_ot()` (estado + timeline, sin costos). Falta la UI React en ARM-DocsCars.
6. ✅ **Backend** de presupuestos (`sql/21`): `fn_mv_vehiculo_presupuestos()` (sin costo/margen/SKU)
   + `fn_mv_presupuesto_responder()` → `fn_responder_presupuesto` con vía `mi_vehiculo`. Falta UI React.
7. ✅ Historial mecánico automático (`sql/22`): trigger en `taller_ordenes` que al pasar a
   `entregada` inserta en `autodocumentos_maintenance_records` (dedup por `source`/`source_ref`,
   fail-open, sin datos internos). Funciona sin UI. **Reflejar las 2 columnas nuevas en el repo ARM-DocsCars.**

**ARM Taller UI** ✅ — módulo Vehículos: columna de estado del vínculo + botón "Mi Vehículo"
que genera la invitación (QR + código vía `qrcodejs` de jsdelivr), muestra "esperando confirmación",
o "vinculado / revocar". `js/modulo-vehiculos.js`, `js/config.js` (`MI_VEHICULO_URL`, `vinculoLink`),
`app.html` (script qrcodejs). `?v=20260907b`.

**ARM-DocsCars UI** ✅ — feature `src/features/taller/`:
- `MisTalleresPage` (`/talleres`, item nuevo en la bottom-nav) — talleres vinculados + contadores.
- `SeguimientoTallerPage` (`/vehiculos/:id/taller`, link nuevo en `VehiculoPage`) — línea de
  tiempo de la OT + presupuestos pendientes con **Aprobar / Rechazar**.
- `VincularPage` (`/vincular/:token`) — preview + aceptar/rechazar, hace match del vehículo por patente.
- `src/types/db.ts`: +`source`/`source_ref` en `MantencionRow`, +7 RPC en `Functions`.
- `supabase/migrations/0007_integracion_arm_taller.sql` (registro; ya aplicado vía arm-taller/sql/22).
- `tsc` + `eslint` + 58 tests + `vite build` en verde.

**Pendiente FASE 1b:** desplegar ARM-DocsCars; ajustar `MI_VEHICULO_URL` en
`ARM_Taller/js/config.js` al dominio real; prueba end-to-end con login en ambas apps.

### FASE 1c — Comunicación
8. ✅ Capa de notificaciones (`sql/23`): `taller_notificacion_eventos` (log) +
   `taller_notificaciones` (bandeja de salida por canal) + `taller_clientes.canal_pref`
   (`auto`/`mi_vehiculo`/`whatsapp`/`ambos`/`ninguno`) + `fn_taller_emitir_evento` (abanica
   a los canales según preferencia y si el vehículo está vinculado) + triggers en `taller_ordenes`
   y `taller_presupuestos`. Lectura Mi Vehículo: `fn_mv_novedades` / `fn_mv_novedad_leida` /
   `fn_mv_novedades_todas_leidas`. Probado end-to-end (auto/ambos/ninguno).
9. ✅ Dispatcher WhatsApp:
   - `sql/24`: `fn_taller_wa_responder_presupuesto(telefono, respuesta)` (match por teléfono, service_role).
   - Edge Functions en `ARM_Taller/supabase/functions/`: `taller-notification-dispatch` (cron →
     WhatsApp Cloud API de Meta) y `taller-whatsapp-webhook` (verificación + APRUEBO/RECHAZO
     entrante). Ver su `README.md` para deploy, secrets y cron. **Sin credenciales de Meta aún:
     el dispatcher deja las de WhatsApp en `error` y sigue; Mi Vehículo funciona igual.**
10. ✅ Directorio "Talleres ARM" + "Mis talleres":
   - `sql/25`: `taller_config` +`publicado`/`descripcion`/`whatsapp`/`horario`/`lat`/`lng`/
     `servicios[]`/`especialidades[]`/`marcas[]`. `fn_directorio_talleres()` (filtros +
     distancia haversine) + `fn_directorio_filtros()`. `taller_solicitudes_hora` +
     `fn_mv_solicitar_hora()` + `v_taller_solicitudes_hora`.
   - ARM Taller: `modulo-taller.js` card "Perfil público · Directorio"; `modulo-agenda.js`
     bloque "📨 Solicitudes de hora" (contactado/descartar). `?v=20260907e`.
   - ARM-DocsCars: `/talleres` ahora con pestañas **Mis talleres | Buscar talleres**
     (`TalleresPage`), `DirectorioTalleresPanel` (búsqueda, filtros, "cerca de ti" por
     geolocalización, contacto WhatsApp/tel) + modal **Solicitar hora**. `db.ts` +3 RPC.
   - Probado por SQL (directorio, filtros, haversine, solicitar sin sesión) + tsc/lint/58 tests/build.

**ARM Taller UI FASE 1c** ✅ — `modulo-clientes.js` (selector "Cómo avisarle" = `canal_pref`),
`modulo-ordenes.js` (bloque "Actividad y avisos al cliente" en el detalle de OT: timeline +
qué avisos salieron y por qué canal). `?v=20260907c`.

**ARM-DocsCars UI FASE 1c** ✅ — `SeguimientoTallerPage`: sección **Novedades** con contador de
no leídas y "marcar leídas" (`useNovedades` → `fn_mv_novedades`). `db.ts`: +3 RPC.

### FASE 2 — Media

12. ✅ **Agenda conectada** — `sql/27`: `fn_solicitud_a_cita()` (solicitud → cita real vía
    `fn_agendar_cita`, avisa al cliente). ARM Taller: botón "Agendar" en el bloque de
    solicitudes de `modulo-agenda.js`.
13. ✅ **Confirmación de citas** — `fn_mv_citas()` / `fn_mv_cita_responder()` (confirmar/cancelar,
    avisa al taller). Recordatorios: `taller_citas` +`aviso_creada`/`aviso_24h`/`aviso_2h`,
    `fn_taller_recordatorios_citas()` (la llama el cron del dispatcher). ARM-DocsCars:
    sección "Próximas citas" en `SeguimientoTallerPage` con confirmar/cancelar.
21. ✅ **Presupuestos perdidos** — `taller_presupuestos.motivo_rechazo_cat`
    (`precio`/`postergado`/`no_responde`/`otro_taller`/`otro`), `fn_taller_presup_motivo_perdida()`,
    `fn_reporte_presupuestos()` ahora con `monto_perdido` + `perdida_por_motivo`. ARM Taller:
    modal de rechazo con categoría + desglose "Presupuestos perdidos" en `modulo-presupuestos.js`.
    `?v=20260907f`.

14. ✅ **Recepción digital** — `sql/29`: `taller_ordenes.danos_recepcion` (jsonb) +
    `recepcion_observaciones`. `modulo-recepcion.js`: marcador de daños (tipo × zona × nota);
    se muestran en el detalle de OT y en `SeguimientoTallerPage` de Mi Vehículo.
15/16/17. Ya estaban (stock por RPC + kardex, `v_taller_ordenes_saldo`, `fn_cerrar_caja`).
18. `taller_cuentas_pagar` existe (módulo CxP).
19. ✅ **Gastos** — `sql/30`: `taller_gastos` + `fn_reporte_gastos` + `fn_reporte_resumen`
    ahora suma el libro de gastos al resultado. Módulo nuevo `js/modulo-gastos.js`
    (panel `panel-gastos`, roles admin/jefe_taller/contador).
20. ✅ **Reportes ampliados** — `modulo-reportes.js`: bloques "Gastos del periodo" (por
    categoría) y "Presupuestos" (emitidos/aprobados/rechazados/tasa + perdidos por motivo).

**→ FASE 2 COMPLETA.**  `?v=20260907i`.

### FASE 3 — Baja (no bloquea lanzamiento)
Valoraciones · perfil público avanzado · fidelización · Premium Mi Vehículo · IA.

**Validar BD, permisos, flujo, móvil y escritorio al final de cada sub-fase antes de seguir.**

---

## 8. Riesgos

| Sev | Riesgo | Mitigación |
|---|---|---|
| 🔴 | RLS del taller apagado — fuga de datos entre talleres y hacia el cliente final | FASE 1a punto 0 antes de exponer nada |
| 🔴 | Patente sin unicidad/normalización → vehículo mal vinculado → cliente ve OT ajena | normalizar + unique + validación en el vínculo (marca/modelo deben calzar) |
| 🔴 | Dos auth incompatibles; unificar a la fuerza rompe el login del taller | Edge Functions como frontera, no unificar |
| 🟠 | Fuga de datos internos: `costo_unitario`, `costo`, `margen`, `margen_pct` en las mismas tablas/vistas | APIs a Mi Vehículo solo por vistas/DTO explícitos, nunca `select *` |
| 🟠 | `empresas` es compartida con ARM Universal y otras apps | no renombrar, no agregarle columnas del taller (van en `taller_config`) |
| 🟠 | Nombres genéricos ya tomados (`notificaciones` = app clínica) | prefijo `taller_` siempre |
| 🟠 | WhatsApp: plantillas pre-aprobadas por Meta, opt-in, costo por conversación, ventana 24 h | dejar la capa lista, integrar real más tarde |
| 🟠 | Cambiar el enum de estados rompe badges CSS + `_transicionValida` | migración con mapeo viejo→nuevo, revisar CSS |
| 🟢 | Confundir `ordenes` (8.758 filas, ARM Universal legacy) con `taller_ordenes` (4) | — |

---

## 9. Primer objetivo funcional (MVP de la integración)

```
Cliente tiene vehículo en Mi Vehículo
  → Taller ARM vincula el vehículo (código/QR)
  → Cliente acepta la vinculación
  → Taller crea recepción → se crea OT
  → OT cambia de estado → Mi Vehículo lo refleja (timeline)
  → Taller genera presupuesto → Cliente lo ve en Mi Vehículo
  → Cliente aprueba/rechaza → ARM Taller recibe la respuesta
  → Taller repara → OT "Listo para retirar" → Cliente recibe aviso
  → OT entregada → historial mecánico se actualiza en Mi Vehículo
```

El mismo flujo debe funcionar para un cliente **sin** Mi Vehículo, por WhatsApp:
mismo motor de eventos, distinto dispatcher.

---

## 10. Apreciación general

- El plan es sólido y el modelo de datos propuesto **ya está construido en ~80%**.
- El trabajo real no es crear tablas: es (a) cerrar la seguridad del taller y
  (b) construir el puente entre dos filosofías de auth opuestas.
- Reutilización alta: presupuestos, agenda y mantenciones/historial ya están casi listos.
- No fusionar entidades entre productos — puentear por patente. No unificar auth —
  Edge Functions como API neutral.
- El MVP demostrable está a **5 pasos**, no a 14.
- WhatsApp: arquitectura lista ahora, integración real después.
