/* Shared gate. One password, checked on every API call.
   The browser stores the token, the server never trusts the browser blindly. */
import crypto from "node:crypto";

export function expectedToken() {
  const pw = process.env.HQ_PASSWORD || "";
  if (!pw) return null;                       // no password set -> gate is open
  return crypto.createHash("sha256").update("exodus:" + pw).digest("hex");
}

export function authed(req) {
  const want = expectedToken();
  if (!want) return true;                     // nothing configured, allow
  const got =
    req.headers["x-hq-token"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!got || got.length !== want.length) return false;
  // constant time compare so the token cannot be guessed a character at a time
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export function deny(res) {
  res.status(401).json({ error: "Not authorised. Sign in again." });
}

/* Small helper: read a JSON body whichever way Vercel hands it over. */
export async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}
