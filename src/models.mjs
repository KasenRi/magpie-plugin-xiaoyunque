// Static video model schemas, ratio/VIP mappings, live model normalization,
// and parameter validation for XiaoYunQue (www.xiaoyunque.com).

export const SILENT_PROMPT_SUFFIX = "（全片无对白、无旁白、无背景音乐，静音）";

export const RATIO_CODE_MAP = {
  0: "adaptive",
  2: "16:9",
  13: "21:9",
  3: "9:16",
  4: "1:1",
  5: "4:3",
  6: "3:4",
  // Additional Pippit CLI ratio codes (describe.go)
  7: "2:1",
  8: "2.35:1",
  9: "1.85:1",
  11: "3:2",
  12: "2:3",
};

export const VIP_LEVEL_NAMES = {
  free: "free (免费版)",
  standard: "standard (基础会员)",
  pro: "pro (标准会员)",
  max: "max (高级会员)",
  ultra: "ultra (超级会员)",
};

export function formatVipLevel(rawLevel) {
  const key = typeof rawLevel === "string" && rawLevel.trim() ? rawLevel.trim().toLowerCase() : "free";
  return {
    cur_vip_level: key,
    vip_level_name: VIP_LEVEL_NAMES[key] ?? `${key}`,
  };
}

export function mapRatioCodes(codes) {
  if (!Array.isArray(codes)) return [];
  const out = [];
  for (const code of codes) {
    if (typeof code === "string" && code.trim()) {
      const mapped = RATIO_CODE_MAP[code.trim()] ?? code.trim();
      if (!out.includes(mapped)) out.push(mapped);
    } else if (typeof code === "number" && RATIO_CODE_MAP[code]) {
      const mapped = RATIO_CODE_MAP[code];
      if (!out.includes(mapped)) out.push(mapped);
    }
  }
  return out;
}

export const STANDARD_SEEDANCE_RATIOS = ["adaptive", "16:9", "21:9", "9:16", "1:1", "4:3", "3:4"];

