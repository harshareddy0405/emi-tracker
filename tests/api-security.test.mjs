import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.AUTH_COOKIE_SECRET = "test-only-secret-that-is-longer-than-thirty-two-bytes";

const { hashPassword, verifyPassword } = await import("../api/_lib/password.js");
const {
  clearSessionCookie,
  createSessionToken,
  parseCookies,
  sessionCookie,
  verifySessionToken
} = await import("../api/_lib/session.js");
const { dateToMonth, normalizeLoan, normalizeRecord, normalizeSettings } = await import("../api/_lib/validation.js");
const { mapDocumentMetadata } = await import("../api/_lib/mappers.js");
const { ApiError, readJson } = await import("../api/_lib/http.js");
const { fingerprintLoginClient } = await import("../api/_lib/login-rate-limit.js");
const { createLoginHandler } = await import("../api/auth/login.js");
const { default: dataHandler } = await import("../api/data.js");
const { default: meHandler } = await import("../api/auth/me.js");
const { default: documentHandler } = await import("../api/documents/[id].js");

function responseDouble() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = "") { this.body = String(value); }
  };
}

test("scrypt hashes verify without storing plaintext", async () => {
  const password = "correct horse battery staple";
  const hash = await hashPassword(password);
  assert.match(hash, /^scrypt\$/);
  assert.equal(hash.includes(password), false);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("incorrect password", hash), false);
});

test("session tokens are signed, persistent, and use hardened cookies", () => {
  const now = Date.UTC(2026, 7, 8, 6, 0, 0);
  const token = createSessionToken({ id: "00000000-0000-4000-8000-000000000001", sessionVersion: 7 }, now);
  assert.equal(verifySessionToken(token, now + 1000)?.sv, 7);
  assert.equal(verifySessionToken(`${token.slice(0, -1)}x`, now + 1000), null);
  assert.equal(verifySessionToken(token, now + 20 * 365 * 24 * 60 * 60 * 1000)?.sv, 7);

  const cookie = sessionCookie(token);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=315360000/);
  assert.equal(parseCookies(`other=1; ${cookie.split(";")[0]}`).emi_session, token);
  assert.match(clearSessionCookie(), /Max-Age=0/);
});

test("login client fingerprints are stable, canonical, and reveal no address", () => {
  const primary = fingerprintLoginClient({
    headers: {
      "x-vercel-forwarded-for": "203.0.113.8",
      "x-forwarded-for": "198.51.100.9"
    }
  });
  const samePrimary = fingerprintLoginClient({
    headers: {
      "x-vercel-forwarded-for": "203.0.113.8",
      "x-forwarded-for": "192.0.2.4"
    }
  });
  const different = fingerprintLoginClient({
    headers: { "x-vercel-forwarded-for": "203.0.113.9" }
  });
  const expandedIpv6 = fingerprintLoginClient({
    headers: { "x-vercel-forwarded-for": "2001:0db8:0:0:0:0:0:1" }
  });
  const compressedIpv6 = fingerprintLoginClient({
    headers: { "x-vercel-forwarded-for": "2001:db8::1" }
  });

  assert.match(primary, /^[0-9a-f]{64}$/);
  assert.equal(primary, samePrimary);
  assert.notEqual(primary, different);
  assert.equal(expandedIpv6, compressedIpv6);
  assert.equal(primary.includes("203.0.113.8"), false);
});

test("login handler rate limits by client without consulting or locking the owner", async () => {
  let passwordWork = 0;
  let userQueries = 0;
  let failuresRecorded = 0;
  const handler = createLoginHandler({
    database: () => async () => { userQueries += 1; return []; },
    fingerprintClient: () => "b".repeat(64),
    checkRateLimit: async () => 417,
    consumeWork: async () => { passwordWork += 1; },
    verify: async () => { throw new Error("Password verification must not run while blocked."); },
    recordFailure: async () => { failuresRecorded += 1; return 0; },
    clearFailures: async () => {}
  });
  const response = responseDouble();
  await handler({
    method: "POST",
    headers: {},
    body: { username: "owner", password: "not-the-password" }
  }, response);

  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["retry-after"], "417");
  assert.equal(JSON.parse(response.body).code, "login_rate_limited");
  assert.equal(passwordWork, 1);
  assert.equal(userQueries, 0);
  assert.equal(failuresRecorded, 0);
});

