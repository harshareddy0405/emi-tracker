CREATE UNIQUE INDEX IF NOT EXISTS source_documents_user_filename_hash_unique
  ON source_documents (user_id, filename, content_sha256)
  WHERE content_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS loan_source_documents (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loan_id varchar(128) NOT NULL,
  document_id uuid NOT NULL,
  role varchar(32) NOT NULL DEFAULT 'evidence'
    CHECK (role IN ('primary', 'evidence', 'supporting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, loan_id, document_id),
  FOREIGN KEY (user_id, loan_id)
    REFERENCES loans(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, document_id)
    REFERENCES source_documents(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS loan_source_documents_document_idx
  ON loan_source_documents (user_id, document_id);
