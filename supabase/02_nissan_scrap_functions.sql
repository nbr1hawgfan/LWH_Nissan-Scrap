/* ============================================================
   NISSAN SCRAP ANALYTICS - functions  (step 2 of 2)
   Paste into Supabase > SQL Editor (LWH Companion) and Run.
   Safe to re-run. Only touches nissan_* objects plus one
   NISSAN row in cust_app_customers.
   (Step 1, the tables, is already applied.)
   ============================================================ */

-- ------------------------------------------------------------
-- refresh_nissan_units(): staging -> live, rebuild daily rollup
-- Called by Sync-NissanScrap.ps1 after a full staging upload.
-- ------------------------------------------------------------
create or replace function public.refresh_nissan_units()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $$
declare
    v_staging  integer;
    v_live     integer;
    v_today    date := (now() at time zone 'America/Chicago')::date;
    v_first    date;
begin
    select count(*) into v_staging from nissan_units_staging;
    if v_staging = 0 then
        raise exception 'Nissan refresh cancelled: staging is empty';
    end if;

    select count(*) into v_live from nissan_units;
    if v_live > 0 and v_staging < v_live * 0.9 then
        raise exception 'Nissan refresh cancelled: staging has % rows but live has % (upload looks incomplete)',
            v_staging, v_live;
    end if;

    delete from nissan_units where root_lwh is not null;

    insert into nissan_units
        (root_lwh, item_nm, item_desc, unit_type, inbound_date, disposition, scrap_source,
         out_date, out_date_source, out_pro, ref_num, final_lwh, chain_level, days_to_out,
         final_gen_count, synced_at)
    select root_lwh, item_nm, item_desc, unit_type, inbound_date, disposition, scrap_source,
           out_date, out_date_source, out_pro, ref_num, final_lwh, chain_level, days_to_out,
           final_gen_count, now()
    from nissan_units_staging;

    delete from nissan_units_staging where root_lwh is not null;

    -- ---------------- daily rollup ----------------
    select min(inbound_date) into v_first from nissan_units;

    delete from nissan_daily where d is not null;

    insert into nissan_daily
        (d, unit_type, inbound, scrap_load, scrap_ref, shipped, adjusted, on_hand_end,
         cohort_scrapped, cohort_out, cohort_scrap_days)
    with days as (
        select gs::date as d from generate_series(v_first, v_today, interval '1 day') gs
    ),
    types as (
        select unnest(array['ENGINE','TRANSMISSION','OTHER']) as unit_type
    ),
    inb as (
        select inbound_date as d, unit_type,
               count(*)                                              as inbound,
               count(*) filter (where disposition = 'SCRAP')         as cohort_scrapped,
               count(*) filter (where disposition <> 'ON HAND')      as cohort_out,
               coalesce(sum(greatest(days_to_out,0)) filter (where disposition = 'SCRAP'),0) as cohort_scrap_days
        from nissan_units group by 1,2
    ),
    outs as (
        select out_date as d, unit_type,
               count(*) filter (where disposition = 'SCRAP' and scrap_source = 'SCRAP OUT LOAD') as scrap_load,
               count(*) filter (where disposition = 'SCRAP' and coalesce(scrap_source,'') <> 'SCRAP OUT LOAD') as scrap_ref,
               count(*) filter (where disposition = 'SHIPPED')  as shipped,
               count(*) filter (where disposition = 'ADJUSTED') as adjusted,
               count(*)                                         as total_out
        from nissan_units where out_date is not null group by 1,2
    )
    select dy.d, t.unit_type,
           coalesce(i.inbound,0), coalesce(o.scrap_load,0), coalesce(o.scrap_ref,0),
           coalesce(o.shipped,0), coalesce(o.adjusted,0),
           sum(coalesce(i.inbound,0) - coalesce(o.total_out,0))
               over (partition by t.unit_type order by dy.d),
           coalesce(i.cohort_scrapped,0), coalesce(i.cohort_out,0), coalesce(i.cohort_scrap_days,0)
    from days dy
    cross join types t
    left join inb  i on i.d = dy.d and i.unit_type = t.unit_type
    left join outs o on o.d = dy.d and o.unit_type = t.unit_type;

    insert into nissan_sync_meta (id, last_synced_at, unit_count, first_inbound, last_inbound)
    select 1, now(), count(*), min(inbound_date), max(inbound_date) from nissan_units
    on conflict (id) do update
       set last_synced_at = excluded.last_synced_at, unit_count = excluded.unit_count,
           first_inbound = excluded.first_inbound, last_inbound = excluded.last_inbound;

    return jsonb_build_object('units', v_staging, 'days', (v_today - v_first) + 1);
