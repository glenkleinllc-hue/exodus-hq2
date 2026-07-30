/* ==========================================================================
   THE LEAD WEBHOOK  —  speed to lead
   --------------------------------------------------------------------------
   Point your form at:
       https://exodus-hq2.vercel.app/api/form?key=YOUR_FORM_WEBHOOK_SECRET

   The moment somebody hits submit:
     1. the submission is written to form_submissions
     2. the person is created in leads as a New Lead, so they are in the
        pipeline and on the dashboard's call list before you have read anything
     3. your phone gets a text

   A text rather than an email because Twilio is already wired up for the
   dialer — no new account, no new key, and a text is what actually makes you
   look. If RESEND_API_KEY is ever set, an email goes out as well.

   Deliberately NOT behind the password gate: the form has to be able to reach
   it. The ?key= secret is what keeps strangers out.

   Nothing about notifying can lose a lead. The database write happens first and
   is committed before a single message is attempted, and a failed text is
   reported in the response instead of thrown.
   ========================================================================== */

/* ---------- reading the submission ----------
   HTML forms post application/x-www-form-urlencoded. The shared JSON body
   helper returned {} for those, so a real form submission came through as
   "nothing usable" — the endpoint would have looked fine and quietly worked for
   nobody. This reads the body itself and handles all three shapes: JSON,
   urlencoded, and a plain query string. */
async function readBody(req) {
  if (req.method === "GET") return { ...(req.query || {}) };

  const ctype = String(req.headers["content-type"] || "").toLowerCase();

  /* Vercel may have parsed it already */
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body))
    return { ...(req.query || {}), ...req.body };

  let raw = "";
  if (typeof req.body === "string") raw = req.body;
  else if (Buffer.isBuffer(req.body)) raw = req.body.toString("utf8");
  else {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    raw = Buffer.concat(chunks).toString("utf8");
  }
  raw = raw.trim();
  if (!raw) return { ...(req.query || {}) };

  if (ctype.includes("json") || raw[0] === "{") {
    try { return { ...(req.query || {}), ...JSON.parse(raw) }; } catch { /* fall through */ }
  }
  const out = { ...(req.query || {}) };
  try { for (const [k, v] of new URLSearchParams(raw)) out[k] = v; } catch { /* keep what we have */ }
  return out;
}

/* Field names differ on every form builder, so match loosely: strip anything
   that is not a letter, then compare. "Full Name", "full_name" and "fullname"
   all land on the same key. */
function pick(o, keys) {
  const norm = k => String(k).toLowerCase().replace(/[^a-z]/g, "");
  for (const want of keys) {
    for (const actual of Object.keys(o || {})) {
      if (norm(actual) === want) {
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

/* A guard against the one bug that has bitten this project again and again:
   Postgres refuses a DELETE or UPDATE with no WHERE. Nothing here should ever
   build one, so if it does, shout rather than send. */
function unsafe(q) {
  const t = String(q).replace(/\s+/g, " ");
  for (const part of t.split(";")) {
    const p = part.trim(); if (!p) continue;
    if (/^delete\s+from\s/i.test(p) && !/\swhere\s/i.test(p)) return p.slice(0, 90);
    if (/^update\s/i.test(p) && !/\swhere\s/i.test(p)) return p.slice(0, 90);
  }
  return null;
}

async function runSql(url, srv, q) {
  const bad = unsafe(q);
  if (bad) throw new Error("Refused unsafe SQL: " + bad);
  const r = await fetch(url.replace(/\/$/, "") + "/rest/v1/rpc/exodus_sql", {
    method: "POST",
    headers: { apikey: srv, Authorization: "Bearer " + srv, "Content-Type": "application/json" },
    body: JSON.stringify({ q })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text.slice(0, 300));
  try { return JSON.parse(text); } catch { return text; }
}

/* ---------- the text message ---------- */
function e164(raw) {
  const s = String(raw || "").trim();
  const d = s.replace(/\D/g, "");
  if (!d) return null;
  if (s.startsWith("+")) return "+" + d;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return "+" + d;
}

async function textGlen(lines) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = e164(process.env.TWILIO_FROM_NUMBER);
  const to = e164(process.env.GLEN_PHONE);
  if (!sid || !token || !from || !to)
    return { sent: false, why: "Twilio not configured (needs TWILIO_ACCOUNT_SID, "
      + "TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, GLEN_PHONE)." };

  const form = new URLSearchParams({ From: from, To: to, Body: lines.join("\n") });
  const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(sid + ":" + token).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { sent: false, why: (j && j.message) || ("Twilio said " + r.status) };
  return { sent: true, sid: j.sid };
}

/* Optional, and off unless he adds a key. No account needed today. */
async function emailGlen(subject, lines) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL || process.env.GLEN_EMAIL;
  if (!key || !to) return { sent: false, why: "No RESEND_API_KEY / NOTIFY_EMAIL — skipped." };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM || "Exodus HQ <onboarding@resend.dev>",
      to: [to], subject, text: lines.join("\n")
    })
  });
  if (!r.ok) return { sent: false, why: (await r.text()).slice(0, 200) };
  return { sent: true };
}

