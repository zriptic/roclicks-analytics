import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { Header } from "@/components/Header";
import { CreateGameForm } from "@/components/analytics/CreateGameForm";
import { FREE_EVENTS_PER_MONTH, MAX_GAMES_PER_USER } from "@/lib/analytics/limits";

export const dynamic = "force-dynamic";

export const metadata = { title: "Games", robots: { index: false } };

const FEATURES = [
  { title: "Players and retention", text: "Daily active players, new players, and day 1 / 7 / 30 retention by join day." },
  { title: "Sessions", text: "Session count and average length, tracked from join to leave with no code from you." },
  { title: "Markers", text: "One line, Analytics.Track(player, \"ShopOpened\"), for anything you want counted." },
  { title: "Remote config", text: "Change prices, rewards or switches on the site. Running servers pick it up in seconds." },
];

function ago(date: Date | null): string {
  if (!date) return "No data yet";
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 120) return "Live now";
  if (s < 3600) return `Last data ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `Last data ${Math.round(s / 3600)} h ago`;
  return `Last data ${Math.round(s / 86400)} d ago`;
}

export default async function AnalyticsPage() {
  const session = await auth();
  const games = session?.user
    ? await prisma.analyticsGame.findMany({
        where: { ownerId: session.user.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, lastIngestAt: true, _count: { select: { players: { where: { env: "prod" } } } } },
      })
    : [];

  return (
    <>
      <Header />
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 pt-14 pb-20">
        <p className="text-signal-hi text-xs font-bold tracking-[0.14em] uppercase">Analytics</p>
        <h1 className="display mt-3 text-[clamp(2rem,5vw,3.25rem)]">Your Roblox games.</h1>
        <p className="text-ink-2 mt-5 max-w-2xl text-lg leading-relaxed">
          Self-hosted RoClicks Analytics. Add a game to get its SDK key and setup steps.
        </p>

        {!session?.user ? (
          <>
            <ul className="mt-10 grid gap-3 sm:grid-cols-2">
              {FEATURES.map((f) => (
                <li key={f.title} className="panel p-5">
                  <span className="text-ink block font-semibold">{f.title}</span>
                  <span className="text-ink-2 mt-1.5 block text-sm leading-relaxed">{f.text}</span>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <Link href="/signin" className="btn-primary">
                Sign in
              </Link>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-ink mt-12 text-xl font-bold">Your games</h2>
            {games.length ? (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {games.map((g) => {
                  const live = ago(g.lastIngestAt);
                  return (
                    <li key={g.id}>
                      <Link href={`/analytics/${g.id}`} className="panel hover:border-line block p-5 transition-colors">
                        <span className="text-ink block text-lg font-semibold">{g.name}</span>
                        <span className="text-ink-2 mt-1 flex items-center gap-2 text-sm">
                          {live === "Live now" && <span className="bg-ok inline-block size-2 rounded-full" aria-hidden />}
                          {live} · <span className="tabular-nums">{g._count.players.toLocaleString("en-US")}</span> players
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-ink-2 mt-3">No games yet. Add one to get its SDK key and setup steps.</p>
            )}
            {games.length < MAX_GAMES_PER_USER && (
              <div className="mt-6">
                <CreateGameForm />
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
