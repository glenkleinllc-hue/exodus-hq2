/* Supabase SQL, run server side.
   The page sends SQL exactly the way it does today, so every query in the app
   keeps working. The service role key never leaves this function.

   Guard rail: only statements the app actually needs are allowed. A stray or
   injected DROP cannot get through even if something upstream goes wrong. */
import { authed, deny, body } from "./_auth.js";

const ALLOWED_START = /^\s*(select|insert|update|delete|with)\b/i;
const BANNED = /\b(drop|truncate|alter\s+system|create\s+role|grant|revoke|pg_read_file|pg_ls_dir|copy\s)\b/i;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!authed(req)) return deny(res);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({ error: "Supabase is not configured yet." });

  const { query } = await body(req);
  if (!query || typeof query !== "string")
    return res.status(400).json({ error: "No query." });
  if (query.length > 200_000)
    return res.status(413).json({ error: "Query too large." });
  if (!ALLOWED_START.test(query) || BANNED.test(query))
    return res.status(400).json({ error: "That statement is not allowed from the app." });

  try {
    /* Supabase exposes no generic SQL endpoint, so the project has a tiny
       function for it. See DEPLOY.md step 4 — it is one statement to install. */
    const r = await fetch(url.replace(/\/$/, "") + "/rest/v1/rpc/exodus_sql", {
      method: "POST",
      headers: {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query })
    });
    const text = await r.text();
    if (!r.ok) {
      return res.status(502).json({ error: "Database refused that.", detail: text.slice(0, 400) });
    }
    /* exodus_sql returns json, already an array of rows or null */
    let rows = [];
    try { rows = JSON.parse(text); } catch { rows = []; }
    if (rows === null) rows = [];
    res.status(200).json({ rows });
  } catch (e) {
    res.status(502).json({ error: "Could not reach the database.", detail: String(e.message || e) });
  }
}
