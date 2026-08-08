import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const MAX_FAILURES = 5;
const WINDOW_SECONDS = 15 * 60;
const BLOCK_SECONDS = 15 * 60;
const RETENTION_SECONDS = 24 * 60 * 60;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

function secret() {
  const value = process.env.AUTH_COOKIE_SECRET;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("AUTH_COOKIE_SECRET must contain at least 32 bytes.");
  }
  return value;
}

function firstHeaderValue(value) {
  const header = Array.isArray(value) ? value[0] : value;
  return typeof header === "string" ? header.split(",", 1)[0].trim() : "";
}

function canonicalAddress(value) {
  const candidate = firstHeaderValue(value).toLowerCase();
  if (!candidate) return null;

  const mappedAddress = candidate.startsWith("::ffff:") ? candidate.slice(7) : "";
  if (isIP(mappedAddress) === 4) return mappedAddress.split(".").map(Number).join(".");
  if (isIP(candidate) === 4) return candidate.split(".").map(Number).join(".");
  if (isIP(candidate) !== 6) return null;

  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.slice(1, -1);
  } catch {
    return null;
  }
}

function requestAddress(req) {
  const headers = req?.headers || {};
  return canonicalAddress(headers["x-vercel-forwarded-for"])
    || canonicalAddress(headers["x-forwarded-for"])
    || canonicalAddress(req?.socket?.remoteAddress)
    || "unresolved-client";
}

export function fingerprintLoginClient(req) {
  return createHmac("sha256", secret())
    .update("emi-tracker:login-rate-limit:v1\0", "utf8")
    .update(requestAddress(req), "utf8")
    .digest("hex");
}

function retryAfter(value) {
  const seconds = Math.ceil(Number(value || 0));
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

export async function loginRetryAfter(sql, clientFingerprint) {
  const rows = await sql`
    SELECT GREATEST(
             0,
             CEIL(EXTRACT(EPOCH FROM (blocked_until - now())))
           )::integer AS retry_after_seconds
    FROM login_rate_limits
    WHERE client_fingerprint = ${clientFingerprint}
      AND blocked_until > now()
    LIMIT 1
  `;
  return retryAfter(rows[0]?.retry_after_seconds);
}

export async function recordLoginFailure(sql, clientFingerprint) {
  await sql`
    DELETE FROM login_rate_limits
    WHERE client_fingerprint IN (
      SELECT client_fingerprint
      FROM login_rate_limits
      WHERE updated_at < now() - (${RETENTION_SECONDS} * interval '1 second')
        AND client_fingerprint <> ${clientFingerprint}
      ORDER BY updated_at ASC
      LIMIT 100
    )
  `;
  const rows = await sql`
    INSERT INTO login_rate_limits AS limits (
      client_fingerprint, failure_count, window_started_at,
      last_failure_at, blocked_until, updated_at
    ) VALUES (
      ${clientFingerprint}, 1, now(), now(), NULL, now()
    )
    ON CONFLICT (client_fingerprint) DO UPDATE SET
      failure_count = CASE
        WHEN limits.blocked_until > now() THEN limits.failure_count
        WHEN limits.blocked_until IS NOT NULL
          OR limits.window_started_at <= now() - (${WINDOW_SECONDS} * interval '1 second')
          THEN 1
        ELSE LEAST(limits.failure_count + 1, ${MAX_FAILURES})
      END,
      window_started_at = CASE
        WHEN limits.blocked_until > now() THEN limits.window_started_at
        WHEN limits.blocked_until IS NOT NULL
          OR limits.window_started_at <= now() - (${WINDOW_SECONDS} * interval '1 second')
          THEN now()
        ELSE limits.window_started_at
      END,
      last_failure_at = now(),
      blocked_until = CASE
        WHEN limits.blocked_until > now() THEN limits.blocked_until
        WHEN limits.blocked_until IS NOT NULL
          OR limits.window_started_at <= now() - (${WINDOW_SECONDS} * interval '1 second')
          THEN NULL
        WHEN limits.failure_count + 1 >= ${MAX_FAILURES}
          THEN now() + (${BLOCK_SECONDS} * interval '1 second')
        ELSE NULL
      END,
      updated_at = now()
    RETURNING GREATEST(
                0,
                CEIL(EXTRACT(EPOCH FROM (blocked_until - now())))
              )::integer AS retry_after_seconds
  `;
  return retryAfter(rows[0]?.retry_after_seconds);
}

export async function clearLoginFailures(sql, clientFingerprint) {
  await sql`
    DELETE FROM login_rate_limits
    WHERE client_fingerprint = ${clientFingerprint}
  `;
}
