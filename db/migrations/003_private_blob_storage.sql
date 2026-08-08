-- Remove the hash-only index used by an early provenance migration. Different
-- source files can legitimately contain the same bytes, so filename remains
-- part of the document identity.
DROP INDEX IF EXISTS source_documents_user_hash_unique;

CREATE UNIQUE INDEX IF NOT EXISTS source_documents_user_filename_hash_unique
  ON source_documents (user_id, filename, content_sha256)
  WHERE content_sha256 IS NOT NULL;

ALTER TABLE source_documents
  ADD COLUMN IF NOT EXISTS blob_url text,
  ADD COLUMN IF NOT EXISTS blob_pathname text,
  ADD COLUMN IF NOT EXISTS blob_etag text;

CREATE UNIQUE INDEX IF NOT EXISTS source_documents_user_blob_pathname_unique
  ON source_documents (user_id, blob_pathname)
  WHERE blob_pathname IS NOT NULL;
