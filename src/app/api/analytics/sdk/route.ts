import { asRbxmx, sdkSource } from "@/lib/analytics/sdkFile";

/**
 * GET ?format=rbxmx (default, drag into Studio) or ?format=luau (paste into
 * a script). ?file=client gets the optional device LocalScript instead.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "luau" ? "luau" : "rbxmx";
  const client = params.get("file") === "client";
  const name = client ? "RoClicksAnalyticsClient" : "RoClicksAnalytics";
  const source = await sdkSource(client ? "client" : "sdk", new URL(request.url).origin);
  const body = format === "luau" ? source : asRbxmx(source, client ? "LocalScript" : "ModuleScript", name);
  return new Response(body, {
    headers: {
      "Content-Type": format === "luau" ? "text/plain; charset=utf-8" : "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.${format}"`,
      "Cache-Control": "public, max-age=300",
    },
  });
}
