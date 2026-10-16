import { prisma } from "@/lib/db";
import type { Env } from "./limits";

export async function readConfig(gameId: string, env: Env) {
  const row = await prisma.analyticsConfig.findUnique({
    where: { gameId_env: { gameId, env } },
    select: { version: true, values: true, updatedAt: true },
  });
  return row ?? { version: 0, values: {}, updatedAt: null };
}

/** Current config version per env, so ingest can tell servers to refetch. */
export async function configVersion(gameId: string, env: Env): Promise<number> {
  const row = await prisma.analyticsConfig.findUnique({
    where: { gameId_env: { gameId, env } },
    select: { version: true },
  });
  return row?.version ?? 0;
}
