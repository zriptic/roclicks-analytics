import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/** The signed-in user's game, or null if it's missing or someone else's. */
export async function ownedGame(gameId: string) {
  const session = await auth();
  if (!session?.user) return { userId: null, game: null };
  const game = await prisma.analyticsGame.findFirst({
    where: { id: gameId, ownerId: session.user.id },
  });
  return { userId: session.user.id, game };
}
