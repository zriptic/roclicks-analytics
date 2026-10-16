import { COOKIE, passwordMatches, sessionToken } from "@/auth";

export async function POST(request: Request) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const url = new URL(request.url);
  if (!passwordMatches(password)) {
    return Response.redirect(new URL("/signin?error=1", url), 303);
  }
  const res = Response.redirect(new URL("/analytics", url), 303);
  const headers = new Headers(res.headers);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  headers.append("Set-Cookie", `${COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
  return new Response(null, { status: 303, headers });
}