end $$;

-- ------------------------------------------------------------
-- nissan_scrap_dashboard(from, to): daily rows for the range
-- plus on-hand at the start. KPI math happens in the app.
-- daily row = [date, type, inbound, scrap_load, scrap_ref, shipped,
--              adjusted, on_hand_end, cohort_scrapped, cohort_out,
--              cohort_scrap_days]
-- ------------------------------------------------------------
create or replace function public.nissan_scrap_dashboard(p_from date, p_to date)
returns jsonb
language sql
stable
set search_path to 'public'
as $$
    select jsonb_build_object(
        'meta', (select jsonb_build_object(
                    'last_synced_at', last_synced_at, 'unit_count', unit_count,
                    'first_inbound', first_inbound, 'last_inbound', last_inbound,
                    'today', (now() at time zone 'America/Chicago')::date)
                 from nissan_sync_meta where id = 1),
        'from', p_from,
        'to',   p_to,
        'start_on_hand', coalesce((
            select jsonb_object_agg(unit_type, on_hand_end)
            from nissan_daily where d = p_from - 1), '{}'::jsonb),
        'daily', coalesce((
            select jsonb_agg(jsonb_build_array(
                       d, unit_type, inbound, scrap_load, scrap_ref, shipped, adjusted,
                       on_hand_end, cohort_scrapped, cohort_out, cohort_scrap_days)
                   order by d, unit_type)
            from nissan_daily where d between p_from and p_to), '[]'::jsonb)
    );
$$;

-- ------------------------------------------------------------
-- nissan_scrap_loads(from, to): one row per scrap load
-- ------------------------------------------------------------
create or replace function public.nissan_scrap_loads(p_from date, p_to date)
returns jsonb
language sql
stable
set search_path to 'public'
as $$
    select coalesce(jsonb_agg(x order by x.out_date desc, x.out_pro desc), '[]'::jsonb)
    from (
        select out_date, out_pro, max(ref_num) as ref_num, max(scrap_source) as scrap_source,
               count(*) filter (where unit_type = 'ENGINE')       as engines,
               count(*) filter (where unit_type = 'TRANSMISSION') as trans,
               count(*) filter (where unit_type = 'OTHER')        as other,
               round(avg(greatest(days_to_out,0)), 1)             as avg_days
        from nissan_units
        where disposition = 'SCRAP' and out_date between p_from and p_to
        group by out_date, out_pro
    ) x;
$$;

-- ------------------------------------------------------------
-- nissan_scrap_load_units(pro): unit detail for one load
-- ------------------------------------------------------------
create or replace function public.nissan_scrap_load_units(p_pro bigint)
returns jsonb
language sql
stable
set search_path to 'public'
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
               'lwh_id', root_lwh, 'item', item_nm, 'desc', item_desc, 'type', unit_type,
               'received', inbound_date, 'scrapped', out_date, 'days', days_to_out,
               'ref', ref_num) order by unit_type, item_nm, root_lwh), '[]'::jsonb)
    from nissan_units
    where out_pro = p_pro and disposition = 'SCRAP';
$$;

-- Lock down: only the service role (sync script + Edge Function)
revoke all on function public.refresh_nissan_units()                 from public, anon, authenticated;
revoke all on function public.nissan_scrap_dashboard(date, date)     from public, anon, authenticated;
revoke all on function public.nissan_scrap_loads(date, date)         from public, anon, authenticated;
revoke all on function public.nissan_scrap_load_units(bigint)        from public, anon, authenticated;
grant execute on function public.refresh_nissan_units()              to service_role;
grant execute on function public.nissan_scrap_dashboard(date, date)  to service_role;
grant execute on function public.nissan_scrap_loads(date, date)      to service_role;
grant execute on function public.nissan_scrap_load_units(bigint)     to service_role;

-- NISSAN as a customer on the shared PIN backend
insert into public.cust_app_customers (code, display_name, active, columns)
select 'NISSAN', 'Nissan', true, columns from public.cust_app_customers where code = 'TRAFO'
on conflict (code) do nothing;

-- Quick confirmation
select 'functions ready' as status,
       (select count(*) from cust_app_customers where code = 'NISSAN') as nissan_customer_rows;
