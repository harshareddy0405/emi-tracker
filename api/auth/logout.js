import { getDb } from "../_lib/db.js";
import { getAuthenticatedUser } from "../_lib/auth.js";
import { clearSessionCookie } from "../_lib/session.js";
import { handleApiError, requireMethod, requireSameOrigin, sendJson } from "../_lib/http.js";

const METHODS = ["POST"];

export default async function handler(req, res) {
  try {
    requireMethod(req, METHODS);
    requireSameOrigin(req);
    const user = await getAuthenticatedUser(req, { required: false });
    if (user) {
      const sql = getDb();
      await sql`
        UPDATE users
        SET session_version = session_version + 1,
            updated_at = now()
        WHERE id = ${user.id}
      `;
    }
    res.setHeader("Set-Cookie", clearSessionCookie());
    sendJson(res, 200, { ok: true });
  } catch (error) {
    res.setHeader("Set-Cookie", clearSessionCookie());
    handleApiError(res, error, METHODS);
  }
}
