// ByteDance web request signer for XiaoYunQue (www.xiaoyunque.com):
//   1. verifyCenter query parameters: verifyFp & fp (from cookie s_v_web_id or generated verify_<ts36>_<uuid>)
//   2. bdms.js query parameters: msToken (from session localStorage.xmst) & a_bogus (SM3 + RC4 + custom Base64)
//   3. Optional fallback that executes the site's bdms.js inside jsdom.
//
// Attribution:
//   The pure-JS SM3, RC4 (dy_rc4), custom Base64 (dy_base64), and a_bogus buffer construction are ported
//   and adapted from ylcangel/douyin_sign (https://github.com/ylcangel/douyin_sign, licensed under the
//   Apache License, Version 2.0), updated for XiaoYunQue's bdms.js 1.0.1.20 (aid=795647, pageId=44487)
//   and POST request body hashing.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const DEFAULT_SIGN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const DEFAULT_AID = 795647;
export const DEFAULT_PAGE_ID = 44487;
export const DEFAULT_SDK_VERSION = "1.0.1.20";
export const DEFAULT_SDK_VERSION_BYTES = [1, 0, 1, 20];

// Paths intercepted by window._SdkGlueInit({ bdms: { paths: { include: [...] } } }) in home.html
export const BDMS_INCLUDE_PATH_PATTERNS = [
  "^/api",
  "^/commerce",
  "^/lv",
  "^/passport",
  "^/pippit",
  "^/cc",
  "^/feedback",
  "^/luckycat",
];

// Paths intercepted by verifyCenter in home.html
export const VERIFY_CENTER_INCLUDE_PATH_PATTERNS = ["^/api"];

const BASE64_ALPHABETS = {
  s0: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
  s1: "Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
  s2: "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=",
  s3: "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
  s4: "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe",
};

