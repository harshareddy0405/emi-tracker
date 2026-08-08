import { publicUser } from "../_lib/auth.js";
import { getDb } from "../_lib/db.js";
import { ApiError, handleApiError, readJson, requireMethod, requireSameOrigin, sendJson } from "../_lib/http.js";
import {
  clearLoginFailures,
  fingerprintLoginClient,
  loginRetryAfter,
  recordLoginFailure
} from "../_lib/login-rate-limit.js";
import { consumePasswordWork, verifyPassword } from "../_lib/password.js";
import { createSessionToken, sessionCookie } from "../_lib/session.js";

const METHODS = ["POST"];
const INVALID_LOOKUP_USERNAME = "__invalid_login_username__";

function credentialsAreWellFormed(username, password) {
  return Boolean(username)
    && username.length <= 80
    && Boolean(password)
    && password.length <= 1024;
}

function rejectRateLimited(res, retryAfterSeconds) {
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  throw new ApiError(429, "Too many sign-in attempts. Try again later.", "login_rate_limited");
}

export function createLoginHandler({
  database = getDb,
  verify = verifyPassword,
  consumeWork = consumePasswordWork,
  fingerprintClient = fingerprintLoginClient,
  checkRateLimit = loginRetryAfter,
  recordFailure = recordLoginFailure,
  clearFailures = clearLoginFailures
} = {}) {
  return async function loginHandler(req, res) {
    try {
      requireMethod(req, METHODS);
      requireSameOrigin(req);
      const body = await readJson(req);
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const clientFingerprint = fingerprintClient(req);
      const sql = database();

      const blockedFor = await checkRateLimit(sql, clientFingerprint);
      if (blockedFor > 0) {
        await consumeWork(password);
        rejectRateLimited(res, blockedFor);
      }

      const wellFormed = credentialsAreWellFormed(username, password);
      const rows = await sql`
        SELECT id, username, display_name, password_hash, session_version, last_login_at
        FROM users
        WHERE username = ${wellFormed ? username : INVALID_LOOKUP_USERNAME}
        LIMIT 1
      `;
      const user = rows[0];

      let valid = false;
      if (wellFormed && user) valid = await verify(password, user.password_hash);
      else await consumeWork(password);

      if (!valid) {
        const retryAfter = await recordFailure(sql, clientFingerprint);
        if (retryAfter > 0) rejectRateLimited(res, retryAfter);
        throw new ApiError(401, "Invalid username or password.", "invalid_credentials");
      }

      await clearFailures(sql, clientFingerprint);
      const updatedRows = await sql`
        UPDATE users
        SET last_login_at = now(),
            updated_at = now()
        WHERE id = ${user.id}
        RETURNING id, username, display_name, session_version, last_login_at
      `;
      const authenticatedUser = updatedRows[0];
      const token = createSessionToken({
        id: authenticatedUser.id,
        sessionVersion: Number(authenticatedUser.session_version)
      });
      res.setHeader("Set-Cookie", sessionCookie(token));
      sendJson(res, 200, { user: publicUser(authenticatedUser) });
    } catch (error) {
      handleApiError(res, error, METHODS);
    }
  };
}

export default createLoginHandler();
