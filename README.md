# EMI TRACKER

A mobile-first finance dashboard for monthly commitments, interest, payment status, account details, and authenticated source-document review.

## Architecture

- Static responsive frontend deployed on Vercel
- Vercel Node functions under `api/`
- Neon Postgres for account, loan, payment, settings, and document metadata
- Private Vercel Blob for source images and statements
- Scrypt password hashing and a signed, HttpOnly session cookie

The repository contains application code only. Portfolio records, credentials, source-file names, document hashes, screenshots, and statements are not committed.

## Local development

Install dependencies, configure the variables described in `.env.example`, initialize the schema, and run with Vercel's local runtime:

```bash
npm install
npm run db:migrate
npx vercel dev
```

The document API requires authentication and returns `Cache-Control: private, no-store`. The service worker deliberately bypasses every `/api/*` request.

## Tests

```bash
npm run test:api
```

See `BACKEND.md` for the API contract and security model.