function rotl32(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function p0(x) {
  return (x ^ rotl32(x, 9) ^ rotl32(x, 17)) >>> 0;
}

function p1(x) {
  return (x ^ rotl32(x, 15) ^ rotl32(x, 23)) >>> 0;
}

const SM3_IV = new Uint32Array([
  0x7380166f,
  0x4914b2b9,
  0x172442d7,
  0xda8a0600,
  0xa96f30bc,
  0x163138aa,
  0xe38dee4d,
  0xb0fb0e4e,
]);

const SM3_TJ = new Uint32Array(64);
for (let j = 0; j < 64; j++) {
  SM3_TJ[j] = rotl32(j < 16 ? 0x79cc4519 : 0x7a879d8a, j % 32);
}

/**
 * Pure-JS SM3 cryptographic hash implementation (ported from ylcangel/douyin_sign, Apache-2.0).
 */
export class SM3 {
  constructor() {
    this.reg = new Uint32Array(8);
    this.chunk = [];
    this.size = 0;
    this.reset();
  }

  reset() {
    this.reg.set(SM3_IV);
    this.chunk = [];
    this.size = 0;
  }

  write(data) {
    const bytes = typeof data === "string" ? SM3._strToUtf8Bytes(data) : data;
    this.size += bytes.length;
    let f = 64 - this.chunk.length;
    if (bytes.length < f) {
      this.chunk = this.chunk.concat(Array.from(bytes));
      return;
    }
    this.chunk = this.chunk.concat(Array.from(bytes.slice(0, f)));
    while (this.chunk.length >= 64) {
      this._compress(this.chunk);
      if (f < bytes.length) {
        this.chunk = Array.from(bytes.slice(f, Math.min(f + 64, bytes.length)));
      } else {
        this.chunk = [];
      }
      f += 64;
    }
  }

  sum(data, enc) {
    if (data !== undefined) {
      this.reset();
      this.write(data);
    }
    this._fill();
    for (let f = 0; f < this.chunk.length; f += 64) {
      this._compress(this.chunk.slice(f, f + 64));
    }
    const outBytes = [];
    for (let i = 0; i < 8; i++) {
      const v = this.reg[i];
      outBytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    }
    this.reset();
    if (enc === "hex") {
      return outBytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return outBytes;
  }

  _compress(block) {
    const w = new Uint32Array(132);
    for (let j = 0; j < 16; j++) {
      const idx = j * 4;
      w[j] =
        (((block[idx] & 0xff) << 24) |
          ((block[idx + 1] & 0xff) << 16) |
          ((block[idx + 2] & 0xff) << 8) |
          (block[idx + 3] & 0xff)) >>>
        0;
    }
    for (let j = 16; j < 68; j++) {
      const x = w[j - 16] ^ w[j - 9] ^ rotl32(w[j - 3], 15);
      w[j] = (p1(x) ^ rotl32(w[j - 13], 7) ^ w[j - 6]) >>> 0;
    }
    for (let j = 0; j < 64; j++) {
      w[j + 68] = (w[j] ^ w[j + 4]) >>> 0;
    }

    let A = this.reg[0];
    let B = this.reg[1];
    let C = this.reg[2];
    let D = this.reg[3];
    let E = this.reg[4];
    let F = this.reg[5];
    let G = this.reg[6];
    let H = this.reg[7];

    for (let j = 0; j < 64; j++) {
      const ss1 = rotl32((rotl32(A, 12) + E + SM3_TJ[j]) >>> 0, 7);
      const ss2 = (ss1 ^ rotl32(A, 12)) >>> 0;
      const ff = j < 16 ? (A ^ B ^ C) >>> 0 : ((A & B) | (A & C) | (B & C)) >>> 0;
      const gg = j < 16 ? (E ^ F ^ G) >>> 0 : ((E & F) | (~E & G)) >>> 0;
      const tt1 = (ff + D + ss2 + w[j + 68]) >>> 0;
      const tt2 = (gg + H + ss1 + w[j]) >>> 0;
      D = C;
      C = rotl32(B, 9);
      B = A;
      A = tt1;
      H = G;
      G = rotl32(F, 19);
      F = E;
      E = p0(tt2);
    }

    this.reg[0] = (this.reg[0] ^ A) >>> 0;
    this.reg[1] = (this.reg[1] ^ B) >>> 0;
    this.reg[2] = (this.reg[2] ^ C) >>> 0;
    this.reg[3] = (this.reg[3] ^ D) >>> 0;
    this.reg[4] = (this.reg[4] ^ E) >>> 0;
    this.reg[5] = (this.reg[5] ^ F) >>> 0;
    this.reg[6] = (this.reg[6] ^ G) >>> 0;
    this.reg[7] = (this.reg[7] ^ H) >>> 0;
  }

  _fill() {
    const bitLen = this.size * 8;
    let padPos = this.chunk.push(0x80) % 64;
    if (64 - padPos < 8) {
      padPos -= 64;
    }
    while (padPos < 56) {
      this.chunk.push(0);
      padPos++;
    }
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    this.chunk.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
    this.chunk.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);
  }

  static _strToUtf8Bytes(str) {
    return Array.from(Buffer.from(String(str), "utf8"));
  }
}

export function sm3Digest(data) {
  const sm3 = new SM3();
  return sm3.sum(data);
}

export function sm3DigestTwice(data) {
  const sm3 = new SM3();
  return sm3.sum(sm3.sum(data));
}

/**
 * Modified RC4 stream cipher from bdms.js 1.0.1.20 (ported from ylcangel/douyin_sign dyRc4, Apache-2.0).
 */
export function dyRc4(keyStr, plainStr) {
  const s = new Uint8Array(256);
  const k = new Uint8Array(256);
  const keyLen = keyStr.length;
  for (let i = 0; i < 256; i++) {
    s[i] = 255 - i;
    k[i] = keyStr.charCodeAt(i % keyLen) & 0xff;
  }
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j * s[i] + j + k[i]) % 256;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }

  let i = 0;
  let kIdx = 0;
  const out = new Array(plainStr.length);
  for (let n = 0; n < plainStr.length; n++) {
    i = (i + 1) % 256;
    kIdx = (kIdx + s[i]) % 256;
    const tmp = s[i];
    s[i] = s[kIdx];
    s[kIdx] = tmp;
    const rnd = s[(s[i] + s[kIdx]) % 256];
    out[n] = String.fromCharCode((plainStr.charCodeAt(n) ^ rnd) & 0xff);
  }
  return out.join("");
}

/**
 * ByteDance custom Base64 encoding (ported from ylcangel/douyin_sign dy_base64, Apache-2.0).
 */
