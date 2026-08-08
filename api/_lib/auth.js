import { getDb } from "./db.js";
import { ApiError } from "./http.js";
import { readSessionToken, verifySessionToken } from "./session.js";

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name ?? user.displayName,
    lastLoginAt: user.last_login_at ?? user.lastLoginAt ?? null
  };
}

export async function getAuthenticatedUser(req, { required = true } = {}) {
  const payload = verifySessionToken(readSessionToken(req));
  if (!payload) {
    if (required) throw new ApiError(401, "Authentication required.", "unauthorized");
    return null;
  }

  const sql = getDb();
  const rows = await sql`
    SELECT id, username, display_name, session_version, last_login_at
    FROM users
    WHERE id = ${payload.uid}
    LIMIT 1
  `;
  const user = rows[0];
  if (!user || Number(user.session_version) !== payload.sv) {
    if (required) throw new ApiError(401, "Authentication required.", "unauthorized");
    return null;
  }
  return user;
}
