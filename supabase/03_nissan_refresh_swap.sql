/* ============================================================
   NISSAN SCRAP ANALYTICS - fast refresh  (step 3)
   Paste into Supabase > SQL Editor (LWH Companion) and Run.

   WHY: the first refresh deleted and re-inserted ~380K rows,
   which takes ~85s - over the 60s limit for API calls.
   Now staging is an exact twin of nissan_units, and the
   refresh swaps the two tables by renaming them (instant),
   then rebuilds the small daily rollup.

   Also clears the 380K dummy rows from the timing test.
   ============================================================ */

-- 0. clear test data (nothing real has been loaded yet)
truncate public.nissan_units, public.nissan_units_staging, public.nissan_daily;
delete from public.nissan_sync_meta where id = 1;

-- 1. make staging an exact twin of nissan_units
alter table public.nissan_units_staging
    add column if not exists synced_at timestamptz not null default now();
alter table public.nissan_units_staging
    alter column unit_type    set not null,
    alter column inbound_date set not null,
    alter column disposition  set not null;
alter table public.nissan_units_staging drop constraint if exists nissan_units_staging_unit_type_check;
alter table public.nissan_units_staging drop constraint if exists nissan_units_staging_disposition_check;
alter table public.nissan_units_staging
    add constraint nissan_units_staging_unit_type_check   check (unit_type in ('ENGINE','TRANSMISSION','OTHER')),
    add constraint nissan_units_staging_disposition_check check (disposition in ('SCRAP','SHIPPED','ADJUSTED','ON HAND'));
create index if not exists nissan_units_staging_inbound_idx on public.nissan_units_staging (inbound_date);
create index if not exists nissan_units_staging_out_idx     on public.nissan_units_staging (out_date) where out_date is not null;
create index if not exists nissan_units_staging_pro_idx     on public.nissan_units_staging (out_pro);

-- 2. clear staging (called by the sync before each upload)
create or replace function public.nissan_clear_staging()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    truncate nissan_units_staging;
end $$;

-- 3. refresh: guard, swap tables, rebuild daily rollup
create or replace function public.refresh_nissan_units()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
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

    -- swap: staging becomes live, old live becomes staging
    lock table nissan_units, nissan_units_staging in access exclusive mode;
    alter table nissan_units         rename to nissan_units_swap;
    alter table nissan_units_staging rename to nissan_units;
    alter table nissan_units_swap    rename to nissan_units_staging;
    truncate nissan_units_staging;

    -- daily rollup
    select min(inbound_date) into v_first from nissan_units;

    truncate nissan_daily;

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

revoke all on function public.nissan_clear_staging()  from public, anon, authenticated;
revoke all on function public.refresh_nissan_units()  from public, anon, authenticated;
grant execute on function public.nissan_clear_staging() to service_role;
grant execute on function public.refresh_nissan_units() to service_role;

-- 4. both tables stay locked down whichever name they hold
alter table public.nissan_units         enable row level security;
alter table public.nissan_units_staging enable row level security;
revoke all on public.nissan_units, public.nissan_units_staging from anon, authenticated;
grant all on public.nissan_units, public.nissan_units_staging to service_role;

select 'fast refresh ready' as status,
       (select count(*) from nissan_units) as live_rows,
       (select count(*) from nissan_units_staging) as staging_rows;
