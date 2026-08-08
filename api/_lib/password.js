import { promisify } from "node:util";
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

const scrypt = promisify(nodeScrypt);
const KEY_LENGTH = 64;
const DEFAULT_COST = Object.freeze({ N: 32768, r: 8, p: 1 });
const HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function assertCost(N, r, p) {
  if (N < 16384 || N > 131072 || (N & (N - 1)) !== 0 || r < 8 || r > 32 || p < 1 || p > 4) {
    throw new Error("Unsupported password hash parameters.");
  }
}

async function derive(password, salt, { N, r, p }) {
  assertCost(N, r, p);
  return Buffer.from(await scrypt(password, salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: Math.max(64 * 1024 * 1024, 256 * N * r)
  }));
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new Error("Password must be between 12 and 1024 characters.");
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt, DEFAULT_COST);
  return `scrypt$${DEFAULT_COST.N}$${DEFAULT_COST.r}$${DEFAULT_COST.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password, encodedHash) {
  if (typeof password !== "string" || password.length > 1024 || typeof encodedHash !== "string") return false;
  const match = HASH_PATTERN.exec(encodedHash);
  if (!match) return false;

  try {
    const [, NText, rText, pText, saltText, keyText] = match;
    const expected = Buffer.from(keyText, "base64url");
    const salt = Buffer.from(saltText, "base64url");
    if (expected.length !== KEY_LENGTH || salt.length < 16 || salt.length > 64) return false;
    const actual = await derive(password, salt, {
      N: Number(NText),
      r: Number(rText),
      p: Number(pText)
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function consumePasswordWork(password) {
  const safePassword = typeof password === "string" && password.length <= 1024 ? password : "invalid-password";
  await derive(safePassword, Buffer.alloc(16), DEFAULT_COST);
}
