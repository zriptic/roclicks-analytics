import { prisma } from "@/lib/db";
import {
  RETENTION_DAYS,
  STUDIO_RETENTION_DAYS,
  USAGE_RETENTION_MONTHS,
  monthKey,
  type Env,
} from "./limits";

/**
 * Deletes in chunks so one prune never holds a long lock or blows up the WAL
 * on a game with millions of markers. Every delete is per game and env, so it
 * runs on the (gameId, env, ...) indexes instead of scanning whole tables.
 */
const CHUNK = 20_000;

export type PruneResult = {
  games: number;
  events: number;
  sessions: number;
  activeDays: number;
  usageRows: number;
};

function cutoffFor(env: Env, now: Date): Date {
  const days = env === "studio" ? STUDIO_RETENTION_DAYS : RETENTION_DAYS;
  return new Date(now.getTime() - days * 86_400_000);
}

async function deleteInChunks(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await run();
    total += n;
    if (n < CHUNK) return total;
  }
}

/**
 * Removes analytics data older than the retention window. Safe to run any
 * time and as often as you like; `dryRun` counts instead of deleting.
 */
export async function pruneAnalytics({
  now = new Date(),
  dryRun = false,
}: { now?: Date; dryRun?: boolean } = {}): Promise<PruneResult> {
  const games = await prisma.analyticsGame.findMany({ select: { id: true } });
  const result: PruneResult = { games: games.length, events: 0, sessions: 0, activeDays: 0, usageRows: 0 };

  for (const { id: gameId } of games) {
    for (const env of ["prod", "studio"] as const) {
      const cutoff = cutoffFor(env, now);

      if (dryRun) {
        const [events, sessions, activeDays] = await Promise.all([
          prisma.analyticsEvent.count({ where: { gameId, env, at: { lt: cutoff } } }),
          prisma.analyticsSession.count({
            where: { gameId, env, startedAt: { lt: cutoff }, lastSeenAt: { lt: cutoff } },
          }),
          prisma.analyticsActiveDay.count({ where: { gameId, env, day: { lt: cutoff } } }),
        ]);
        result.events += events;
        result.sessions += sessions;
        result.activeDays += activeDays;
        continue;
      }

      result.events += await deleteInChunks(() =>
        prisma.$executeRaw`
          DELETE FROM "AnalyticsEvent" WHERE id IN (
            SELECT id FROM "AnalyticsEvent"
            WHERE "gameId" = ${gameId} AND env = ${env} AND at < ${cutoff}
            LIMIT ${CHUNK}
          )`,
      );
      // A session still being heartbeated (lastSeenAt inside the window) is
      // kept even if it started long ago.
      result.sessions += await deleteInChunks(() =>
        prisma.$executeRaw`
          DELETE FROM "AnalyticsSession" WHERE id IN (
            SELECT id FROM "AnalyticsSession"
            WHERE "gameId" = ${gameId} AND env = ${env}
              AND "startedAt" < ${cutoff} AND "lastSeenAt" < ${cutoff}
            LIMIT ${CHUNK}
          )`,
      );
      result.activeDays += await deleteInChunks(() =>
        prisma.$executeRaw`
          DELETE FROM "AnalyticsActiveDay" WHERE ctid IN (
            SELECT ctid FROM "AnalyticsActiveDay"
            WHERE "gameId" = ${gameId} AND env = ${env} AND day < ${cutoff}::date
            LIMIT ${CHUNK}
          )`,
      );
    }
  }

  // Usage rows are keyed "YYYY-MM", so string comparison is date order.
  const oldestMonth = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - USAGE_RETENTION_MONTHS, 1)));
  if (dryRun) {
    result.usageRows = await prisma.analyticsUsage.count({ where: { month: { lt: oldestMonth } } });
  } else {
    result.usageRows = (await prisma.analyticsUsage.deleteMany({ where: { month: { lt: oldestMonth } } })).count;
  }

  return result;
}
