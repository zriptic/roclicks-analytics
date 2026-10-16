import Link from "next/link";
import { auth } from "@/auth";

export async function Header() {
  const session = await auth();
  return (
    <header className="border-line-soft border-b">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-5">
        <Link href="/analytics" className="text-ink font-bold">
          Ro<span className="text-signal-hi">Clicks</span> Analytics
        </Link>
        {session && (
          <form action="/api/auth/signout" method="post">
            <button className="btn-quiet !min-h-0 py-1.5">Sign out</button>
          </form>
        )}
      </div>
    </header>
  );
}
