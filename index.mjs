// Magpie / OpenCode tools plugin for XiaoYunQue (小云雀 / www.xiaoyunque.com) video generation.
// Exposes tools as xiaoyunque_<tool> via Magpie's MCP server (/mcp/magpie/tools).
import {
  COMMERCE_APP_VR,
  DEFAULT_APP_ID,
  DEFAULT_APP_VR,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ORIGIN,
  DEFAULT_PF,
  DEFAULT_REFERER,
  DEFAULT_SKILL_BASE_URL,
  DEFAULT_SKILL_USER_AGENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  XiaoYunQueApiError,
  XiaoYunQueClient,
  combineAbortSignal,
  computeCommerceSign,
  extractCookiePairsFromHeader,
  extractSessionTokensFromPairs,
  isXiaoYunQueDomain,
  parseAccessKeyFileContent,
  parseCookieFileContent,
  redactSecrets,
} from "./src/client.mjs";
import {
  ALL_MODEL_KEYS,
  RATIO_CODE_MAP,
  SEEDANCE_MODEL_KEYS,
  SILENT_PROMPT_SUFFIX,
  STANDARD_SEEDANCE_RATIOS,
  STATIC_MODELS_BY_KEY,
  STATIC_VIDEO_MODELS,
  VIP_LEVEL_NAMES,
  buildSchemaFromLiveModel,
  findStaticModel,
  formatStaticModelForList,
  formatVipLevel,
  inferCreationMode,
  mapRatioCodes,
  normalizeLiveModelItem,
  resolveAndValidateVideoParams,
} from "./src/models.mjs";
import {
  BDMS_INCLUDE_PATH_PATTERNS,
  DEFAULT_AID,
  DEFAULT_PAGE_ID,
  DEFAULT_SDK_VERSION,
  DEFAULT_SDK_VERSION_BYTES,
  DEFAULT_SIGN_USER_AGENT,
  SM3,
  VERIFY_CENTER_INCLUDE_PATH_PATTERNS,
  bdmsRandom,
  computeABogus,
  createBdmsJsdomSigner,
  dyBase64,
  dyRc4,
  generateVerifyFp,
  serializeBodyForSigning,
  shouldAddVerifyFp,
  shouldSignPath,
  signRequestUrl,
  sm3Digest,
  sm3DigestTwice,
  u88Transform,
} from "./src/signer.mjs";
import { MagpieAccountPool } from "./src/magpie-auth.mjs";
import {
  MAX_UPLOAD_BYTES,
  RUN_STATE_MAP,
  createTools,
  downloadTaskVideosIfRequested,
  getTaskHelper,
  normalizeCreditBalance,
  normalizeRunToTaskResult,
  parseTaskIdentifier,
  unescapeUrl,
  uploadImageHelper,
  uploadMediaHelper,
  waitTaskHelper,
} from "./src/tools.mjs";

const PROVIDER_ID = "xiaoyunque";
const PROVIDER_NAME = "小云雀 (XiaoYunQue)";

function detectSavedCredentialMode(entry) {
  const explicit = String(entry?.metadata?.mode ?? entry?.mode ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "cookie" || explicit === "web" || explicit === "session") {
    return "cookie";
  }
  if (
    explicit === "access_key" ||
    explicit === "accesskey" ||
    explicit === "ak" ||
    explicit === "api" ||
    explicit === "skill"
  ) {
    return "access_key";
  }

  const raw = String(entry?.key || entry?.access || "").trim();
  if (!raw) return "access_key";

  if (raw.startsWith("[")) {
    return "cookie";
  }
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.cookies) || Array.isArray(parsed?.data?.cookies)) {
        return "cookie";
      }
      if (
        parsed?.access_key ||
        parsed?.accessKey ||
        parsed?.token ||
        parsed?.data?.access_key ||
        parsed?.data?.accessKey
      ) {
        return "access_key";
      }
    } catch {
      // Fall through to text heuristics
    }
  }
  if (
    /^#\s*(?:Netscape|HTTP Cookie File)/im.test(raw) ||
    /^#HttpOnly_/m.test(raw) ||
    raw.split(/\r?\n/).some((l) => !l.trim().startsWith("#") && l.split("\t").length >= 7)
  ) {
    return "cookie";
  }
  if (
    /^cookie\s*:/i.test(raw) ||
    /\b(?:sessionid(?:_ss)?|sid_tt|sid_guard|uid_tt(?:_ss)?|ttwid|odin_tt)\s*=/i.test(raw) ||
    (raw.includes(";") && extractCookiePairsFromHeader(raw).length >= 2)
  ) {
    return "cookie";
  }
  return "access_key";
}

function createClientFromSaved(baseOptions, entry) {
  const {
    accessKey: _ak,
    accessKeyFile: _akf,
    cookie: _ck,
    cookieFile: _ckf,
    msToken: _ms,
    xmst: _xm,
    fp: _fp,
    verifyFp: _vfp,
    workspaceId: _ws,
    ...sharedOptions
  } = baseOptions || {};

  const raw = String(entry?.key || entry?.access || "").trim();
  const mode = detectSavedCredentialMode(entry);
  const teamId = entry?.metadata?.teamId ?? sharedOptions.teamId;

  if (mode === "cookie") {
    const parsed = parseCookieFileContent(raw);
    return new XiaoYunQueClient({
      ...sharedOptions,
      ...(teamId !== undefined ? { teamId } : {}),
      accessKey: "",
      accessKeyFile: "",
      cookie: parsed.cookieHeader || raw,
      cookieFile: "",
      msToken: parsed.msToken || "",
      fp: parsed.fp || "",
      workspaceId: entry?.metadata?.workspaceId ? String(entry.metadata.workspaceId).trim() : "",
    });
  }

  return new XiaoYunQueClient({
    ...sharedOptions,
    ...(teamId !== undefined ? { teamId } : {}),
    accessKey: parseAccessKeyFileContent(raw) || raw,
    accessKeyFile: "",
    cookie: "",
    cookieFile: "",
    msToken: "",
    fp: "",
    workspaceId: "",
  });
}

