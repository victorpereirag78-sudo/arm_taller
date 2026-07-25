# ARM Taller

Plataforma SaaS multiempresa para administración de talleres mecánicos — ARM Sistemas.
Mismo patrón, misma instancia Supabase y mismo estilo visual que ARM Universal.

## Puesta en marcha

1. Repo GitHub `arm-taller` con estos archivos → conectar a Cloudflare Pages (sin build, output `/`).
2. Ejecutar el script SQL de setup (tablas `taller_`, `empresas.tipo`, funciones RPC) — ya aplicado.
3. Crear un taller de prueba y su usuario:

```sql
INSERT INTO empresas (nombre, slug, tipo, activo, modulos_activos)
VALUES ('Taller Demo', 'taller-demo', 'taller', true, '{}'::jsonb);

INSERT INTO usuarios (empresa_id, rut, pass, rol, activo)
VALUES ('<id de Taller Demo>', '11111111-1', 'demo123', 'admin', true);
```

4. Abrir `login.html` e ingresar con ese RUT.

## Reglas de acceso

- Solo entran usuarios de empresas con `tipo='taller'`.
- Excepción: admin de la empresa `arm-sur` (superadmin ARM) para administrar talleres.
- Roles: admin, recepcion, mecanico, vendedor, lector (ROL_MODULOS en config.js).
- Planes Profesional/Premium se activarán vía `empresas.modulos_activos` + MODULO_REQUIERE.

## Estructura

```
login.html               Login (brand panel + formulario, RUT + pass)
app.html                 Shell: sidebar colapsable, topbar, paneles
css/login.css            = Universal (textual)
css/app.css              = Universal + paleta y componentes tll-* del taller
js/config.js             Supabase, ROL_MODULOS, MODULO_REQUIERE, PANEL_INFO
js/auth.js               = Universal + validación tipo='taller' (claves tll_)
js/login.js              = Universal (textual: RUT, recordar, validaciones)
js/app.js                Menú dinámico por permisos, cambio de paneles
js/modulo-dashboard.js   KPIs + órdenes en curso (patrón IIFE)
```

## Convenciones heredadas

- Toda query filtra por `empresa_id` (`window.appData.usuario.empresa_id`).
- Cache-busting `?v=YYYYMMDD` en scripts y CSS.
- Stock SOLO vía RPC `fn_descontar_stock_repuesto`; correlativos vía `fn_taller_siguiente_numero`.
- Supabase JS v2: try/catch con await; >1000 filas → `.range()`.
