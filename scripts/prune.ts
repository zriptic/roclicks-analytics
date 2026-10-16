/**
 * Runs the analytics retention prune by hand (the worker runs it nightly).
 *   npm run prune -- --dry-run
 *   npm run prune
 */
import { pruneAnalytics } from "@/lib/analytics/retention";
import { RETENTION_DAYS, STUDIO_RETENTION_DAYS } from "@/lib/analytics/limits";
import { prisma } from "@/lib/db";

const dryRun = process.argv.includes("--dry-run");
console.log(`retention: ${RETENTION_DAYS} days live, ${STUDIO_RETENTION_DAYS} days studio${dryRun ? " (dry run, nothing deleted)" : ""}`);
const result = await pruneAnalytics({ dryRun });
console.log(result);
await prisma.$disconnect();
