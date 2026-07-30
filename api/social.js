/* ==========================================================================
   LIVE FOLLOWER COUNTS
   --------------------------------------------------------------------------
   GET /api/social            read what we have (no keys needed)
   GET /api/social?refresh=1  go and ask the platforms

   The honest state of each platform, as of building this:

   YouTube  — works today with nothing but an API key. channels.list with
              part=statistics returns subscriberCount and costs 1 unit against a
              10,000/day quota. No OAuth, no review, no expiry.
              Needs: YOUTUBE_API_KEY, YOUTUBE_CHANNEL_ID.
              Note: YouTube rounds subscriber counts to three significant
              figures above 1,000. 5,420 comes back as 5,420; 5,423 also comes
              back as 5,420. That is YouTube's rounding, not a bug here.

   Instagram — needs a Meta app, a Business or Creator account linked to a
              Facebook Page, and a long-lived token that has to be refreshed
              every 60 days. follower_count is then available.
              Needs: IG_USER_ID, IG_ACCESS_TOKEN.

   TikTok    — follower_count moved behind the user.info.stats scope, which
              means a TikTok developer app, Login Kit, and a review that TikTok
              says takes 3-4 days and is friendlier to apps with a production
              track record. Until that is approved there is no API path to an
              exact follower count for your own account.
              Needs: TIKTOK_ACCESS_TOKEN.

   So: whatever has credentials gets pulled, everything else keeps the number
   Glen typed in. A platform we cannot read is never zeroed out — that is the
   whole point of the source column.
   ========================================================================== */

function sqlv(v) {
  if (v === null || v === undefined || v === "") return "null";
  if (typeof v === "number") return isFinite(v) ? String(v) : "null";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function unsafe(q) {
  const t = String(q).replace(/\s+/g, " ");
  for (const part of t.split(";")) {
    const p = part.trim(); if (!p) continue;
    if (/^delete\s+from\s/i.test(p) && !/\swhere\s/i.test(p)) return p.slice(0, 90);
    if (/^update\s/i.test(p) && !/\swhere\s/i.test(p)) return p.slice(0, 90);
  }
  return null;
}

async function runSql(q) {
  const url = process.env.SUPABASE_URL, srv = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srv) throw new Error("Database not configured.");
  const bad = unsafe(q);
  if (bad) throw new Error("Refused unsafe SQL: " + bad);
  const r = await fetch(url.replace(/\/$/, "") + "/rest/v1/rpc/exodus_sql", {
    method: "POST",
    headers: { apikey: srv, Authorization: "Bearer " + srv, "Content-Type": "application/json" },
    body: JSON.stringify({ q })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text.slice(0, 300));
  try { return JSON.parse(text); } catch { return []; }
}

/* ---------------- the platforms ---------------- */

async function youtube() {
  const key = process.env.YOUTUBE_API_KEY;
  const ch = process.env.YOUTUBE_CHANNEL_ID;
  if (!key || !ch)
    return { ok: false, why: "Needs YOUTUBE_API_KEY and YOUTUBE_CHANNEL_ID." };

  const u = "https://www.googleapis.com/youtube/v3/channels"
    + "?part=statistics&id=" + encodeURIComponent(ch) + "&key=" + encodeURIComponent(key);
  const r = await fetch(u);
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = j && j.error && j.error.message ? j.error.message : ("HTTP " + r.status);
    return { ok: false, why: msg.slice(0, 200) };
  }
  const item = j && j.items && j.items[0];
  if (!item) return { ok: false, why: "No channel came back for that ID." };
  if (item.statistics && item.statistics.hiddenSubscriberCount)
    return { ok: false, why: "That channel hides its subscriber count." };
  const n = parseInt(item.statistics && item.statistics.subscriberCount, 10);
  if (!isFinite(n)) return { ok: false, why: "No subscriberCount in the response." };
  return { ok: true, followers: n,
    note: "YouTube rounds to 3 significant figures above 1,000." };
}

async function instagram() {
  const id = process.env.IG_USER_ID, tok = process.env.IG_ACCESS_TOKEN;
  if (!id || !tok) return { ok: false, why: "Needs IG_USER_ID and IG_ACCESS_TOKEN." };
  const u = "https://graph.facebook.com/v21.0/" + encodeURIComponent(id)
    + "?fields=followers_count,username&access_token=" + encodeURIComponent(tok);
  const r = await fetch(u);
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = j && j.error && j.error.message ? j.error.message : ("HTTP " + r.status);
    /* the 60-day expiry is the failure he will actually hit, so name it */
    const expired = /expired|session|OAuth/i.test(msg);
    return { ok: false, why: msg.slice(0, 200)
      + (expired ? "  (Instagram tokens last 60 days — this one needs renewing.)" : "") };
  }
  const n = parseInt(j && j.followers_count, 10);
  if (!isFinite(n)) return { ok: false, why: "No followers_count in the response." };
  return { ok: true, followers: n, handle: j.username || null };
}

