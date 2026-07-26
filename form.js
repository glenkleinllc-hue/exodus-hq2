/* The lead webhook. Point formsubmit.co (or any form) at:
     https://YOUR-DOMAIN/api/form?key=FORM_WEBHOOK_SECRET

   This replaces scraping Gmail. A submission lands in Postgres immediately
   instead of fifteen minutes later, and no mailbox access is needed at all.
   Deliberately NOT behind the password gate — the form has to reach it. */
import { body } from "./_auth.js";

function pick(o, keys) {
  for (const k of keys) {
    for (const actual of Object.keys(o || {})) {
      if (actual.toLowerCase().replace(/[^a-z]/g, "") === k) {
        const v = o[actual];
        if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
      }
    }
  }
  return null;
}

function sql(v) {
  if (v === null || v === undefined || v === "") return "null";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET")
    return res.status(405).json({ error: "POST" });

  const secret = process.env.FORM_WEBHOOK_SECRET;
  const given = (req.query && req.query.key) || req.headers["x-webhook-key"];
  if (secret && given !== secret) return res.status(401).json({ error: "Bad key." });

  const url = process.env.SUPABASE_URL;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) return res.status(500).json({ error: "Database not configured." });

  const raw = req.method === "POST" ? await body(req) : (req.query || {});
  const name  = pick(raw, ["name", "fullname", "firstname"]);
  const email = pick(raw, ["email", "emailaddress"]);
  const phone = pick(raw, ["phone", "phonenumber", "tel", "mobile"]);
  const want  = pick(raw, ["interest", "message", "wants", "goal", "comments", "destination"]);

  if (!name && !email && !phone)
    return res.status(400).json({ error: "Nothing usable in that submission." });

  /* Glen tests his own form constantly, so tag those instead of dropping them */
  const isSelf = !!(email && /glenkleinllc@gmail\.com/i.test(email));
  const fingerprint = "web:" + [name, email, phone].join("|").toLowerCase();

  const q = `insert into form_submissions
      (name,email,phone,interest,submitted_at,gmail_id,is_self_test)
    values (${sql(name)},${sql(email)},${sql(phone)},${sql(want)},now(),${sql(fingerprint)},${isSelf})
    on conflict (gmail_id) do nothing
    returning id;`;

  try {
    const r = await fetch(url.replace(/\/$/, "") + "/rest/v1/rpc/exodus_sql", {
      method: "POST",
      headers: {
        "apikey": srv, "Authorization": "Bearer " + srv, "Content-Type": "application/json"
      },
      body: JSON.stringify({ q })
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({ error: "Could not save the lead.", detail: t.slice(0, 300) });
    }
    /* If the form posted from a browser, send them somewhere friendly. */
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      res.setHeader("Location", "/thanks.html");
      return res.status(303).end();
    }
    res.status(200).json({ ok: true, saved: name || email || phone });
  } catch (e) {
    res.status(502).json({ error: "Save failed.", detail: String(e.message || e) });
  }
}
