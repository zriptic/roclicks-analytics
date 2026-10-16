import { prisma } from "@/lib/db";
import { newSdkKey } from "@/lib/analytics/limits";
import { ownedGame } from "@/lib/analytics/owner";
import { invalidateSdkKeys } from "@/lib/analytics/sdkAuth";

/** { name } renames; { rotateKey: true } issues a new SDK key; { devexRate } sets the USD estimate rate. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { userId, game } = await ownedGame(id);
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!game) return Response.json({ error: "not found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as
    | { name?: unknown; rotateKey?: unknown; devexRate?: unknown }
    | null;
  const data: { name?: string; sdkKey?: string; devexRate?: number } = {};
  if (typeof body?.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 60);
  if (body?.rotateKey === true) data.sdkKey = newSdkKey();
  if (typeof body?.devexRate === "number" && body.devexRate > 0 && body.devexRate < 0.1) data.devexRate = body.devexRate;
  if (!Object.keys(data).length) return Response.json({ error: "nothing to change" }, { status: 400 });

  const updated = await prisma.analyticsGame.update({
    where: { id },
    data,
    select: { name: true, sdkKey: true, devexRate: true },
  });
  if (data.sdkKey) invalidateSdkKeys();
  return Response.json(updated);
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { userId, game } = await ownedGame(id);
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!game) return Response.json({ error: "not found" }, { status: 404 });
  await prisma.analyticsGame.delete({ where: { id } });
  invalidateSdkKeys();
  return Response.json({ ok: true });
}
