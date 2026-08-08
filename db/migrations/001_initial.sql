CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key smallint NOT NULL DEFAULT 1 UNIQUE CHECK (singleton_key = 1),
  username varchar(80) NOT NULL UNIQUE CHECK (username = lower(username)),
  display_name varchar(120) NOT NULL,
  password_hash text NOT NULL,
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0),
  failed_login_attempts integer NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename varchar(255) NOT NULL,
  content_type varchar(120) NOT NULL DEFAULT 'application/octet-stream',
  byte_size bigint NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  content_sha256 char(64),
  source_date date,
  content bytea,
  extracted_text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (content IS NULL OR octet_length(content) = byte_size)
);

CREATE TABLE IF NOT EXISTS loans (
  id varchar(128) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  lender varchar(160) NOT NULL,
  category varchar(80) NOT NULL,
  repayment_type varchar(32) NOT NULL DEFAULT 'amortizing'
    CHECK (repayment_type IN ('amortizing', 'interest_only')),
  original_principal numeric(16,2) NOT NULL DEFAULT 0 CHECK (original_principal >= 0),
  outstanding_principal numeric(16,2) NOT NULL DEFAULT 0 CHECK (outstanding_principal >= 0),
  monthly_payment numeric(16,2) NOT NULL CHECK (monthly_payment >= 0),
  annual_interest_rate numeric(8,4) NOT NULL DEFAULT 0
    CHECK (annual_interest_rate >= 0 AND annual_interest_rate <= 100),
  fixed_monthly_interest numeric(16,2) CHECK (fixed_monthly_interest >= 0),
  due_day smallint NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  start_month date NOT NULL,
  end_month date NOT NULL,
  base_month date NOT NULL,
  paid_through date,
  auto_pay boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  source_label varchar(255),
  note text,
  imported boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  record_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  FOREIGN KEY (source_document_id)
    REFERENCES source_documents(id) ON DELETE SET NULL,
  CHECK (date_trunc('month', start_month)::date = start_month),
  CHECK (date_trunc('month', end_month)::date = end_month),
  CHECK (date_trunc('month', base_month)::date = base_month),
  CHECK (paid_through IS NULL OR date_trunc('month', paid_through)::date = paid_through),
  CHECK (end_month >= start_month)
);

CREATE TABLE IF NOT EXISTS loan_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loan_id varchar(128) NOT NULL,
  period date NOT NULL,
  opening_balance numeric(16,2) NOT NULL DEFAULT 0 CHECK (opening_balance >= 0),
  payment numeric(16,2) NOT NULL DEFAULT 0 CHECK (payment >= 0),
  principal numeric(16,2) NOT NULL DEFAULT 0 CHECK (principal >= 0),
  interest numeric(16,2) NOT NULL DEFAULT 0 CHECK (interest >= 0),
  closing_balance numeric(16,2) NOT NULL DEFAULT 0 CHECK (closing_balance >= 0),
  status varchar(24) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'paid', 'overdue', 'skipped', 'matured')),
  is_estimated boolean NOT NULL DEFAULT true,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_document_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, loan_id, period),
  FOREIGN KEY (user_id, loan_id) REFERENCES loans(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id)
    REFERENCES source_documents(id) ON DELETE SET NULL,
  CHECK (date_trunc('month', period)::date = period),
  CHECK (principal + interest <= payment + 0.01)
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loan_id varchar(128) NOT NULL,
  period date NOT NULL,
  paid boolean NOT NULL DEFAULT false,
  amount numeric(16,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  due_date date,
  paid_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, loan_id, period),
  FOREIGN KEY (user_id, loan_id) REFERENCES loans(user_id, id) ON DELETE CASCADE,
  CHECK (date_trunc('month', period)::date = period),
  CHECK (paid OR paid_at IS NULL)
);

CREATE TABLE IF NOT EXISTS settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_income numeric(16,2) NOT NULL DEFAULT 0 CHECK (monthly_income >= 0),
  reported_monthly_outflow numeric(16,2) NOT NULL DEFAULT 0 CHECK (reported_monthly_outflow >= 0),
  currency char(3) NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  timezone varchar(80) NOT NULL DEFAULT 'Asia/Kolkata',
  theme varchar(16) NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark', 'system')),
  monthly_roll boolean NOT NULL DEFAULT true,
  reminders boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loans_user_active_idx ON loans (user_id, active, end_month);
CREATE INDEX IF NOT EXISTS loan_records_user_period_idx ON loan_records (user_id, period DESC);
CREATE INDEX IF NOT EXISTS payments_user_period_idx ON payments (user_id, period DESC);
CREATE INDEX IF NOT EXISTS source_documents_user_created_idx ON source_documents (user_id, created_at DESC);

COMMENT ON COLUMN source_documents.content IS
  'Private document bytes. API bootstrap responses expose metadata only.';
