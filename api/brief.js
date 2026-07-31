/* ==========================================================================
   /api/brief  —  everything Claudia cannot know on her own
   --------------------------------------------------------------------------
   Weather, world news, sport and the two coins, fetched server-side and handed
   to her as facts. She is told, in her own brief, never to state one of these
   that is not in here. An invented headline is worse than no headline.

   Why server-side rather than from the page: no news organisation sets an
   Access-Control-Allow-Origin header on its RSS feed, so a browser fetch is
   blocked before it starts. Same for ESPN's feeds.

   No API keys anywhere in this file. Every source below is free and open.

     GET /api/brief                      the lot, for the morning brief
     GET /api/brief?lat=&lon=&tz=        weather for wherever he actually is
     GET /api/brief?only=crypto          just the coins — what the banner polls
     GET /api/brief?only=sports          just sport
     GET /api/brief?n=6                  more headlines

   If one source is down its section comes back with an error and everything
   else still arrives. One bad feed never takes the brief with it.
   ========================================================================== */

const HOME = { name: "New York", lat: 40.7128, lon: -74.0060, tz: "America/New_York" };
const AWAY = { name: "Bangkok",  lat: 13.7563, lon: 100.5018, tz: "Asia/Bangkok" };

/* WMO codes in the words a person says out loud, because she reads this aloud. */
const SKY = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "rain showers", 81: "heavy showers", 82: "violent showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorms", 96: "thunderstorms with hail", 99: "severe thunderstorms"
};

async function weatherAt(place) {
  const u = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + place.lat + "&longitude=" + place.lon
    + "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m"
    + "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max"
    + "&temperature_unit=fahrenheit&wind_speed_unit=mph"
    + "&timezone=" + encodeURIComponent(place.tz || "auto") + "&forecast_days=1";
  try {
    const r = await fetch(u);
    if (!r.ok) return { place: place.name, error: "Weather service returned " + r.status };
    const j = await r.json();
    const c = j.current || {}, d = j.daily || {};
    return {
      place: place.name,
      now: Math.round(c.temperature_2m),
      feels: Math.round(c.apparent_temperature),
      sky: SKY[c.weather_code] !== undefined ? SKY[c.weather_code] : "unsettled",
      wind: Math.round(c.wind_speed_10m),
      high: Math.round((d.temperature_2m_max || [])[0]),
      low: Math.round((d.temperature_2m_min || [])[0]),
      rainChance: (d.precipitation_probability_max || [])[0],
      unit: "F"
    };
  } catch (e) {
    return { place: place.name, error: String(e.message || e).slice(0, 120) };
  }
}

/* Turn coordinates into a place name, so the brief says "Philadelphia" and not
   "39.95, -75.16". Open-Meteo's geocoder has no reverse lookup, so this uses
   BigDataCloud's free client endpoint, which needs no key. If it does not
   answer, the coordinates still give correct weather — only the label is lost,
   and a nameless correct forecast beats a named wrong one. */
async function placeName(lat, lon) {
  try {
    const r = await fetch("https://api.bigdatacloud.net/data/reverse-geocode-client"
      + "?latitude=" + lat + "&longitude=" + lon + "&localityLanguage=en");
    if (!r.ok) return null;
    const j = await r.json();
    return j.city || j.locality || j.principalSubdivision || j.countryName || null;
  } catch { return null; }
}

/* ---------------- the wires ----------------
   Five desks in five countries: London, Doha, Washington, Berlin, Toronto.
   Glen asked for sources that are not all pulling the same way, and that is
   what this is — not a claim that any one of them is neutral, but a spread wide
   enough that a story only pushed by one of them is visibly only in one.

   AP returns 401 to a plain fetch, Reuters retired its public feed and France
   24's returns an empty document. All three were tested and dropped rather than
   left in to fail silently every morning. */
