import { gameFromRequest } from "@/lib/analytics/sdkAuth";
import { readConfig } from "@/lib/analytics/config";
import { runningExperiments } from "@/lib/analytics/experiments";

/**
 * The game's remote config for the key's env ("prod" unless x-rc-env:
 * studio), plus its running A/B tests. Older SDKs ignore `experiments` and
 * keep reading the plain values.
 */
export async function GET(request: Request) {
  const who = await gameFromRequest(request);
  if (who instanceof Response) return who;
  const [{ version, values }, experiments] = await Promise.all([
    readConfig(who.gameId, who.env),
    runningExperiments(who.gameId, who.env),
  ]);
  return Response.json({ version, values, experiments });
}
