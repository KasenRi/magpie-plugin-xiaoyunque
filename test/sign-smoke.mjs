import assert from "node:assert/strict";
import {
  DEFAULT_SIGN_USER_AGENT,
  computeABogus,
  generateVerifyFp,
  signRequestUrl,
} from "../src/signer.mjs";

const fixedNow = 1762800000000;
const fixedRng = () => 0.123456789;

// 1. Verify exact byte-for-byte parity with bdms.js 1.0.1.20 reference vector
const expectedAb =
  "xJsfkFWjQqmjFpAb8Cbh9Gq3c9j/rBgyR-iORDiAexKWOq0cKzPsPEUjnoEMskfzimpVFq17/D/KbEEc0rh0/InkzmkkuQ7WNQACISvo/qqfT0JMgHDFe0TzowBa0bsxaQd1Eej5X4/PIgO3hHQ0/ZOfE5gu55jvPd5/Bf==";
const actualAb = computeABogus("babi_param=1", '{"hello":1}', DEFAULT_SIGN_USER_AGENT, {
  nowMs: fixedNow,
  enterPageTs: fixedNow,
  ink: fixedNow - 1,
  rng: fixedRng,
  envMask: 3,
  envInfo: "1024|768|1024|768|0|0|0|0|Win32",
});
assert.equal(actualAb, expectedAb, "computeABogus should match bdms.js 1.0.1.20 reference output");

// 2. Verify signRequestUrl produces verifyFp, fp, msToken, and a_bogus for a request URL + body
const fp = generateVerifyFp(fixedNow, fixedRng);
assert.match(fp, /^verify_[0-9a-z]+_[0-9A-Za-z_]{36}$/);

const msToken = "smoke_test_msToken_value_1234567890";
const rawUrl =
  "https://www.xiaoyunque.com/api/biz/v1/agent/submit_run?babi_param=%7B%22enter_from%22%3A%22web%22%7D";
const bodyA = JSON.stringify({ thread_id: "00000000-0000-0000-0000-000000000000", run_id: "1" });
const bodyB = JSON.stringify({ thread_id: "00000000-0000-0000-0000-000000000000", run_id: "2" });

const signedA = await signRequestUrl(rawUrl, {
  method: "POST",
  body: bodyA,
  fp,
  msToken,
  nowMs: fixedNow,
  rng: fixedRng,
  signMode: "pure",
});
const signedB = await signRequestUrl(rawUrl, {
  method: "POST",
  body: bodyB,
  fp,
  msToken,
  nowMs: fixedNow,
  rng: fixedRng,
  signMode: "pure",
});

const parsedA = new URL(signedA);
const parsedB = new URL(signedB);

assert.equal(parsedA.searchParams.get("verifyFp"), fp);
assert.equal(parsedA.searchParams.get("fp"), fp);
assert.equal(parsedA.searchParams.get("msToken"), msToken);
assert.ok(parsedA.searchParams.get("a_bogus")?.length >= 160);
assert.notEqual(
  parsedA.searchParams.get("a_bogus"),
  parsedB.searchParams.get("a_bogus"),
  "Different POST bodies must produce different a_bogus signatures"
);

console.log("PASS test/sign-smoke.mjs", {
  verifyFp: parsedA.searchParams.get("verifyFp"),
  fp: parsedA.searchParams.get("fp"),
  msTokenLength: parsedA.searchParams.get("msToken")?.length,
  aBogusLength: parsedA.searchParams.get("a_bogus")?.length,
});
