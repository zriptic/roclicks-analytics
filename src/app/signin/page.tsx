export const metadata = { title: "Sign in" };

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto w-full max-w-sm flex-1 px-5 pt-24">
      <h1 className="display text-3xl">
        Ro<span className="text-signal-hi">Clicks</span> Analytics
      </h1>
      <form action="/api/auth/signin" method="post" className="panel mt-8 space-y-4 p-5">
        <label className="block">
          <span className="label">Admin password</span>
          <input name="password" type="password" className="input" autoFocus required autoComplete="current-password" />
        </label>
        <button className="btn-primary w-full">Sign in</button>
        {error && <p className="text-danger text-sm">That password isn&apos;t right.</p>}
      </form>
      <p className="text-ink-3 mt-4 text-sm">The password is ADMIN_PASSWORD in your .env file.</p>
    </main>
  );
}
