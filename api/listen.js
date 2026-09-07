/* /api/listen — Claudius' ears.
 *
 * The page records a few seconds of audio, base64s it, and posts it here.
 * This forwards it to ElevenLabs Scribe and returns { text }.
 *
 * The API key never leaves the server. It lives in a Vercel environment
 * variable called ELEVENLABS_API_KEY and is read at request time, so it is
 * never in the HTML, never in the repo, and never in the browser.
 *
 * Why this exists at all: the browser's built-in speech recognition has never
 * heard of "Jadon", "Mohannad", "Siveyer" or "Exodus", so it substitutes
 * whatever ordinary English sounds closest. Scribe accepts a keyterms list —
 * the page sends every lead name from the CRM — so the model knows those words
 * exist before it starts guessing.
 */

export const config = { api: { bodyParser: { sizeLimit: "10mb" } } };

const MODEL = "scribe_v2";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    // 503 is deliberate: the page treats it as permanent for the session and
    // quietly drops back to the browser's own recogniser instead of retrying
    // a route that cannot work.
    return res.status(503).json({ error: "No ELEVENLABS_API_KEY set on the server." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const b64 = String(body.audio || "");
    if (!b64) return res.status(400).json({ error: "No audio sent." });

    const mime = String(body.mime || "audio/webm").split(";")[0];
    const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length) return res.status(400).json({ error: "Audio was empty." });

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), "clip." + ext);
    form.append("model_id", MODEL);
    form.append("language_code", "eng");

    // Names the model would otherwise mangle. Each keyterm must be under 50
    // characters and at most 5 words, so anything longer is dropped rather
    // than risking a 422 that would kill the whole request.
    const terms = Array.isArray(body.keyterms) ? body.keyterms : [];
    const clean = [];
    const seen = new Set();
    for (const t of terms) {
      const v = String(t || "").trim();
      if (!v || v.length >= 50) continue;
      if (v.split(/\s+/).length > 5) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      clean.push(v);
      if (clean.length >= 400) break;
    }
    for (const t of clean) form.append("keyterms", t);

    const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return res.status(r.status === 401 ? 503 : 502).json({
        error: "ElevenLabs returned " + r.status,
        detail: detail.slice(0, 400)
      });
    }

    const out = await r.json();
    return res.status(200).json({ text: String(out.text || "").trim() });

  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