export function dyBase64(rawStr, keyType = "s4", padChar = "=") {
  const alphabet = BASE64_ALPHABETS[keyType] || BASE64_ALPHABETS.s4;
  const out = [];
  const fullGroups = Math.floor(rawStr.length / 3) * 3;

  for (let i = 0; i < fullGroups; i += 3) {
    const b0 = rawStr.charCodeAt(i) & 0xff;
    const b1 = rawStr.charCodeAt(i + 1) & 0xff;
    const b2 = rawStr.charCodeAt(i + 2) & 0xff;
    const combined = (b0 << 16) | (b1 << 8) | b2;
    out.push(
      alphabet.charAt((combined >> 18) & 0x3f),
      alphabet.charAt((combined >> 12) & 0x3f),
      alphabet.charAt((combined >> 6) & 0x3f),
      alphabet.charAt(combined & 0x3f)
    );
  }

  const rem = rawStr.length - fullGroups;
  if (rem === 1) {
    const b0 = rawStr.charCodeAt(fullGroups) & 0xff;
    const combined = b0 << 16;
    out.push(
      alphabet.charAt((combined >> 18) & 0x3f),
      alphabet.charAt((combined >> 12) & 0x3f),
      padChar,
      padChar
    );
  } else if (rem === 2) {
    const b0 = rawStr.charCodeAt(fullGroups) & 0xff;
    const b1 = rawStr.charCodeAt(fullGroups + 1) & 0xff;
    const combined = (b0 << 16) | (b1 << 8);
    out.push(
      alphabet.charAt((combined >> 18) & 0x3f),
      alphabet.charAt((combined >> 12) & 0x3f),
      alphabet.charAt((combined >> 6) & 0x3f),
      padChar
    );
  }

  return out.join("");
}

/**
 * 3-byte to 4-byte bit-interleaving transform used on the U[88] payload (U[88] -> U[90]).
 */
export function u88Transform(inputBytes, rng = Math.random) {
  const out = [];
  let i = 0;
  const E1 = 145;
  const E2 = 110;
  const E3 = 66;
  const E4 = 189;
  const E5 = 44;
  const E6 = 211;
  while (i < inputBytes.length) {
    if (i + 2 < inputBytes.length) {
      const x = (rng() * 1000) & 255;
      const a = (x & E1) | (inputBytes[i] & E2);
      const b = (x & E3) | (inputBytes[i + 1] & E4);
      const c = (x & E5) | (inputBytes[i + 2] & E6);
      const d = (inputBytes[i] & E1) | (inputBytes[i + 1] & E3) | (inputBytes[i + 2] & E5);
      out.push(a, b, c, d);
    } else {
      out.push(inputBytes[i]);
      if (inputBytes[i + 1] !== undefined) {
        out.push(inputBytes[i + 1]);
      }
    }
    i += 3;
  }
  return out;
}

/**
 * Random byte-quad generator from bdms.js 1.0.1.20 (ported from ylcangel/douyin_sign random()).
 */
export function bdmsRandom(inList, mode, rng = Math.random) {
  if (mode === undefined) {
    return bdmsRandom([inList[0], inList[1]], 0, rng).concat(
      bdmsRandom([inList[2], inList[3]], 2, rng)
    );
  }
  const in0 = inList[0] & 0xff;
  const in1 = inList[1] & 0xff;
  const r = rng() * 65535;
  let r1 = r & 0xff;
  let r2 = (r >> 8) & 0xff;

  if (mode === 1) {
    r2 = (rng() * 40) >> 0;
  } else if (mode === 2) {
    r1 = (rng() * 240) >> 0;
    if (r1 > 109) {
      r1 = r1 + (r1 % 2) + 1;
    }
    r2 = ((rng() * 255) >> 0) & 77;
    r2 |= (1 << 1) | (1 << 4) | (1 << 5) | (1 << 7);
  }

  return [
    (r1 & 170) | (in0 & 85),
    (r1 & 85) | (in0 & 170),
    (r2 & 170) | (in1 & 85),
    (r2 & 85) | (in1 & 170),
  ];
}

/**
 * Generates a verifyFp / fp fingerprint token matching 547009.6d56df8ca3.js (aN()) when
 * the s_v_web_id cookie is not present in the session.
 */