// Complete static table of all 11 models from docs/API.md Section 3.2 & Section 7.2
export const STATIC_VIDEO_MODELS = [
  {
    key: "Seedance_2.5_draft",
    name: "Seedance 2.5 Draft",
    abbreviated_name: "SD 2.5 Draft",
    disabled: false,
    is_seedance: true,
    is_seedance_25: true,
    is_draft: true,
    has_resolution_dimension: false,
    durations: { min: 4, max: 30, step: 1, default: 10 },
    resolutions: "server default 720p",
    allowed_resolutions: ["480p"],
    default_resolution: "480p",
    ratios: STANDARD_SEEDANCE_RATIOS,
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: true, last_frame: true },
    reference_limits: { total: 50, image: 30, video: 10, audio: 10 },
    creation_modes: ["reference_generation", "video_edit", "video_extend", "first_last_frame"],
    pricing_policy: "output_only",
    credits_per_second: { "480p": 9, default: 9 },
  },
  {
    key: "Seedance_2.5",
    name: "Seedance 2.5",
    abbreviated_name: "SD 2.5",
    disabled: false,
    is_seedance: true,
    is_seedance_25: true,
    is_draft: false,
    has_resolution_dimension: true,
    durations: { min: 4, max: 30, step: 1, default: 10 },
    resolutions: ["480p", "720p", "1080p", "4k"],
    allowed_resolutions: ["480p", "720p", "1080p", "4k"],
    default_resolution: "720p",
    ratios: STANDARD_SEEDANCE_RATIOS,
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: true, last_frame: true },
    reference_limits: { total: 50, image: 30, video: 10, audio: 10 },
    creation_modes: ["reference_generation", "video_edit", "video_extend", "first_last_frame"],
    pricing_policy: "output_only",
    credits_per_second: { "480p": 12, "720p": 20, "1080p": 64, "4k": 99 },
  },
  {
    key: "seedance2.0_fast_vision",
    name: "Seedance 2.0 Fast VIP",
    abbreviated_name: "SD 2.0 Fast VIP",
    disabled: false,
    is_seedance: true,
    is_seedance_25: false,
    is_draft: false,
    has_resolution_dimension: true,
    durations: { min: 4, max: 15, step: 1, default: 10 },
    resolutions: ["480p", "720p"],
    allowed_resolutions: ["480p", "720p"],
    default_resolution: "720p",
    ratios: STANDARD_SEEDANCE_RATIOS,
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: true, last_frame: true },
    reference_limits: { total: 12, image: 9, video: 3, audio: 3 },
    creation_modes: ["reference_generation", "first_last_frame"],
    pricing_policy: "output_only",
    credits_per_second: { "480p": 3, "720p": 6 },
  },
  {
    key: "seedance2.0_vision",
    name: "Seedance 2.0 VIP",
    abbreviated_name: "SD 2.0 VIP",
    disabled: false,
    is_seedance: true,
    is_seedance_25: false,
    is_draft: false,
    has_resolution_dimension: true,
    durations: { min: 4, max: 15, step: 1, default: 10 },
    resolutions: ["480p", "720p", "1080p", "4k"],
    allowed_resolutions: ["480p", "720p", "1080p", "4k"],
    default_resolution: "720p",
    ratios: STANDARD_SEEDANCE_RATIOS,
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: true, last_frame: true },
    reference_limits: { total: 12, image: 9, video: 3, audio: 3 },
    creation_modes: ["reference_generation", "first_last_frame"],
    pricing_policy: "output_only",
    credits_per_second: { "480p": 8, "720p": 14, "1080p": 33, "4k": 80 },
  },
  {
    key: "Seedance_2.0_mini_lite",
    name: "Seedance 2.0 Mini 体验版",
    abbreviated_name: "2.0 Mini 体验版",
    disabled: false,
    is_seedance: true,
    is_seedance_25: false,
    is_draft: false,
    has_resolution_dimension: false,
    durations: { min: 4, max: 15, step: 1, default: 10 },
    resolutions: "server default 720p",
    allowed_resolutions: ["720p"],
    default_resolution: "720p",
    ratios: STANDARD_SEEDANCE_RATIOS,
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: true, last_frame: true },
    reference_limits: { total: 12, image: 9, video: 3, audio: 3 },
    creation_modes: ["reference_generation", "first_last_frame"],
    pricing_policy: "output_only",
    credits_per_second: { "720p": 4, default: 4 },
  },
  {
    key: "Seedance_2.0_mini",
    name: "Seedance 2.0 Mini",
    abbreviated_name: "SD 2.0 Mini",
    disabled: false,
    is_seedance: true,
    is_seedance_25: false,
    is_draft: false,
    has_resolution_dimension: false,
    durations: { min: 4, max: 15, step: 1, default: 10 },
    resolutions: "server default 720p",
    allowed_resolutions: ["720p"],
    default_resolution: "720p",
    ratios: STANDARD_SEEDANCE_RATIOS,
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: true, last_frame: true },
    reference_limits: { total: 12, image: 9, video: 3, audio: 3 },
    creation_modes: ["reference_generation", "first_last_frame"],
    pricing_policy: "output_only",
    credits_per_second: { "720p": 6, default: 6 },
  },
  {
    key: "wan3.0",
    name: "Wan 3.0",
    abbreviated_name: "Wan 3.0",
    disabled: false,
    is_seedance: false,
    is_seedance_25: false,
    is_draft: false,
    has_resolution_dimension: true,
    durations: { min: 4, max: 30, step: 1, default: 10 },
    resolutions: ["480p", "720p", "1080p"],
    allowed_resolutions: ["480p", "720p", "1080p"],
    default_resolution: "720p",
    ratios: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4"],
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: true, last_frame: true },
    reference_limits: { total: 15, image: 10, video: 5, audio: 0 },
    creation_modes: ["reference_generation", "first_last_frame"],
    pricing_policy: "output_only",
    credits_per_second: { "480p": 7, "720p": 14, "1080p": 33 },
  },
  {
    key: "happyhorse-1.1",
    name: "HappyHorse 1.1",
    abbreviated_name: "HappyHorse 1.1",
    disabled: false,
    is_seedance: false,
    is_seedance_25: false,
    is_draft: false,
    has_resolution_dimension: true,
    durations: { min: 3, max: 15, step: 1, default: 5 },
    resolutions: ["720p", "1080p"],
    allowed_resolutions: ["720p", "1080p"],
    default_resolution: "720p",
    ratios: ["16:9", "21:9", "9:16", "1:1", "4:3", "3:4"],
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: false, last_frame: false },
    reference_limits: { total: 9, image: 9, video: 0, audio: 0 },
    creation_modes: ["reference_generation"],
    pricing_policy: "output_only",
    credits_per_second: { "720p": 14, "1080p": 18 },
  },
  {
    key: "seedance2.0_direct",
    name: "Seedance 2.0",
    abbreviated_name: "SD 2.0",
    disabled: false,
    is_seedance: true,
    is_seedance_25: false,
    is_draft: false,
    has_resolution_dimension: true,
    durations: { min: 4, max: 15, step: 1, default: 4 },
    resolutions: ["480p", "720p"],
    allowed_resolutions: ["480p", "720p"],
    default_resolution: "480p",
    ratios: STANDARD_SEEDANCE_RATIOS,
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: true, last_frame: true },
    reference_limits: { total: 12, image: 9, video: 3, audio: 0 },
    creation_modes: ["reference_generation", "first_last_frame"],
    pricing_policy: "output_plus_reference",
    credits_per_second: { "480p": 7, "720p": 8 },
  },
  {
    key: "seedance2.0_fast_direct",
    name: "Seedance 2.0 Fast",
    abbreviated_name: "SD 2.0 Fast",
    disabled: false,
    is_seedance: true,
    is_seedance_25: false,
    is_draft: false,
    has_resolution_dimension: false,
    durations: { min: 4, max: 15, step: 1, default: 10 },
    resolutions: "server default 720p",
    allowed_resolutions: ["720p"],
    default_resolution: "720p",
    ratios: STANDARD_SEEDANCE_RATIOS,
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: true, last_frame: true },
    reference_limits: { total: 12, image: 9, video: 3, audio: 0 },
    creation_modes: ["reference_generation", "first_last_frame"],
    pricing_policy: "output_plus_reference",
    credits_per_second: { "720p": 5, default: 5 },
  },
  {
    key: "Seedance_1.0_fast",
    name: "Seedance 1.0 Fast",
    abbreviated_name: "SD 1.0 Fast",
    disabled: false,
    is_seedance: true,
    is_seedance_25: false,
    is_draft: false,
    has_resolution_dimension: true,
    durations: { min: 2, max: 12, step: 1, default: 5 },
    resolutions: ["720p", "1080p"],
    allowed_resolutions: ["720p", "1080p"],
    default_resolution: "720p",
    ratios: STANDARD_SEEDANCE_RATIOS,
    default_ratio: "16:9",
    first_last_frame_support: { first_frame: true, last_frame: false },
    reference_limits: { total: 1, image: 1, video: 0, audio: 0 },
    creation_modes: ["first_last_frame"],
    pricing_policy: "output_only",
    credits_per_second: { "720p": 2, "1080p": 4 },
  },
];