export const XiaoYunQuePlugin = async (_input, options = {}) => {
  const pool = new MagpieAccountPool({
    providerId: PROVIDER_ID,
    defaultDirectory: _input?.directory,
    clientAuth: _input?.client?.auth,
    legacyOptions: options,
    createClientFromSaved: (entry) => createClientFromSaved(options, entry),
    createLegacyClient: (opts) => new XiaoYunQueClient(opts),
  });

  return {
    async config(cfg) {
      cfg.provider = cfg.provider ?? {};
      cfg.provider[PROVIDER_ID] = {
        ...(cfg.provider[PROVIDER_ID] ?? {}),
        name: PROVIDER_NAME,
      };
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "Access Key（推荐）",
          placeholder: "粘贴小云雀 Access Key（在 https://www.xiaoyunque.com/cli?tab=api 创建）",
          prompts: [
            {
              type: "text",
              key: "email",
              message: "账号备注名（可选，如 主号 / 剪辑号，用于多账号区分）",
              placeholder: "主号",
            },
          ],
        },
        {
          type: "api",
          label: "网页端 Cookie / Session JSON",
          placeholder:
            "粘贴浏览器 Cookie 请求头（sessionid=...）或导出的 xiaoyunque-session.json 全文",
          prompts: [
            {
              type: "text",
              key: "email",
              message: "账号备注名（可选，如 网页号，用于多账号区分）",
              placeholder: "网页号",
            },
            {
              type: "select",
              key: "mode",
              message: "认证模式标记（保持默认即可）",
              options: [
                {
                  label: "网页端 Cookie / Session JSON",
                  value: "cookie",
                },
              ],
            },
          ],
        },
      ],

      async usage(getAuth, _provider, opts) {
        const saved = await getAuth();
        if (!saved) return { windows: [] };
        const c = createClientFromSaved(options, saved);
        if (!c.isAccessKeyMode()) {
          return { windows: [] };
        }
        const data = await c.post(
          "/api/biz/v1/skill/get_credit_balance",
          {},
          { signal: opts?.signal }
        );
        const credit = normalizeCreditBalance(data);
        return {
          windows: [
            {
              name: "积分",
              balance: Number(credit?.total ?? 0),
              unit: "积分",
            },
          ],
        };
      },
    },

    tool: createTools(pool),
  };
};

export const _internal = {
  PROVIDER_ID,
  PROVIDER_NAME,
  MagpieAccountPool,
  detectSavedCredentialMode,
  createClientFromSaved,
  COMMERCE_APP_VR,
  DEFAULT_APP_ID,
  DEFAULT_APP_VR,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ORIGIN,
  DEFAULT_PF,
  DEFAULT_REFERER,
  DEFAULT_SKILL_BASE_URL,
  DEFAULT_SKILL_USER_AGENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_UPLOAD_BYTES,
  RUN_STATE_MAP,
  XiaoYunQueApiError,
  XiaoYunQueClient,
  combineAbortSignal,
  computeCommerceSign,
  extractCookiePairsFromHeader,
  extractSessionTokensFromPairs,
  isXiaoYunQueDomain,
  parseAccessKeyFileContent,
  parseCookieFileContent,
  redactSecrets,
  BDMS_INCLUDE_PATH_PATTERNS,
  DEFAULT_AID,
  DEFAULT_PAGE_ID,
  DEFAULT_SDK_VERSION,
  DEFAULT_SDK_VERSION_BYTES,
  DEFAULT_SIGN_USER_AGENT,
  SM3,
  VERIFY_CENTER_INCLUDE_PATH_PATTERNS,
  bdmsRandom,
  computeABogus,
  createBdmsJsdomSigner,
  dyBase64,
  dyRc4,
  generateVerifyFp,
  serializeBodyForSigning,
  shouldAddVerifyFp,
  shouldSignPath,
  signRequestUrl,
  sm3Digest,
  sm3DigestTwice,
  u88Transform,
  ALL_MODEL_KEYS,
  RATIO_CODE_MAP,
  SEEDANCE_MODEL_KEYS,
  SILENT_PROMPT_SUFFIX,
  STANDARD_SEEDANCE_RATIOS,
  STATIC_MODELS_BY_KEY,
  STATIC_VIDEO_MODELS,
  VIP_LEVEL_NAMES,
  buildSchemaFromLiveModel,
  findStaticModel,
  formatStaticModelForList,
  formatVipLevel,
  inferCreationMode,
  mapRatioCodes,
  normalizeLiveModelItem,
  resolveAndValidateVideoParams,
  createTools,
  downloadTaskVideosIfRequested,
  getTaskHelper,
  normalizeCreditBalance,
  normalizeRunToTaskResult,
  parseTaskIdentifier,
  unescapeUrl,
  uploadImageHelper,
  uploadMediaHelper,
  waitTaskHelper,
};
