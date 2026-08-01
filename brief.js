/* ==========================================================================
   /api/brief  —  everything Claudia cannot know on her own
   --------------------------------------------------------------------------
   Weather where he is, and eight desks of headlines — world, USA, markets,
   military, Thailand, sport and men's health — plus the two coins. Fetched server-side and handed to her as facts. She is told, in her
   own brief, never to state one of these that is not in here. An invented
   headline is worse than no headline.

   Why server-side: no news organisation sets an Access-Control-Allow-Origin
   header on its RSS feed, so a browser fetch is blocked before it starts.

   No API keys anywhere in this file.

     GET /api/brief                  the lot
     GET /api/brief?lat=&lon=&tz=    weather for wherever he actually is
     GET /api/brief?only=crypto      just the coins — what the banner polls
     GET /api/brief?only=sports      just sport
     GET /api/brief?cat=markets      one category of headlines
     GET /api/brief?n=14             how many per category (default 12)

   Every source below was tested from the server before it went in. AP and
   Reuters killed their public feeds and France 24's returns an empty document,
   so those three come through Google News search instead, which does work and
   whose links resolve to the publisher's own site.
   ========================================================================== */

const HOME = { name: "New York", lat: 40.7128, lon: -74.0060, tz: "America/New_York" };

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

/* Hourly as well as daily, because "what is it doing tonight" is the question
   he actually has, and a daily high does not answer it. */
async function weatherAt(place) {
  const u = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + place.lat + "&longitude=" + place.lon
    + "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m"
    + "&hourly=temperature_2m,weather_code,precipitation_probability"
    + "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunset"
    + "&temperature_unit=fahrenheit&wind_speed_unit=mph"
    + "&timezone=" + encodeURIComponent(place.tz || "auto") + "&forecast_days=2";
  try {
    const r = await fetch(u);
    if (!r.ok) return { place: place.name, error: "Weather service returned " + r.status };
    const j = await r.json();
    const c = j.current || {}, d = j.daily || {}, h = j.hourly || {};

    /* The next 24 hours, condensed to the three things worth saying out loud:
       how warm it gets, how cold it gets, and whether it rains. Read from the
       hour after now, not from midnight — a "daily low" that already happened
       at 5am this morning is not useful at 9pm. */
    let ahead = null;
    if (Array.isArray(h.time) && h.time.length) {
      const now = new Date();
      let i0 = h.time.findIndex(t => new Date(t) > now);
      if (i0 < 0) i0 = 0;
      const slice = (a) => Array.isArray(a) ? a.slice(i0, i0 + 24) : [];
      const temps = slice(h.temperature_2m).filter(Number.isFinite);
      const rain = slice(h.precipitation_probability).filter(Number.isFinite);
      const codes = slice(h.weather_code).filter(Number.isFinite);
      if (temps.length) {
        /* the worst weather coming, not the average — that is the bit that
           changes whether he films outside */
        const worst = codes.length ? Math.max.apply(null, codes) : null;
        ahead = {
          high: Math.round(Math.max.apply(null, temps)),
          low: Math.round(Math.min.apply(null, temps)),
          rainChance: rain.length ? Math.max.apply(null, rain) : null,
          worst: worst === null ? null
               : (SKY[worst] !== undefined ? SKY[worst] : "unsettled")
        };
      }
    }

    /* His local clock, from the timezone the forecast was computed in, so the
       brief can say "it is 9:14pm where you are" without guessing. */
    let localTime = null;
    try {
      localTime = new Intl.DateTimeFormat("en-US", {
        timeZone: j.timezone || place.tz, hour: "numeric", minute: "2-digit"
      }).format(new Date());
    } catch { /* an unknown zone is not worth failing the forecast over */ }

    return {
      place: place.name,
      now: Math.round(c.temperature_2m),
      feels: Math.round(c.apparent_temperature),
      sky: SKY[c.weather_code] !== undefined ? SKY[c.weather_code] : "unsettled",
      wind: Math.round(c.wind_speed_10m),
      high: Math.round((d.temperature_2m_max || [])[0]),
      low: Math.round((d.temperature_2m_min || [])[0]),
      rainChance: (d.precipitation_probability_max || [])[0],
      sunset: (d.sunset || [])[0] || null,
      next24: ahead,
      localTime,
      tz: j.timezone || place.tz,
      unit: "F"
    };
  } catch (e) {
    return { place: place.name, error: String(e.message || e).slice(0, 120) };
  }
}

