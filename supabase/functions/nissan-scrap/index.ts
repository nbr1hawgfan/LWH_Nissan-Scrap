/*===========================================================
  NISSAN SCRAP - Edge Function
  Read-only analytics for the Nissan Scrap PWA.

  Sign-in uses the shared customer-inventory function
  ({ action: "login", customer: "NISSAN", pin }). The token it
  returns is checked here against cust_app_sessions and must
  belong to customer NISSAN.

  POST JSON { action, token, ... }:
    dashboard   { from, to }   -> meta, start_on_hand, daily rows
    loads       { from, to }   -> scrap loads in range
    load_units  { pro }        -> units on one scrap load
    log         { note }       -> access log entry (exports)
  Deployed with verify_jwt = false: it does its own auth.
===========================================================*/
import { createClient } from "npm:@supabase/supabase-js@2";

const CUSTOMER = "NISSAN";
const ALLOWED_ORIGINS = [
  "https://nbr1hawgfan.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:5500",
];
const MAX_RANGE_DAYS = 1100; // ~3 years

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function cors(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function session(token: string): Promise<{ name: string } | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const { data } = await db.from("cust_app_sessions")
    .select("expires_at, customer_code, cust_app_users!inner(name, active, customer_code)")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const u = (data as any)?.cust_app_users;
  if (!data || data.customer_code !== CUSTOMER) return null;
  if (!u?.active || u.customer_code !== CUSTOMER) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  return { name: u.name as string };
}

function range(body: Record<string, unknown>): { from: string; to: string } | null {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(body.from ?? ""), to = String(body.to ?? "");
  if (!iso.test(from) || !iso.test(to)) return null;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (!(days >= 0) || days > MAX_RANGE_DAYS) return null;
  return { from, to };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    const s = await session(String(body.token ?? ""));
    if (!s) return json({ error: "SESSION_EXPIRED" }, 401, origin);

    if (action === "dashboard" || action === "loads") {
      const r = range(body);
      if (!r) return json({ error: "Choose a valid date range (up to 3 years)." }, 400, origin);
      const fn = action === "dashboard" ? "nissan_scrap_dashboard" : "nissan_scrap_loads";
      const { data, error } = await db.rpc(fn, { p_from: r.from, p_to: r.to });
      if (error) throw error;
      return json(data, 200, origin);
    }

    if (action === "load_units") {
      const pro = Number(body.pro);
      if (!Number.isInteger(pro) || pro <= 0) return json({ error: "Invalid load." }, 400, origin);
      const { data, error } = await db.rpc("nissan_scrap_load_units", { p_pro: pro });
      if (error) throw error;
      return json(data, 200, origin);
    }

    if (action === "log") {
      const note = String(body.note ?? "").slice(0, 200);
      if (note) {
        await db.from("cust_app_access_log").insert({ customer_code: CUSTOMER, user_name: s.name, action: note });
      }
      return json({ ok: true }, 200, origin);
    }

    return json({ error: "Unknown action" }, 400, origin);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong loading scrap data. Please try again." }, 500, origin);
  }
});
