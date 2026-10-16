// Unit test for the SDK API rate limiter (no database, no server).
//   npx tsx tests/analytics/ratelimit.test.mts
import { badKeyWait, noteBadKey, resetRateLimits, takeKeyToken } from "../src/lib/analytics/rateLimit";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

resetRateLimits();
const t0 = 1_000_000;

// Key bucket: burst of 500, then 100/s.
let allowed = 0;
for (let i = 0; i < 600; i++) if (takeKeyToken("rca_a", t0) === 0) allowed++;
check("key burst allows exactly 500 at once", allowed === 500, `allowed=${allowed}`);
check("over the burst asks to wait", takeKeyToken("rca_a", t0) >= 1);
check("one second later, about 100 more", (() => {
  let n = 0;
  for (let i = 0; i < 200; i++) if (takeKeyToken("rca_a", t0 + 1000) === 0) n++;
  return n === 100;
})());
check("other keys are independent", takeKeyToken("rca_b", t0) === 0);

// Bad keys per IP: 30 a minute, then blocked; refills at 0.5/s.
for (let i = 0; i < 30; i++) noteBadKey("1.2.3.4", t0);
check("30 rejected keys block the address", badKeyWait("1.2.3.4", t0) >= 1, `wait=${badKeyWait("1.2.3.4", t0)}`);
check("other addresses unaffected", badKeyWait("5.6.7.8", t0) === 0);
check("block lifts after a couple of seconds", badKeyWait("1.2.3.4", t0 + 2500) === 0);

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
