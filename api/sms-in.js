/* ==========================================================================
   /api/sms-in  —  what happens when a lead texts back
   --------------------------------------------------------------------------
   Until this file existed, replies went nowhere. Twilio received them, and
   with no webhook configured on the number they were visible only in the
   Twilio console's message log — which nobody opens. A lead could reply "yes
   let's talk" and it would sit unread indefinitely.

   Point your Twilio number at this file:

     Twilio Console -> Phone Numbers -> Manage -> Active numbers
       -> click your number -> Messaging -> "A message comes in"
       -> Webhook,  HTTPS POST,  https://exodus-hq2.vercel.app/api/sms-in

   WHAT IT DOES, in order, and the order is the point:
     1. verifies the request really came from Twilio
     2. writes the message to the database
     3. matches it to a lead if it can
     4. forwards it to Glen's own phone
     5. returns empty TwiML so Twilio does not auto-reply anything

   Storing before forwarding is deliberate. If the forward fails — Glen's
   number is wrong, Twilio is rate limiting, anything — the message is already
   saved and shows up in the CRM. Nothing about notifying is allowed to lose a
   reply. That is the same rule /api/form follows.

   NOT AUTHENTICATED BY A SECRET, ON PURPOSE. Twilio has to be able to reach
   this without one, so it is protected by signature validation instead, which
   is stronger: it proves the request was signed with your auth token.

   Environment:
     TWILIO_AUTH_TOKEN            required, used to validate the signature
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
     TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER, GLEN_PHONE   for the forward
     SMS_IN_SKIP_SIGNATURE=1      escape hatch for local testing only
   ========================================================================== */

import crypto from "crypto";

/* Vercel's default body parser eats the raw form body, and the signature is
   computed over the exact parameters as sent. Read it ourselves. */
export const config = { api: { bodyParser: false } };

/* ---------------- the same number rules as /api/sms and the dialer -------- */
function digits(v) { return String(v || "").replace(/[^\d+]/g, ""); }
function nanpOk(d) {
  if (!/^\d{10}$/.test(d)) return false;
  if (d[0] < "2" || d[3] < "2") return false;
  if (d[4] === "1" && d[5] === "1") return false;
  if (d.slice(3, 8) === "55501") return false;
  return true;
}
function e164(n) {
  const raw = digits(n);
  if (!raw) return "";
  if (raw.startsWith("+")) {
    const d = raw.slice(1);
    return (d.length >= 8 && d.length <= 15) ? "+" + d : "";
  }
  if (raw.length === 11 && raw[0] === "1" && nanpOk(raw.slice(1))) return "+" + raw;
  if (raw.length === 10 && nanpOk(raw)) return "+1" + raw;
  return "";
}

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/* ---------------- proving the request is really from Twilio ---------------
   Twilio signs each webhook: sort the POST parameters by name, concatenate
   key+value onto the full URL, HMAC-SHA1 with the auth token, base64. If the
   result matches X-Twilio-Signature, only somebody holding the token could
   have produced it.

   timingSafeEqual rather than === so the comparison cannot be probed a byte at
   a time. */
function twilioSigned(req, params, token) {
  const sig = req.headers["x-twilio-signature"];
  if (!sig || !token) return false;

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const url = proto + "://" + host + req.url;

  let data = url;
  Object.keys(params).sort().forEach(k => { data += k + params[k]; });

  const mine = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
  const a = Buffer.from(mine), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- database ---------------- */
function db() {
  return {
    url: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  };
}

async function sql(text) {
  const { url, key } = db();
  if (!url || !key) return { error: "Database not configured." };
  const r = await fetch(url + "/rest/v1/rpc/exodus_sql", {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ q: text })
  });
  const t = await r.text();
  if (!r.ok) return { error: t.slice(0, 300) };
  try { return { rows: JSON.parse(t) }; } catch { return { rows: [] }; }
}

/* Postgres string literal. Single quotes double up; nothing else is
   interpolated into these statements. */
