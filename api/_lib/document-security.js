const INLINE_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export function safeContentType(value) {
  const contentType = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MIME_TYPE_PATTERN.test(contentType) ? contentType : "application/octet-stream";
}

export function isPreviewableContentType(value) {
  return INLINE_CONTENT_TYPES.has(safeContentType(value));
}

export function safeDownloadFilename(value) {
  const filename = String(value || "document")
    .replace(/[^\x20-\x7e]|[\r\n"\\/]/g, "_")
    .slice(0, 180);
  return filename || "document";
}
