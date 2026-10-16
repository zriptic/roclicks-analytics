import { prisma } from "@/lib/db";
import { readEnv } from "@/lib/analytics/limits";
import { ownedGame } from "@/lib/analytics/owner";
import { bumpConfigVersion, setPath, type Variant } from "@/lib/analytics/experiments";

type Params = { params: Promise<{ id: string; expId: string }> };

async function load({ params }: Params) {
  const { id, expId } = await params;
  const { userId, game } = await ownedGame(id);
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!game) return Response.json({ error: "not found" }, { status: 404 });
  const exp = await prisma.analyticsExperiment.findFirst({ where: { id: expId, gameId: id } });
  if (!exp) return Response.json({ error: "not found" }, { status: 404 });
  return exp;
}

/**
 * Stop a test: { keep?: "<variant name>" }. With `keep`, that variant's value
 * is written into the config so every player gets it from now on. Without
 * it, players go back to whatever the config already says.
 */
export async function PATCH(request: Request, ctx: Params) {
  const exp = await load(ctx);
  if (exp instanceof Response) return exp;
  if (exp.status !== "running") return Response.json({ error: "This test has already stopped." }, { status: 409 });

  const body = (await request.json().catch(() => null)) as { keep?: unknown } | null;
  const keep = typeof body?.keep === "string" ? (exp.variants as Variant[]).find((v) => v.name === body.keep) : undefined;
  if (body?.keep !== undefined && body.keep !== null && !keep) {
    return Response.json({ error: "That variant isn't part of this test." }, { status: 400 });
  }
  const env = readEnv(exp.env);

  await prisma.$transaction(async (tx) => {
    const stopped = await tx.analyticsExperiment.updateMany({
      where: { id: exp.id, status: "running" },
      data: { status: "stopped", stoppedAt: new Date(), winner: keep?.name ?? null },
    });
    if (!stopped.count || !keep) return;
    const config = await tx.analyticsConfig.findUnique({ where: { gameId_env: { gameId: exp.gameId, env } } });
    const values = setPath((config?.values as Record<string, unknown>) ?? {}, exp.key, keep.value) as object;
    await tx.analyticsConfig.upsert({
      where: { gameId_env: { gameId: exp.gameId, env } },
      create: { gameId: exp.gameId, env, values, version: 1 },
      update: { values },
    });
  });
  // One bump covers both the stop and the kept value.
  await bumpConfigVersion(exp.gameId, env);
  return Response.json({ ok: true });
}

/** Delete a test and its results. */
export async function DELETE(_request: Request, ctx: Params) {
  const exp = await load(ctx);
  if (exp instanceof Response) return exp;
  await prisma.analyticsExperiment.delete({ where: { id: exp.id } });
  if (exp.status === "running") await bumpConfigVersion(exp.gameId, readEnv(exp.env));
  return Response.json({ ok: true });
}
