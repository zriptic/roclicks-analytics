import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * A self-hosted install has one owner. Signing in with ADMIN_PASSWORD sets a
 * cookie holding an HMAC made with AUTH_SECRET; nothing is stored server side.
 * Every game belongs to the owner id below.
 */
export const OWNER_ID = "owner";
export const COOKIE = "rca_session";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error("Set AUTH_SECRET to a random string of 16+ characters (see .env.example).");
  return s;
}

export function sessionToken(): string {
  return createHmac("sha256", secret()).update(`${OWNER_ID}:${process.env.ADMIN_PASSWORD ?? ""}`).digest("base64url");
}

export function passwordMatches(input: string): boolean {
  const want = process.env.ADMIN_PASSWORD;
  if (!want) throw new Error("Set ADMIN_PASSWORD (see .env.example).");
  const a = Buffer.from(createHmac("sha256", secret()).update(input).digest());
  const b = Buffer.from(createHmac("sha256", secret()).update(want).digest());
  return timingSafeEqual(a, b);
}

/** Same shape the RoClicks site's auth() returns, so the dashboard code is shared. */
export async function auth(): Promise<{ user: { id: string } } | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const want = Buffer.from(sessionToken());
  const got = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want) ? { user: { id: OWNER_ID } } : null;
}
