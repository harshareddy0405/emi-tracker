import { neon } from "@neondatabase/serverless";

let sqlClient;

export function getDb() {
  if (sqlClient) return sqlClient;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured.");
  if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) throw new Error("DATABASE_URL is invalid.");
  sqlClient = neon(connectionString);
  return sqlClient;
}