function q(v) {
  if (v === null || v === undefined || v === "") return "null";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/* ---------------- matching a number to a person ---------------------------
   Leads store phone numbers however Glen typed them — (716) 909-1304,
   716-909-1304, 7169091304. Comparing to +17169091304 directly matches
   nothing. So compare on the last ten digits, which is the part that is the
   same in every one of those spellings.

   No match is not a failure. The message is already stored; name_key stays
   null and the CRM shows it as an unknown number, which is exactly what it is
   and is far better than silently discarding it. */
async function matchLead(num) {
  const last10 = digits(num).replace(/^\+?1?/, "").slice(-10);
  if (last10.length !== 10) return null;
  const r = await sql(
    "select name_key, name from leads " +
    "where right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10) = " + q(last10) +
    " limit 1"
  );
  const row = r.rows && r.rows[0];
  return row ? { key: row.name_key, name: row.name } : null;
}

async function forwardToGlen(from, body, who) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromNum = e164(process.env.TWILIO_FROM_NUMBER);
  const glen = e164(process.env.GLEN_PHONE);
  if (!sid || !token || !fromNum || !glen) return { sent: false, why: "forwarding not configured" };

  const label = who ? who + " (" + from + ")" : from;
  const text = "Reply from " + label + ":\n\n" + String(body || "").slice(0, 1200);

  const form = new URLSearchParams({ To: glen, From: fromNum, Body: text });
  const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + sid + "/Messages.json", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(sid + ":" + token).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });
  if (!r.ok) return { sent: false, why: "Twilio said " + r.status };
  return { sent: true };
}

/* Empty TwiML. Twilio expects a response; anything inside <Response> would be
   texted straight back to the lead, so it stays empty on purpose. */
function noReply(res) {
  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

export default async function handler(req, res) {
  /* A read-only diagnostic, safe to open in a browser. Says what is wired,
     never what any of it is. */
  if (req.method === "GET") {
    const r = await sql("select count(*) as n, " +
      "count(*) filter (where read_at is null and direction='in') as unread from messages");
    const row = (r.rows && r.rows[0]) || {};
    return res.status(200).json({
      ok: true,
      webhook: "Point your Twilio number's \"A message comes in\" at this URL, HTTP POST.",
      signatureChecked: !!process.env.TWILIO_AUTH_TOKEN
        && process.env.SMS_IN_SKIP_SIGNATURE !== "1",
      forwardsToGlen: !!e164(process.env.GLEN_PHONE),
      stored: row.n === undefined ? null : Number(row.n),
      unread: row.unread === undefined ? null : Number(row.unread),
      dbError: r.error || null
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });

  const raw = await rawBody(req);
  const params = {};
  try { new URLSearchParams(raw).forEach((v, k) => { params[k] = v; }); } catch { /* empty below */ }

  /* Signature first, before anything is written. An unsigned request is not a
     message, it is somebody poking the endpoint. */
  const skip = process.env.SMS_IN_SKIP_SIGNATURE === "1";
  if (!skip && !twilioSigned(req, params, process.env.TWILIO_AUTH_TOKEN))
    return res.status(403).json({ error: "Bad signature." });

  const from = e164(params.From);
  const body = String(params.Body || "");
  const sid = params.MessageSid || params.SmsSid || null;
  if (!from) return noReply(res);

  const who = await matchLead(from);

  /* on conflict does nothing: Twilio retries a webhook it thinks failed, and
     without this the same reply appears in the thread two or three times. */
  const ins = await sql(
    "insert into messages (direction, e164, name_key, body, twilio_sid, status, sent_at) values (" +
    "'in', " + q(from) + ", " + q(who && who.key) + ", " + q(body) + ", " + q(sid) + ", 'received', now())" +
    " on conflict (twilio_sid) do nothing returning id"
  );

  /* A lead who replies is a lead who is warm. Nothing is downgraded and a
     signed-up member is left alone — this only lifts people who are sitting in
     the stages a reply actually changes the meaning of. */
  if (who && who.key)
    await sql(
      "update leads set stage='Warm Lead', updated_at=now() where name_key=" + q(who.key) +
      " and stage in ('New Lead','Did Not Answer','Cold Lead')"
    );

  /* Stored first, forwarded second. If this fails the reply is still in the
     CRM — notifying is never allowed to be the thing that loses a message. */
  let fwd = { sent: false, why: "skipped" };
  const isNew = !!(ins.rows && ins.rows.length);
  if (isNew) {
    try { fwd = await forwardToGlen(from, body, who && who.name); }
    catch (e) { fwd = { sent: false, why: String(e.message || e) }; }
  }

  return noReply(res);
}
