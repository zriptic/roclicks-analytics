import { COOKIE } from "@/auth";

export async function POST(request: Request) {
  const headers = new Headers({ Location: new URL("/signin", request.url).toString() });
  headers.append("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return new Response(null, { status: 303, headers });
}