export const ALL_MODEL_KEYS = STATIC_VIDEO_MODELS.map((m) => m.key);
export const SEEDANCE_MODEL_KEYS = STATIC_VIDEO_MODELS.filter((m) => m.is_seedance).map((m) => m.key);

export const STATIC_MODELS_BY_KEY = Object.fromEntries(
  STATIC_VIDEO_MODELS.map((m) => [m.key, m])
);

const MODEL_ALIASES = {
  "seedance1.0_fast": "Seedance_1.0_fast",
  seedance1_fast: "Seedance_1.0_fast",
  "seedance_2.0": "seedance2.0_vision",
  "seedance2.0": "seedance2.0_vision",
  "seedance_2.0_fast": "seedance2.0_fast_vision",
  "seedance2.0_fast": "seedance2.0_fast_vision",
  seedance_2_0_mini_lite: "Seedance_2.0_mini_lite",
  "seedance_2.0_mini_lite": "Seedance_2.0_mini_lite",
  "seedance2.0_mini_lite": "Seedance_2.0_mini_lite",
  "seedance2.0_mini": "Seedance_2.0_mini",
  "seedance_2.0_mini": "Seedance_2.0_mini",
  "seedance2.5": "Seedance_2.5",
  "seedance_2.5": "Seedance_2.5",
  "seedance2.5_draft": "Seedance_2.5_draft",
  "seedance_2.5_draft": "Seedance_2.5_draft",
};

