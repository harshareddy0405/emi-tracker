import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { put } from "@vercel/blob";
import ws from "ws";

const SUPPORTED_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".pdf", ".png", ".webp"]);
const CONTENT_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

const connectionString = process.env.DATABASE_URL;
const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
if (!connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
  throw new Error("DATABASE_URL is required and must be a Postgres connection string.");
}
if (!blobToken || blobToken === "CHANGE_ME") {
  throw new Error("BLOB_READ_WRITE_TOKEN is required.");
}

function configuredPaths() {
  const commandLinePaths = process.argv.slice(2).filter(Boolean);
  if (commandLinePaths.length) return commandLinePaths;
  return String(process.env.BLOB_SOURCE_PATHS || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function collectFiles(entryPath, files) {
  const resolved = await realpath(path.resolve(entryPath));
  const info = await stat(resolved);
  if (info.isFile()) {
    if (SUPPORTED_EXTENSIONS.has(path.extname(resolved).toLowerCase())) files.add(resolved);
    return;
  }
  if (!info.isDirectory()) return;

  const entries = await readdir(resolved, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const childPath = path.join(resolved, entry.name);
    if (entry.isDirectory()) await collectFiles(childPath, files);
    else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.add(childPath);
    }
  }
}

function pathnameFilename(filename) {
  const extension = path.extname(filename).toLowerCase();
  const stem = path.basename(filename, path.extname(filename))
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return `${stem || "document"}${extension}`;
}

async function resolveOwner(client) {
  const configuredUsername = process.env.EMI_ADMIN_USERNAME?.trim().toLowerCase();
  const result = configuredUsername
    ? await client.query("SELECT id FROM users WHERE username = $1 LIMIT 1", [configuredUsername])
    : await client.query("SELECT id FROM users ORDER BY created_at ASC LIMIT 2");
  if (result.rows.length !== 1) {
    throw new Error(configuredUsername ? "The configured owner account was not found." : "Exactly one owner account is required.");
  }
  return result.rows[0].id;
}

async function matchingDocument(client, userId, filename, sha256) {
  const result = await client.query(
    `SELECT id, content_type
       FROM source_documents
      WHERE user_id = $1 AND filename = $2 AND content_sha256 = $3
      LIMIT 2`,
    [userId, filename, sha256]
  );
  return result.rows.length === 1 ? result.rows[0] : null;
}

async function uploadDocument(client, userId, filePath) {
  const bytes = await readFile(filePath);
  const filename = path.basename(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const document = await matchingDocument(client, userId, filename, sha256);
  if (!document) return false;

  // The document UUID and full content hash make this pathname immutable for
  // practical purposes. allowOverwrite therefore only replaces identical bytes.
  const pathname = `emi-tracker/source-documents/${document.id}/${sha256}/${pathnameFilename(filename)}`;
  const storedType = String(document.content_type || "").trim().toLowerCase();
  const contentType = MIME_TYPE_PATTERN.test(storedType) && storedType !== "application/octet-stream"
    ? storedType
    : CONTENT_TYPES.get(path.extname(filename).toLowerCase()) || "application/octet-stream";

  let blob;
  try {
    blob = await put(pathname, bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType,
      token: blobToken
    });
  } catch {
    throw new Error(`Private Blob upload failed for ${filename}.`);
  }

  const result = await client.query(
    `UPDATE source_documents
        SET blob_url = $1,
            blob_pathname = $2,
            blob_etag = $3,
            updated_at = now()
      WHERE id = $4
        AND user_id = $5
        AND filename = $6
        AND content_sha256 = $7
      RETURNING id`,
    [blob.url, blob.pathname, blob.etag, document.id, userId, filename, sha256]
  );
  if (result.rows.length !== 1) {
    throw new Error(`Database metadata update failed for ${filename}.`);
  }
  return true;
}

const requestedPaths = configuredPaths();
if (!requestedPaths.length) {
  throw new Error("Provide file or directory paths, or set BLOB_SOURCE_PATHS.");
}

const files = new Set();
for (const entryPath of requestedPaths) await collectFiles(entryPath, files);
if (!files.size) throw new Error("No supported image or PDF files were found.");

neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString });
const client = await pool.connect();

let uploaded = 0;
let unmatched = 0;
try {
  const userId = await resolveOwner(client);
  for (const filePath of [...files].sort()) {
    if (await uploadDocument(client, userId, filePath)) uploaded += 1;
    else unmatched += 1;
  }
} finally {
  client.release();
  await pool.end();
}

process.stdout.write(`Private Blob upload complete: ${uploaded} uploaded, ${unmatched} unmatched.\n`);
if (unmatched) {
  throw new Error("Some files did not match source_documents by exact filename and SHA-256 hash.");
}