/* ---------- spam ----------
   A honeypot field a human never sees and never fills. If it has anything in
   it, accept politely and throw the submission away — arguing with a bot only
   teaches it. */
function looksLikeSpam(raw, name, email) {
  if (pick(raw, ["honeypot", "botfield", "captcha"])) return "honeypot";
  const blob = [name, email, pick(raw, ["interest", "message"])].join(" ");
  if (/(?:https?:\/\/|www\.)\S+/i.test(blob) && /(seo|crypto|casino|viagra|backlink)/i.test(blob))
    return "link spam";
  return null;
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

  const raw = await readBody(req);
  const name = pick(raw, ["name", "fullname", "firstname", "yourname"]);
  const email = pick(raw, ["email", "emailaddress", "youremail"]);
  const phone = pick(raw, ["phone", "phonenumber", "tel", "mobile", "cell", "whatsapp"]);
  const want = pick(raw, ["interest", "message", "wants", "goal", "comments", "destination", "notes"]);
  const insta = pick(raw, ["instagram", "ig", "handle", "socials", "social"]);

  if (!name && !email && !phone)
    return res.status(400).json({
      error: "Nothing usable in that submission.",
      fieldsReceived: Object.keys(raw || {}).slice(0, 12)
    });

  const spam = looksLikeSpam(raw, name, email);
  if (spam) return res.status(200).json({ ok: true, ignored: spam });

  /* He tests his own form constantly. Tag those rather than dropping them, so
     the pipeline count stays honest but he can still see the test landed. */
  const isSelf = !!(email && /glenkleinllc@gmail\.com/i.test(email));
  const fingerprint = "web:" + [name, email, phone].join("|").toLowerCase();
  const display = name || email || phone;

  /* One round trip, one transaction: the submission and the lead land together
     or not at all. A self-test is recorded but never added to the pipeline. */
  const q = `
    with sub as (
      insert into form_submissions
        (name,email,phone,interest,submitted_at,gmail_id,is_self_test)
      values (${sql(name)},${sql(email)},${sql(phone)},${sql(want)},now(),
              ${sql(fingerprint)},${isSelf})
      on conflict (gmail_id) do nothing
      returning id
    ), lead as (
      /* name_key is a GENERATED column — Postgres refuses an explicit value for
         it, so it is left out of the insert and only used for the conflict
         target, where its unique index does the de-duplicating. */
      insert into leads
        (name,phone,email,instagram,stage,source,notes,
         came_in,came_in_precision,first_seen)
      select ${sql(display)},${sql(phone)},${sql(email)},${sql(insta)},
             'New Lead','form',${sql(want)},current_date,'day',current_date
      where ${isSelf ? "false" : "true"} and exists (select 1 from sub)
      on conflict (name_key) do nothing
      returning id
    )
    select (select count(*) from sub) as submissions,
           (select count(*) from lead) as leads;`;

  let saved;
  try {
    saved = await runSql(url, srv, q);
  } catch (e) {
    return res.status(502).json({ error: "Could not save the lead.",
      detail: String(e.message || e) });
  }

  const row = Array.isArray(saved) ? (saved[0] || {}) : {};
  const isNew = Number(row.submissions || 0) > 0;

  let sms = { sent: false, why: "already in the database — not notified twice" };
  let mail = sms;
  if (isSelf) {
    sms = { sent: false, why: "your own test submission" };
    mail = sms;
  } else if (isNew) {
    const lines = [
      "NEW LEAD — " + display,
      phone ? "Phone: " + phone : "No phone given",
      email ? "Email: " + email : null,
      insta ? "IG: " + insta : null,
      want ? "Wants: " + String(want).slice(0, 140) : null,
      "",
      "Open HQ: " + (process.env.PUBLIC_BASE_URL
        || (process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : ""))
    ].filter(Boolean);
    try { sms = await textGlen(lines); }
    catch (e) { sms = { sent: false, why: String(e.message || e) }; }
    try { mail = await emailGlen("New lead: " + display, lines); }
    catch (e) { mail = { sent: false, why: String(e.message || e) }; }
  }

  /* A browser posting the form wants a page back, not JSON. */
  if (req.headers.accept && String(req.headers.accept).includes("text/html")) {
    res.setHeader("Location", "/thanks.html");
    return res.status(303).end();
  }

  res.status(200).json({
    ok: true,
    saved: display,
    newSubmission: isNew,
    leadCreated: Number(row.leads || 0) > 0,
    selfTest: isSelf,
    text: sms,
    email: mail
  });
}
