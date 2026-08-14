/* ==========================================================================
   /api/threads  —  what the CRM reads to draw conversations
   --------------------------------------------------------------------------
   Three questions, one endpoint:

     GET  /api/threads                     unread count + who has replied
     GET  /api/threads?e164=%2B17169091304 one person's conversation
     GET  /api/threads?name=Marco%20Martin same, looked up by lead name
     POST /api/threads  {e164, read:true}  mark that conversation read

   Read-only except for marking read, and marking read cannot destroy anything —
   it stamps a timestamp. Nothing here deletes a message; there is no endpoint
   in this app that does, on purpose. A text you regret is still evidence of
   what was said.

   Why an endpoint rather than the page's existing SQL bridge: the dashboard
   polls this every 30 seconds, and a narrow endpoint that can only read
   messages is a much smaller thing to leave running on a timer than a general
   SQL channel.
   ========================================================================== */

function db() {
  return {
    url: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  };
}

function q(v) {
  if (v === null || v === undefined || v === "") return "null";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

async function sql(text) {
  const { url, key } = db();
  if (!url || !key) return { error: "Database not configured." };
  try {
    const r = await fetch(url + "/rest/v1/rpc/exodus_sql", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: text })
    });
    const t = await r.text();
    if (!r.ok) return { error: t.slice(0, 300) };
    try { return { rows: JSON.parse(t) || [] }; } catch { return { rows: [] }; }
  } catch (e) { return { error: String(e.message || e).slice(0, 200) }; }
}

/* The last ten digits are the only part that is the same across every way a
   number gets written down. Everything in here matches on them. */
function last10(v) { return String(v || "").replace(/[^\d]/g, "").slice(-10); }

async function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  let raw = "";
  try {
    if (typeof req.body === "string") raw = req.body;
    else { for await (const c of req) raw += c; }
  } catch { return {}; }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const o = {};
    try { new URLSearchParams(raw).forEach((v, k) => { o[k] = v; }); } catch { /* give back what we have */ }
    return o;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  /* ---------------- mark a conversation read ---------------- */
  if (req.method === "POST") {
    const b = await readBody(req);
    const ten = last10(b.e164 || b.to || "");
    if (ten.length !== 10) return res.status(400).json({ error: "Need a phone number." });
    const r = await sql(
      "update messages set read_at = now() " +
      "where direction='in' and read_at is null and right(regexp_replace(e164,'[^0-9]','','g'),10) = " +
      q(ten) + " returning id"
    );
    if (r.error) return res.status(502).json({ error: r.error });
    return res.status(200).json({ ok: true, marked: (r.rows || []).length });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "GET or POST" });

  const qs = req.query || {};

  /* ---------------- one conversation ---------------- */
  if (qs.e164 || qs.name) {
    let ten = last10(qs.e164);

    /* Looked up by name: find their number first. Glen thinks in names; Twilio
       only knows numbers. */
    if (!ten && qs.name) {
      const w = await sql(
        "select phone from leads where lower(name) = lower(" + q(qs.name) + ") limit 1"
      );
      const row = w.rows && w.rows[0];
      ten = last10(row && row.phone);
    }
    if (ten.length !== 10)
      return res.status(200).json({ ok: true, messages: [], why: "no usable number" });

    const r = await sql(
      "select direction, e164, body, sent_at, read_at, status from messages " +
      "where right(regexp_replace(e164,'[^0-9]','','g'),10) = " + q(ten) +
      " order by sent_at asc limit 200"
    );
    if (r.error) return res.status(502).json({ error: r.error });
    return res.status(200).json({ ok: true, e164: qs.e164 || null, messages: r.rows || [] });
  }

  /* ---------------- the overview the dashboard polls ----------------
     One row per person who has ever texted, newest activity first, with the
     unread count and the last thing said. That last line matters more than it
     looks: it is what lets Glen decide who to open without opening anyone. */
  const r = await sql(
    "with t as (" +
    "  select right(regexp_replace(e164,'[^0-9]','','g'),10) as ten," +
    "         max(sent_at) as last_at," +
    "         count(*) filter (where direction='in' and read_at is null) as unread," +
    "         max(e164) as e164," +
    "         max(name_key) as name_key" +
    "    from messages group by 1" +
    ") select t.ten, t.e164, t.unread, t.last_at, l.name," +
    "  (select body from messages m where right(regexp_replace(m.e164,'[^0-9]','','g'),10)=t.ten" +
    "    order by m.sent_at desc limit 1) as last_body," +
    "  (select direction from messages m where right(regexp_replace(m.e164,'[^0-9]','','g'),10)=t.ten" +
    "    order by m.sent_at desc limit 1) as last_dir" +
    " from t left join leads l on l.name_key = t.name_key" +
    " order by t.last_at desc limit 50"
  );
  if (r.error) return res.status(502).json({ error: r.error, threads: [], unread: 0 });

  const threads = r.rows || [];
  const unread = threads.reduce((a, t) => a + Number(t.unread || 0), 0);
  return res.status(200).json({ ok: true, unread, threads });
}
