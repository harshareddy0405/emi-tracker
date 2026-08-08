import { getDb } from "../api/_lib/db.js";
import { hashPassword } from "../api/_lib/password.js";

const username = String(process.env.EMI_ADMIN_USERNAME || "").trim().toLowerCase();
const password = process.env.EMI_ADMIN_PASSWORD;
const displayName = String(process.env.EMI_ADMIN_DISPLAY_NAME || "Portfolio owner").trim();

if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(username)) {
  throw new Error("EMI_ADMIN_USERNAME must be 3-80 lowercase letters, numbers, dots, underscores, or hyphens.");
}
if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
  throw new Error("EMI_ADMIN_PASSWORD must be between 12 and 1024 characters.");
}
if (!displayName || displayName.length > 120) throw new Error("EMI_ADMIN_DISPLAY_NAME is invalid.");

const passwordHash = await hashPassword(password);
const sql = getDb();
const userRows = await sql`
  INSERT INTO users (singleton_key, username, display_name, password_hash)
  VALUES (1, ${username}, ${displayName}, ${passwordHash})
  ON CONFLICT (singleton_key) DO UPDATE SET
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    password_hash = EXCLUDED.password_hash,
    session_version = users.session_version + 1,
    failed_login_attempts = 0,
    locked_until = NULL,
    updated_at = now()
  RETURNING id
`;
await sql`
  INSERT INTO settings (user_id)
  VALUES (${userRows[0].id})
  ON CONFLICT (user_id) DO NOTHING
`;

process.stdout.write("Single-user account configured. Existing sessions were revoked.\n");