test("unknown and incorrect login credentials return the same generic failure", async () => {
  const knownUser = {
    id: "00000000-0000-4000-8000-000000000001",
    username: "owner",
    display_name: "Owner",
    password_hash: "test-hash",
    session_version: 1
  };

  async function attempt(user) {
    let consumed = 0;
    let verified = 0;
    let recorded = 0;
    const sql = async (strings) => strings.join("").includes("FROM users") && user ? [user] : [];
    const handler = createLoginHandler({
      database: () => sql,
      fingerprintClient: () => "c".repeat(64),
      checkRateLimit: async () => 0,
      consumeWork: async () => { consumed += 1; },
      verify: async () => { verified += 1; return false; },
      recordFailure: async () => { recorded += 1; return 0; },
      clearFailures: async () => {}
    });
    const response = responseDouble();
    await handler({
      method: "POST",
      headers: {},
      body: { username: user ? "owner" : "unknown", password: "wrong-password" }
    }, response);
    return { response, consumed, verified, recorded };
  }

  const unknown = await attempt(null);
  const incorrect = await attempt(knownUser);
  assert.equal(unknown.response.statusCode, 401);
  assert.equal(incorrect.response.statusCode, 401);
  assert.equal(unknown.response.body, incorrect.response.body);
  assert.equal(unknown.consumed, 1);
  assert.equal(incorrect.verified, 1);
  assert.equal(unknown.recorded, 1);
  assert.equal(incorrect.recorded, 1);
});

