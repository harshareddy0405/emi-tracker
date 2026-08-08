import { getAuthenticatedUser, publicUser } from "../_lib/auth.js";
import { handleApiError, requireMethod, sendJson } from "../_lib/http.js";

const METHODS = ["GET"];

export default async function handler(req, res) {
  try {
    requireMethod(req, METHODS);
    const user = await getAuthenticatedUser(req);
    sendJson(res, 200, { user: publicUser(user) });
  } catch (error) {
    handleApiError(res, error, METHODS);
  }
}