export function generateVerifyFp(nowMs = Date.now(), rng = Math.random) {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const uuid = new Array(36);
  uuid[8] = "_";
  uuid[13] = "_";
  uuid[18] = "_";
  uuid[23] = "_";
  uuid[14] = "4";

  for (let i = 0; i < 36; i++) {
    if (!uuid[i]) {
      const r = 0 | (rng() * 16);
      uuid[i] = chars[i === 19 ? (r & 0x3) | 0x8 : r];
    }
  }
  const tsBase36 = Math.floor(Number(nowMs)).toString(36);
  return `verify_${tsBase36}_${uuid.join("")}`;
}

export function serializeBodyForSigning(body) {
  if (body === undefined || body === null || body === "") {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return Buffer.from(body).toString("utf8");
  }
  // Browser bdms.js only hashes string bodies (e.g. JSON strings) and uses "" for FormData/Blob
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return "";
  }
  if (typeof body === "object") {
    try {
      return JSON.stringify(body);
    } catch {
      return "";
    }
  }
  return String(body);
}

/**
 * Computes ByteDance a_bogus query parameter in pure JS, matching bdms.js 1.0.1.20 on www.xiaoyunque.com.
 *
 * @param {string} queryParamsStr URL query string without leading '?' (e.g. "babi_param=...&verifyFp=...&fp=...&msToken=...")
 * @param {string|object|Buffer} [body=""] Request body (serialized JSON string for POST, "" for GET/FormData)
 * @param {string} [userAgent=DEFAULT_SIGN_USER_AGENT] User-Agent header string
 * @param {object} [options]
 * @returns {string} a_bogus signature
 */
