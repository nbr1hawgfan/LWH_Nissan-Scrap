/* ============================================================
   NISSAN SCRAP ANALYTICS - unit-level exports  (step 4)
   Paste into Supabase > SQL Editor (LWH Companion) and Run.
   Read-only function; adds nothing else.

   nissan_units_export(from, to, mode)
     mode 'scrapped'  - units scrapped in the range
     mode 'received'  - units received in the range, with current status
   Returns compact rows (arrays) to keep large exports small:
     [lwh_id, item, description, type, received, status,
      out_date, days_to_out, pro, reference, scrap_route]
   ============================================================ */

create or replace function public.nissan_units_export(p_from date, p_to date, p_mode text)
returns jsonb
language sql
stable
set search_path to 'public'
as $$
    select coalesce(jsonb_agg(jsonb_build_array(
               root_lwh, item_nm, item_desc, unit_type, inbound_date, disposition,
               out_date, days_to_out, out_pro, ref_num,
               case scrap_source when 'SCRAP OUT LOAD' then 'Scrap out load'
                                 when 'SCRAP REF'      then 'Scrap reference' end)
           order by case when p_mode = 'scrapped' then out_date else inbound_date end, root_lwh), '[]'::jsonb)
    from (
        select * from nissan_units
        where case when p_mode = 'scrapped'
                   then disposition = 'SCRAP' and out_date between p_from and p_to
                   else inbound_date between p_from and p_to end
        limit 200000
    ) u;
$$;

revoke all on function public.nissan_units_export(date, date, text) from public, anon, authenticated;
grant execute on function public.nissan_units_export(date, date, text) to service_role;

select 'unit exports ready' as status;