export function findStaticModel(rawKey) {
  if (typeof rawKey !== "string" || !rawKey.trim()) return null;
  const trimmed = rawKey.trim();
  if (STATIC_MODELS_BY_KEY[trimmed]) return STATIC_MODELS_BY_KEY[trimmed];
  const lower = trimmed.toLowerCase();
  const byCase = STATIC_VIDEO_MODELS.find((m) => m.key.toLowerCase() === lower);
  if (byCase) return byCase;
  const aliased = MODEL_ALIASES[lower];
  if (aliased && STATIC_MODELS_BY_KEY[aliased]) return STATIC_MODELS_BY_KEY[aliased];
  return null;
}

export function formatStaticModelForList(model) {
  return {
    key: model.key,
    name: model.name,
    disabled: Boolean(model.disabled),
    durations: {
      min: model.durations.min,
      max: model.durations.max,
      default: model.durations.default,
    },
    resolutions: Array.isArray(model.resolutions) ? [...model.resolutions] : model.resolutions,
    ratios: [...model.ratios],
    first_last_frame_support: { ...model.first_last_frame_support },
    reference_limits: { ...model.reference_limits },
    creation_modes: [...model.creation_modes],
    credits_per_second: { ...model.credits_per_second },
  };
}

export function normalizeLiveModelItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key ?? raw.id ?? "").trim();
  if (!key) return null;
  const staticFallback = findStaticModel(key);

  const dims = Array.isArray(raw.parameter_config?.dimensions)
    ? raw.parameter_config.dimensions
    : [];

  const durDim = dims.find((d) => d && d.key === "duration");
  const rc = durDim?.range_config;
  const durMin =
    rc?.min_value ?? rc?.min ?? raw.durations?.min ?? staticFallback?.durations?.min ?? 4;
  const durMax =
    rc?.max_value ?? rc?.max ?? raw.durations?.max ?? staticFallback?.durations?.max ?? 15;
  const durDef =
    (durDim?.default_value !== undefined ? Number(durDim.default_value) : undefined) ??
    raw.durations?.default ??
    staticFallback?.durations?.default ??
    10;

  const resDim = dims.find((d) => d && d.key === "resolution");
  const rawResOptions = Array.isArray(resDim?.option_list)
    ? resDim.option_list
    : Array.isArray(resDim?.options)
    ? resDim.options
    : null;

  let resolutions;
  if (rawResOptions && rawResOptions.length > 0) {
    resolutions = rawResOptions
      .filter((o) => o && !o.disabled && o.value)
      .map((o) => String(o.value));
  } else if (Array.isArray(raw.resolutions) && raw.resolutions.length > 0) {
    resolutions = raw.resolutions.map(String);
  } else {
    resolutions = "server default 720p";
  }

  const ratios = Array.isArray(raw.supported_ratio_list)
    ? mapRatioCodes(raw.supported_ratio_list)
    : Array.isArray(raw.ratios)
    ? mapRatioCodes(raw.ratios)
    : staticFallback
    ? [...staticFallback.ratios]
    : [...STANDARD_SEEDANCE_RATIOS];

  const firstFrame =
    raw.is_support_first_frame_image ??
    raw.first_last_frame_support?.first_frame ??
    staticFallback?.first_last_frame_support?.first_frame ??
    true;
  const lastFrame =
    raw.is_support_last_frame_image ??
    raw.first_last_frame_support?.last_frame ??
    staticFallback?.first_last_frame_support?.last_frame ??
    true;

  const imageLimit =
    raw.image_total_limit ?? raw.reference_limits?.image ?? staticFallback?.reference_limits?.image ?? 0;
  const videoLimit =
    raw.video_total_limit ?? raw.reference_limits?.video ?? staticFallback?.reference_limits?.video ?? 0;
  const audioLimit =
    raw.audio_total_limit ?? raw.reference_limits?.audio ?? staticFallback?.reference_limits?.audio ?? 0;
  const totalLimit =
    raw.total_limit ??
    raw.reference_limits?.total ??
    staticFallback?.reference_limits?.total ??
    imageLimit + videoLimit + audioLimit;

  const liveModes = Array.isArray(raw.creation_mode_config?.modes)
    ? raw.creation_mode_config.modes.filter((m) => m && m.enabled !== false && m.key).map((m) => m.key)
    : Array.isArray(raw.creation_modes)
    ? raw.creation_modes
    : null;

  const creationModes =
    liveModes && liveModes.length > 0
      ? liveModes
      : staticFallback
      ? [...staticFallback.creation_modes]
      : firstFrame
      ? ["reference_generation", "first_last_frame"]
      : ["reference_generation"];

  return {
    key,
    name: raw.name ?? staticFallback?.name ?? key,
    disabled: Boolean(raw.disabled),
    durations: {
      min: Number(durMin),
      max: Number(durMax),
      default: Number.isFinite(durDef) ? durDef : 10,
    },
    resolutions,
    ratios,
    first_last_frame_support: {
      first_frame: Boolean(firstFrame),
      last_frame: Boolean(lastFrame),
    },
    reference_limits: {
      total: totalLimit,
      image: imageLimit,
      video: videoLimit,
      audio: audioLimit,
    },
    creation_modes: creationModes,
    ...(staticFallback?.credits_per_second
      ? { credits_per_second: { ...staticFallback.credits_per_second } }
      : {}),
  };
}

