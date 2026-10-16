# RoClicks Analytics

Analytics for Roblox games that you host yourself. It's the same platform that runs on [roclicks.gg/analytics](https://roclicks.gg/analytics), packaged as its own app so you can run it on your computer or your own server and keep all the data.

- **Players:** daily players, new players, sessions, session length, day 1 / 7 / 30 retention by join day, devices and countries
- **Revenue:** developer products, game passes and anything else you report, with Roblox's cut taken off and a USD estimate at your DevEx rate
- **Markers:** `Analytics.Track(player, "ShopOpened")` for anything you want counted, with the latest and top markers on the dashboard
- **Heatmaps:** where markers happen on your map, seen from above
- **Funnels:** how many players get through steps in order, and where they drop off
- **Remote config:** change values on the dashboard and running servers pick them up in seconds
- **A/B tests:** try two to four values of a config key on real players and keep the winner
- **Studio vs live:** playtests in Studio are stored separately, so they never mix with real numbers

## Run it on your computer

You need Node.js 20.19+ and a Postgres database. The included `docker-compose.yml` starts one.

```bash
git clone https://github.com/zriptic/roclicks-analytics.git
cd roclicks-analytics
npm install
cp .env.example .env
```

Open `.env`, set `ADMIN_PASSWORD`, and set `AUTH_SECRET` to a long random string (`openssl rand -base64 32` makes one).

```bash
docker compose up -d
npm run db:migrate
npm run dev
```

Open http://localhost:3000 and sign in with your admin password. Add a game to get its SDK key and setup steps.

Want something to look at first? `npm run seed` fills a demo game with 30 days of made-up players (local databases only).

## Connect your game

1. On your game's **Setup** tab, download `RoClicksAnalytics.rbxmx` and drag it into ServerScriptService. The download already points at your server.
2. In Studio, turn on Game Settings > Security > Allow HTTP Requests.
3. Start it from a server Script:

```lua
local Analytics = require(game.ServerScriptService.RoClicksAnalytics)
Analytics.Setup({ key = "rca_..." })

Analytics.Track(player, "ShopOpened")
local coins = Analytics.Config.Get("starterCoins", 50, player) -- player opts into A/B tests
```

4. Optional: drop `RoClicksAnalyticsClient.rbxmx` (also on the Setup tab) into StarterPlayer > StarterPlayerScripts to split players by phone, tablet, computer, console and VR.

**Localhost and Roblox:** Studio playtests on your own computer can reach `http://localhost:3000`. Live Roblox servers can't. For a published game, run this on a server with a public address (or a tunnel such as cloudflared or ngrok while testing) and set `PUBLIC_URL` in `.env` to that address.

## Run it on a server

```bash
npm run build
npm run db:migrate
npm start            # the dashboard and the SDK API, port 3000 (PORT=... to change)
npm run worker       # optional: deletes old raw data every night
```

Any Node host with Postgres works. Put it behind HTTPS.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | | Postgres connection string |
| `ADMIN_PASSWORD` | | Dashboard password |
| `AUTH_SECRET` | | Signs the sign-in cookie |
| `PUBLIC_URL` | address you open | Where Roblox servers reach the API |
| `ANALYTICS_EVENTS_PER_MONTH` | 100,000,000 | Marker cap per game per month |
| `ANALYTICS_MAX_GAMES` | 100 | Games you can add |
| `ANALYTICS_RETENTION_DAYS` | 180 | Days raw live data is kept |
| `ANALYTICS_STUDIO_RETENTION_DAYS` | 30 | Days Studio data is kept |
| `ANALYTICS_RATE_PER_KEY` / `ANALYTICS_BURST_PER_KEY` | 100 / 500 | API requests per second per game |
| `ANALYTICS_PRUNE_CRON` | `15 4 * * *` | When the worker cleans up |

Sales are never deleted by the cleanup.

## How it works

- The SDK is one ModuleScript that runs on the server. It records joins and leaves by itself, batches everything, sends every 15 seconds (5 in Studio) and once more when the server shuts down. Failed batches are retried, and it backs off when the API asks it to.
- Each A/B test player is put in a variant by a hash of the test and their user id, so they get the same value on every server and every visit. The API recomputes the variant itself, so a server can't put a player in the wrong group.
- Everything lives in plain Postgres tables (`prisma/schema.prisma`), so you can query your data directly.

## Tests

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE).
