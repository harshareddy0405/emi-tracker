import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "emi_session";
const PERSISTENT_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getSecret() {
  const secret = process.env.AUTH_COOKIE_SECRET;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("AUTH_COOKIE_SECRET must contain at least 32 bytes.");
  }
  return secret;
}

function sign(payload) {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export function createSessionToken(user, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    uid: user.id,
    sv: Number(user.sessionVersion),
    iat: issuedAt
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadText, signatureText] = parts;

  try {
    const expected = Buffer.from(sign(payloadText), "base64url");
    const received = Buffer.from(signatureText, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));
    const nowSeconds = Math.floor(now / 1000);
    if (payload?.v !== 1 || typeof payload.uid !== "string" || !UUID_PATTERN.test(payload.uid)) return null;
    if (!Number.isSafeInteger(payload.sv) || payload.sv < 1) return null;
    if (!Number.isSafeInteger(payload.iat) || payload.iat > nowSeconds + 60) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== "string") return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

export function readSessionToken(req) {
  return parseCookies(req.headers?.cookie)[SESSION_COOKIE] || null;
}

export function sessionCookie(token, now = Date.now()) {
  const expires = new Date(now + PERSISTENT_MAX_AGE_SECONDS * 1000).toUTCString();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${PERSISTENT_MAX_AGE_SECONDS}; Expires=${expires}; Priority=High`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Priority=High`;
}
