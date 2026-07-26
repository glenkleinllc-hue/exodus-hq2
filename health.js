/* Is everything wired? Open /api/health after deploying.
   Reports what is configured without ever printing a secret. */
export default async function handler(req, res) {
  const has = (k) => Boolean(process.env[k] && process.env[k].length > 6);
  const out = {
    ok: true,
    supabase:  has("SUPABASE_URL") && has("SUPABASE_SERVICE_ROLE_KEY"),
    anthropic: has("ANTHROPIC_API_KEY"),
    gate:      has("HQ_PASSWORD"),
    formHook:  has("FORM_WEBHOOK_SECRET"),
    calendar:  has("GOOGLE_REFRESH_TOKEN")
  };

  if (out.supabase) {
    try {
      const r = await fetch(process.env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/rpc/exodus_sql", {
        method: "POST",
        headers: {
          "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: "select count(*) as leads from leads;" })
      });
      out.dbReachable = r.ok;
      if (r.ok) { try { out.leads = (JSON.parse(await r.text()) || [])[0]?.leads ?? null; } catch {} }
      else out.dbError = (await r.text()).slice(0, 200);
    } catch (e) { out.dbReachable = false; out.dbError = String(e.message || e); }
  }

  out.notes = [];
  if (!out.supabase)  out.notes.push("Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  if (!out.anthropic) out.notes.push("Add ANTHROPIC_API_KEY or the agents will not answer.");
  if (!out.gate)      out.notes.push("No HQ_PASSWORD set — the page is open to anyone with the link.");
  if (out.dbReachable === false) out.notes.push("Database unreachable. Did you run the exodus_sql function from DEPLOY.md step 4?");
  if (!out.notes.length) out.notes.push("Everything is wired.");

  res.status(200).json(out);
}
