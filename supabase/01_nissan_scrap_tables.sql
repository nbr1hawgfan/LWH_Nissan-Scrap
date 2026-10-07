/* ============================================================
   NISSAN SCRAP ANALYTICS - tables  (step 1 of 2)
   Already applied to LWH Companion on 2026-10-07. Kept here
   for the record / rebuilds. Safe to re-run.

   Unit-level disposition rows synced nightly from birdseye by
   Sync-NissanScrap.ps1, plus a daily rollup rebuilt on refresh.
   No anon/authenticated access: read only through the
   nissan-scrap Edge Function (service role).
   ============================================================ */

create table if not exists public.nissan_units (
    root_lwh         bigint primary key,
    item_nm          text,
    item_desc        text,
    unit_type        text not null check (unit_type in ('ENGINE','TRANSMISSION','OTHER')),
    inbound_date     date not null,
    disposition      text not null check (disposition in ('SCRAP','SHIPPED','ADJUSTED','ON HAND')),
    scrap_source     text,
    out_date         date,
    out_date_source  text,
    out_pro          bigint,
    ref_num          text,
    final_lwh        bigint,
    chain_level      integer,
    days_to_out      integer,
    final_gen_count  integer,
    synced_at        timestamptz not null default now()
);
create index if not exists nissan_units_inbound_idx on public.nissan_units (inbound_date);
create index if not exists nissan_units_out_idx     on public.nissan_units (out_date) where out_date is not null;
create index if not exists nissan_units_pro_idx     on public.nissan_units (out_pro);

create table if not exists public.nissan_units_staging (
    root_lwh         bigint primary key,
    item_nm          text,
    item_desc        text,
    unit_type        text,
    inbound_date     date,
    disposition      text,
    scrap_source     text,
    out_date         date,
    out_date_source  text,
    out_pro          bigint,
    ref_num          text,
    final_lwh        bigint,
    chain_level      integer,
    days_to_out      integer,
    final_gen_count  integer
);

create table if not exists public.nissan_daily (
    d                    date not null,
    unit_type            text not null,
    inbound              integer not null default 0,
    scrap_load           integer not null default 0,   -- SCRAP OUT loads
    scrap_ref            integer not null default 0,   -- scrap by reference (ghost bills)
    shipped              integer not null default 0,
    adjusted             integer not null default 0,
    on_hand_end          integer not null default 0,   -- end of day
    cohort_scrapped      integer not null default 0,   -- of units received this day, eventually scrapped
    cohort_out           integer not null default 0,   -- of units received this day, gone by any route
    cohort_scrap_days    bigint  not null default 0,   -- sum of days-to-scrap for cohort_scrapped
    primary key (d, unit_type)
);

create table if not exists public.nissan_sync_meta (
    id              integer primary key default 1 check (id = 1),
    last_synced_at  timestamptz,
    unit_count      integer,
    first_inbound   date,
    last_inbound    date
);

alter table public.nissan_units          enable row level security;
alter table public.nissan_units_staging  enable row level security;
alter table public.nissan_daily          enable row level security;
alter table public.nissan_sync_meta      enable row level security;

revoke all on public.nissan_units, public.nissan_units_staging,
              public.nissan_daily, public.nissan_sync_meta
       from anon, authenticated;