const NEWS_FEEDS = [
  { src: "BBC",        url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { src: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { src: "NPR",        url: "https://feeds.npr.org/1004/rss.xml" },
  { src: "DW",         url: "https://rss.dw.com/rdf/rss-en-world" },
  { src: "CBC",        url: "https://www.cbc.ca/webfeed/rss/rss-world" }
];

const SPORT_FEEDS = [
  { src: "ESPN",     url: "https://www.espn.com/espn/rss/news" },
  { src: "ESPN NFL", url: "https://www.espn.com/espn/rss/nfl/news" },
  { src: "ESPN NBA", url: "https://www.espn.com/espn/rss/nba/news" }
];

function unxml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (m, d) => String.fromCharCode(parseInt(d, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

/* A regex, not an XML parser. These are eight known feeds and we want two
   fields from each; adding a dependency to a serverless function to read a
   <title> tag is not a trade worth making. */
function parseFeed(xml, src, want) {
  const out = [];
  const items = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1);
  for (const raw of items) {
    const t = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!t) continue;
    const title = unxml(t[1]);
    if (!title || title.length < 12) continue;
    let link = "";
    const l = raw.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    if (l && l[1].trim()) link = unxml(l[1]);
    else {
      const h = raw.match(/<link[^>]*href="([^"]+)"/i);
      if (h) link = h[1];
    }
    out.push({ title, link, src });
    if (out.length >= want) break;
  }
  return out;
}

/* Interleave rather than concatenate. Concatenated, the first feed fills every
   slot and the list is one newsroom wearing five badges. */
async function pullFeeds(feeds, limit) {
  const per = Math.max(2, Math.ceil(limit / feeds.length) + 1);
  const got = await Promise.all(feeds.map(async (f) => {
    try {
      const r = await fetch(f.url, { headers: { "user-agent": "ExodusHQ/1.0 (brief)" } });
      if (!r.ok) return [];
      return parseFeed(await r.text(), f.src, per);
    } catch { return []; }
  }));
  const rows = [], seen = new Set();
  for (let i = 0; i < per; i++) {
    for (const list of got) {
      const it = list[i];
      if (!it) continue;
      const k = it.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 44);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(it);
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

/* ---------------- live scores ----------------
   ESPN's scoreboard endpoint is public and needs no key. It returns whatever is
   on today for each league, so "up to date" here means genuinely today's games
   with their current state, not a headline about them. */
const LEAGUES = [
  { k: "NFL",  path: "football/nfl" },
  { k: "NBA",  path: "basketball/nba" },
  { k: "MLB",  path: "baseball/mlb" },
  { k: "NHL",  path: "hockey/nhl" },
  { k: "EPL",  path: "soccer/eng.1" },
  { k: "UCL",  path: "soccer/uefa.champions" }
];

async function scores() {
  const out = [];
  await Promise.all(LEAGUES.map(async (lg) => {
    try {
      const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/"
        + lg.path + "/scoreboard");
      if (!r.ok) return;
      const j = await r.json();
      (j.events || []).slice(0, 6).forEach((e) => {
        const st = (e.status && e.status.type) || {};
        const comp = (e.competitions && e.competitions[0]) || {};
        const teams = (comp.competitors || []).map((c) => ({
          team: (c.team && (c.team.abbreviation || c.team.shortDisplayName)) || "?",
          score: c.score === undefined ? null : c.score,
          home: c.homeAway === "home"
        }));
        out.push({
          league: lg.k,
          name: e.shortName || e.name,
          state: st.state || "",            /* pre | in | post */
          detail: st.shortDetail || "",
          live: st.state === "in",
          done: st.completed === true,
          teams
        });
      });
    } catch { /* one league down does not take the section */ }
  }));
  /* What is happening now first, then what already finished, then what is next.
     That is the order a person cares about them in. */
  const rank = (x) => x.live ? 0 : x.done ? 1 : 2;
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

/* ---------------- the two coins ----------------
   CoinGecko's simple/price endpoint, free and keyless. Kept in its own section
   with its own short cache because a price is the one thing here that is stale
   after two minutes. */
async function crypto() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price"
      + "?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true");
    if (!r.ok) return { error: "CoinGecko returned " + r.status };
    const j = await r.json();
    const one = (o) => o ? {
      usd: o.usd,
      change24h: o.usd_24h_change === undefined ? null
               : Math.round(o.usd_24h_change * 100) / 100
    } : null;
    return { btc: one(j.bitcoin), eth: one(j.ethereum) };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 120) };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET" });
  const q = req.query || {};
  const only = String(q.only || "").toLowerCase();

  /* The banner polls this every couple of minutes and nothing else. Sixty
     seconds of cache keeps it honest without hammering CoinGecko. */
  if (only === "crypto") {
    const c = await crypto();
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({ ok: true, at: new Date().toISOString(), crypto: c });
  }
  if (only === "sports") {
    const [head, sc] = await Promise.all([pullFeeds(SPORT_FEEDS, 4), scores()]);
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
    return res.status(200).json({ ok: true, at: new Date().toISOString(),
      sport: head, scores: sc });
  }

  /* Where he actually is. The page sends coordinates when he has allowed it;
     without them this falls back to New York, which is where he is anyway. */
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  const haveFix = isFinite(lat) && isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const here = haveFix
    ? { name: (q.place ? String(q.place).slice(0, 40) : null),
        lat, lon, tz: q.tz ? String(q.tz).slice(0, 40) : "auto" }
    : HOME;
  if (haveFix && !here.name) here.name = (await placeName(lat, lon)) || "Where you are";

  const limit = Math.min(10, Math.max(1, parseInt(q.n, 10) || 4));

  const [wHere, wAway, news, sport, sc, coins] = await Promise.all([
    weatherAt(here),
    weatherAt(AWAY),
    pullFeeds(NEWS_FEEDS, limit),
    pullFeeds(SPORT_FEEDS, 3),
    scores(),
    crypto()
  ]);

  const out = {
    ok: true,
    at: new Date().toISOString(),
    locationFrom: haveFix ? "device" : "default (New York)",
    weather: { here: wHere, bangkok: wAway },
    news, sport, scores: sc, crypto: coins
  };
  /* Say it plainly rather than leaving an empty array to be filled in by
     imagination. She is instructed to read these lines out as they are. */
  if (!news.length)  out.newsError  = "No news feed answered just now.";
  if (!sport.length && !sc.length) out.sportError = "No sports feed answered just now.";

  /* Five minutes. Weather and the wires do not move faster than that, and it
     keeps a chatty morning down to one round of fetches. */
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
  res.status(200).json(out);
}