export function computeABogus(
  queryParamsStr = "",
  body = "",
  userAgent = DEFAULT_SIGN_USER_AGENT,
  options = {}
) {
  const {
    aid = DEFAULT_AID,
    pageId = DEFAULT_PAGE_ID,
    sdkVersionBytes = DEFAULT_SDK_VERSION_BYTES,
    nowMs,
    enterPageTs,
    ink: inkOption,
    rng = Math.random,
    envInfo,
    envMask = 1,
    u17Mask = 14,
    u37 = [0, 0, 0, 0, 3],
  } = options || {};

  const cleanQuery = String(queryParamsStr || "").replace(/^\?/, "");
  const bodyStr = serializeBodyForSigning(body);
  const uaStr = String(userAgent || DEFAULT_SIGN_USER_AGENT).trim();

  const u14 = nowMs !== undefined ? Math.floor(Number(nowMs)) : Date.now();
  const pageTs = enterPageTs !== undefined ? Math.floor(Number(enterPageTs)) : u14;
  const ink = inkOption !== undefined ? Math.floor(Number(inkOption)) : pageTs - 1;

  // 1. Double-SM3 of (queryParams + "dhzx") and (body + "dhzx")
  const urlSm3 = sm3DigestTwice(`${cleanQuery}dhzx`);
  const bodySm3 = sm3DigestTwice(`${bodyStr}dhzx`);

  // 2. Single-SM3 of dyBase64(dyRc4(createKey(envMask, u17Mask), userAgent), "s3")
  const uaRc4Key = String.fromCharCode(envMask / 256, envMask % 256, u17Mask % 256);
  const uaEncode = dyBase64(dyRc4(uaRc4Key, uaStr), "s3", "=");
  const uaSm3 = sm3Digest(uaEncode);

  // 3. Environment fingerprint string (9 fields: innerWidth|innerHeight|outerWidth|outerHeight|availWidth|availHeight|sizeWidth|sizeHeight|platform)
  const effectiveEnvInfo =
    typeof envInfo === "string" && envInfo.length > 0
      ? envInfo
      : "1920|960|1920|1040|1920|1040|1920|1080|Win32";
  const u77 = Array.from(Buffer.from(effectiveEnvInfo, "utf8"));
  const u81 = `${(u14 + 3) & 0xff},`;
  const u82 = Array.from(Buffer.from(u81, "utf8"));

  // 4. Construct U fields matching bdms.js 1.0.1.20 VM slots
  const U = new Array(94);
  U[24] = 41;
  U[26] = ((u14 - 1721836800000) / (1000 * 60 * 60 * 24 * 14)) >> 0;
  U[27] = 6;
  U[28] = (u14 - pageTs + 3) & 0xff;

  U[29] = u14 & 0xff;
  U[30] = (u14 >> 8) & 0xff;
  U[31] = (u14 >> 16) & 0xff;
  U[32] = (u14 >> 24) & 0xff;
  U[33] = Math.floor(u14 / 0x100000000) & 0xff;
  U[34] = Math.floor(u14 / 0x10000000000) & 0xff;

  U[35] = envMask & 0xff;
  U[36] = (envMask >> 8) & 0xff;

  U[38] = u37[4] & 0xff;
  U[39] = (u37[4] >> 8) & 0xff;
  U[40] = u37[0] & 0xff;
  U[41] = u37[1] & 0xff;
  U[42] = u37[2] & 0xff;
  U[43] = u37[3] & 0xff;

  U[44] = u17Mask & 0xff;
  U[45] = (u17Mask >> 8) & 0xff;
  U[46] = (u17Mask >> 16) & 0xff;
  U[47] = (u17Mask >> 24) & 0xff;

  U[48] = urlSm3[9];
  U[49] = urlSm3[18];
  U[50] = 3;
  U[51] = u37[4] & 2 ? 11 : urlSm3[U[50]];

  U[52] = bodySm3[10];
  U[53] = bodySm3[19];
  U[54] = 4;
  U[55] = u37[4] & 4 ? 8 : bodySm3[U[54]];

  U[56] = uaSm3[11];
  U[57] = uaSm3[21];
  U[58] = 5;
  U[59] = u37[4] & 8 ? 12 : uaSm3[U[58]];

  U[60] = ink & 0xff;
  U[61] = (ink >> 8) & 0xff;
  U[62] = (ink >> 16) & 0xff;
  U[63] = (ink >> 24) & 0xff;
  U[64] = Math.floor(ink / 0x100000000) & 0xff;
  U[65] = Math.floor(ink / 0x10000000000) & 0xff;

  U[66] = 3;

  U[67] = pageId & 0xff;
  U[68] = (pageId >> 8) & 0xff;
  U[69] = (pageId >> 16) & 0xff;
  U[70] = (pageId >> 24) & 0xff;

  U[71] = aid & 0xff;
  U[72] = (aid >> 8) & 0xff;
  U[73] = (aid >> 16) & 0xff;
  U[74] = (aid >> 24) & 0xff;

  U[79] = u77.length & 0xff;
  U[80] = (u77.length >> 8) & 0xff;
  U[84] = u82.length & 0xff;
  U[85] = (u82.length >> 8) & 0xff;

  const u86 = bdmsRandom(sdkVersionBytes, undefined, rng);

  const tlist = [
    U[34], U[44], U[56], U[61], U[73], U[29], U[70], U[45], U[35], U[49],
    U[38], U[66], U[51], U[68], U[28], U[48], U[64], U[47], U[30], U[71],
    U[26], U[55], U[31], U[69], U[59], U[40], U[62], U[63], U[27], U[72],
    U[41], U[74], U[57], U[52], U[42], U[39], U[33], U[67], U[53], U[43],
    U[65], U[46], U[36], U[24], U[60], U[32], U[79], U[80], U[84], U[85],
  ];

  let xorChecksum = 0;
  for (let i = 0; i < u86.length; i++) {
    xorChecksum ^= u86[i];
  }
  for (let i = 0; i < tlist.length; i++) {
    xorChecksum ^= tlist[i];
  }
  U[87] = xorChecksum & 0xff;

  const u88 = tlist.concat(u77, u82, [U[87]]);
  const u89 = String.fromCharCode(...bdmsRandom([3, 82], 1, rng));
  const u90 = u88Transform(u88, rng);
  const t1List = u86.concat(u90);

  const encrypted = dyRc4(String.fromCharCode(211), String.fromCharCode(...t1List));
  const u92 = u89 + encrypted;
  return dyBase64(u92, "s4", "=");
}

/**
 * Checks whether a request pathname matches the browser's bdms.paths.include patterns.
 */
