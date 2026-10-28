-- ================================================================
-- 48_imagen_repuestos.sql — ARM TALLER
-- Foto del repuesto, para ver el catálogo en tarjetas (Ventas / Inventario).
--
-- La imagen NO vive en la tabla: se guarda en Supabase Storage y en
-- taller_repuestos solo queda la ruta (unas 40 letras). El navegador
-- la achica a 480×480 WebP (~20-30 KB) antes de subirla, así 2.000
-- repuestos pesan ~50 MB de archivos y 0 MB de base de datos.
--
-- Idempotente: se puede correr más de una vez.
-- Ejecutar en: Supabase → SQL Editor
-- ================================================================


-- ════════════════════════════════════════════════════════════════
-- PASO 1 — Ruta de la imagen en el repuesto
-- ════════════════════════════════════════════════════════════════

alter table taller_repuestos
    add column if not exists imagen_url text;

comment on column taller_repuestos.imagen_url is
    'Ruta dentro del bucket "repuestos" (<empresa_id>/<archivo>.webp). La URL pública se arma en el navegador.';


-- ════════════════════════════════════════════════════════════════
-- PASO 2 — Bucket público (lectura por URL), solo imágenes livianas
-- ════════════════════════════════════════════════════════════════
-- Público = las tarjetas cargan con un <img> normal y el navegador
-- las cachea. Los nombres llevan un sufijo aleatorio, no se adivinan.
-- Tope de 300 KB por archivo: aunque alguien se salte el redimensionado
-- del navegador, no puede llenar el almacenamiento con fotos enormes.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('repuestos', 'repuestos', true, 307200,
        array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
   set public             = true,
       file_size_limit    = 307200,
       allowed_mime_types = array['image/webp', 'image/jpeg', 'image/png'];


-- ════════════════════════════════════════════════════════════════
-- PASO 3 — Escritura solo en la carpeta del propio taller
-- ════════════════════════════════════════════════════════════════
-- Misma idea que el resto de las tablas: la empresa se resuelve en
-- Postgres desde el token de sesión (taller_empresa_actual), no desde
-- lo que diga el navegador. La primera carpeta de la ruta es el
-- empresa_id.

drop policy if exists taller_repuestos_img_leer     on storage.objects;
drop policy if exists taller_repuestos_img_subir    on storage.objects;
drop policy if exists taller_repuestos_img_cambiar  on storage.objects;
drop policy if exists taller_repuestos_img_borrar   on storage.objects;

create policy taller_repuestos_img_leer on storage.objects
    for select to anon, authenticated
    using (bucket_id = 'repuestos'
           and (storage.foldername(name))[1] = taller_empresa_actual()::text);

create policy taller_repuestos_img_subir on storage.objects
    for insert to anon, authenticated
    with check (bucket_id = 'repuestos'
                and (storage.foldername(name))[1] = taller_empresa_actual()::text);

create policy taller_repuestos_img_cambiar on storage.objects
    for update to anon, authenticated
    using      (bucket_id = 'repuestos'
                and (storage.foldername(name))[1] = taller_empresa_actual()::text)
    with check (bucket_id = 'repuestos'
                and (storage.foldername(name))[1] = taller_empresa_actual()::text);

create policy taller_repuestos_img_borrar on storage.objects
    for delete to anon, authenticated
    using (bucket_id = 'repuestos'
           and (storage.foldername(name))[1] = taller_empresa_actual()::text);