export function buildSchemaFromLiveModel(liveNormalized) {
  const is25 =
    liveNormalized.key === "Seedance_2.5" ||
    liveNormalized.key === "Seedance_2.5_draft" ||
    liveNormalized.creation_modes?.includes("video_edit");
  const isDraft = liveNormalized.key === "Seedance_2.5_draft";
  const hasResDim = Array.isArray(liveNormalized.resolutions) && liveNormalized.resolutions.length > 0;
  return {
    key: liveNormalized.key,
    name: liveNormalized.name || liveNormalized.key,
    disabled: Boolean(liveNormalized.disabled),
    is_seedance: liveNormalized.key.toLowerCase().includes("seedance"),
    is_seedance_25: is25,
    is_draft: isDraft,
    has_resolution_dimension: hasResDim,
    durations: {
      min: liveNormalized.durations?.min ?? 4,
      max: liveNormalized.durations?.max ?? 15,
      step: 1,
      default: liveNormalized.durations?.default ?? 10,
    },
    resolutions: liveNormalized.resolutions,
    allowed_resolutions: hasResDim ? liveNormalized.resolutions : isDraft ? ["480p"] : ["720p"],
    default_resolution: hasResDim ? liveNormalized.resolutions[0] : isDraft ? "480p" : "720p",
    ratios:
      Array.isArray(liveNormalized.ratios) && liveNormalized.ratios.length > 0
        ? liveNormalized.ratios
        : STANDARD_SEEDANCE_RATIOS,
    default_ratio:
      Array.isArray(liveNormalized.ratios) && liveNormalized.ratios.includes("16:9")
        ? "16:9"
        : liveNormalized.ratios?.[0] ?? "16:9",
    first_last_frame_support: liveNormalized.first_last_frame_support ?? {
      first_frame: true,
      last_frame: true,
    },
    reference_limits: liveNormalized.reference_limits ?? {
      total: 12,
      image: 9,
      video: 3,
      audio: 3,
    },
    creation_modes: liveNormalized.creation_modes ?? ["reference_generation", "first_last_frame"],
    pricing_policy: "output_only",
    credits_per_second: liveNormalized.credits_per_second ?? {},
  };
}

const MODE_ALIASES = {
  auto: "auto",
  t2v: "t2v",
  text_to_video: "t2v",
  first_last_frame: "first_last_frame",
  firstlast: "first_last_frame",
  i2v: "first_last_frame",
  reference: "reference",
  reference_generation: "reference",
  ref2v: "reference",
  edit: "edit",
  video_edit: "edit",
  extend: "extend",
  video_extend: "extend",
};