async function placeName(lat, lon) {
  try {
    const r = await fetch("https://api.bigdatacloud.net/data/reverse-geocode-client"
      + "?latitude=" + lat + "&longitude=" + lon + "&localityLanguage=en");
    if (!r.ok) return null;
    const j = await r.json();
    return j.city || j.locality || j.principalSubdivision || j.countryName || null;
  } catch { return null; }
}

/* ==================== THE DESKS ====================
   Four categories, because those are the four things he reads: what is
   happening in the world, what it is doing to the markets, sport, and staying
   in shape. Spread across a lot of mastheads on purpose — a story only one of
   them is pushing is then visibly only in one.

   `gn` marks a Google News search feed. Those carry a <source> element with
   the real publisher, so the badge says Reuters, not Google. */
const DESKS = {
  world: [
    { src: "BBC",        url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    { src: "Reuters",    gn: 1, url: "https://news.google.com/rss/search?q=site:reuters.com+when:1d&hl=en-US&gl=US&ceid=US:en" },
    { src: "AP",         gn: 1, url: "https://news.google.com/rss/search?q=site:apnews.com+when:1d&hl=en-US&gl=US&ceid=US:en" },
    { src: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
    { src: "Guardian",   url: "https://www.theguardian.com/world/rss" },
    { src: "DW",         url: "https://rss.dw.com/rdf/rss-en-world" },
    { src: "NPR",        url: "https://feeds.npr.org/1004/rss.xml" },
    { src: "CBC",        url: "https://www.cbc.ca/webfeed/rss/rss-world" },
    { src: "ToI",        url: "https://www.timesofisrael.com/feed/" }
  ],
  markets: [
    { src: "CNBC",       url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258" },
    { src: "CNBC",       url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114" },
    { src: "MarketWatch",url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
    { src: "Yahoo Fin",  url: "https://finance.yahoo.com/news/rssindex" },
    { src: "Investing",  url: "https://www.investing.com/rss/news.rss" },
    { src: "CoinDesk",   url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
    { src: "Cointelegraph", url: "https://cointelegraph.com/rss" }
  ],
  usa: [
    { src: "AP",      gn: 1, url: "https://news.google.com/rss/search?q=site:apnews.com+US+when:1d&hl=en-US&gl=US&ceid=US:en" },
    { src: "NPR",     url: "https://feeds.npr.org/1003/rss.xml" },
    { src: "CBS",     url: "https://www.cbsnews.com/latest/rss/us" },
    { src: "ABC",     url: "https://feeds.abcnews.com/abcnews/usheadlines" },
    { src: "The Hill",url: "https://thehill.com/news/feed/" }
  ],
  /* Where he is moving. Bangkok Post and the Thaiger are the two English
     mastheads people there actually read; the Google News sweep catches the
     wires when something big happens. */
  thailand: [
    { src: "Bangkok Post", url: "https://www.bangkokpost.com/rss/data/topstories.xml" },
    { src: "Thaiger",      url: "https://thethaiger.com/feed" },
    { src: "Thailand",     gn: 1, url: "https://news.google.com/rss/search?q=Thailand+when:2d&hl=en-US&gl=US&ceid=US:en" }
  ],
  military: [
    { src: "Defense News",     url: "https://www.defensenews.com/arc/outboundfeeds/rss/" },
    { src: "War on the Rocks", url: "https://warontherocks.com/feed/" },
    { src: "Breaking Defense", url: "https://breakingdefense.com/feed/" },
    { src: "Task & Purpose",   url: "https://taskandpurpose.com/feed/" }
  ],
  sport: [
    { src: "ESPN",       url: "https://www.espn.com/espn/rss/news" },
    { src: "ESPN NFL",   url: "https://www.espn.com/espn/rss/nfl/news" },
    { src: "ESPN NBA",   url: "https://www.espn.com/espn/rss/nba/news" },
    { src: "ESPN MLB",   url: "https://www.espn.com/espn/rss/mlb/news" },
    { src: "ESPN Soccer",url: "https://www.espn.com/espn/rss/soccer/news" },
    { src: "BBC Sport",  url: "https://feeds.bbci.co.uk/sport/rss.xml" }
  ],
  fitness: [
    /* Men's Health's all.xml carries film reviews and celebrity pieces — the
       section feeds are the ones actually about training. */
    { src: "Men's Health", url: "https://www.menshealth.com/rss/fitness.xml/" },
    { src: "Men's Health", url: "https://www.menshealth.com/rss/nutrition.xml/" },
    { src: "Men's Health", url: "https://www.menshealth.com/rss/health.xml/" },
    { src: "M&F",          url: "https://www.muscleandfitness.com/feed/" },
    { src: "Stronger by Science", url: "https://www.strongerbyscience.com/feed/" },
    { src: "Runner's World", url: "https://www.runnersworld.com/rss/all.xml/" },
    { src: "Outside",      url: "https://www.outsideonline.com/feed/" },
    { src: "Healthline",   url: "https://www.healthline.com/rss/health-news" },
    { src: "NYT Well",     url: "https://rss.nytimes.com/services/xml/rss/nyt/Well.xml" }
  ]
};

/* Google News hands back a bare domain for some publishers. A badge that says
   "apnews.com" looks like a bug; one that says "AP" looks like a newspaper. */
const TIDY = {
  "apnews.com": "AP", "associated press": "AP",
  "reuters.com": "Reuters", "reuters": "Reuters",
  "bbc.com": "BBC", "bbc.co.uk": "BBC",
  "cnbc.com": "CNBC", "theguardian.com": "Guardian",
  "aljazeera.com": "Al Jazeera", "npr.org": "NPR",
  "espn.com": "ESPN", "cnn.com": "CNN", "nytimes.com": "NYT",
  "wsj.com": "WSJ", "bloomberg.com": "Bloomberg", "ft.com": "FT"
};

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

function parseFeed(xml, feed, want) {
  const out = [];
  const items = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1);
  for (const raw of items) {
    const t = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!t) continue;
    let title = unxml(t[1]);
    if (!title || title.length < 12) continue;

    let src = feed.src;
    if (feed.gn) {
      /* Google News appends " - Publisher" to the title and repeats it in a
         <source> element. Use the element, and strip the suffix, so the badge
         is right and the headline is not printing its own byline. */
      const sm = raw.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
      if (sm) {
        const pub = unxml(sm[1]);
        if (pub) {
          src = TIDY[pub.toLowerCase()] || pub.replace(/\s*\(.*\)$/, "");
          const tail = new RegExp("\\s*[-–—]\\s*" + pub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i");
          title = title.replace(tail, "");
        }
      }
    }

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

/* Interleave. Concatenated, the first feed fills every slot and the list is
   one newsroom wearing nine badges. */
async function pullDesk(feeds, limit) {
  const per = Math.max(3, Math.ceil(limit / feeds.length) + 2);
  const got = await Promise.all(feeds.map(async (f) => {
    try {
      const r = await fetch(f.url, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; ExodusHQ/1.0)" },
        signal: AbortSignal.timeout(7000)
      });
      if (!r.ok) return [];
      return parseFeed(await r.text(), f, per);
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

/* ---------------- live scores ---------------- */
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
        + lg.path + "/scoreboard", { signal: AbortSignal.timeout(7000) });
      if (!r.ok) return;
      const j = await r.json();
      (j.events || []).slice(0, 6).forEach((e) => {
        const st = (e.status && e.status.type) || {};
        const comp = (e.competitions && e.competitions[0]) || {};
        out.push({
          league: lg.k,
          name: e.shortName || e.name,
          link: (e.links && e.links[0] && e.links[0].href) || "",
          state: st.state || "",
          detail: st.shortDetail || "",
          live: st.state === "in",
          done: st.completed === true,
          teams: (comp.competitors || []).map((c) => ({
            team: (c.team && (c.team.abbreviation || c.team.shortDisplayName)) || "?",
            score: c.score === undefined ? null : c.score,
            home: c.homeAway === "home"
          }))
        });
      });
    } catch { /* one league down does not take the section */ }
  }));
  const rank = (x) => x.live ? 0 : x.done ? 1 : 2;
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

async function crypto() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price"
      + "?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true",
      { signal: AbortSignal.timeout(7000) });
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
  const limit = Math.min(20, Math.max(4, parseInt(q.n, 10) || 12));

  if (only === "crypto") {
    const c = await crypto();
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    return res.status(200).json({ ok: true, at: new Date().toISOString(), crypto: c });
  }
  if (only === "sports") {
    const [head, sc] = await Promise.all([pullDesk(DESKS.sport, limit), scores()]);
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
    return res.status(200).json({ ok: true, at: new Date().toISOString(),
      sport: head, scores: sc });
  }

  /* one desk on its own */
  const cat = String(q.cat || "").toLowerCase();
  if (DESKS[cat]) {
    const rows = await pullDesk(DESKS[cat], limit);
    res.setHeader("Cache-Control", "public, s-maxage=240, stale-while-revalidate=600");
    return res.status(200).json({ ok: true, at: new Date().toISOString(),
      cat, headlines: rows });
  }

  /* Where he is. Without a fix this falls back to New York and says so, so the
     brief is never quietly describing the wrong city. */
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  const haveFix = isFinite(lat) && isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const here = haveFix
    ? { name: (q.place ? String(q.place).slice(0, 40) : null),
        lat, lon, tz: q.tz ? String(q.tz).slice(0, 40) : "auto" }
    : HOME;
  if (haveFix && !here.name) here.name = (await placeName(lat, lon)) || "Where you are";

  /* Every desk at once. They run in parallel and each feed has its own 7s
     timeout, so a slow masthead costs nothing but its own slot. */
  const CATS = ["world", "usa", "markets", "military", "thailand", "sport", "fitness"];
  const smaller = { fitness: 8, thailand: 8, military: 8 };
  const [wHere, sc, coins, ...desks] = await Promise.all([
    weatherAt(here),
    scores(),
    crypto(),
    ...CATS.map(c => pullDesk(DESKS[c], smaller[c] || limit))
  ]);

  const tag = (rows, c) => rows.map(r => Object.assign({ cat: c }, r));
  const byCat = {}, counts = {};
  CATS.forEach((c, i) => { byCat[c] = desks[i] || []; counts[c] = byCat[c].length; });

  const world = byCat.world, sport = byCat.sport;
  const news = tag(world, "world");

  const out = {
    ok: true,
    at: new Date().toISOString(),
    locationFrom: haveFix ? "device" : "default (New York)",
    weather: { here: wHere },
    news,
    headlines: CATS.reduce((a, c) => a.concat(tag(byCat[c], c)), []),
    counts,
    cats: CATS,
    sport, scores: sc, crypto: coins
  };
  if (!news.length) out.newsError = "No news feed answered just now.";
  if (!sport.length && !sc.length) out.sportError = "No sports feed answered just now.";

  /* Two minutes. Long enough that a chatty morning is a handful of fetches,
     short enough that "Refresh" during a breaking story actually brings
     something new rather than the same cached page. */
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");
  res.status(200).json(out);
}
