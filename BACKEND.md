# EMI TRACKER backend

The backend is a set of Vercel Node functions backed by Neon Postgres. All portfolio and document access requires the signed `emi_session` cookie.

## Environment

Copy `.env.example` into your local environment and provide real values outside source control:

- `DATABASE_URL`: Neon pooled Postgres connection string.
- `AUTH_COOKIE_SECRET`: at least 32 random bytes. Changing it invalidates every browser session.
- `EMI_ADMIN_USERNAME`, `EMI_ADMIN_PASSWORD`, `EMI_ADMIN_DISPLAY_NAME`: read only by the user-creation script.
- `BLOB_READ_WRITE_TOKEN`: server-only credential for the private Vercel Blob store.
- `BLOB_SOURCE_PATHS`: optional platform-delimited list of local upload inputs. Paths can instead be passed on the command line.

No API response or setup script prints a password, connection string, cookie secret, or password hash.

## Initialize Neon

```bash
npm install
npm run db:migrate
npm run db:create-user
npm run blob:upload -- "/path/to/source/screenshots" "/path/to/source/statements"
```

The migration is transactional and recorded in `schema_migrations`. The user script enforces one owner account, uses Node's `scrypt`, and revokes older sessions whenever the password is replaced.

The Blob upload command runs only on a trusted machine after document metadata exists. It recursively accepts PDF and safe raster-image files, requires an exact filename and SHA-256 match in `source_documents`, uploads to a content-addressed private Blob pathname, and stores only the resulting private pointer in Neon. The content hash and document UUID make `allowOverwrite` safe for idempotent reruns. The command exits unsuccessfully if any input file is unmatched.

## HTTP contract

All responses are JSON unless an authenticated private document is downloaded. Errors use `{ "error": "Readable message", "code": "machine_code" }`.

### Authentication

- `POST /api/auth/login` with `{ "username": "...", "password": "..." }` returns `{ "user": {...} }` and sets an HMAC-signed `HttpOnly; Secure; SameSite=Lax` cookie.
- `POST /api/auth/logout` returns `{ "ok": true }`, revokes the current session version, and clears the cookie.
- `GET /api/auth/me` returns `{ "user": {...} }` or HTTP 401.

The login cookie is persistent for ten years and the signed token has no time-based expiry. It remains revocable because every authenticated request verifies its `session_version` against the user row. Logout and password reset increment that version.

Login failures are limited per network client rather than on the singleton owner account. The request address is canonicalized only in memory and transformed with a domain-separated HMAC keyed by `AUTH_COOKIE_SECRET`; Neon stores only the pseudonymous digest, failure window, and block timestamps. Five failures in a 15-minute window produce a 15-minute client block. Blocked and unknown-user requests still perform scrypt-cost password work, successful login clears that client's row, and raw addresses are never stored, returned, or logged by the application.

### Portfolio bootstrap

`GET /api/data` returns:

```json
{
  "loans": [],
  "records": {},
  "payments": [],
  "settings": {},
  "documents": []
}
```

`records` is the exact loan-ID map used by the entity detail screen:

```json
{
  "loan-id": {
    "sourceFiles": ["statement.pdf"],
    "sections": [{ "title": "Contract terms", "fields": [["Rate", "7.85% p.a."]] }],
    "sourceNote": "..."
  }
}
```

Loan fields used for calculations are normalized into typed columns. Every additional imported field is preserved in `loans.details` and merged back into the returned loan object. The `imported` boolean is returned explicitly.

### Portfolio mutations

`POST /api/data` accepts one of:

```json
{ "action": "upsertLoan", "loan": {}, "record": {} }
{ "action": "deleteLoan", "loanId": "custom-..." }
{ "action": "setPayment", "loanId": "...", "month": "2026-08", "paid": true }
{ "action": "updateSettings", "settings": {} }
```

All writes validate their shape and origin. Loan deletes cascade to related monthly records and payment state.

### Private documents

Bootstrap data contains document metadata only. Available files include authenticated `contentUrl` and storage flags; safe images and PDFs also include `previewUrl`. Raw Blob URLs and pathnames are never returned. `GET /api/documents/:id` verifies ownership, disables caching, streams from private Vercel Blob, and falls back to the private Neon bytea copy during migration or a Blob outage. It serves an attachment by default. `GET /api/documents/:id?inline=1` permits same-origin inline display only for PDF, JPEG, PNG, GIF, and WebP content. Document bytes and extracted text are never included in `/api/data`.

`.vercelignore` excludes the original root-level statements, screenshots, archives, environment files, and seed material. They must not be uploaded as public static assets; imported copies are available only through the authenticated document endpoint.

## Data model

- `users`: singleton owner, scrypt hash, and revocable session version.
- `login_rate_limits`: short-lived per-client failure windows keyed only by an HMAC fingerprint.
- `loans`: normalized calculation fields plus lossless `details` and `record_details` JSON.
- `loan_records`: optional month-level balance/payment snapshots plus additional JSON details.
- `payments`: per-loan, per-month paid state.
- `settings`: income, reported outflow, locale-related preferences, and theme.
- `source_documents`: private metadata, optional Neon binary fallback, private Blob pointers, extracted text, and hashes.
- `loan_source_documents`: private many-to-many provenance links between accounts and source files.

Run the API security checks with `npm run test:api`.
