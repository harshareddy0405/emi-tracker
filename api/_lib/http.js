const MAX_JSON_BYTES = 64 * 1024;

export class ApiError extends Error {
  constructor(status, message, code = "bad_request") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

export function requireMethod(req, allowed) {
  const methods = Array.isArray(allowed) ? allowed : [allowed];
  if (!methods.includes(req.method)) {
    throw new ApiError(405, "Method not allowed.", "method_not_allowed");
  }
}

export function setAllowedMethods(res, methods) {
  res.setHeader("Allow", methods.join(", "));
}

export async function readJson(req) {
  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new ApiError(413, "Request body is too large.", "payload_too_large");
  }

  let body;
  try {
    body = req.body;
  } catch {
    throw new ApiError(400, "The request body is not valid JSON.", "invalid_json");
  }
  if (body === undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_JSON_BYTES) {
        throw new ApiError(413, "Request body is too large.", "payload_too_large");
      }
      chunks.push(bytes);
    }
    body = Buffer.concat(chunks).toString("utf8");
  }

  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    if (!body.trim()) throw new ApiError(400, "A JSON body is required.", "invalid_json");
    try {
      body = JSON.parse(body);
    } catch {
      throw new ApiError(400, "The request body is not valid JSON.", "invalid_json");
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "The JSON body must be an object.", "invalid_json");
  }
  return body;
}

export function requireSameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return;

  const localProto = req.socket?.encrypted ? "https" : "http";
  const forwardedProto = String(req.headers?.["x-forwarded-proto"] || localProto).split(",")[0].trim();
  const forwardedHost = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "").split(",")[0].trim();
  if (!forwardedHost || origin !== `${forwardedProto}://${forwardedHost}`) {
    throw new ApiError(403, "Cross-origin mutation rejected.", "origin_rejected");
  }
}

export function handleApiError(res, error, allowedMethods) {
  if (error instanceof ApiError) {
    if (error.status === 405 && allowedMethods) setAllowedMethods(res, allowedMethods);
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  sendJson(res, 500, { error: "The request could not be completed.", code: "internal_error" });
}
