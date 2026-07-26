/* Exchange the password for a token the browser can keep.
   Rate limited in memory so it cannot be brute forced quickly. */
import crypto from "node:crypto";
import { expectedToken, body } from "./_auth.js";

const tries = new Map();                       // ip -> { n, until }

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const now = Date.now();
  const rec = tries.get(ip) || { n: 0, until: 0 };
  if (rec.until > now) {
    return res.status(429).json({ error: "Too many attempts. Wait a minute." });
  }

  const want = expectedToken();
  if (!want) return res.status(200).json({ token: "open", open: true });

  const { password } = await body(req);
  const given = crypto.createHash("sha256")
    .update("exodus:" + String(password || "")).digest("hex");

  const ok = given.length === want.length &&
             crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));

  if (!ok) {
    rec.n += 1;
    if (rec.n >= 6) { rec.until = now + 60_000; rec.n = 0; }
    tries.set(ip, rec);
    return res.status(401).json({ error: "Wrong password." });
  }

  tries.delete(ip);
  res.status(200).json({ token: want });
}
