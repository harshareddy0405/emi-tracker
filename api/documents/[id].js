import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { get } from "@vercel/blob";
import { getAuthenticatedUser } from "../_lib/auth.js";
import { getDb } from "../_lib/db.js";
import {
  isPreviewableContentType,
  safeContentType,
  safeDownloadFilename
} from "../_lib/document-security.js";
import { ApiError, handleApiError, requireMethod } from "../_lib/http.js";

const METHODS = ["GET"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function contentBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string" && value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  if (typeof value === "string") return Buffer.from(value, "base64");
  return null;
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function responseContentType(documentType, blobType) {
  const storedType = safeContentType(documentType);
  return storedType === "application/octet-stream" ? safeContentType(blobType) : storedType;
}

function setDocumentHeaders(res, { contentType, filename, byteSize, inline }) {
  const disposition = inline && isPreviewableContentType(contentType) ? "inline" : "attachment";
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  if (Number.isSafeInteger(byteSize) && byteSize >= 0) {
    res.setHeader("Content-Length", String(byteSize));
  }
  res.setHeader("Content-Disposition", `${disposition}; filename="${safeDownloadFilename(filename)}"`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Cookie");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "sandbox");
}

async function getPrivateBlob(document) {
  const blobIdentifier = document.blob_pathname || document.blob_url;
  if (!blobIdentifier) return null;
  try {
    const result = await get(blobIdentifier, { access: "private" });
    return result?.statusCode === 200 ? result : null;
  } catch {
    // A Neon bytea copy can serve as a private fallback during migration or
    // temporary Blob outages. Credential details are deliberately not logged.
    return null;
  }
}

export default async function handler(req, res) {
  try {
    requireMethod(req, METHODS);
    const user = await getAuthenticatedUser(req);
    const id = firstQueryValue(req.query?.id);
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      throw new ApiError(404, "Document not found.", "not_found");
    }

    const sql = getDb();
    const rows = await sql`
      SELECT filename, content_type, byte_size, blob_url, blob_pathname,
             (content IS NOT NULL) AS has_database_content
      FROM source_documents
      WHERE id = ${id} AND user_id = ${user.id}
      LIMIT 1
    `;
    const document = rows[0];
    if (!document) throw new ApiError(404, "Document not found.", "not_found");

    const inline = firstQueryValue(req.query?.inline) === "1";
    const blob = await getPrivateBlob(document);
    if (blob) {
      const contentType = responseContentType(document.content_type, blob.blob.contentType);
      setDocumentHeaders(res, {
        contentType,
        filename: document.filename,
        byteSize: Number(blob.blob.size),
        inline
      });
      await pipeline(Readable.fromWeb(blob.stream), res);
      return;
    }

    if (!document.has_database_content) {
      throw new ApiError(404, "Document content is unavailable.", "not_found");
    }
    const contentRows = await sql`
      SELECT content
      FROM source_documents
      WHERE id = ${id} AND user_id = ${user.id}
      LIMIT 1
    `;
    const content = contentBuffer(contentRows[0]?.content);
    if (!content) throw new ApiError(404, "Document content is unavailable.", "not_found");

    const contentType = safeContentType(document.content_type);
    setDocumentHeaders(res, {
      contentType,
      filename: document.filename,
      byteSize: content.length,
      inline
    });
    res.end(content);
  } catch (error) {
    if (res.headersSent) {
      if (typeof res.destroy === "function") res.destroy();
      return;
    }
    handleApiError(res, error, METHODS);
  }
}
