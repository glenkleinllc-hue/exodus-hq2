/* ============================================================
   Exodus HQ — voices and the dialer.

   A separate file on purpose. Editing api/hq.js in place kept failing, and
   there is no reason these routes have to live in that function.

   api/hq.js is untouched and keeps doing everything it already did.

     /api/voice?route=speak     ElevenLabs text to speech
     /api/voice?route=call      Twilio click to call
     /api/voice?route=twiml     what Twilio fetches once Glen answers
     /api/voice?route=callback  Twilio reports how the call went
     /api/voice?route=check     is any of this switched on?

   Every key stays in this file's environment. Nothing secret reaches the page.
   ============================================================ */
import crypto from "node:crypto";

/* ---------- the same password gate hq.js uses ---------- */
function expectedToken() {
  const pw = process.env.HQ_PASSWORD || "";
  if (!pw) return null;
  return crypto.createHash("sha256").update("exodus:" + pw).digest("hex");
}
function authed(req) {
  const want = expectedToken();
  if (!want) return true;
  const got = req.headers["x-hq-token"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!got || got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); }
  catch { return false; }
}
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); }
  catch {
    const out = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    return out;
  }
}
function sqlLit(v) {
  if (v === null || v === undefined || v === "") return "null";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
async function runSql(q) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  const r = await fetch(url.replace(/\/$/, "") + "/rest/v1/rpc/exodus_sql", {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ q })
  });
  if (!r.ok) throw new Error("Database refused that.");
  return r.json().catch(() => []);
}