export function inferCreationMode({
  mode,
  first_frame,
  last_frame,
  reference_images,
  reference_videos,
  reference_audios,
}) {
  const rawMode = mode !== undefined && mode !== null && String(mode).trim() !== "" ? String(mode).trim().toLowerCase() : "auto";
  const normalized = MODE_ALIASES[rawMode];
  if (!normalized) {
    throw new Error(
      `Invalid 'mode' ("${mode}"). Allowed modes: auto, t2v, first_last_frame, reference, edit, extend.`
    );
  }
  if (normalized !== "auto") {
    return normalized;
  }
  const hasFirst = first_frame !== undefined && first_frame !== null && first_frame !== "";
  const hasLast = last_frame !== undefined && last_frame !== null && last_frame !== "";
  if (hasFirst || hasLast) {
    return "first_last_frame";
  }
  const hasRefImg = Array.isArray(reference_images) && reference_images.length > 0;
  const hasRefVid = Array.isArray(reference_videos) && reference_videos.length > 0;
  const hasRefAud = Array.isArray(reference_audios) && reference_audios.length > 0;
  if (hasRefImg || hasRefVid || hasRefAud) {
    return "reference";
  }
  return "t2v";
}

function validateMediaArray(arr, fieldName) {
  if (arr === undefined || arr === null) return [];
  if (!Array.isArray(arr)) {
    throw new Error(`Invalid '${fieldName}': expected an array.`);
  }
  return arr.map((item, idx) => {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) {
        throw new Error(`Invalid '${fieldName}[${idx}]': string cannot be empty.`);
      }
      return trimmed;
    }
    if (item && typeof item === "object" && (item.asset_id || item.pippit_asset_id || item.url)) {
      return item;
    }
    throw new Error(
      `Invalid '${fieldName}[${idx}]': expected a URL/path/base64 string or an uploaded asset object {asset_id, ...}.`
    );
  });
}

