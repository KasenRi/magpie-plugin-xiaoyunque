import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  DEFAULT_PAGE_ID,
  createBdmsJsdomSigner,
  generateVerifyFp,
  shouldSignPath,
  signRequestUrl,
} from "./signer.mjs";

export const DEFAULT_BASE_URL = "https://www.xiaoyunque.com";
export const DEFAULT_SKILL_BASE_URL = "https://xyq.jianying.com";
export const DEFAULT_SKILL_USER_AGENT = "Pippit-CLI/1.0";
export const DEFAULT_ORIGIN = "https://www.xiaoyunque.com";
export const DEFAULT_REFERER = "https://www.xiaoyunque.com/home";
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const DEFAULT_APP_ID = "795647";
export const DEFAULT_APP_VR = "1.1.4";
export const COMMERCE_APP_VR = "5.8.0";
export const DEFAULT_PF = "7";
export const DEFAULT_MODEL = "Seedance_2.5";
export const DEFAULT_TIMEOUT_MS = 42_000;

export function isXiaoYunQueDomain(domain) {
  if (domain === undefined || domain === null) return true;
  const trimmed = String(domain).trim();
  if (!trimmed) return true;
  const clean = trimmed
    .replace(/^#HttpOnly_/i, "")
    .replace(/^\.+/, "")
    .toLowerCase();
  return clean === "xiaoyunque.com" || clean.endsWith(".xiaoyunque.com");
}

export function extractCookiePairsFromHeader(rawHeader) {
  if (typeof rawHeader !== "string") return [];
  const cleaned = rawHeader.trim().replace(/^cookie\s*:\s*/i, "");
  if (!cleaned) return [];
  const pairs = [];
  for (const part of cleaned.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (name && value) {
      pairs.push({ name, value });
    }
  }
  return pairs;
}

export function extractSessionTokensFromPairs(pairs = [], localStorageEntries = []) {
  let msToken = "";
  let fp = "";

  if (Array.isArray(localStorageEntries)) {
    for (const entry of localStorageEntries) {
      if (!entry || typeof entry !== "object") continue;
      const key = String(entry.key ?? entry.name ?? "").trim();
      const val = entry.value !== undefined && entry.value !== null ? String(entry.value).trim() : "";
      if (!key || !val) continue;
      if (!msToken && (key === "xmst" || key === "msToken")) {
        msToken = val;
      }
      if (!fp && (key === "s_v_web_id" || key === "verifyFp" || key === "fp")) {
        fp = val;
      }
    }
  } else if (localStorageEntries && typeof localStorageEntries === "object") {
    for (const [k, v] of Object.entries(localStorageEntries)) {
      const key = String(k).trim();
      const val = v !== undefined && v !== null ? String(v).trim() : "";
      if (!key || !val) continue;
      if (!msToken && (key === "xmst" || key === "msToken")) {
        msToken = val;
      }
      if (!fp && (key === "s_v_web_id" || key === "verifyFp" || key === "fp")) {
        fp = val;
      }
    }
  }

  if (Array.isArray(pairs)) {
    for (const { name, value } of pairs) {
      if (!name || !value) continue;
      if (!msToken && (name === "xmst" || name === "msToken")) {
        msToken = value;
      }
      if (!fp && (name === "s_v_web_id" || name === "verifyFp" || name === "fp")) {
        fp = value;
      }
    }
  }

  return { msToken, fp };
}

export function parseCookieFileContent(rawText) {
  if (typeof rawText !== "string") {
    return { cookieHeader: "", pairs: [], msToken: "", fp: "" };
  }
  const text = rawText.trim();
  if (!text) {
    return { cookieHeader: "", pairs: [], msToken: "", fp: "" };
  }

  // (a) & (b): Try JSON formats first
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      const cookieArray = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cookies)
        ? parsed.cookies
        : Array.isArray(parsed?.data?.cookies)
        ? parsed.data.cookies
        : null;

      if (cookieArray) {
        const pairs = [];
        for (const item of cookieArray) {
          if (!item || typeof item !== "object") continue;
          if (item.domain !== undefined && !isXiaoYunQueDomain(item.domain)) {
            continue;
          }
          const name = typeof item.name === "string" ? item.name.trim() : "";
          const value = item.value !== undefined && item.value !== null ? String(item.value).trim() : "";
          if (name && value) {
            pairs.push({ name, value });
          }
        }

        const localStorageSource =
          parsed?.localStorage ??
          parsed?.data?.localStorage ??
          parsed?.origins?.[0]?.localStorage ??
          [];
        const tokens = extractSessionTokensFromPairs(pairs, localStorageSource);
        const topMsToken =
          typeof parsed?.xmst === "string"
            ? parsed.xmst.trim()
            : typeof parsed?.msToken === "string"
            ? parsed.msToken.trim()
            : "";
        const topFp =
          typeof parsed?.s_v_web_id === "string"
            ? parsed.s_v_web_id.trim()
            : typeof parsed?.verifyFp === "string"
            ? parsed.verifyFp.trim()
            : typeof parsed?.fp === "string"
            ? parsed.fp.trim()
            : "";

        return {
          cookieHeader: pairs.map((p) => `${p.name}=${p.value}`).join("; "),
          pairs,
          msToken: tokens.msToken || topMsToken,
          fp: tokens.fp || topFp,
        };
      }
    } catch {
      // Fall through to text formats
    }
  }

  // (c) Netscape cookies.txt format (lines with 7 tab-separated fields)
  const lines = text.split(/\r?\n/);
  const looksLikeNetscape = lines.some((line) => {
    const t = line.trim();
    if (!t) return false;
    if (t.startsWith("# Netscape") || t.startsWith("# HTTP Cookie File")) return true;
    const uncommented = t.replace(/^#HttpOnly_/i, "");
    if (uncommented.startsWith("#")) return false;
    const cols = uncommented.split(/\t+/);
    return cols.length >= 7;
  });

  if (looksLikeNetscape) {
    const pairs = [];
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      const isHttpOnly = /^#HttpOnly_/i.test(trimmed);
      if (trimmed.startsWith("#") && !isHttpOnly) continue;
      const effectiveLine = isHttpOnly ? trimmed.replace(/^#HttpOnly_/i, "") : trimmed;
      const cols = effectiveLine.split(/\t/);
      if (cols.length < 7) continue;
      const domain = cols[0].trim();
      const name = cols[5].trim();
      const value = cols.slice(6).join("\t").trim();
      if (!isXiaoYunQueDomain(domain)) continue;
      if (name && value) {
        pairs.push({ name, value });
      }
    }
    const { msToken, fp } = extractSessionTokensFromPairs(pairs);
    return {
      cookieHeader: pairs.map((p) => `${p.name}=${p.value}`).join("; "),
      pairs,
      msToken,
      fp,
    };
  }

  // (d) Plain text file containing a raw Cookie header (single or multi-line)
  const joined = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .join("; ");
  const pairs = extractCookiePairsFromHeader(joined);
  const { msToken, fp } = extractSessionTokensFromPairs(pairs);
  return {
    cookieHeader: pairs.map((p) => `${p.name}=${p.value}`).join("; "),
    pairs,
    msToken,
    fp,
  };
}