export function shouldSignPath(pathname, includePatterns = BDMS_INCLUDE_PATH_PATTERNS) {
  if (typeof pathname !== "string" || !pathname) return false;
  const clean = pathname.startsWith("/") ? pathname : `/${pathname}`;
  for (const pat of includePatterns) {
    if (new RegExp(pat).test(clean)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether a request pathname matches verifyCenter's interceptPathList.include patterns.
 */
export function shouldAddVerifyFp(pathname, includePatterns = BDMS_INCLUDE_PATH_PATTERNS) {
  return shouldSignPath(pathname, includePatterns);
}

const DEFAULT_BDMS_PATHS = [
  resolve(__dirname, "../../site/bdms.js"),
  resolve(__dirname, "../../refs/HZhertz_ByteDance-a_bogus-parameter/bdms.js"),
];

const DEFAULT_JSDOM_PATHS = [
  "jsdom",
  "/home/box/.local/lib/node_modules/@bitwarden/cli/node_modules/jsdom",
];

function loadJsdomConstructor(customJsdomPath) {
  const candidates = customJsdomPath
    ? [customJsdomPath, ...DEFAULT_JSDOM_PATHS]
    : DEFAULT_JSDOM_PATHS;
  const errors = [];
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (mod?.JSDOM) return mod.JSDOM;
    } catch (err) {
      errors.push(`${candidate}: ${err.message}`);
    }
  }
  throw new Error(
    `Failed to load 'jsdom' for bdms.js fallback signer (${errors.join("; ")}).`
  );
}

function loadBdmsScriptContent(customBdmsPath) {
  const candidates = customBdmsPath
    ? [customBdmsPath, ...DEFAULT_BDMS_PATHS]
    : DEFAULT_BDMS_PATHS;
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return { path: candidate, code: readFileSync(candidate, "utf8") };
    }
  }
  throw new Error(
    `Failed to locate bdms.js for jsdom fallback signer. Checked: ${candidates.join(", ")}`
  );
}

/**
 * Creates a sandboxed jsdom runner that executes ByteDance's bdms.js and intercepts
 * the signed URL produced by window.fetch without making any external network calls.
 */
export function createBdmsJsdomSigner({
  bdmsJsPath,
  jsdomPath,
  userAgent = DEFAULT_SIGN_USER_AGENT,
  aid = DEFAULT_AID,
  pageId = DEFAULT_PAGE_ID,
  msToken = "",
  fp = "",
} = {}) {
  const JSDOM = loadJsdomConstructor(jsdomPath);
  const { path: resolvedBdmsPath, code: bdmsCode } = loadBdmsScriptContent(bdmsJsPath);

  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    url: "https://www.xiaoyunque.com/home",
    referrer: "https://www.xiaoyunque.com/",
    userAgent,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });

  const win = dom.window;
  try {
    Object.defineProperty(win.navigator, "userAgent", {
      value: userAgent,
      configurable: true,
    });
    Object.defineProperty(win.navigator, "platform", {
      value: "Win32",
      configurable: true,
    });
    win.chrome = { runtime: {} };
  } catch {
    // Ignore descriptor override errors
  }
  let lastCapturedUrl = null;

  // Install a local-only fetch stub before bdms.js wraps window.fetch
  win.fetch = async (input, _init) => {
    lastCapturedUrl = typeof input === "string" ? input : input?.url || String(input);
    if (typeof Response !== "undefined") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return {
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    };
  };

  if (typeof Request !== "undefined") win.Request = Request;
  if (typeof Headers !== "undefined") win.Headers = Headers;
  if (typeof Response !== "undefined") win.Response = Response;

  if (msToken) {
    win.localStorage.setItem("xmst", msToken);
    win.sessionStorage.setItem("xmst", msToken);
  }
  if (fp) {
    win.localStorage.setItem("s_v_web_id", fp);
    win.document.cookie = `s_v_web_id=${fp}`;
  }

  win.eval(bdmsCode);
  if (!win.bdms || typeof win.bdms.init !== "function") {
    throw new Error(`bdms.js at "${resolvedBdmsPath}" did not expose window.bdms.init.`);
  }

  win.bdms.init({
    aid,
    pageId,
    paths: { include: BDMS_INCLUDE_PATH_PATTERNS },
    ddrt: 3,
    track: { mode: 0 },
  });

  return {
    bdmsJsPath: resolvedBdmsPath,
    setSession({ msToken: nextMsToken, fp: nextFp } = {}) {
      if (nextMsToken !== undefined) {
        if (nextMsToken) {
          win.localStorage.setItem("xmst", nextMsToken);
          win.sessionStorage.setItem("xmst", nextMsToken);
        } else {
          win.localStorage.removeItem("xmst");
          win.sessionStorage.removeItem("xmst");
        }
      }
      if (nextFp !== undefined && nextFp) {
        win.localStorage.setItem("s_v_web_id", nextFp);
        win.document.cookie = `s_v_web_id=${nextFp}`;
      }
    },
    async signUrl(
      urlInput,
      { method = "POST", body = "", fp: reqFp = fp, msToken: reqMsToken = msToken } = {}
    ) {
      const origUrl = new URL(String(urlInput), "https://www.xiaoyunque.com");
      if (!shouldSignPath(origUrl.pathname)) {
        return origUrl.toString();
      }

      this.setSession({ msToken: reqMsToken, fp: reqFp });

      const effectiveFp = reqFp || generateVerifyFp();
      const simUrl = new URL(
        `${origUrl.pathname}${origUrl.search}`,
        "https://www.xiaoyunque.com"
      );
      if (shouldAddVerifyFp(simUrl.pathname)) {
        if (!simUrl.searchParams.has("verifyFp")) {
          simUrl.searchParams.set("verifyFp", effectiveFp);
        }
        if (!simUrl.searchParams.has("fp")) {
          simUrl.searchParams.set("fp", effectiveFp);
        }
      }

      const serializedBody = serializeBodyForSigning(body);
      lastCapturedUrl = null;
      await win.fetch(`${simUrl.pathname}${simUrl.search}`, {
        method,
        ...(serializedBody ? { body: serializedBody } : {}),
      });

      if (!lastCapturedUrl) {
        throw new Error("bdms.js under jsdom did not invoke the underlying fetch stub.");
      }

      const signedSimUrl = new URL(lastCapturedUrl, "https://www.xiaoyunque.com");
      const finalUrl = new URL(origUrl.toString());
      finalUrl.search = signedSimUrl.search;
      return finalUrl.toString();
    },
    close() {
      try {
        dom.window.close();
      } catch {
        // Ignore close errors
      }
    },
  };
}