test("successful login clears only its client failure record", async () => {
  const user = {
    id: "00000000-0000-4000-8000-000000000001",
    username: "owner",
    display_name: "Owner",
    password_hash: "test-hash",
    session_version: 3,
    last_login_at: null
  };
  const sql = async (strings) => {
    const query = strings.join("");
    if (query.includes("SELECT id")) return [user];
    if (query.includes("UPDATE users")) return [{ ...user, last_login_at: "2026-08-08T00:00:00.000Z" }];
    throw new Error("Unexpected query in login test.");
  };
  let clearedFingerprint = null;
  let recorded = 0;
  const fingerprint = "d".repeat(64);
  const handler = createLoginHandler({
    database: () => sql,
    fingerprintClient: () => fingerprint,
    checkRateLimit: async () => 0,
    consumeWork: async () => { throw new Error("Dummy password work must not replace a real verification."); },
    verify: async () => true,
    recordFailure: async () => { recorded += 1; return 0; },
    clearFailures: async (_sql, value) => { clearedFingerprint = value; }
  });
  const response = responseDouble();
  await handler({
    method: "POST",
    headers: {},
    body: { username: "owner", password: "correct-password" }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(clearedFingerprint, fingerprint);
  assert.equal(recorded, 0);
  assert.match(response.headers["set-cookie"], /HttpOnly/);
});

test("loan and source-record validation preserves complete detail fields", () => {
  const loan = normalizeLoan({
    id: "custom-test",
    name: "Test facility",
    lender: "Test Bank",
    category: "Personal loan",
    original: 100000,
    outstanding: 80000,
    emi: 5000,
    rate: 10.5,
    dueDay: 5,
    start: "2026-01",
    end: "2027-12",
    baseMonth: "2026-08",
    imported: false,
    accountNumber: "XX1234",
    tenureMonths: 24,
    scheduleEstimated: true
  });
  assert.equal(loan.details.accountNumber, "XX1234");
  assert.equal(loan.details.tenureMonths, 24);
  assert.equal(loan.details.scheduleEstimated, true);

  const record = normalizeRecord({
    sourceFiles: ["statement.pdf"],
    sections: [{ title: "Contract terms", fields: [["Rate", "10.5%"]] }],
    sourceNote: "Imported privately"
  });
  assert.equal(record.sections[0].fields[0][1], "10.5%");
});

test("settings preserve the reported monthly outflow comparison", () => {
  const settings = normalizeSettings({ dark: true, reportedMonthlyOutflow: 85000 }, { monthlyIncome: 120000 });
  assert.equal(settings.theme, "dark");
  assert.equal(settings.reportedMonthlyOutflow, 85000);
});

test("database dates retain their calendar month outside UTC", () => {
  assert.equal(dateToMonth(new Date(2026, 7, 1)), "2026-08");
  assert.equal(dateToMonth("2026-08-01"), "2026-08");
});

test("document metadata exposes only authenticated delivery and safe preview URLs", () => {
  const image = mapDocumentMetadata({
    id: "00000000-0000-4000-8000-000000000001",
    filename: "statement.jpeg",
    content_type: "image/jpeg",
    byte_size: 123,
    content_sha256: "a".repeat(64),
    metadata: {},
    has_content: false,
    blob_pathname: "private/source.jpeg",
    blob_url: "https://private.example.invalid/source.jpeg",
    has_extracted_text: false
  });
  assert.equal(image.hasBlob, true);
  assert.equal(image.hasDatabaseContent, false);
  assert.equal(image.hasContent, true);
  assert.equal(image.storage, "vercel_blob");
  assert.equal(image.contentUrl, `/api/documents/${image.id}`);
  assert.equal(image.previewUrl, `/api/documents/${image.id}?inline=1`);
  assert.equal(Object.hasOwn(image, "blobUrl"), false);
  assert.equal(Object.hasOwn(image, "blobPathname"), false);

  const unsafe = mapDocumentMetadata({
    ...image,
    content_type: "text/html",
    has_content: false,
    blob_pathname: "private/source.html"
  });
  assert.equal(unsafe.previewable, false);
  assert.equal(unsafe.previewUrl, null);
});

test("private API endpoints reject requests without a session", async () => {
  for (const handler of [meHandler, dataHandler, documentHandler]) {
    const response = responseDouble();
    await handler({ method: "GET", headers: {}, query: { id: "00000000-0000-4000-8000-000000000001" } }, response);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.body), {
      error: "Authentication required.",
      code: "unauthorized"
    });
    assert.equal(response.headers["cache-control"], "no-store, max-age=0");
  }
});

test("malformed JSON from the Vercel body helper is a 400 error", async () => {
  const request = {
    headers: {},
    get body() { throw new SyntaxError("malformed"); }
  };
  await assert.rejects(readJson(request), (error) => {
    assert.equal(error instanceof ApiError, true);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_json");
    return true;
  });
});

test("production configuration excludes credentials and private source data", async () => {
  const ignore = await readFile(new URL("../.vercelignore", import.meta.url), "utf8");
  for (const pattern of [".env", ".env.*", "*.pdf", "*.jpeg", "*.jpg", "*.png", "*.zip", "*-seed-*.json", "db/", "scripts/", "tests/"]) {
    assert.equal(ignore.split(/\r?\n/).includes(pattern), true, `Missing Vercel exclusion: ${pattern}`);
  }

  const productionConfig = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  assert.doesNotMatch(productionConfig, /DATABASE_URL|AUTH_COOKIE_SECRET|BLOB_READ_WRITE_TOKEN/i);

  const gitIgnore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  for (const pattern of [".env", ".env.*", "*.pdf", "*.jpeg", "*.jpg", "*.png", "*.zip", "scripts/seed-portfolio.mjs", "scripts/verify-portfolio.mjs"]) {
    assert.equal(gitIgnore.split(/\r?\n/).includes(pattern), true, `Missing Git exclusion: ${pattern}`);
  }
});
