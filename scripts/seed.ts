/**
 * Local dev only: a demo game with 30 days of simulated players, pushed
 * through the real ingest code (parseBatch + writeBatch) with historical
 * clocks, so the dashboard's DAU, retention and marker charts have data.
 *
 *   npm run seed            (or: npm run seed -- --fresh)
 *
 */
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/db";
import { OWNER_ID } from "../src/auth";
import { parseBatch, writeBatch } from "../src/lib/analytics/ingest";
import { newSdkKey } from "../src/lib/analytics/limits";
import { assignVariant } from "../src/lib/analytics/experiments";

if (process.env.NODE_ENV === "production" || !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("analytics-seed only runs against a local database");
}

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");

// Deterministic so reruns look the same.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

async function main() {
  const owner = { id: OWNER_ID };

  let game = await prisma.analyticsGame.findFirst({ where: { ownerId: owner.id, name: "Demo Obby" } });
  if (game && fresh) {
    await prisma.analyticsGame.delete({ where: { id: game.id } });
    game = null;
  }
  if (game) {
    console.log(`Demo game already seeded (pass --fresh to redo).\nGAME_ID=${game.id}\nSDK_KEY=${game.sdkKey}`);
    return;
  }
  game = await prisma.analyticsGame.create({
    data: { ownerId: owner.id, name: "Demo Obby", sdkKey: newSdkKey() },
  });

  await prisma.analyticsConfig.create({
    data: {
      gameId: game.id,
      env: "prod",
      version: 1,
      values: { starterCoins: 50, xpMultiplier: 1, shop: { swordPrice: 120, saleActive: false } },
    },
  });

  const DAY = 86_400_000;
  const nowMs = Date.now();
  const todayStart = Math.floor(nowMs / DAY) * DAY;

  // An A/B test that started 13 days ago. Variant B (150 starter coins)
  // really is better here: those players come back a bit more and level up
  // more, so the results page has a winner to show.
  const TEST_DAYS = 13;
  const variants = [
    { name: "A", value: 50, weight: 1 },
    { name: "B", value: 150, weight: 1 },
  ];
  const test = await prisma.analyticsExperiment.create({
    data: {
      gameId: game.id,
      env: "prod",
      name: "Starter coins 50 vs 150",
      key: "starterCoins",
      variants,
      goal: "LevelUp",
      startedAt: new Date(todayStart - TEST_DAYS * DAY),
    },
  });
  const inB = (uid: number) => assignVariant(test.id, uid, variants) === "B";
  const exposed = new Set<number>();
  let nextUserId = 1_000_000;
  // Each player has a "stickiness": the daily chance they come back.
  const players: { id: number; stick: number; joined: number }[] = [];

  for (let d = 29; d >= 0; d--) {
    const dayStart = todayStart - d * DAY;
    const dayEnd = d === 0 ? nowMs - 60_000 : dayStart + DAY - 1;
    const span = dayEnd - dayStart;

    // Growing game with a weekend bump.
    const weekday = new Date(dayStart).getUTCDay();
    const newCount = Math.round((40 + (29 - d) * 3) * (weekday === 0 || weekday === 6 ? 1.4 : 1) * (0.8 + rand() * 0.4) * (span / DAY));
    for (let i = 0; i < newCount; i++) players.push({ id: nextUserId++, stick: 0.15 + rand() * 0.5, joined: d });

    const boost = (p: { id: number }) => (d <= TEST_DAYS && exposed.has(p.id) && inB(p.id) ? 1.3 : 1);
    const today = players.filter((p) => p.joined === d || (p.joined > d && rand() < p.stick * boost(p) * Math.pow(0.93, p.joined - d)));

    const started: object[] = [];
    const ended: object[] = [];
    const events: object[] = [];
    const purchases: object[] = [];
    const exposures: object[] = [];
    for (const p of today) {
      const sessions = rand() < 0.3 ? 2 : 1;
      for (let s = 0; s < sessions; s++) {
        const id = randomUUID();
        const t0 = dayStart + rand() * span * 0.9;
        const len = (3 + rand() * 25) * 60_000;
        const t1 = Math.min(t0 + len, dayEnd);
        started.push({ id, userId: p.id, t: t0 / 1000, country: pick(["US", "US", "US", "GB", "BR", "PH", "CA", "DE"]) });
        ended.push({ id, t: t1 / 1000 });
        if (d <= TEST_DAYS && !exposed.has(p.id)) {
          exposed.add(p.id);
          exposures.push({ e: test.id, userId: p.id, t: t0 / 1000 + 5 });
        }
        const at = (f: number) => (t0 + (t1 - t0) * f) / 1000;
        if (p.joined === d && s === 0) {
          const steps = 1 + Math.floor(rand() * 5);
          for (let k = 1; k <= steps; k++) events.push({ name: "TutorialStep", t: at(k / 10), userId: p.id, sessionId: id, value: { step: k } });
        }
        if (rand() < 0.6) events.push({ name: "ShopOpened", t: at(0.5), userId: p.id, sessionId: id });
        if (rand() < 0.07) {
          // Developer products, sometimes at a regional price below list.
          const [itemId, name, list] = pick([[5001, "500 Coins", 49], [5002, "2,500 Coins", 199], [5003, "Revive", 25]] as const);
          purchases.push({ id: `receipt:${randomUUID()}`, userId: p.id, sessionId: id, kind: "product", itemId, name, robux: rand() < 0.2 ? Math.round(list * 0.8) : list, t: at(0.6) });
        }
        if (p.joined === d && s === 0 && rand() < 0.03)
          purchases.push({ id: randomUUID(), userId: p.id, sessionId: id, kind: "pass", itemId: 7001, name: "VIP", robux: 199, t: at(0.3) });
        if (rand() < 0.01)
          purchases.push({ id: randomUUID(), userId: p.id, sessionId: id, kind: "avatar_item", name: "Obby Crown", robux: 75, t: at(0.8) });
        const levels = Math.floor(rand() * (boost(p) > 1 ? 5 : 4));
        for (let k = 0; k < levels; k++) events.push({ name: "LevelUp", t: at(0.2 + k * 0.2), userId: p.id, sessionId: id, pos: [rand() * 200 - 100, 5, rand() * 200 - 100] });
        if (rand() < 0.35) {
          // Deaths pile up at the hard stages (4, 7 and 11), scattered around
          // each stage's jump, so the heatmap has real hotspots to show.
          const hard = [4, 7, 11];
          const stage = rand() < 0.7 ? hard[Math.floor(rand() * hard.length)] : 1 + Math.floor(rand() * 12);
          const gauss = () => (rand() + rand() + rand() - 1.5) * 4;
          const pos = [-110 + stage * 18 + gauss(), 4 + stage * 3, Math.sin(stage) * 30 + gauss()];
          events.push({ name: "Died", t: at(0.7), userId: p.id, sessionId: id, value: { stage }, pos });
        }
      }
    }
    events.push({ name: "ServerStarted", t: (dayStart + 1000) / 1000 });

    // Sessions first (they create the player rows), then their ends, then
    // markers, each chunked to the ingest limits.
    for (let i = 0; i < started.length; i += 500)
      await writeBatch(game.id, "prod", parseBatch({ serverId: "seed", started: started.slice(i, i + 500) }, dayEnd), dayEnd);
    for (let i = 0; i < ended.length; i += 500)
      await writeBatch(game.id, "prod", parseBatch({ serverId: "seed", ended: ended.slice(i, i + 500) }, dayEnd), dayEnd);
    for (let i = 0; i < purchases.length; i += 500)
      await writeBatch(game.id, "prod", parseBatch({ serverId: "seed", purchases: purchases.slice(i, i + 500) }, dayEnd), dayEnd);
    for (let i = 0; i < exposures.length; i += 1000)
      await writeBatch(game.id, "prod", parseBatch({ serverId: "seed", exposures: exposures.slice(i, i + 1000) }, dayEnd), dayEnd);
    for (let i = 0; i < events.length; i += 1000)
      await writeBatch(game.id, "prod", parseBatch({ serverId: "seed", events: events.slice(i, i + 1000) }, dayEnd), dayEnd);

    process.stdout.write(`day -${d}: ${today.length} players, ${events.length} markers, ${purchases.length} sales\n`);
  }

  console.log(`\nSeeded.\nGAME_ID=${game.id}\nSDK_KEY=${game.sdkKey}`);
}

main().finally(() => prisma.$disconnect());
