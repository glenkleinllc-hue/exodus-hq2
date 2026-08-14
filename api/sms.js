/* ==========================================================================
   /api/sms  —  text a client, through the Twilio number the dialer already uses
   --------------------------------------------------------------------------
   Claudia writes the message. She does NOT send it. Nothing here fires until a
   request arrives carrying `confirmed:true`, and the page only sets that after
   Glen has read the exact words and the exact number and tapped Send.

   That is deliberate and it is not negotiable. A model that can silently text
   a prospect is a model that can text the wrong prospect, and a bad text to a
   lead is unrecoverable — there is no unsend. The dialer works the same way:
   it shows the E.164 number before it rings anything.

     POST /api/sms   {to, body, name, confirmed:true}
     GET  /api/sms?check=1        is it configured? (never echoes a secret)

   Environment, all of it already set for the dialer except nothing new:
     TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
   ========================================================================== */

/* ---- the same number rules the dialer uses, kept in step deliberately ---- */
function digits(v) { return String(v || "").replace(/[^\d+]/g, ""); }

function nanpOk(d) {
  /* North American numbering: area code and exchange both start 2-9, and the
     exchange cannot be N11 (211, 411, 911...). Junk that looks like a number is
     the thing that gets a business flagged for spam.

     555-01xx is the reserved fictional block — it is what ends up in a CRM when
     someone types a placeholder, and the page already refuses it. The two rules
     have to agree or a stale page can push through something the fresh one
     would have caught. */
  if (!/^\d{10}$/.test(d)) return false;
  if (d[0] < "2" || d[3] < "2") return false;
  if (d[4] === "1" && d[5] === "1") return false;
  if (d.slice(3, 8) === "55501") return false;
  return true;
}

function dialable(n) {
  const raw = digits(n);
  if (!raw) return { ok: false, why: "no number" };
  if (raw.startsWith("+")) {
    const d = raw.slice(1);
    if (d.length < 8 || d.length > 15) return { ok: false, why: "wrong length for an international number" };
    return { ok: true, e164: "+" + d };
  }
  const d = raw;
  if (d.length === 11 && d[0] === "1" && nanpOk(d.slice(1)))
    return { ok: true, e164: "+" + d };
  if (d.length === 10 && nanpOk(d)) return { ok: true, e164: "+1" + d };
  if (d.length === 10) return { ok: false,
    why: d.slice(3,8)==="55501" ? "555-01xx is a fictional number"
       : "that is not a valid US number" };
  return { ok: false, why: "needs a country code with a + in front" };
}
function e164(n) { const v = dialable(n); return v.ok ? v.e164 : ""; }

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  try {
    if (typeof req.body === "string") raw = req.body;
    else { for await (const c of req) raw += c; }
  } catch { return {}; }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const o = {};
    new URLSearchParams(raw).forEach((v, k) => { o[k] = v; });
    return o;
  }
}

/* ------------------------- logging what was sent -------------------------
   A thread that only holds their replies is not a conversation. Every outbound
   text is written to the same table /api/sms-in writes inbound ones to, so the
   lead card can show both sides in order.

   Logging happens AFTER Twilio has accepted the message and never blocks the
   response: if the database write fails, the text still went, and reporting a
   failure to Glen for a message that was in fact delivered would be worse than
   a missing row. The failure is returned in the payload instead. */
function dbCfg() {
  return {
    url: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  };
}
function qlit(v) {
  if (v === null || v === undefined || v === "") return "null";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
async function logOut(to, body, sid, name) {
  const { url, key } = dbCfg();
  if (!url || !key) return { logged: false, why: "database not configured" };

  /* Match the lead on the last ten digits. Numbers are stored however Glen
     typed them and this one is E.164, so a direct comparison matches nothing.
     A miss is fine — the row is still written, just without a name. */
  const last10 = String(to).replace(/[^\d]/g, "").slice(-10);
  const q =
    "with who as (select name_key from leads where right(regexp_replace("
      + "coalesce(phone,''), '[^0-9]', '', 'g'), 10) = " + qlit(last10) + " limit 1) "
    + "insert into messages (direction, e164, name_key, body, twilio_sid, status, sent_at) "
    + "select 'out', " + qlit(to) + ", (select name_key from who), " + qlit(body) + ", "
    + qlit(sid) + ", 'sent', now() "
    + "on conflict (twilio_sid) do nothing returning id";
  try {
    const r = await fetch(url + "/rest/v1/rpc/exodus_sql", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ q })
    });
    if (!r.ok) return { logged: false, why: (await r.text()).slice(0, 160) };
    return { logged: true };
  } catch (e) { return { logged: false, why: String(e.message || e).slice(0, 160) }; }
}