export function parseAccessKeyFileContent(rawText) {
  if (typeof rawText !== "string") return "";
  const text = rawText.trim();
  if (!text) return "";

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const raw =
        parsed?.access_key ??
        parsed?.accessKey ??
        parsed?.token ??
        parsed?.data?.access_key ??
        parsed?.data?.accessKey ??
        "";
      if (typeof raw === "string" && raw.trim()) {
        return raw.trim().replace(/^Bearer\s+/i, "").trim();
      }
    } catch {
      // Fall through to plain-text parsing
    }
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line
      .replace(/^(?:export\s+)?(?:XYQ_ACCESS_KEY|access_key|accessKey)\s*=\s*/i, "")
      .replace(/^(?:Authorization\s*:\s*)?(?:Bearer\s+)/i, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    if (cleaned) return cleaned;
  }
  return "";
}

export function computeCommerceSign(
  urlOrPathname,
  { nowMs, deviceTime, pf = DEFAULT_PF, appvr = COMMERCE_APP_VR, tdid = "" } = {}
) {
  const fullUrl = String(urlOrPathname || "").startsWith("http")
    ? String(urlOrPathname)
    : `https://www.jianying.com${String(urlOrPathname || "").startsWith("/") ? "" : "/"}${urlOrPathname || ""}`;
  const { pathname } = new URL(fullUrl);
  const unixSec =
    deviceTime !== undefined && deviceTime !== null
      ? Math.floor(Number(deviceTime))
      : Math.floor((nowMs !== undefined ? Number(nowMs) : Date.now()) / 1000);
  const last7 = pathname.slice(-7);
  const raw = `9e2c|${last7}|${pf}|${appvr}|${unixSec}|${tdid}|11ac`;
  const sign = createHash("md5").update(raw).digest("hex").toLowerCase();
  return {
    sign,
    "device-time": String(unixSec),
    deviceTime: unixSec,
  };
}