/* ---------- what a voice should not read out loud ---------- */
function speakable(text) {
  return String(text || "")
    .replace(/\[\[[\s\S]*?\]\]/g, " ")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/[*_`#>|]/g, " ")
    .replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, "$1 dollars")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

/* ---------- one voice each ---------- */
const VOICES = {
  claudia: { id: "21m00Tcm4TlvDq8ikWAM", stability: 0.42, similarity: 0.78, style: 0.22, speed: 1.04 },
  jordan:  { id: "pNInz6obpgDQGcFmaJgB", stability: 0.28, similarity: 0.72, style: 0.55, speed: 1.12 },
  claude:  { id: "ErXwobaYiN019PkySvjV", stability: 0.55, similarity: 0.82, style: 0.30, speed: 0.92 }
};
function voiceFor(agent) {
  const key = String(agent || "claudia").toLowerCase();
  const base = VOICES[key] || VOICES.claudia;
  const envId = process.env["VOICE_" + key.toUpperCase()];
  return envId ? { ...base, id: envId.trim() } : base;
}

async function speak(req, res) {
  if (!authed(req)) return res.status(401).json({ error: "Not signed in." });
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: "No ElevenLabs key set.", fallback: true });

  const { text, agent } = await readBody(req);
  const clean = speakable(text);
  if (!clean) return res.status(400).json({ error: "Nothing to say." });

  const v = voiceFor(agent);
  try {
    const r = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/" + v.id + "?output_format=mp3_44100_128",
      {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: clean,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: v.stability, similarity_boost: v.similarity,
            style: v.style, use_speaker_boost: true, speed: v.speed
          }
        })
      }
    );
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 300);
      return res.status(502).json({ error: "ElevenLabs refused that.", status: r.status, detail, fallback: true });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", String(buf.length));
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e), fallback: true });
  }
}

/* ---------- the dialer ---------- */
function digits(n) { return String(n || "").replace(/[^0-9+]/g, ""); }
function e164(n) {
  const d = digits(n);
  if (d.startsWith("+")) return d;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d ? "+" + d : "";
}
function twilioCfg() {
  return {
    sid: process.env.TWILIO_ACCOUNT_SID,
    token: process.env.TWILIO_AUTH_TOKEN,
    from: e164(process.env.TWILIO_FROM_NUMBER),
    glen: e164(process.env.GLEN_PHONE),
    base: process.env.PUBLIC_BASE_URL
      || (process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "")
  };
}
function xmlEsc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function call(req, res) {
  if (!authed(req)) return res.status(401).json({ error: "Not signed in." });
  const c = twilioCfg();
  if (!c.sid || !c.token || !c.from || !c.glen)
    return res.status(503).json({
      error: "Dialer is not configured.",
      missing: [["TWILIO_ACCOUNT_SID", c.sid], ["TWILIO_AUTH_TOKEN", c.token],
                ["TWILIO_FROM_NUMBER", c.from], ["GLEN_PHONE", c.glen]]
                .filter(p => !p[1]).map(p => p[0])
    });
  if (!c.base) return res.status(503).json({ error: "PUBLIC_BASE_URL is not set." });

  const { to, name } = await readBody(req);
  const lead = e164(to);
  if (!lead || lead.length < 8) return res.status(400).json({ error: "That is not a dialable number." });
  if (lead === c.glen) return res.status(400).json({ error: "That is your own number." });

  const b = c.base.replace(/\/$/, "");
  const body = new URLSearchParams({
    To: c.glen,
    From: c.from,
    Url: b + "/api/voice?route=twiml&to=" + encodeURIComponent(lead)
       + "&name=" + encodeURIComponent(String(name || "")),
    StatusCallback: b + "/api/voice?route=callback&name=" + encodeURIComponent(String(name || "")),
    StatusCallbackEvent: "completed",
    Timeout: "25"
  });

  try {
    const r = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + c.sid + "/Calls.json", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(c.sid + ":" + c.token).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: j.message || "Twilio refused that.", code: j.code });
    return res.status(200).json({ ok: true, sid: j.sid, ringing: c.glen, then: lead });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}

async function twiml(req, res) {
  const to = e164((req.query && req.query.to) || "");
  const name = (req.query && req.query.name) || "";
  const c = twilioCfg();
  res.setHeader("Content-Type", "text/xml; charset=utf-8");
  if (!to) {
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response>'
      + '<Say voice="Polly.Matthew">No number was given. Goodbye.</Say><Hangup/></Response>');
  }
  const who = name ? "Connecting you to " + xmlEsc(name) : "Connecting your call";
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response>'
    + '<Say voice="Polly.Matthew">' + who + '</Say>'
    + '<Dial callerId="' + xmlEsc(c.from) + '" timeout="30" answerOnBridge="true">'
    + '<Number>' + xmlEsc(to) + '</Number></Dial>'
    + '<Say voice="Polly.Matthew">They did not pick up. Goodbye.</Say></Response>');
}

async function callback(req, res) {
  const p = await readBody(req).catch(() => ({}));
  const q = req.query || {};
  const name = String(q.name || p.name || "").trim();
  const status = String(p.CallStatus || "unknown");
  const secs = parseInt(p.CallDuration || "0", 10) || 0;
  if (name) {
    const said = status === "completed"
      ? (secs > 25 ? "Called - spoke for " + Math.floor(secs / 60) + "m " + (secs % 60) + "s."
                   : "Called - connected but only " + secs + "s.")
      : "Called - " + status + ".";
    try {
      await runSql("insert into lead_activity (lead_id, name_key, body) values ("
        + "(select id from leads where name_key=" + sqlLit(name.toLowerCase()) + "),"
        + sqlLit(name.toLowerCase()) + "," + sqlLit(said) + ");");
    } catch { }
  }
  res.status(204).end();
}

/* ---------- is any of this on? Open on purpose so it can be checked in a browser. ---------- */
async function check(req, res) {
  const has = k => Boolean(process.env[k] && process.env[k].length > 6);
  const c = twilioCfg();
  const out = {
    fileDeployed: true,
    voices: has("ELEVENLABS_API_KEY"),
    dialer: Boolean(c.sid && c.token && c.from && c.glen),
    baseUrl: c.base || null,
    voiceOverrides: {
      claudia: has("VOICE_CLAUDIA"), jordan: has("VOICE_JORDAN"), claude: has("VOICE_CLAUDE")
    },
    notes: []
  };
  if (!out.voices) out.notes.push("Add ELEVENLABS_API_KEY in Vercel, then redeploy.");
  if (!out.dialer) out.notes.push("Dialer needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and GLEN_PHONE.");
  if (out.dialer && !out.baseUrl) out.notes.push("Set PUBLIC_BASE_URL to your site address.");
  if (!out.notes.length) out.notes.push("Voices and the dialer are both live.");
  res.status(200).json(out);
}

/* ---------- the switchboard ---------- */
export default async function handler(req, res) {
  const route = (req.query && req.query.route) || "check";
  try {
    switch (route) {
      case "speak":    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
                       return await speak(req, res);
      case "call":     if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
                       return await call(req, res);
      case "twiml":    return await twiml(req, res);
      case "callback": return await callback(req, res);
      case "check":    return await check(req, res);
      default:         return res.status(404).json({ error: "Unknown route: " + route });
    }
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e.message || e) });
  }
}

