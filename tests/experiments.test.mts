// Unit test for A/B test assignment, input checks and the ingest parsing of
// exposures and devices (no database, no server).
//   npx tsx tests/analytics/experiments.test.mts
import { assignVariant, fnv1a, getPath, parseExperimentInput, setPath } from "../src/lib/analytics/experiments";
import { parseBatch } from "../src/lib/analytics/ingest";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

// Published FNV-1a 32-bit test vectors.
check("fnv1a('') is the offset basis", fnv1a("") === 0x811c9dc5);
check("fnv1a('a')", fnv1a("a") === 0xe40c292c, fnv1a("a").toString(16));
check("fnv1a('foobar')", fnv1a("foobar") === 0xbf9cf968, fnv1a("foobar").toString(16));

const ab = [
  { name: "A", weight: 1 },
  { name: "B", weight: 1 },
];
const id = "cmvbg8poh000047wv2pqk4z7s";
check("same player, same variant", assignVariant(id, 12345, ab) === assignVariant(id, 12345, ab));
check("bigint and number ids agree", assignVariant(id, 8123456789n, ab) === assignVariant(id, 8123456789, ab));

const count = (variants: { name: string; weight: number }[], n: number) => {
  const c: Record<string, number> = {};
  for (let u = 1; u <= n; u++) {
    const v = assignVariant(id, 1_000_000 + u * 7919, variants);
    c[v] = (c[v] ?? 0) + 1;
  }
  return c;
};
const even = count(ab, 20_000);
check("50/50 split is close to even", Math.abs(even.A - 10_000) < 400, JSON.stringify(even));
const skew = count(
  [
    { name: "A", weight: 90 },
    { name: "B", weight: 10 },
  ],
  20_000,
);
check("90/10 split honours the weights", Math.abs(skew.B - 2_000) < 250, JSON.stringify(skew));
const three = count(
  [
    { name: "A", weight: 1 },
    { name: "B", weight: 1 },
    { name: "C", weight: 2 },
  ],
  20_000,
);
check("1/1/2 split", Math.abs(three.C - 10_000) < 400 && three.A > 4_500 && three.B > 4_500, JSON.stringify(three));
// A different test reshuffles players instead of reusing the same halves.
let same = 0;
for (let u = 1; u <= 2000; u++) if (assignVariant(id, u, ab) === assignVariant("cmvbzzzzz000047wv2pqk4z7s", u, ab)) same++;
check("two tests split players independently", same > 850 && same < 1150, `same=${same}`);

const ok = parseExperimentInput({
  name: "Coins",
  key: "shop.price",
  goal: "LevelUp",
  variants: [
    { name: "A", value: 50, weight: 1 },
    { name: "B", value: { a: 1 }, weight: 3 },
  ],
});
check("valid input parses", typeof ok === "object" && ok.variants[1].weight === 3, JSON.stringify(ok));
const bad = (label: string, body: object) => check(label, typeof parseExperimentInput(body) === "string");
const v2 = [
  { name: "A", value: 1 },
  { name: "B", value: 2 },
];
bad("needs a name", { key: "k", variants: v2 });
bad("rejects a key with spaces", { name: "x", key: "my key", variants: v2 });
bad("rejects one variant", { name: "x", key: "k", variants: [v2[0]] });
bad("rejects five variants", { name: "x", key: "k", variants: [1, 2, 3, 4, 5].map((n) => ({ name: `V${n}`, value: n })) });
bad("rejects duplicate names", { name: "x", key: "k", variants: [v2[0], { ...v2[1], name: "A" }] });
bad("rejects a missing value", { name: "x", key: "k", variants: [v2[0], { name: "B" }] });
bad("rejects weight 0", { name: "x", key: "k", variants: [v2[0], { ...v2[1], weight: 0 }] });
bad("rejects a goal that isn't a marker name", { name: "x", key: "k", goal: "a;b", variants: v2 });

const cfg = { starterCoins: 50, shop: { price: 10 } };
const next = setPath(cfg, "shop.sale.on", true);
check("setPath makes the nested table", getPath(next, "shop.sale.on") === true && getPath(next, "shop.price") === 10);
check("setPath leaves the original alone", getPath(cfg, "shop.sale") === undefined);
check("setPath replaces a non-table on the way", getPath(setPath(cfg, "starterCoins.x", 1), "starterCoins.x") === 1);

const now = Date.now();
const batch = parseBatch(
  {
    exposures: [
      { e: id, userId: 111, t: now / 1000 },
      { e: "x'; DROP", userId: 111 },
      { e: id, userId: 0 },
    ],
    devices: [
      { id: "11111111-2222-3333-4444-555555555555", device: "phone" },
      { id: "11111111-2222-3333-4444-555555555555", device: "toaster" },
      { id: "bad id!", device: "desktop" },
    ],
  },
  now,
);
check("one good exposure kept", batch.exposures.length === 1 && batch.exposures[0].uid === 111);
check("one good device kept", batch.devices.length === 1 && batch.devices[0].device === "phone");
check("four bad rows rejected", batch.rejected === 4, `rejected=${batch.rejected}`);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
