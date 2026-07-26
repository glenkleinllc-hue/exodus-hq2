/* Claudia books appointments here. Google's refresh token is swapped for a
   short-lived access token on each call, so nothing long-lived sits in the page.

   Leave the three GOOGLE_ vars blank until you have done DEPLOY.md step 7 —
   this route will simply say it is not connected yet. */
import { authed, deny, body } from "./_auth.js";

async function accessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token"
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    /* the failure worth naming: Google kills refresh tokens after 7 days while
       the OAuth app is still in Testing mode. See DEPLOY.md step 7. */
    const hint = /invalid_grant/i.test(JSON.stringify(j))
      ? " Your refresh token was revoked. This happens every 7 days while the "
        + "Google app is in Testing mode — publish it to Production to stop it."
      : "";
    throw new Error((j.error_description || j.error || "Google refused the token.") + hint);
  }
  return j.access_token;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!authed(req)) return deny(res);

  if (!process.env.GOOGLE_REFRESH_TOKEN)
    return res.status(503).json({ error: "Calendar is not connected yet. See DEPLOY.md step 7." });

  const a = await body(req);
  if (!a.summary || !a.startTime || !a.endTime)
    return res.status(400).json({ error: "Need a title, a start and an end." });

  try {
    const token = await accessToken();
    const calId = encodeURIComponent(a.calendarId || "primary");
    const tz = a.timeZone || "America/New_York";

    const event = {
      summary: a.summary,
      description: a.description || "Booked from Exodus HQ.",
      start: { dateTime: a.startTime, timeZone: tz },
      end:   { dateTime: a.endTime,   timeZone: tz }
    };
    if (Array.isArray(a.attendees) && a.attendees.length)
      event.attendees = a.attendees.filter(x => x && x.email).map(x => ({ email: x.email }));
    if (a.addGoogleMeetUrl)
      event.conferenceData = {
        createRequest: { requestId: "exodus-" + Date.now(), conferenceSolutionKey: { type: "hangoutsMeet" } }
      };

    const r = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/" + calId +
      "/events?conferenceDataVersion=1&sendUpdates=all",
      {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(event)
      });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const m = (j.error && j.error.message) || "Google rejected the event.";
      return res.status(502).json({ error: m });
    }
    res.status(200).json({ ok: true, id: j.id, link: j.htmlLink, meet: j.hangoutLink || null });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
