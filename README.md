# LWH Nissan Scrap Analytics

PIN-gated PWA that shows Nissan engine and transmission scrap analytics:
inbound vs scrap, scrap rates, scrap share of inventory, on-hand trend,
a weekly Sunday-to-Saturday cohort table, and a scrap-load list with unit drill-down.

Hosted on GitHub Pages. Data comes from the **LWH Companion** Supabase project.

## How it fits together

```
birdseye (SQL Server)
   |  Sync-NissanScrap.ps1  (nightly, separate folder - see the sync zip)
   v
Supabase  nissan_units  ->  refresh_nissan_units()  ->  nissan_daily
   |
   |  Edge Function  nissan-scrap      (dashboard / loads / load_units)
   |  Edge Function  customer-inventory (shared PIN sign-in, customer NISSAN)
   v
This PWA
```

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | Function URLs and the cohort maturity window (21 days) |
| `sw.js` | Service worker - caches the app shell, never data. Bump `VERSION` on each release. |
| `manifest.json`, `icons/` | Install-to-home-screen |
| `supabase/` | SQL and the Edge Function source, for the record |

## Users and PINs

Users live in `cust_app_users` under customer `NISSAN` (same table and rules as TRAFO).
Run in the Supabase SQL Editor:

```sql
select cust_app_add_user('NISSAN', 'Full Name', '12345678');   -- add or reset (6-8 digits)
select cust_app_remove_user('NISSAN', 'Full Name');            -- remove
select * from cust_app_list_users('NISSAN');                   -- list
```

LWH team members who need access get their own NISSAN user.
Ten wrong PINs in 15 minutes pauses sign-in for that customer.

## Definitions shown in the app

- **Scrapped vs received** - units scrapped in the range / units received in the range.
- **Received-unit scrap rate** - of units received in the range, the share scrapped so far (cohort). Ranges ending less than 21 days ago are flagged *Developing*.
- **Scrap share of inventory** - units scrapped in the range / (on hand at start + received in range).
- **Daily averages** - per operating day (days with receiving or scrap activity).
- **Scrap** - SCRAP OUT loads plus any freight bill whose BillToRefNum contains scrap (typos like Srap / crap included). Engines and transmissions only.
