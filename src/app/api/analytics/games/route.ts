import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { MAX_GAMES_PER_USER, newSdkKey } from "@/lib/analytics/limits";
import { invalidateSdkKeys } from "@/lib/analytics/sdkAuth";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) return Response.json({ error: "Give the game a name." }, { status: 400 });

  const count = await prisma.analyticsGame.count({ where: { ownerId: session.user.id } });
  if (count >= MAX_GAMES_PER_USER) {
    return Response.json({ error: `You can track up to ${MAX_GAMES_PER_USER} games.` }, { status: 400 });
  }

  const game = await prisma.analyticsGame.create({
    data: { ownerId: session.user.id, name, sdkKey: newSdkKey() },
    select: { id: true },
  });
  invalidateSdkKeys();
  return Response.json(game);
}
