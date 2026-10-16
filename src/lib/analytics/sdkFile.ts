import { readFile } from "node:fs/promises";
import path from "node:path";

export const SDK_FILE = path.join(process.cwd(), "content/analytics-sdk/RoClicksAnalytics.luau");
/** Optional LocalScript that reports the player's device type. */
export const CLIENT_FILE = path.join(process.cwd(), "content/analytics-sdk/RoClicksAnalyticsClient.client.luau");

/**
 * The SDK ships pointing at roclicks.gg. A self-hosted copy rewrites that to
 * this server, so Setup() works without a `url` option.
 */
export async function sdkSource(file: "sdk" | "client" = "sdk", origin?: string): Promise<string> {
  const text = await readFile(file === "client" ? CLIENT_FILE : SDK_FILE, "utf8");
  const base = process.env.PUBLIC_URL?.replace(/\/$/, "") || origin;
  return base ? text.replace("https://roclicks.gg/api/a/v1", `${base}/api/a/v1`) : text;
}

/** A script as a one-instance model file you can drag into Studio. */
export function asRbxmx(source: string, className = "ModuleScript", name = "RoClicksAnalytics"): string {
  // CDATA can't contain "]]>", which Luau long strings can; split it across sections.
  const cdata = source.replaceAll("]]>", "]]]]><![CDATA[>");
  return `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" version="4">
  <Item class="${className}" referent="RBX0">
    <Properties>
      <string name="Name">${name}</string>
      <ProtectedString name="Source"><![CDATA[${cdata}]]></ProtectedString>
    </Properties>
  </Item>
</roblox>
`;
}
