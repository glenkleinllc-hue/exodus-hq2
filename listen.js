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
  // A GET is a health check you can open in a browser. Diagnosing this from
  // the outside was guesswork, so the route now says plainly whether it is
  // deployed, whether it can see the key, and whether ElevenLabs answers.
  if (req.method === "GET") {
    // ?anthropic=1 tests the key that actually makes Claudius think, and
    // reports Anthropic's own words rather than the app's paraphrase of them.
    // This route needs no sign-in, which is the point: it can be checked from
    // a browser when nothing else in the app is working.
    if (req.query && req.query.anthropic) {
      const ak = process.env.ANTHROPIC_API_KEY;
      const o = {
        anthropicKeySet: Boolean(ak && ak.length > 6),
        looksRight: Boolean(ak && ak.startsWith("sk-ant-")),
        length: ak ? ak.length : 0,
        // every env var name present, so a misspelt one is obvious
        envNames: Object.keys(process.env).filter(k => /ANTHROPIC|CLAUDE/i.test(k))
      };
      if (!o.anthropicKeySet) {
        o.verdict = "No ANTHROPIC_API_KEY is visible to this deployment. Either it was "
                  + "never saved, or the site has not been redeployed since it was.";
        return res.status(200).json(o);
      }
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": ak,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-5",
            max_tokens: 8,
            messages: [{ role: "user", content: "ping" }]
          })
        });
        const body = await r.text().catch(() => "");
        o.status = r.status;
        o.works = r.ok;
        o.detail = body.slice(0, 400);
        o.verdict = r.ok
          ? "The Anthropic key works. Claudius should answer."
          : r.status === 401
            ? "Anthropic rejected the key (401). It is wrong, revoked, or the site was "
              + "not redeployed after you saved it."
            : r.status === 400 && /credit|balance/i.test(body)
              ? "The key is valid but the account has no credit. Add billing at "
                + "console.anthropic.com."
              : "Anthropic returned " + r.status + ". Detail above.";
      } catch (e) {
        o.works = false;
        o.verdict = "Could not reach Anthropic: " + String(e.message || e);
      }
      return res.status(200).json(o);
    }

    const key = process.env.ELEVENLABS_API_KEY;
    const out = { deployed: true, model: MODEL, keySet: Boolean(key && key.length > 6) };
    if (!out.keySet) {
      out.verdict = "No ELEVENLABS_API_KEY visible to this function. Add it in "
                  + "Vercel > Settings > Environment Variables, then redeploy.";
      return res.status(200).json(out);
    }
    // /v1/models is the request ElevenLabs' own auth docs use as the first
    // test, and it needs no scopes beyond a working key. The previous check
    // hit /v1/user/subscription, which can 400 for reasons that have nothing
    // to do with whether the key is valid — it reported a good key as dead.
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/models",
        { headers: { "xi-api-key": key } });
      const body = await r.text().catch(() => "");
      out.keyWorks = r.ok;
      out.status = r.status;
      if (r.ok) {
        let n = 0;
        try { const j = JSON.parse(body); n = Array.isArray(j) ? j.length : (j.models || []).length; }
        catch { /* count is a nicety, not the answer */ }
        out.modelsVisible = n;
        out.verdict = "Key works. If the mic still does nothing, it is the browser's "
                    + "microphone permission, not the server.";
      } else if (r.status === 401) {
        out.verdict = "ElevenLabs says the key is invalid (401). Make a new one and update Vercel.";
        out.detail = body.slice(0, 300);
      } else {
        out.verdict = "ElevenLabs returned " + r.status + ". Detail below.";
        out.detail = body.slice(0, 300);
      }
    } catch (e) {
      out.keyWorks = false;
      out.verdict = "Could not reach ElevenLabs: " + String(e.message || e);
    }
    return res.status(200).json(out);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, GET");
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