/**
 * Signs a request URL with verifyFp, fp, msToken, and a_bogus for all paths signed by the browser.
 * Uses the pure-JS signer by default, with an optional fallback to bdms.js under jsdom when
 * signMode === "jsdom" or signMode === "auto" (if pure-JS throws).
 */
export async function signRequestUrl(
  urlInput,
  {
    method = "POST",
    body = "",
    userAgent = DEFAULT_SIGN_USER_AGENT,
    fp = "",
    msToken = "",
    aid = DEFAULT_AID,
    pageId = DEFAULT_PAGE_ID,
    nowMs,
    perfNow,
    rng = Math.random,
    signMode = "pure",
    jsdomSigner = null,
    bdmsJsPath,
    jsdomPath,
  } = {}
) {
  const urlObj = new URL(String(urlInput));
  if (!shouldSignPath(urlObj.pathname)) {
    return urlObj.toString();
  }

  const runJsdomFallback = async () => {
    const activeSigner =
      jsdomSigner ||
      createBdmsJsdomSigner({
        bdmsJsPath,
        jsdomPath,
        userAgent,
        aid,
        pageId,
        msToken,
        fp,
      });
    try {
      return await activeSigner.signUrl(urlObj.toString(), {
        method,
        body,
        fp,
        msToken,
      });
    } finally {
      if (!jsdomSigner) {
        activeSigner.close();
      }
    }
  };

  if (signMode === "jsdom") {
    return runJsdomFallback();
  }

  try {
    const effectiveFp = fp || generateVerifyFp(nowMs, rng);
    if (shouldAddVerifyFp(urlObj.pathname)) {
      if (!urlObj.searchParams.has("verifyFp")) {
        urlObj.searchParams.set("verifyFp", effectiveFp);
      }
      if (!urlObj.searchParams.has("fp")) {
        urlObj.searchParams.set("fp", effectiveFp);
      }
    }

    if (msToken && !urlObj.searchParams.has("msToken")) {
      urlObj.searchParams.set("msToken", msToken);
    }

    const queryStr = urlObj.search.replace(/^\?/, "");
    const aBogus = computeABogus(queryStr, body, userAgent, {
      aid,
      pageId,
      nowMs,
      perfNow,
      rng,
    });
    urlObj.searchParams.set("a_bogus", aBogus);
    return urlObj.toString();
  } catch (err) {
    if (signMode === "auto") {
      return runJsdomFallback();
    }
    throw err;
  }
}