async function tiktok() {
  const tok = process.env.TIKTOK_ACCESS_TOKEN;
  if (!tok) return { ok: false, why: "Needs TIKTOK_ACCESS_TOKEN, which needs an "
    + "approved TikTok app with the user.info.stats scope." };
  const u = "https://open.tiktokapis.com/v2/user/info/?fields=follower_count,display_name";
  const r = await fetch(u, { headers: { Authorization: "Bearer " + tok } });
  const j = await r.json().catch(() => null);
  const err = j && j.error && j.error.code && j.error.code !== "ok" ? j.error : null;
  if (!r.ok || err) {
    let msg = (err && (err.message || err.code)) || ("HTTP " + r.status);
    if (/scope_not_authorized/i.test(msg))
      msg += "  (the app has not been granted user.info.stats)";
    return { ok: false, why: String(msg).slice(0, 200) };
  }
  const n = parseInt(j && j.data && j.data.user && j.data.user.follower_count, 10);
  if (!isFinite(n)) return { ok: false, why: "No follower_count in the response." };
  return { ok: true, followers: n,
    handle: (j.data.user.display_name || null) };
}

const PULLERS = { youtube, instagram, tiktok };
/* social_accounts.platform holds the full names — 'youtube', 'instagram',
   'tiktok'. The app shortens them to yt / ig / tiktok on the way into local
   storage, so that translation belongs in the page, not here. Writing 'yt' would
   have created a second, orphan row and left the real one stale. */

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST")
    return res.status(405).json({ error: "GET" });

  /* Reading is open. Refreshing is not, because it spends API quota, so it needs
     one of two things:
       - the same ?key= secret the form webhook uses, or
       - to be Vercel's own scheduled job.

     The nightly cron lives in vercel.json, which sits in a PUBLIC repo, so the
     secret cannot go in the path. Vercel stamps its own cron requests with
     x-vercel-cron, and that header cannot be set by an outside caller, so it is
     the right thing to trust here. If CRON_SECRET is configured, Vercel also
     sends it as a bearer token and that is checked as well. */
  const wantRefresh = !!(req.query && (req.query.refresh || req.query.pull));
  if (wantRefresh) {
    const secret = process.env.FORM_WEBHOOK_SECRET;
    const given = (req.query && req.query.key) || req.headers["x-webhook-key"];
    const fromCron = !!req.headers["x-vercel-cron"];
    const cronSecret = process.env.CRON_SECRET;
    const cronOk = fromCron && (!cronSecret
      || (req.headers.authorization || "") === "Bearer " + cronSecret);
    if (secret && given !== secret && !cronOk)
      return res.status(401).json({ error: "Bad key." });
  }

  if (!wantRefresh) {
    try {
      const rows = await runSql(
        "select platform, handle, followers, goal, source, checked_at, updated_at "
        + "from social_accounts order by platform;");
      return res.status(200).json({ ok: true, accounts: rows });
    } catch (e) {
      return res.status(502).json({ error: String(e.message || e) });
    }
  }

  /* ---- go and ask ---- */
  const result = {};
  await Promise.all(Object.keys(PULLERS).map(async (name) => {
    try { result[name] = await PULLERS[name](); }
    catch (e) { result[name] = { ok: false, why: String(e.message || e) }; }
  }));

  /* Only platforms that answered get written. A platform we cannot read keeps
     whatever Glen typed in, and keeps source='manual' so it stays his number. */
  const wins = Object.keys(result).filter(k => result[k].ok);
  let wrote = 0;
  if (wins.length) {
    const q = `
      insert into social_accounts (platform, handle, followers, source)
      values ${wins.map(k => "(" + sqlv(k) + "," + sqlv(result[k].handle || null)
        + "," + result[k].followers + ",'api')").join(",")}
      on conflict (platform) do update
        set followers  = excluded.followers,
            handle     = coalesce(excluded.handle, social_accounts.handle),
            source     = 'api',
            checked_at = now(),
            updated_at = now();

      insert into social_history (platform, on_date, followers, source)
      values ${wins.map(k => "(" + sqlv(k) + ",current_date,"
        + result[k].followers + ",'api')").join(",")}
      on conflict (platform, on_date) do update
        set followers = excluded.followers;`;
    try { await runSql(q); wrote = wins.length; }
    catch (e) { return res.status(502).json({ error: "Saved nothing: " + String(e.message || e),
      pulled: result }); }
  }

  let accounts = [];
  try {
    accounts = await runSql(
      "select platform, handle, followers, goal, source, checked_at "
      + "from social_accounts order by platform;");
  } catch { /* the pull still succeeded; reporting it is enough */ }

  res.status(200).json({
    ok: true,
    updated: wrote,
    pulled: result,
    accounts,
    setup: {
      youtube: "YOUTUBE_API_KEY + YOUTUBE_CHANNEL_ID — works with just an API key.",
      instagram: "IG_USER_ID + IG_ACCESS_TOKEN — Meta app, Business/Creator account, "
        + "token expires every 60 days.",
      tiktok: "TIKTOK_ACCESS_TOKEN — needs an approved TikTok app with user.info.stats."
    }
  });
}
