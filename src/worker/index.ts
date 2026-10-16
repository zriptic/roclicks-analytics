import cron from "node-cron";
import { pruneAnalytics } from "../lib/analytics/retention";

/**
 * Nightly cleanup: raw markers, sessions and daily-active rows older than the
 * retention window are deleted (see limits.ts). Run with `npm run worker`.
 */
const schedule = process.env.ANALYTICS_PRUNE_CRON ?? "15 4 * * *";
cron.schedule(schedule, async () => {
  try {
    const r = await pruneAnalytics();
    console.log(`[prune] ${r.games} games: ${r.events} markers, ${r.sessions} sessions, ${r.activeDays} active days, ${r.usageRows} usage rows`);
  } catch (e) {
    console.error("[prune] failed", e);
  }
});
console.log(`[worker] pruning on "${schedule}"`);
