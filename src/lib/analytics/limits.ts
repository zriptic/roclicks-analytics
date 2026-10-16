import { randomBytes } from "node:crypto";

/**
 * Monthly marker cap per game (set ANALYTICS_EVENTS_PER_MONTH). Sessions, heartbeats and config reads never count against the
 * quota; only markers the game sends with Track() do, so a game over its
 * quota keeps DAU and retention, it just stops recording new markers.
 */
export const FREE_EVENTS_PER_MONTH = Number(
  process.env.ANALYTICS_EVENTS_PER_MONTH ?? 100_000_000,
);
export const MAX_GAMES_PER_USER = Number(process.env.ANALYTICS_MAX_GAMES ?? 100);

/** Per-batch caps. The SDK flushes well under these. */
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_EVENTS_PER_BATCH = 1000;
export const MAX_SESSIONS_PER_BATCH = 500;
export const MAX_VALUE_BYTES = 2048;
export const MAX_CONFIG_BYTES = 256_000;

/**
 * How long raw data is kept. Markers, sessions and daily-active rows older
 * than this are pruned by the worker every night (180 days matches the free
 * tier of the hosted alternatives). Studio playtest data is test noise and
 * goes after 30. Sales are never pruned: they are small and they are the
 * owner's revenue history.
 */
export const RETENTION_DAYS = Number(process.env.ANALYTICS_RETENTION_DAYS ?? 180);
export const STUDIO_RETENTION_DAYS = Number(process.env.ANALYTICS_STUDIO_RETENTION_DAYS ?? 30);
/** Monthly quota counters are kept two years for the usage history. */
export const USAGE_RETENTION_MONTHS = 24;

/** A session with no heartbeat for this long is treated as gone. */
export const LIVE_WINDOW_SECONDS = 120;

export const EVENT_NAME = /^[A-Za-z0-9_ .:/-]{1,64}$/;

export type Env = "prod" | "studio";

export function readEnv(value: string | null | undefined): Env {
  return value === "studio" ? "studio" : "prod";
}

export function newSdkKey(): string {
  return "rca_" + randomBytes(24).toString("base64url");
}

export function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/**
 * Share of the Robux price the game owner keeps, per kind of sale. Roblox
 * keeps the rest (the "30% cut"). Avatar items sold inside a game pay the
 * game owner a 40% commission (the item's creator gets 30%, Roblox 30%).
 * Local-currency subscriptions pay 100% after the first month; the SDK can't
 * tell a renewal from a first month, so subscriptions use 70% throughout.
 */
export const OWNER_SHARE: Record<string, number> = {
  product: 0.7,
  pass: 0.7,
  private_server: 0.7,
  subscription: 0.7,
  avatar_item: 0.4,
  other: 0.7,
};
export const PURCHASE_KINDS = Object.keys(OWNER_SHARE);

export const DEVEX_RATES = [
  { rate: 0.0038, label: "Standard DevEx rate ($0.0038)" },
  { rate: 0.0054, label: "Eligible US 18+ sales ($0.0054)" },
  { rate: 0.0035, label: "Pre Sep 2025 balance ($0.0035)" },
] as const;
export const DEFAULT_DEVEX_RATE = 0.0038;

export const MAX_PURCHASES_PER_BATCH = 500;
export const MAX_PURCHASE_ROBUX = 10_000_000;
