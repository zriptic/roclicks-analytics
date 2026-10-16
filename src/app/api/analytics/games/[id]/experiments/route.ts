import { prisma } from "@/lib/db";
import { readEnv } from "@/lib/analytics/limits";
import { ownedGame } from "@/lib/analytics/owner";
import { MAX_RUNNING_TESTS, bumpConfigVersion, parseExperimentInput } from "@/lib/analytics/experiments";

/** Start an A/B test. It reaches servers on their next flush. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { userId, game } = await ownedGame(id);
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!game) return Response.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const env = readEnv(typeof body?.env === "string" ? body.env : null);
  const input = parseExperimentInput(body);
  if (typeof input === "string") return Response.json({ error: input }, { status: 400 });

  const running = await prisma.analyticsExperiment.findMany({
    where: { gameId: id, env, status: "running" },
    select: { key: true },
  });
  if (running.length >= MAX_RUNNING_TESTS) {
    return Response.json({ error: `Up to ${MAX_RUNNING_TESTS} tests can run at once. Stop one first.` }, { status: 400 });
  }
  // Two tests on the same key would fight over the value; nested keys too
  // ("shop" and "shop.price").
  const clash = running.find((r) => r.key === input.key || r.key.startsWith(input.key + ".") || input.key.startsWith(r.key + "."));
  if (clash) return Response.json({ error: `A running test already changes "${clash.key}".` }, { status: 409 });

  const exp = await prisma.analyticsExperiment.create({
    data: { gameId: id, env, name: input.name, key: input.key, variants: input.variants as object[], goal: input.goal },
    select: { id: true },
  });
  await bumpConfigVersion(id, env);
  return Response.json({ ok: true, id: exp.id });
}