function cfg() {
  return {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from: e164(process.env.TWILIO_FROM_NUMBER),
    glen: e164(process.env.GLEN_PHONE)
  };
}

export default async function handler(req, res) {
  const c = cfg();

  /* A read-only diagnostic. Says which credentials are present, never what
     they are, so it is safe to open in a browser. */
  if (req.method === "GET") {
    const q = req.query || {};
    if (!q.check) return res.status(405).json({ error: "POST to send. GET ?check=1 to test." });
    return res.status(200).json({
      ok: true,
      configured: !!(c.sid && c.token && c.from),
      accountSet: !!c.sid, tokenSet: !!c.token,
      fromSet: !!c.from, fromNumber: c.from || null,
      note: "Claudia drafts. Nothing sends without confirmed:true, which the "
          + "page only sets after Glen has read the message and tapped Send."
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST" });

  if (!c.sid || !c.token || !c.from)
    return res.status(503).json({
      error: "Texting is not configured.",
      missing: [["TWILIO_ACCOUNT_SID", c.sid], ["TWILIO_AUTH_TOKEN", c.token],
                ["TWILIO_FROM_NUMBER", c.from]].filter(p => !p[1]).map(p => p[0])
    });

  const b = await readBody(req);

  /* THE GATE. Everything above this line is setup; this is the rule. */
  if (b.confirmed !== true && b.confirmed !== "true")
    return res.status(400).json({
      error: "Not confirmed.",
      why: "A text is only sent after Glen has seen the exact words and the "
         + "exact number and pressed Send. Drafting is not sending."
    });

  const v = dialable(b.to);
  /* The page checks this too. A stale page must never be able to text junk. */
  if (!v.ok) return res.status(400).json({ error: "Not textable: " + v.why,
    refused: String(b.to || "") });

  const body = String(b.body || "").trim();
  if (!body) return res.status(400).json({ error: "Nothing to send." });
  if (body.length > 1500) return res.status(400).json({
    error: "That is " + body.length + " characters. Keep a text under 1500." });

  /* ---- ask Twilio to tell us what actually happened ----
     This is the gap that made a failed text look like a sent one. Twilio's POST
     returns 200 as soon as it ACCEPTS the message — that is "queued", not
     "delivered". The real outcome arrives minutes later and only if you asked
     for it. Without a StatusCallback, a message blocked by carrier filtering or
     by missing A2P registration is indistinguishable from one that landed, which
     is exactly what happened: the server said 200, the row said "sent", and the
     phone never buzzed.

     PUBLIC_BASE_URL is used if set; otherwise VERCEL_URL, which Vercel provides
     on every deployment. If neither exists we simply do not ask — a missing
     callback must never stop a text going out. */
  const base = process.env.PUBLIC_BASE_URL
    || (process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "");

  const form = new URLSearchParams({ To: v.e164, From: c.from, Body: body });
  if (base) form.set("StatusCallback", base.replace(/\/+$/, "") + "/api/sms-in?status=1");

  try {
    const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/"
      + c.sid + "/Messages.json", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(c.sid + ":" + c.token).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({
      error: j.message || "Twilio refused that.", code: j.code });
    /* Sent first, logged second, and a logging failure never turns a
       delivered text into an error. */
    let log = { logged: false, why: "skipped" };
    try { log = await logOut(v.e164, body, j.sid, b.name); }
    catch (e) { log = { logged: false, why: String(e.message || e).slice(0, 160) }; }

    return res.status(200).json({
      ok: true, sid: j.sid, to: v.e164, from: c.from,
      segments: Math.ceil(body.length / 153) || 1,
      name: b.name || null,
      log
    });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e).slice(0, 200) });
  }
}