export function redactSecrets(input, extraSecrets = []) {
  if (typeof input !== "string" || !input) return "";
  let out = input;

  for (const secret of extraSecrets) {
    if (typeof secret === "string" && secret.trim().length >= 4) {
      out = out.split(secret.trim()).join("[REDACTED]");
    }
  }

  // Redact common ByteDance / XiaoYunQue cookie & query token key=value pairs
  out = out.replace(
    /\b(sessionid(?:_ss)?|sid_tt|sid_guard|uid_tt(?:_ss)?|sid_ucp_v1|ssid_ucp_v1|ttwid|passport_csrf_token|odin_tt|msToken|xmst|s_v_web_id|verifyFp|access_key|accessKey|XYQ_ACCESS_KEY)\s*=\s*[^;\s"'&]+/gi,
    "$1=[REDACTED]"
  );

  // Redact Cookie / AccessKey headers or JSON fields
  out = out.replace(
    /(["']?(?:cookie|set-cookie|access_key|accessKey)["']?\s*[:=]\s*["'])([^"']+)(["'])/gi,
    "$1[REDACTED]$3"
  );
  out = out.replace(/\b(Cookie\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]");
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");

  return out;
}

export function combineAbortSignal(signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal;
}

const LOGIN_ERROR_CODES = new Set(["1002", "1015", "34010105"]);
const ANTIBOT_ERROR_CODES = new Set(["16012", "16013", "16014", "16015"]);

export class XiaoYunQueApiError extends Error {
  constructor({
    status = 200,
    ret,
    errmsg = "",
    log_id = "",
    starling_key = "",
    api_base_resp = null,
    data = null,
    authMode = "cookie",
    extraSecrets = [],
  } = {}) {
    const retStr = ret !== undefined && ret !== null ? String(ret) : "";
    const isLoginError =
      status === 401 ||
      status === 403 ||
      LOGIN_ERROR_CODES.has(retStr) ||
      /check\s*login|login\s*error|not\s*login|unauthorized|invalid.*(?:token|key)|access[_\s-]*key|未登录|鉴权/i.test(
        String(errmsg || "")
      );
    const isAntiBot = ANTIBOT_ERROR_CODES.has(retStr) || /shark|captcha/i.test(String(errmsg || ""));

    const parts = [];
    if (isLoginError) {
      if (authMode === "access_key") {
        parts.push(
          "XiaoYunQue login error: Access Key invalid or expired (create or check your key at https://www.xiaoyunque.com/cli?tab=api)"
        );
      } else {
        parts.push(
          "XiaoYunQue login error: cookie expired or invalid, re-export cookies from https://www.xiaoyunque.com"
        );
      }
    } else if (isAntiBot) {
      parts.push(
        "XiaoYunQue anti-bot verification required: open www.xiaoyunque.com in a browser, pass the captcha, re-export cookies"
      );
    } else {
      parts.push(`XiaoYunQue API error`);
    }

    const meta = [];
    if (status && status !== 200) meta.push(`HTTP ${status}`);
    if (retStr) meta.push(`ret=${retStr}`);
    if (errmsg) meta.push(`errmsg=${errmsg}`);
    if (log_id) meta.push(`log_id=${log_id}`);
    if (starling_key) meta.push(`starling_key=${starling_key}`);
    if (api_base_resp && typeof api_base_resp === "object") {
      const respStr = JSON.stringify(api_base_resp);
      if (respStr && respStr !== "{}") meta.push(`api_base_resp=${respStr}`);
    }

    const fullMsg = meta.length > 0 ? `${parts.join(": ")} (${meta.join(", ")})` : parts.join(": ");
    const safeMsg = redactSecrets(fullMsg, extraSecrets);
    super(safeMsg);
    this.name = "XiaoYunQueApiError";
    this.status = status;
    this.ret = retStr || null;
    this.errmsg = redactSecrets(String(errmsg || ""), extraSecrets);
    this.log_id = log_id || null;
    this.starling_key = starling_key || null;
    this.api_base_resp = api_base_resp || null;
    this.data = data ?? null;
    this.isLoginError = isLoginError;
    this.isAntiBot = isAntiBot;
  }
}

export class XiaoYunQueClient {
  constructor(options = {}, env = process.env) {
    this.options = options || {};
    this.env = env || process.env;

    const explicitBaseUrl = this.options.baseUrl ?? this.env.XYQ_BASE_URL ?? "";
    const rawBaseUrl = explicitBaseUrl || DEFAULT_BASE_URL;
    this.baseUrl = String(rawBaseUrl).trim().replace(/\/+$/, "");

    const rawSkillBaseUrl =
      this.options.skillBaseUrl ??
      this.env.XYQ_SKILL_BASE_URL ??
      (explicitBaseUrl || DEFAULT_SKILL_BASE_URL);
    this.skillBaseUrl = String(rawSkillBaseUrl).trim().replace(/\/+$/, "");

    const hasExplicitAccessKeyOpt =
      this.options.accessKey !== undefined || this.options.accessKeyFile !== undefined;
    const rawAccessKey =
      this.options.accessKey !== undefined
        ? this.options.accessKey
        : !hasExplicitAccessKeyOpt
        ? this.env.XYQ_ACCESS_KEY ?? ""
        : "";
    this.configuredAccessKey = parseAccessKeyFileContent(String(rawAccessKey ?? ""));

    const rawAccessKeyFile =
      this.options.accessKeyFile !== undefined
        ? this.options.accessKeyFile
        : !hasExplicitAccessKeyOpt
        ? this.env.XYQ_ACCESS_KEY_FILE ?? ""
        : "";
    this.accessKeyFile = String(rawAccessKeyFile ?? "").trim();

    const rawCookie = this.options.cookie ?? this.env.XYQ_COOKIE ?? "";
    this.configuredCookie = String(rawCookie).trim().replace(/^cookie\s*:\s*/i, "");

    const rawCookieFile = this.options.cookieFile ?? this.env.XYQ_COOKIE_FILE ?? "";
    this.cookieFile = String(rawCookieFile).trim();

    const rawMsToken =
      this.options.msToken ??
      this.options.xmst ??
      this.env.XYQ_MS_TOKEN ??
      this.env.XYQ_XMST ??
      "";
    this.configuredMsToken = String(rawMsToken).trim();

    const rawFp =
      this.options.fp ??
      this.options.verifyFp ??
      this.env.XYQ_FP ??
      this.env.XYQ_VERIFY_FP ??
      "";
    this.configuredFp = String(rawFp).trim();

    this.signRequests =
      this.options.signRequests !== undefined ? Boolean(this.options.signRequests) : true;
    const rawSignMode =
      this.options.signMode ??
      this.env.XYQ_SIGN_MODE ??
      (this.options.useBdmsJsdom ? "jsdom" : "pure");
    this.signMode = String(rawSignMode).trim().toLowerCase() || "pure";
    this.bdmsJsPath = this.options.bdmsJsPath ?? this.env.XYQ_BDMS_JS_PATH ?? undefined;
    this.jsdomPath = this.options.jsdomPath ?? this.env.XYQ_JSDOM_PATH ?? undefined;
    this.rng = typeof this.options.rng === "function" ? this.options.rng : Math.random;

    const rawWorkspaceId = this.options.workspaceId ?? this.env.XYQ_WORKSPACE_ID ?? "";
    this.configuredWorkspaceId = String(rawWorkspaceId).trim();

    const rawTeamId = this.options.teamId ?? this.env.XYQ_TEAM_ID ?? "";
    this.teamId = String(rawTeamId).trim();

    const rawDefaultModel = this.options.defaultModel ?? this.env.XYQ_DEFAULT_MODEL ?? DEFAULT_MODEL;
    this.defaultModel = String(rawDefaultModel).trim() || DEFAULT_MODEL;

    if (typeof this.options.now === "function") {
      this.now = this.options.now;
    } else if (typeof this.options.now === "number" && Number.isFinite(this.options.now)) {
      const fixedNow = this.options.now;
      this.now = () => fixedNow;
    } else {
      this.now = () => Date.now();
    }

    this._knownSecrets = new Set();
    const configuredPairs = extractCookiePairsFromHeader(this.configuredCookie);
    const configuredTokens = extractSessionTokensFromPairs(configuredPairs);
    this._msTokenFromCookieHeader = configuredTokens.msToken;
    this._fpFromCookieHeader = configuredTokens.fp;

    this._recordSecret(this.configuredAccessKey);
    this._recordCookieSecrets(this.configuredCookie, configuredPairs);
    this._recordSecret(this.configuredMsToken);
    this._recordSecret(this.configuredFp);

    this._accessKeyFileMtimeMs = null;
    this._accessKeyFromFile = "";
    this._cookieFileMtimeMs = null;
    this._cookieFromFile = "";
    this._msTokenFromFile = "";
    this._fpFromFile = "";
    this._generatedFp = "";
    this._jsdomSigner = null;
    this._cachedWorkspace = null;
    this._workspacePromise = null;
  }

  _recordSecret(val) {
    if (typeof val === "string" && val.trim().length >= 4) {
      this._knownSecrets.add(val.trim());
    }
  }

  _recordCookieSecrets(cookieHeader, pairs = []) {
    if (!cookieHeader) return;
    this._recordSecret(cookieHeader);
    const extracted = pairs.length > 0 ? pairs : extractCookiePairsFromHeader(cookieHeader);
    for (const { name, value } of extracted) {
      this._recordSecret(value);
      this._recordSecret(`${name}=${value}`);
    }
  }

  redact(text) {
    // Ensure access key and cookie file secrets are loaded before redacting
    try {
      this.getAccessKey();
    } catch {
      // Ignore accessKeyFile read errors during redaction
    }
    try {
      this.getCookieHeader();
    } catch {
      // Ignore cookie file read errors during redaction
    }
    return redactSecrets(text, Array.from(this._knownSecrets));
  }

  _readAccessKeyFromFileIfNeeded() {
    if (!this.accessKeyFile) return "";
    if (!existsSync(this.accessKeyFile)) {
      throw new Error(
        `XiaoYunQue accessKeyFile does not exist: "${this.accessKeyFile}". Check options.accessKeyFile or XYQ_ACCESS_KEY_FILE.`
      );
    }
    const stat = statSync(this.accessKeyFile);
    const mtimeMs = stat.mtimeMs;
    if (this._accessKeyFileMtimeMs !== mtimeMs || !this._accessKeyFromFile) {
      const raw = readFileSync(this.accessKeyFile, "utf8");
      const key = parseAccessKeyFileContent(raw);
      this._accessKeyFromFile = key;
      this._accessKeyFileMtimeMs = mtimeMs;
      this._recordSecret(key);
    }
    return this._accessKeyFromFile;
  }

  getAccessKey() {
    if (this.configuredAccessKey) {
      return this.configuredAccessKey;
    }
    if (this.accessKeyFile) {
      return this._readAccessKeyFromFileIfNeeded();
    }
    return "";
  }

  isAccessKeyMode() {
    try {
      return Boolean(this.getAccessKey());
    } catch {
      return Boolean(this.accessKeyFile);
    }
  }

  _readCookieFromFileIfNeeded() {
    if (!this.cookieFile) return "";
    if (!existsSync(this.cookieFile)) {
      throw new Error(
        `XiaoYunQue cookieFile does not exist: "${this.cookieFile}". Check options.cookieFile or XYQ_COOKIE_FILE.`
      );
    }
    const stat = statSync(this.cookieFile);
    const mtimeMs = stat.mtimeMs;
    if (this._cookieFileMtimeMs !== mtimeMs || !this._cookieFromFile) {
      const raw = readFileSync(this.cookieFile, "utf8");
      const { cookieHeader, pairs, msToken, fp } = parseCookieFileContent(raw);
      this._cookieFromFile = cookieHeader;
      this._msTokenFromFile = msToken || "";
      this._fpFromFile = fp || "";
      this._cookieFileMtimeMs = mtimeMs;
      this._recordCookieSecrets(cookieHeader, pairs);
      this._recordSecret(this._msTokenFromFile);
      this._recordSecret(this._fpFromFile);
    }
    return this._cookieFromFile;
  }

  getCookieHeader() {
    if (this.configuredCookie) {
      return this.configuredCookie;
    }
    if (this.cookieFile) {
      return this._readCookieFromFileIfNeeded();
    }
    return "";
  }

  getMsToken() {
    if (this.configuredMsToken) {
      return this.configuredMsToken;
    }
    if (this._msTokenFromCookieHeader) {
      return this._msTokenFromCookieHeader;
    }
    if (this.cookieFile) {
      try {
        this._readCookieFromFileIfNeeded();
      } catch {
        // Ignore if cookieFile is already handled elsewhere
      }
      if (this._msTokenFromFile) {
        return this._msTokenFromFile;
      }
    }
    return "";
  }

  getFp() {
    if (this.configuredFp) {
      return this.configuredFp;
    }
    if (this._fpFromCookieHeader) {
      return this._fpFromCookieHeader;
    }
    if (this.cookieFile) {
      try {
        this._readCookieFromFileIfNeeded();
      } catch {
        // Ignore if cookieFile is already handled elsewhere
      }
      if (this._fpFromFile) {
        return this._fpFromFile;
      }
    }
    if (!this._generatedFp) {
      this._generatedFp = generateVerifyFp(this.now(), this.rng);
    }
    return this._generatedFp;
  }

  _getJsdomSigner() {
    if (!this._jsdomSigner) {
      this._jsdomSigner = createBdmsJsdomSigner({
        bdmsJsPath: this.bdmsJsPath,
        jsdomPath: this.jsdomPath,
        userAgent: DEFAULT_USER_AGENT,
        aid: Number(DEFAULT_APP_ID),
        pageId: DEFAULT_PAGE_ID,
        msToken: this.getMsToken(),
        fp: this.getFp(),
      });
    }
    return this._jsdomSigner;
  }

  close() {
    if (this._jsdomSigner) {
      this._jsdomSigner.close();
      this._jsdomSigner = null;
    }
  }

  hasCredentials() {
    try {
      if (this.getAccessKey()) return true;
    } catch {
      // Ignore accessKeyFile error in hasCredentials
    }
    try {
      return Boolean(this.getCookieHeader());
    } catch {
      return false;
    }
  }

  ensureCredentials(authMode) {
    const mode = authMode || (this.isAccessKeyMode() ? "access_key" : "cookie");
    if (mode === "access_key") {
      const accessKey = this.getAccessKey();
      if (!accessKey) {
        throw new Error(
          "XiaoYunQue Access Key is not configured. Set 'options.accessKey' or 'options.accessKeyFile' in Magpie's plugins.json " +
            "(or set XYQ_ACCESS_KEY environment variable). Create an Access Key at https://www.xiaoyunque.com/cli?tab=api."
        );
      }
      return accessKey;
    }
    const cookieHeader = this.getCookieHeader();
    if (!cookieHeader) {
      throw new Error(
        "XiaoYunQue Access Key or cookies are not configured (XiaoYunQue cookies are not configured). " +
          "Recommended: set 'options.accessKey' or 'options.accessKeyFile' in Magpie's plugins.json (or set XYQ_ACCESS_KEY env var; create a key at https://www.xiaoyunque.com/cli?tab=api). " +
          "Fallback: set 'options.cookie' or 'options.cookieFile' (or XYQ_COOKIE / XYQ_COOKIE_FILE). " +
          "How to get cookies: sign in at https://www.xiaoyunque.com, open Browser DevTools -> Application -> Cookies -> https://www.xiaoyunque.com " +
          "(copy at least sessionid, sid_tt, sid_guard, uid_tt, ttwid, s_v_web_id, plus localStorage.xmst), or export cookies to a JSON / cookies.txt file using a browser cookie extension."
      );
    }
    return cookieHeader;
  }

  buildSkillHeaders({ json = true, extraHeaders = {} } = {}) {
    const accessKey = this.getAccessKey();
    const headers = {
      Accept: "application/json",
      "User-Agent": DEFAULT_SKILL_USER_AGENT,
    };

    if (accessKey) {
      headers.Authorization = `Bearer ${accessKey}`;
    }

    if (this.teamId && this.teamId !== "0") {
      headers["X-Team-Id"] = this.teamId;
    }

    if (json) {
      headers["Content-Type"] = "application/json";
    }

    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v !== undefined && v !== null) {
        headers[k] = String(v);
      }
    }

    return headers;
  }

  buildHeaders(pathname = "/", { json = true, extraHeaders = {}, commerce = false } = {}) {
    const cookieHeader = this.getCookieHeader();
    const isCommerce = commerce || String(pathname).startsWith("/commerce/");

    const headers = {
      Accept: "application/json",
      "User-Agent": DEFAULT_USER_AGENT,
      Origin: DEFAULT_ORIGIN,
      Referer: DEFAULT_REFERER,
      appid: DEFAULT_APP_ID,
      appvr: DEFAULT_APP_VR,
      "entrance-from": "web",
      pf: DEFAULT_PF,
    };

    if (this.teamId) {
      headers["x-Team-id"] = this.teamId;
    }

    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    if (json) {
      headers["Content-Type"] = "application/json";
    }

    if (isCommerce) {
      const signInfo = computeCommerceSign(pathname, {
        nowMs: this.now(),
        pf: DEFAULT_PF,
        appvr: COMMERCE_APP_VR,
        tdid: "",
      });
      delete headers.appid;
      headers.Appid = DEFAULT_APP_ID;
      headers.pf = DEFAULT_PF;
      headers.appvr = COMMERCE_APP_VR;
      headers["sign-ver"] = "1";
      headers.tdid = "";
      headers["device-time"] = signInfo["device-time"];
      headers.sign = signInfo.sign;
    }

    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v !== undefined && v !== null) {
        headers[k] = String(v);
      }
    }

    return headers;
  }

  async request(
    path,
    {
      method = "POST",
      query,
      body,
      formData,
      headers = {},
      commerce = false,
      authMode,
      returnEnvelope = false,
      signal,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = {}
  ) {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const effectiveAuthMode =
      authMode ||
      (commerce ? "cookie" : this.isAccessKeyMode() ? "access_key" : "cookie");

    this.ensureCredentials(effectiveAuthMode);

    const activeBaseUrl = effectiveAuthMode === "access_key" ? this.skillBaseUrl : this.baseUrl;
    const urlObj = new URL(`${activeBaseUrl}${cleanPath}`);
    if (query && typeof query === "object") {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) {
          urlObj.searchParams.set(k, String(v));
        }
      }
    }

    const isForm = Boolean(formData);
    const reqHeaders =
      effectiveAuthMode === "access_key"
        ? this.buildSkillHeaders({
            json: !isForm && body !== undefined,
            extraHeaders: headers,
          })
        : this.buildHeaders(urlObj.pathname, {
            json: !isForm && body !== undefined,
            extraHeaders: headers,
            commerce,
          });

    const fetchInit = {
      method,
      headers: reqHeaders,
      signal: combineAbortSignal(signal, timeoutMs),
    };

    if (isForm) {
      fetchInit.body = formData;
    } else if (body !== undefined) {
      fetchInit.body = JSON.stringify(body);
    }

    let targetUrl = urlObj.toString();
    if (
      effectiveAuthMode !== "access_key" &&
      this.signRequests &&
      shouldSignPath(urlObj.pathname)
    ) {
      const bodyForSigning = isForm ? "" : fetchInit.body ?? "";
      targetUrl = await signRequestUrl(targetUrl, {
        method,
        body: bodyForSigning,
        userAgent: reqHeaders["User-Agent"] || DEFAULT_USER_AGENT,
        fp: this.getFp(),
        msToken: this.getMsToken(),
        aid: Number(DEFAULT_APP_ID),
        pageId: DEFAULT_PAGE_ID,
        nowMs: this.now(),
        rng: this.rng,
        signMode: this.signMode,
        jsdomSigner: this.signMode === "jsdom" ? this._getJsdomSigner() : null,
        bdmsJsPath: this.bdmsJsPath,
        jsdomPath: this.jsdomPath,
      });
    }

    let res;
    try {
      res = await fetch(targetUrl, fetchInit);
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) {
        throw err;
      }
      throw new Error(
        `XiaoYunQue request failed (${method} ${cleanPath}): ${this.redact(err?.message || String(err))}`
      );
    }

    const rawText = await res.text();
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    const ret = parsed && typeof parsed === "object" ? parsed.ret : undefined;
    const errmsg =
      parsed && typeof parsed === "object"
        ? parsed.errmsg ?? parsed.message ?? parsed.msg ?? ""
        : rawText || res.statusText;
    const logId =
      (parsed && typeof parsed === "object" ? parsed.log_id : undefined) ||
      res.headers.get("x-tt-logid") ||
      "";
    const starlingKey = parsed && typeof parsed === "object" ? parsed.starling_key ?? "" : "";
    const apiBaseResp = parsed && typeof parsed === "object" ? parsed.api_base_resp ?? null : null;

    if (!res.ok || (ret !== undefined && String(ret) !== "0")) {
      throw new XiaoYunQueApiError({
        status: res.status,
        ret: ret !== undefined ? String(ret) : String(res.status),
        errmsg,
        log_id: logId,
        starling_key: starlingKey,
        api_base_resp: apiBaseResp,
        data: parsed && typeof parsed === "object" ? parsed.data ?? null : null,
        authMode: effectiveAuthMode,
        extraSecrets: Array.from(this._knownSecrets),
      });
    }

    if (returnEnvelope) {
      return parsed;
    }
    if (parsed && typeof parsed === "object" && "data" in parsed) {
      return parsed.data;
    }
    return parsed ?? rawText;
  }

  post(path, body = {}, options = {}) {
    return this.request(path, { ...options, method: "POST", body });
  }

  get(path, options = {}) {
    return this.request(path, { ...options, method: "GET" });
  }

  async getWorkspaceInfo(signal) {
    if (this._cachedWorkspace) {
      return this._cachedWorkspace;
    }
    if (this._workspacePromise) {
      return this._workspacePromise;
    }

    const fetchWorkspace = async () => {
      const data = await this.post("/api/web/v1/workspace/get_user_workspace", {}, { signal });
      const wsId =
        String(data?.workspace_id || this.configuredWorkspaceId || "").trim();
      if (!wsId) {
        throw new Error(
          "XiaoYunQue /api/web/v1/workspace/get_user_workspace did not return a valid workspace_id."
        );
      }
      this._cachedWorkspace = {
        workspace_id: wsId,
        space_id: data?.space_id ? String(data.space_id) : null,
        space_idc: data?.space_idc ? String(data.space_idc) : null,
      };
      return this._cachedWorkspace;
    };

    this._workspacePromise = fetchWorkspace().finally(() => {
      this._workspacePromise = null;
    });
    return this._workspacePromise;
  }

  async ensureWorkspaceId(signal) {
    if (this.configuredWorkspaceId) {
      return this.configuredWorkspaceId;
    }
    if (this._cachedWorkspace?.workspace_id) {
      return this._cachedWorkspace.workspace_id;
    }
    const ws = await this.getWorkspaceInfo(signal);
    return ws.workspace_id;
  }
}