export function resolveAndValidateVideoParams(
  args = {},
  { defaultModel = "Seedance_2.5", requirePrompt = true, liveModelItem = null } = {}
) {
  if (!args || typeof args !== "object") {
    throw new Error("Arguments must be an object.");
  }

  // 1. Validate output_format first (only "mp4" accepted on XiaoYunQue)
  if (args.output_format !== undefined && args.output_format !== null && String(args.output_format).trim() !== "") {
    const fmt = String(args.output_format).trim().toLowerCase();
    if (fmt !== "mp4") {
      throw new Error(
        `Invalid 'output_format' ("${args.output_format}"): XiaoYunQue only outputs MP4 ("mp4"); "${args.output_format}" is not supported.`
      );
    }
  }

  // 2. Check Seedance 2.5 draft -> final upgrade (Stage 2)
  const draftTaskId =
    typeof args.draft_task_id === "string" && args.draft_task_id.trim()
      ? args.draft_task_id.trim()
      : undefined;
  if (draftTaskId) {
    const upgradePrompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    return {
      isDraftUpgrade: true,
      draft_task_id: draftTaskId,
      model: "Seedance_2.5_draft",
      schema: STATIC_MODELS_BY_KEY["Seedance_2.5_draft"],
      prompt: upgradePrompt,
      mode: "draft_upgrade",
      duration: 10,
      aspect_ratio: "16:9",
      resolution: undefined,
      audio: true,
      audio_control: undefined,
      warning: undefined,
      param: {
        draft: false,
        draft_task_id: draftTaskId,
        model: "Seedance_2.5_draft",
        prompt: upgradePrompt,
      },
    };
  }

  // 3. Validate prompt
  let prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (requirePrompt && !prompt) {
    throw new Error("Invalid 'prompt': a non-empty string prompt is required (unless 'draft_task_id' is set).");
  }

  // 4. Resolve and validate model
  const rawModelKey =
    args.model === undefined || args.model === null || String(args.model).trim() === ""
      ? defaultModel
      : String(args.model).trim();

  let schema = findStaticModel(rawModelKey);
  let warning;
  if (!schema && liveModelItem) {
    const normalizedLive = normalizeLiveModelItem(liveModelItem);
    if (normalizedLive) {
      schema = buildSchemaFromLiveModel(normalizedLive);
      warning = `Model "${rawModelKey}" is not in the static model table; validated against live get_available_model_list.`;
    }
  }
  if (!schema) {
    throw new Error(
      `Invalid 'model' ("${rawModelKey}"). Allowed models: ${ALL_MODEL_KEYS.join(", ")}.`
    );
  }

  const modelKey = schema.key;

  // 5. Audio handling (XiaoYunQue has no audio boolean switch; append prompt hint when audio=false)
  let audio = true;
  let audioControl;
  if (args.audio !== undefined && args.audio !== null) {
    if (typeof args.audio !== "boolean") {
      throw new Error(`Invalid 'audio' (${args.audio}): must be a boolean (true or false).`);
    }
    audio = args.audio;
  }
  if (audio === false) {
    audioControl = "prompt_hint";
    if (prompt && !prompt.includes("无对白") && !prompt.endsWith(SILENT_PROMPT_SUFFIX)) {
      prompt = `${prompt}${SILENT_PROMPT_SUFFIX}`;
    } else if (!prompt) {
      prompt = SILENT_PROMPT_SUFFIX;
    }
  }

  // 6. Validate media inputs & resolve mode
  const firstFrame =
    args.first_frame !== undefined && args.first_frame !== null && args.first_frame !== ""
      ? args.first_frame
      : undefined;
  const lastFrame =
    args.last_frame !== undefined && args.last_frame !== null && args.last_frame !== ""
      ? args.last_frame
      : undefined;
  const refImages = validateMediaArray(args.reference_images, "reference_images");
  const refVideos = validateMediaArray(args.reference_videos, "reference_videos");
  const refAudios = validateMediaArray(args.reference_audios, "reference_audios");

  const mode = inferCreationMode({
    mode: args.mode,
    first_frame: firstFrame,
    last_frame: lastFrame,
    reference_images: refImages,
    reference_videos: refVideos,
    reference_audios: refAudios,
  });

  if ((mode === "edit" || mode === "extend") && !schema.is_seedance_25) {
    throw new Error(
      `Invalid 'mode' ("${mode}") for model "${modelKey}": video edit and extend modes are only supported on Seedance_2.5 and Seedance_2.5_draft.`
    );
  }

  if (mode === "first_last_frame") {
    if (!schema.first_last_frame_support.first_frame) {
      throw new Error(
        `Model "${modelKey}" does not support 'first_last_frame' mode (first_frame_support is false). Use mode 'reference' or 't2v'.`
      );
    }
    if (!firstFrame) {
      throw new Error(
        `Mode 'first_last_frame' requires 'first_frame' (cannot provide 'last_frame' alone without 'first_frame').`
      );
    }
    if (lastFrame && !schema.first_last_frame_support.last_frame) {
      throw new Error(
        `Model "${modelKey}" supports 'first_frame' only and does not support 'last_frame'.`
      );
    }
  } else if (mode === "edit") {
    if (refVideos.length < 1) {
      throw new Error(`Mode 'edit' on model "${modelKey}" requires at least 1 video in 'reference_videos'.`);
    }
  } else if (mode === "extend") {
    if (refVideos.length < 1) {
      throw new Error(`Mode 'extend' on model "${modelKey}" requires at least 1 video in 'reference_videos'.`);
    }
  }

  // Validate reference material limits
  const limits = schema.reference_limits;
  if (refImages.length > limits.image) {
    throw new Error(
      `Too many 'reference_images' (${refImages.length}) for model "${modelKey}". Maximum allowed: ${limits.image}.`
    );
  }
  if (refVideos.length > limits.video) {
    throw new Error(
      `Too many 'reference_videos' (${refVideos.length}) for model "${modelKey}". Maximum allowed: ${limits.video}.`
    );
  }
  if (refAudios.length > limits.audio) {
    throw new Error(
      `Too many 'reference_audios' (${refAudios.length}) for model "${modelKey}". Maximum allowed: ${limits.audio}.`
    );
  }
  const totalRefs = refImages.length + refVideos.length + refAudios.length;
  if (limits.total !== null && limits.total !== undefined && totalRefs > limits.total) {
    throw new Error(
      `Total reference materials (${totalRefs}) exceed maximum allowed (${limits.total}) for model "${modelKey}".`
    );
  }

  // 7. Validate duration
  let duration;
  if (args.duration === undefined || args.duration === null) {
    duration = mode === "edit" && schema.is_seedance_25 ? -1 : schema.durations.default;
  } else {
    const parsedDur = Number(args.duration);
    if (!Number.isInteger(parsedDur)) {
      throw new Error(`Invalid 'duration' (${args.duration}): must be an integer number of seconds.`);
    }
    if (mode === "edit" && schema.is_seedance_25 && parsedDur === -1) {
      duration = -1;
    } else if (parsedDur < schema.durations.min || parsedDur > schema.durations.max) {
      throw new Error(
        `Invalid 'duration' (${parsedDur}) for model "${modelKey}". Allowed range: ${schema.durations.min}..${schema.durations.max} seconds (default ${schema.durations.default}).`
      );
    } else {
      duration = parsedDur;
    }
  }

  // 8. Validate aspect_ratio
  let aspectRatio;
  if (args.aspect_ratio === undefined || args.aspect_ratio === null || String(args.aspect_ratio).trim() === "") {
    aspectRatio = schema.default_ratio || "16:9";
  } else {
    const rawAr = String(args.aspect_ratio).trim();
    if (!schema.ratios.includes(rawAr)) {
      throw new Error(
        `Invalid 'aspect_ratio' ("${rawAr}") for model "${modelKey}". Allowed values: ${schema.ratios.join(", ")}.`
      );
    }
    aspectRatio = rawAr;
  }

  // 9. Validate resolution
  // - For Seedance_2.5_draft: never send resolution in param, set draft: true
  // - For models without a resolution dimension: omit resolution in param
  let resolutionForParam;
  let effectiveResolution = schema.default_resolution;
  if (args.resolution !== undefined && args.resolution !== null && String(args.resolution).trim() !== "") {
    const rawRes = String(args.resolution).trim().toLowerCase();
    const normalizedRes = rawRes === "4k" ? "4k" : rawRes;
    if (!schema.allowed_resolutions.includes(normalizedRes)) {
      throw new Error(
        `Invalid 'resolution' ("${args.resolution}") for model "${modelKey}". Allowed values: ${schema.allowed_resolutions.join(", ")}.`
      );
    }
    effectiveResolution = normalizedRes;
  }
  if (schema.has_resolution_dimension && !schema.is_draft) {
    resolutionForParam = effectiveResolution;
  } else {
    resolutionForParam = undefined;
  }

  // 10. Validate seed
  let seed;
  if (args.seed !== undefined && args.seed !== null) {
    const parsedSeed = Number(args.seed);
    if (!Number.isInteger(parsedSeed)) {
      throw new Error(`Invalid 'seed' (${args.seed}): must be an integer.`);
    }
    seed = parsedSeed;
  }

  // 11. Determine generate_type and task_type
  const generateType = mode === "first_last_frame" ? 1 : undefined;
  let taskType;
  if (schema.is_seedance_25) {
    if (mode === "edit") {
      taskType = "edit";
    } else if (mode === "extend") {
      taskType = "extend";
    } else {
      // Web bundle (module 184275 & 760736) initializes videoGenerationTaskType to "reference"
      // for T2V, reference_generation, and first_last_frame on Seedance_2.5 / Seedance_2.5_draft.
      taskType = "reference";
    }
  }

  // Compute static estimated credits if available
  const perSecondStatic =
    schema.credits_per_second?.[effectiveResolution] ??
    schema.credits_per_second?.default ??
    null;
  const staticEstimatedCredits =
    typeof perSecondStatic === "number" && duration > 0
      ? Math.ceil(perSecondStatic * duration)
      : null;

  return {
    isDraftUpgrade: false,
    model: modelKey,
    schema,
    prompt,
    mode,
    duration,
    aspect_ratio: aspectRatio,
    resolution: resolutionForParam,
    effective_resolution: effectiveResolution,
    audio,
    audio_control: audioControl,
    seed,
    generate_type: generateType,
    task_type: taskType,
    draft: schema.is_draft ? true : undefined,
    first_frame: firstFrame,
    last_frame: lastFrame,
    reference_images: refImages,
    reference_videos: refVideos,
    reference_audios: refAudios,
    static_per_second_credits: perSecondStatic,
    static_estimated_credits: staticEstimatedCredits,
    warning,
  };
}
