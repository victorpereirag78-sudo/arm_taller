-- ════════════════════════════════════════════════════════════════
-- 31 · Hardening — search_path fijo en los helpers de la integración
-- ════════════════════════════════════════════════════════════════
-- El linter de Supabase marca `function_search_path_mutable` en las
-- funciones auxiliares que agregó la integración (18/19/24) y en el
-- lector de token (14). Ninguna es SECURITY DEFINER y todas usan solo
-- built-ins de pg_catalog, así que el riesgo real es bajo, pero fijar
-- el search_path cierra el aviso y es buena práctica.
--
-- Se usa ALTER FUNCTION (no CREATE OR REPLACE) para no reescribir los
-- cuerpos y evitar cualquier drift.
-- ════════════════════════════════════════════════════════════════

alter function public.fn_norm_patente(text)       set search_path = '';
alter function public.fn_norm_telefono(text)       set search_path = '';
alter function public.fn_trg_vinculo_touch()       set search_path = '';
alter function public.taller_token_actual()        set search_path = '';

-- Verificación
select p.proname,
       (select array_agg(x) from unnest(coalesce(p.proconfig, '{}')) x) as config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('fn_norm_patente','fn_norm_telefono','fn_trg_vinculo_touch','taller_token_actual')
 order by p.proname;
