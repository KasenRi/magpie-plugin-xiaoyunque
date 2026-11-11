import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { DEFAULT_APP_ID, combineAbortSignal } from "./client.mjs";
import {
  ALL_MODEL_KEYS,
  SEEDANCE_MODEL_KEYS,
  STATIC_VIDEO_MODELS,
  findStaticModel,
  formatStaticModelForList,
  formatVipLevel,
  normalizeLiveModelItem,
  resolveAndValidateVideoParams,
} from "./models.mjs";

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB

export const RUN_STATE_MAP = {
  1: "queued",
  2: "running",
  3: "completed",
  4: "failed",
  5: "canceled",
  7: "running",
  8: "running",
};

const ALLOWED_IMAGE_FORMATS = new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif", "heic", "heif"]);

function omitUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function unescapeUrl(rawUrl) {
  if (typeof rawUrl !== "string") return "";
  return rawUrl
    .trim()
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/\\u0026/gi, "&");
}

function detectImageFormatAndMime(buffer, filenameHint = "", contentTypeHeader = "") {
  if (buffer && buffer.length >= 4) {
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return { format: "png", mime: "image/png", ext: ".png" };
    }
    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { format: "jpeg", mime: "image/jpeg", ext: ".jpg" };
    }
    // GIF: GIF87a / GIF89a
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return { format: "gif", mime: "image/gif", ext: ".gif" };
    }
    // BMP: 42 4D ("BM")
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return { format: "bmp", mime: "image/bmp", ext: ".bmp" };
    }
    // WEBP: RIFF....WEBP
    if (
      buffer.length >= 12 &&
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return { format: "webp", mime: "image/webp", ext: ".webp" };
    }
    // HEIC / HEIF ISO-BMFF ftyp box
    if (
      buffer.length >= 12 &&
      buffer[4] === 0x66 &&
      buffer[5] === 0x74 &&
      buffer[6] === 0x79 &&
      buffer[7] === 0x70
    ) {
      const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
      if (["heic", "heix", "hevc", "hevx"].includes(brand)) {
        return { format: "heic", mime: "image/heic", ext: ".heic" };
      }
      if (["mif1", "msf1", "heif"].includes(brand)) {
        return { format: "heif", mime: "image/heif", ext: ".heif" };
      }
    }
  }

  const ext = extname(filenameHint || "").replace(/^\./, "").toLowerCase();
  if (ext && ALLOWED_IMAGE_FORMATS.has(ext)) {
    const mime =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "heic"
        ? "image/heic"
        : ext === "heif"
        ? "image/heif"
        : `image/${ext}`;
    return { format: ext, mime, ext: `.${ext === "jpeg" ? "jpg" : ext}` };
  }

  const headerType = String(contentTypeHeader || "").split(";")[0].trim().toLowerCase();
  if (headerType.startsWith("image/")) {
    const sub = headerType.slice("image/".length).toLowerCase();
    if (ALLOWED_IMAGE_FORMATS.has(sub)) {
      return {
        format: sub,
        mime: headerType,
        ext: `.${sub === "jpeg" ? "jpg" : sub}`,
      };
    }
  }

  if (ext && !ALLOWED_IMAGE_FORMATS.has(ext)) {
    throw new Error(
      `Unsupported image format ".${ext}". Allowed image formats: jpg, jpeg, png, webp, bmp, gif, heic, heif.`
    );
  }
  if (headerType && !headerType.startsWith("image/") && headerType !== "application/octet-stream") {
    throw new Error(
      `Unsupported image content-type "${headerType}". Allowed image formats: jpg, jpeg, png, webp, bmp, gif, heic, heif.`
    );
  }

  throw new Error(
    "Unrecognized image format: input does not match jpg, jpeg, png, webp, bmp, gif, heic, or heif."
  );
}

function detectGenericMediaMimeAndExt(assetType, filenameHint = "", contentTypeHeader = "") {
  const ext = extname(filenameHint || "").toLowerCase();
  const headerType = String(contentTypeHeader || "").split(";")[0].trim().toLowerCase();
  if (assetType === "1") {
    // Video
    if (ext === ".mov") return { format: "mov", mime: "video/quicktime", ext: ".mov" };
    if (ext === ".webm") return { format: "webm", mime: "video/webm", ext: ".webm" };
    return { format: "mp4", mime: headerType.startsWith("video/") ? headerType : "video/mp4", ext: ".mp4" };
  }
  if (assetType === "4") {
    // Audio
    if (ext === ".wav") return { format: "wav", mime: "audio/wav", ext: ".wav" };
    if (ext === ".m4a") return { format: "m4a", mime: "audio/mp4", ext: ".m4a" };
    return { format: "mp3", mime: headerType.startsWith("audio/") ? headerType : "audio/mpeg", ext: ".mp3" };
  }
  return { format: "bin", mime: "application/octet-stream", ext: ext || ".bin" };
}

export async function uploadMediaHelper(
  client,
  args = {},
  { assetType = "2", maxBytes = MAX_UPLOAD_BYTES, acceptedFormats = null, modelKey = null, signal } = {}
) {
  const effectiveMaxBytes = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_UPLOAD_BYTES;
  const maxMb = Math.round(effectiveMaxBytes / (1024 * 1024));
  const hasUrl = typeof args.url === "string" && args.url.trim().length > 0;
  const hasPath = typeof args.path === "string" && args.path.trim().length > 0;
  const hasBase64 = typeof args.base64 === "string" && args.base64.trim().length > 0;

  const sourcesCount = [hasUrl, hasPath, hasBase64].filter(Boolean).length;
  if (sourcesCount === 0) {
    throw new Error("upload_image requires one of 'url', 'path', or 'base64'.");
  }
  if (sourcesCount > 1) {
    throw new Error("upload_image accepts only one source at a time: provide either 'url', 'path', or 'base64'.");
  }

  let buffer;
  let filenameHint = typeof args.filename === "string" ? args.filename.trim() : "";
  let contentTypeHint = "";

  if (hasUrl) {
    const targetUrl = args.url.trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      throw new Error(`Invalid media 'url' ("${targetUrl}"): must start with http:// or https://.`);
    }
    const res = await fetch(targetUrl, {
      method: "GET",
      signal: combineAbortSignal(signal, 25_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to download media from URL (HTTP ${res.status} ${res.statusText}).`);
    }
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > effectiveMaxBytes) {
      throw new Error(`File size (${contentLength} bytes) exceeds the ${maxMb} MB maximum limit${modelKey ? ` for model "${modelKey}"` : ""}.`);
    }
    contentTypeHint = res.headers.get("content-type") || "";
    const ab = await res.arrayBuffer();
    buffer = Buffer.from(ab);
    if (!filenameHint) {
      try {
        const u = new URL(targetUrl);
        filenameHint = basename(u.pathname) || "";
      } catch {
        filenameHint = "";
      }
    }
  } else if (hasPath) {
    const filePath = args.path.trim();
    const info = await stat(filePath);
    if (info.size > effectiveMaxBytes) {
      throw new Error(`Local file "${basename(filePath)}" (${info.size} bytes) exceeds the ${maxMb} MB maximum limit${modelKey ? ` for model "${modelKey}"` : ""}.`);
    }
    buffer = await readFile(filePath);
    if (!filenameHint) {
      filenameHint = basename(filePath) || "";
    }
  } else if (hasBase64) {
    let rawB64 = args.base64.trim();
    const dataUriMatch = rawB64.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([\s\S]+)$/i);
    if (dataUriMatch) {
      contentTypeHint = dataUriMatch[1] || "";
      rawB64 = dataUriMatch[2].trim();
    }
    buffer = Buffer.from(rawB64, "base64");
  }

  if (!buffer || buffer.length === 0) {
    throw new Error("Upload data is empty (0 bytes).");
  }
  if (buffer.length > effectiveMaxBytes) {
    throw new Error(`File size (${buffer.length} bytes) exceeds the ${maxMb} MB maximum limit${modelKey ? ` for model "${modelKey}"` : ""}.`);
  }

  const { format, mime, ext } =
    String(assetType) === "2"
      ? detectImageFormatAndMime(buffer, filenameHint, contentTypeHint)
      : detectGenericMediaMimeAndExt(String(assetType), filenameHint, contentTypeHint);

  if (String(assetType) === "2" && Array.isArray(acceptedFormats) && acceptedFormats.length > 0) {
    const allowedSet = new Set(
      acceptedFormats.flatMap((f) =>
        f === "jpg" || f === "jpeg" ? ["jpg", "jpeg"] : [String(f).toLowerCase()]
      )
    );
    if (!allowedSet.has(String(format).toLowerCase())) {
      throw new Error(
        `Unsupported image format "${format}"${modelKey ? ` for model "${modelKey}"` : ""}. Allowed image formats: ${acceptedFormats.join(", ")}.`
      );
    }
  }

  let finalFilename = filenameHint || `upload${ext}`;
  if (!extname(finalFilename)) {
    finalFilename += ext;
  }

  const useSkillUpload = typeof client?.isAccessKeyMode === "function" && client.isAccessKeyMode();
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), finalFilename);
  if (!useSkillUpload) {
    form.append("asset_type", String(assetType));
  }

  const uploadEndpoint = useSkillUpload
    ? "/api/biz/v1/skill/upload_file"
    : "/api/web/v1/common/upload_file";

  const uploadData = await client.request(uploadEndpoint, {
    method: "POST",
    formData: form,
    signal,
  });

  const pippitAssetId =
    uploadData?.pippit_asset_id !== undefined && String(uploadData.pippit_asset_id) !== ""
      ? String(uploadData.pippit_asset_id)
      : uploadData?.file_id !== undefined && String(uploadData.file_id) !== ""
      ? String(uploadData.file_id)
      : uploadData?.asset_id !== undefined && String(uploadData.asset_id) !== ""
      ? String(uploadData.asset_id)
      : "";
  const assetId =
    uploadData?.asset_id !== undefined && String(uploadData.asset_id) !== ""
      ? String(uploadData.asset_id)
      : pippitAssetId;
  const downloadUrl = unescapeUrl(uploadData?.download_url || uploadData?.url || "");

  if (!assetId && !pippitAssetId) {
    throw new Error(`XiaoYunQue ${uploadEndpoint} did not return an asset_id or pippit_asset_id.`);
  }

  return omitUndefined({
    asset_id: assetId,
    pippit_asset_id: pippitAssetId,
    url: downloadUrl,
    width: uploadData?.width ?? null,
    height: uploadData?.height ?? null,
    format: uploadData?.format || format,
    ...(uploadData?.cover_url ? { cover_url: unescapeUrl(uploadData.cover_url) } : {}),
    ...(uploadData?.duration_ms ? { duration_ms: Number(uploadData.duration_ms) } : {}),
  });
}

export async function uploadImageHelper(client, args = {}, signal) {
  const uploaded = await uploadMediaHelper(client, args, { assetType: "2", signal });
  return {
    asset_id: uploaded.asset_id,
    pippit_asset_id: uploaded.pippit_asset_id,
    url: uploaded.url,
    width: uploaded.width,
    height: uploaded.height,
    format: uploaded.format,
  };
}

async function resolveMediaAssetInput(
  client,
  item,
  { assetType = "2", maxBytes, acceptedFormats, modelKey, signal } = {}
) {
  if (item && typeof item === "object") {
    return omitUndefined({
      asset_id: item.asset_id !== undefined ? String(item.asset_id) : undefined,
      pippit_asset_id:
        item.pippit_asset_id !== undefined
          ? String(item.pippit_asset_id)
          : item.file_id !== undefined
          ? String(item.file_id)
          : undefined,
      url: unescapeUrl(item.url || item.download_url || ""),
      width: item.width !== undefined ? item.width : undefined,
      height: item.height !== undefined ? item.height : undefined,
      format: item.format !== undefined ? item.format : undefined,
      cover_url: item.cover_url ? unescapeUrl(item.cover_url) : undefined,
      duration_ms: item.duration_ms !== undefined ? item.duration_ms : undefined,
    });
  }
  const str = String(item || "").trim();
  const uploadOpts = { assetType, maxBytes, acceptedFormats, modelKey, signal };
  if (/^https?:\/\//i.test(str)) {
    return uploadMediaHelper(client, { url: str }, uploadOpts);
  }
  if (/^data:/i.test(str)) {
    return uploadMediaHelper(client, { base64: str }, uploadOpts);
  }
  return uploadMediaHelper(client, { path: str }, uploadOpts);
}

function stripAssetUrlsFromParam(param) {
  if (!param || typeof param !== "object") return param;
  const cleanItem = (item) => {
    if (!item || typeof item !== "object") return item;
    const { url: _u, download_url: _d, cover_url: _c, ...rest } = item;
    return rest;
  };
  return {
    ...param,
    ...(Array.isArray(param.images) ? { images: param.images.map(cleanItem) } : {}),
    ...(Array.isArray(param.videos) ? { videos: param.videos.map(cleanItem) } : {}),
    ...(Array.isArray(param.audios) ? { audios: param.audios.map(cleanItem) } : {}),
  };
}

export function normalizeCreditBalance(rawCreditData) {
  const credit = rawCreditData?.credit ?? rawCreditData ?? {};
  if (
    credit.total_remain_amount !== undefined &&
    credit.vip_credit === undefined &&
    credit.gift_credit === undefined &&
    credit.purchase_credit === undefined &&
    credit.free_credits === undefined
  ) {
    const total = Number(credit.total_remain_amount ?? 0) || 0;
    return {
      total,
      total_remain_amount: String(credit.total_remain_amount),
    };
  }
  const vip_credit = Number(credit.vip_credit ?? 0) || 0;
  const gift_credit = Number(credit.gift_credit ?? 0) || 0;
  const purchase_credit = Number(credit.purchase_credit ?? 0) || 0;
  const free_credits = Number(credit.free_credits ?? 0) || 0;
  const total = vip_credit + gift_credit + purchase_credit + free_credits;
  return {
    vip_credit,
    gift_credit,
    purchase_credit,
    free_credits,
    total,
  };
}

export function parseTaskIdentifier(args = {}) {
  const directThread = typeof args.thread_id === "string" ? args.thread_id.trim() : "";
  const directRun = typeof args.run_id === "string" ? args.run_id.trim() : "";
  if (directThread && directRun) {
    return {
      task_id: `${directThread}:${directRun}`,
      thread_id: directThread,
      run_id: directRun,
    };
  }
  const rawTaskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
  if (rawTaskId) {
    const colonIdx = rawTaskId.indexOf(":");
    if (colonIdx > 0 && colonIdx < rawTaskId.length - 1) {
      const tId = rawTaskId.slice(0, colonIdx).trim();
      const rId = rawTaskId.slice(colonIdx + 1).trim();
      if (tId && rId) {
        return {
          task_id: `${tId}:${rId}`,
          thread_id: tId,
          run_id: rId,
        };
      }
    }
  }
  throw new Error(
    "Invalid task identifier: provide 'task_id' in \"<thread_id>:<run_id>\" format, or provide both 'thread_id' and 'run_id'."
  );
}

function collectContentItemsFromEntries(entryList = []) {
  const items = [];
  if (!Array.isArray(entryList)) return items;
  for (const entry of entryList) {
    if (!entry || typeof entry !== "object") continue;
    const sources = [
      entry.artifact?.content,
      entry.message?.content,
      entry.content,
    ];
    for (const arr of sources) {
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && typeof item === "object") {
            items.push({ item, entry });
          }
        }
      }
    }
  }
  return items;
}

export function normalizeRunToTaskResult(run, { thread_id, run_id, nowMs = Date.now(), redact = (s) => s } = {}) {
  const stateNum = Number(run?.state);
  const status =
    RUN_STATE_MAP[stateNum] ??
    (typeof run?.status === "string" && run.status.trim() ? run.status.trim().toLowerCase() : "unknown");

  const effectiveThreadId = String(run?.thread_id || thread_id || "");
  const effectiveRunId = String(run?.run_id || run_id || "");
  const taskId = effectiveThreadId && effectiveRunId ? `${effectiveThreadId}:${effectiveRunId}` : effectiveRunId || effectiveThreadId;

  const entries = Array.isArray(run?.entry_list) ? run.entry_list : [];
  const contentItems = collectContentItemsFromEntries(entries);

  // 1. Extract predict_info -> eta_seconds
  let etaSeconds = null;
  let predictDurationMs = null;
  for (const { item } of contentItems) {
    if (item.sub_type === "biz/x_data_predict_info" && item.data) {
      try {
        const parsed = typeof item.data === "string" ? JSON.parse(item.data) : item.data;
        if (parsed && typeof parsed === "object") {
          const predMs = Number(parsed.predict_duration);
          const startSec = Number(parsed.generate_start_time);
          if (Number.isFinite(predMs) && predMs > 0) {
            predictDurationMs = predMs;
            if (status === "completed" || status === "failed" || status === "canceled") {
              etaSeconds = 0;
            } else if (Number.isFinite(startSec) && startSec > 0) {
              const startMs = startSec > 1e11 ? startSec : startSec * 1000;
              const elapsedMs = Math.max(0, nowMs - startMs);
              etaSeconds = Math.max(0, Math.round((predMs - elapsedMs) / 1000));
            } else {
              etaSeconds = Math.max(0, Math.round(predMs / 1000));
            }
          }
        }
      } catch {
        // Ignore malformed predict_info
      }
    }
  }

  // 2. Extract videos from artifact entries with sub_type "biz/x_data_video"
  const videos = [];
  for (const { item } of contentItems) {
    if (item.sub_type === "biz/x_data_video" && item.data) {
      try {
        const parsed = typeof item.data === "string" ? JSON.parse(item.data) : item.data;
        const v = parsed?.video ?? parsed;
        if (v && typeof v === "object") {
          const rawVideoUrl =
            v.download_url ||
            v.url ||
            v.no_watermark_video_url?.download_url ||
            v.origin_url ||
            v.transcoded_video?.origin?.video_url ||
            "";
          const videoUrl = unescapeUrl(rawVideoUrl);
          const previewUrl = v.preview_url ? unescapeUrl(v.preview_url) : null;
          const coverUrl = v.cover_url ? unescapeUrl(v.cover_url) : null;
          const width = v.width ?? v.metadata?.width ?? null;
          const height = v.height ?? v.metadata?.height ?? null;
          const durationMs =
            v.duration_ms ??
            v.metadata?.duration_ms ??
            (v.extra?.ark_video_duration_ms !== undefined ? Number(v.extra.ark_video_duration_ms) : null);
          const renderTaskId =
            v.render_task_id !== undefined && v.render_task_id !== null && String(v.render_task_id).trim() !== ""
              ? String(v.render_task_id)
              : null;
          const draftTaskId =
            v.draft_task_id !== undefined && v.draft_task_id !== null && String(v.draft_task_id).trim() !== ""
              ? String(v.draft_task_id)
              : renderTaskId;
          const pippitAssetId =
            item.pippit_asset_id !== undefined && item.pippit_asset_id !== null
              ? String(item.pippit_asset_id)
              : v.pippit_asset_id !== undefined && v.pippit_asset_id !== null
              ? String(v.pippit_asset_id)
              : null;

          if (videoUrl || previewUrl || renderTaskId) {
            videos.push(
              omitUndefined({
                video_url: videoUrl || previewUrl,
                preview_url: previewUrl,
                cover_url: coverUrl,
                width,
                height,
                duration_ms: durationMs,
                render_task_id: renderTaskId,
                ...(draftTaskId ? { draft_task_id: draftTaskId } : {}),
                pippit_asset_id: pippitAssetId,
                ...(v.asset_id ? { asset_id: String(v.asset_id) } : {}),
              })
            );
          }
        }
      } catch {
        // Fall through to regex fallback
      }
    }
  }

  // Fallback regex for .mp4 / mime_type=video_mp4 URLs (as in XiakeMan777 extract_video_url)
  if (videos.length === 0 && entries.length > 0) {
    const rawJson = JSON.stringify(entries);
    const mp4Regex = /https?:\/\/[^\s"'<>\\]+?(?:\.mp4\b|mime_type=video_mp4)[^\s"'<>\\]*/gi;
    const matches = rawJson.match(mp4Regex) || [];
    const seen = new Set();
    for (const m of matches) {
      const cleaned = unescapeUrl(m);
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        videos.push({
          video_url: cleaned,
          preview_url: null,
          cover_url: null,
          width: null,
          height: null,
          duration_ms: null,
          render_task_id: null,
          pippit_asset_id: null,
        });
      }
    }
  }

  // 3. Extract credit_consumption
  let creditConsumption = null;
  if (run?.credit_consumption && typeof run.credit_consumption === "object") {
    const cc = run.credit_consumption;
    creditConsumption = {
      actual_deduct_credits: Number(cc.actual_deduct_credits ?? 0),
      returned_credits: Number(cc.returned_credits ?? 0),
    };
  }

  // 4. Extract fail_reason
  let failReason = null;
  if (run?.fail_reason && typeof run.fail_reason === "object") {
    const fr = run.fail_reason;
    const msg = fr.message || fr.detail || fr.fallback_message || "";
    if (fr.code || msg || status === "failed") {
      failReason = {
        code: fr.code ?? null,
        message: redact(String(msg)),
      };
    }
  }
  if (!failReason) {
    const topMsg = run?.error_message || run?.error_msg || run?.errmsg || "";
    if (topMsg) {
      failReason = {
        code: null,
        message: redact(String(topMsg)),
      };
    }
  }
  if (!failReason) {
    for (const { item } of contentItems) {
      if (!item?.data) continue;
      try {
        const parsed = typeof item.data === "string" ? JSON.parse(item.data) : item.data;
        if (parsed && typeof parsed === "object" && (parsed.error_message || parsed.error_code)) {
          failReason = {
            code: parsed.error_code ?? null,
            message: redact(String(parsed.error_message || `error_code=${parsed.error_code}`)),
          };
          break;
        }
      } catch {
        // Ignore malformed content data
      }
    }
  }

  return omitUndefined({
    task_id: taskId,
    thread_id: effectiveThreadId,
    run_id: effectiveRunId,
    state: Number.isFinite(stateNum) ? stateNum : null,
    status,
    eta_seconds: etaSeconds,
    ...(predictDurationMs !== null ? { predict_duration_ms: predictDurationMs } : {}),
    credit_consumption: creditConsumption,
    fail_reason: failReason,
    videos,
  });
}

export async function downloadTaskVideosIfRequested(normalizedResult, args = {}, signal) {
  if (!normalizedResult || normalizedResult.status !== "completed") {
    return normalizedResult;
  }
  const downloadDir = typeof args?.download_dir === "string" ? args.download_dir.trim() : "";
  const outputPath = typeof args?.output_path === "string" ? args.output_path.trim() : "";
  if (!downloadDir && !outputPath) {
    return normalizedResult;
  }
  if (!Array.isArray(normalizedResult.videos) || normalizedResult.videos.length === 0) {
    return normalizedResult;
  }

  const downloadedFiles = [];
  for (let i = 0; i < normalizedResult.videos.length; i += 1) {
    const video = normalizedResult.videos[i];
    const url = video?.video_url;
    if (!url) continue;

    let targetPath;
    if (outputPath && i === 0) {
      targetPath = outputPath;
    } else {
      const dir = downloadDir || dirname(outputPath);
      const baseName = `${normalizedResult.run_id || "video"}_${i + 1}.mp4`;
      targetPath = join(dir, baseName);
    }

    await mkdir(dirname(targetPath), { recursive: true });
    const res = await fetch(url, {
      method: "GET",
      signal: combineAbortSignal(signal, 40_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to download generated video from CDN (HTTP ${res.status} ${res.statusText}).`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(targetPath, buf);
    video.local_path = targetPath;
    video.output_path = targetPath;
    downloadedFiles.push({
      path: targetPath,
      size_bytes: buf.length,
      video_url: url,
    });
  }

  if (downloadedFiles.length > 0) {
    normalizedResult.downloaded_files = downloadedFiles;
  }

  return normalizedResult;
}

function extractRunFromThreadData(threadData, run_id) {
  const thread = threadData?.thread ?? threadData;
  const runList = Array.isArray(thread?.run_list) ? thread.run_list : [];
  const threadRunObj =
    runList.find((r) => r && String(r.run_id) === run_id) ??
    runList[runList.length - 1] ??
    null;
  if (!threadRunObj) return null;

  let mergedEntries = Array.isArray(threadRunObj.entry_list) ? [...threadRunObj.entry_list] : [];
  if (Array.isArray(thread?.entry_list)) {
    mergedEntries = mergedEntries.concat(thread.entry_list);
  }
  return {
    ...threadRunObj,
    ...(mergedEntries.length > 0 ? { entry_list: mergedEntries } : {}),
  };
}

export async function getTaskHelper(client, args = {}, signal) {
  const { thread_id, run_id } = parseTaskIdentifier(args);
  const useSkillApi = typeof client?.isAccessKeyMode === "function" && client.isAccessKeyMode();

  if (useSkillApi) {
    let runObj = null;
    try {
      const threadData = await client.post(
        "/api/biz/v1/skill/get_thread",
        { thread_id, run_id },
        { signal }
      );
      runObj = extractRunFromThreadData(threadData, run_id);
    } catch (err) {
      if (err?.isLoginError || err?.isAntiBot) {
        throw err;
      }
      if (err?.data) {
        runObj = extractRunFromThreadData(err.data, run_id);
        if (runObj && Number(runObj.state) === 4 && !runObj.fail_reason && !runObj.error_message && err.errmsg) {
          runObj.fail_reason = { code: err.ret ?? null, message: err.errmsg };
        }
      }
      if (!runObj && String(err?.ret) === "5" && typeof err?.errmsg === "string") {
        const msg = err.errmsg.trim();
        if (msg === "创作失败" || msg.startsWith("创作失败：")) {
          runObj = {
            thread_id,
            run_id,
            state: 4,
            fail_reason: { code: "5", message: msg },
          };
        } else if (msg === "创作已取消") {
          runObj = {
            thread_id,
            run_id,
            state: 5,
          };
        }
      }
      if (!runObj) {
        throw err;
      }
    }

    if (!runObj) {
      throw new Error(`Run not found for thread_id="${thread_id}", run_id="${run_id}".`);
    }

    const normalized = normalizeRunToTaskResult(runObj, {
      thread_id,
      run_id,
      nowMs: client.now(),
      redact: (s) => client.redact(s),
    });

    return downloadTaskVideosIfRequested(normalized, args, signal);
  }

  let runObj = null;
  try {
    const runData = await client.post(
      "/api/biz/v1/agent/get_run",
      {
        thread_id,
        run_id,
        scopes: ["base", "entry_list"],
        is_need_fail_reason_detail: true,
      },
      { signal }
    );
    runObj = runData?.run ?? (runData?.state !== undefined ? runData : null);
  } catch (err) {
    if (err?.isLoginError || err?.isAntiBot) {
      throw err;
    }
    // Fallback to get_thread below
  }

  let normalized = runObj
    ? normalizeRunToTaskResult(runObj, {
        thread_id,
        run_id,
        nowMs: client.now(),
        redact: (s) => client.redact(s),
      })
    : null;

  if (!runObj || (normalized?.status === "completed" && (!normalized.videos || normalized.videos.length === 0))) {
    try {
      const threadData = await client.post(
        "/api/biz/v1/agent/get_thread",
        {
          thread_id,
          scopes: ["base", "run_list.base", "run_list.entry_list", "entry_list"],
          is_need_fail_reason_detail: true,
        },
        { signal }
      );
      const threadRunObj = extractRunFromThreadData(threadData, run_id);
      if (threadRunObj) {
        runObj = {
          ...runObj,
          ...threadRunObj,
        };
        normalized = normalizeRunToTaskResult(runObj, {
          thread_id,
          run_id,
          nowMs: client.now(),
          redact: (s) => client.redact(s),
        });
      }
    } catch (err) {
      if (!runObj || err?.isLoginError || err?.isAntiBot) {
        throw err;
      }
    }
  }

  if (!runObj || !normalized) {
    throw new Error(`Run not found for thread_id="${thread_id}", run_id="${run_id}".`);
  }

  return downloadTaskVideosIfRequested(normalized, args, signal);
}

function abortableSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

export async function waitTaskHelper(
  client,
  { task_id, thread_id, run_id, timeout_seconds = 40, interval_seconds = 5, download_dir, output_path } = {},
  signal
) {
  const ids = parseTaskIdentifier({ task_id, thread_id, run_id });
  const timeoutSec = Math.min(45, Math.max(0, Number(timeout_seconds ?? 40)));
  const intervalSec = Math.min(30, Math.max(0.02, Number(interval_seconds ?? 5)));
  const startMs = Date.now();
  const deadlineMs = startMs + timeoutSec * 1000;
  const hardCeilingMs = startMs + 47_000;

  let lastResult = await getTaskHelper(
    client,
    ids,
    combineAbortSignal(signal, Math.max(5_000, Math.min(15_000, hardCeilingMs - Date.now())))
  );
  if (TERMINAL_STATUSES.has(lastResult.status)) {
    await downloadTaskVideosIfRequested(
      lastResult,
      { download_dir, output_path },
      combineAbortSignal(signal, Math.max(5_000, hardCeilingMs - Date.now()))
    );
    return {
      ...lastResult,
      timed_out: false,
      elapsed_seconds: Number(((Date.now() - startMs) / 1000).toFixed(2)),
    };
  }

  while (Date.now() < deadlineMs && Date.now() + 6_000 < hardCeilingMs) {
    const remainingMs = Math.min(deadlineMs - Date.now(), hardCeilingMs - 6_000 - Date.now());
    if (remainingMs <= 0) break;
    const sleepMs = Math.min(intervalSec * 1000, remainingMs);
    try {
      await abortableSleep(sleepMs, signal);
    } catch (err) {
      if (signal?.aborted) {
        return {
          ...lastResult,
          timed_out: true,
          aborted: true,
          elapsed_seconds: Number(((Date.now() - startMs) / 1000).toFixed(2)),
          message:
            `Task ${ids.task_id} is still '${lastResult.status}' (aborted after ${((Date.now() - startMs) / 1000).toFixed(1)}s). ` +
            `Call wait_task again with task_id="${ids.task_id}" to continue polling.`,
        };
      }
      throw err;
    }

    const reqSignal = combineAbortSignal(
      signal,
      Math.max(3_000, Math.min(12_000, hardCeilingMs - Date.now()))
    );
    try {
      lastResult = await getTaskHelper(client, ids, reqSignal);
    } catch (err) {
      if (reqSignal?.aborted && !signal?.aborted) {
        break;
      }
      throw err;
    }

    if (TERMINAL_STATUSES.has(lastResult.status)) {
      await downloadTaskVideosIfRequested(
        lastResult,
        { download_dir, output_path },
        combineAbortSignal(signal, Math.max(5_000, hardCeilingMs - Date.now()))
      );
      return {
        ...lastResult,
        timed_out: false,
        elapsed_seconds: Number(((Date.now() - startMs) / 1000).toFixed(2)),
      };
    }
  }

  if (TERMINAL_STATUSES.has(lastResult.status)) {
    await downloadTaskVideosIfRequested(lastResult, { download_dir, output_path }, signal);
    return {
      ...lastResult,
      timed_out: false,
      elapsed_seconds: Number(((Date.now() - startMs) / 1000).toFixed(2)),
    };
  }

  return {
    ...lastResult,
    timed_out: true,
    elapsed_seconds: Number(((Date.now() - startMs) / 1000).toFixed(2)),
    message:
      `Task ${ids.task_id} is still '${lastResult.status}'` +
      (lastResult.eta_seconds !== undefined ? ` (ETA ~${lastResult.eta_seconds}s)` : "") +
      `. Call wait_task again with task_id="${ids.task_id}" to continue waiting.`,
  };
}

const MEDIA_ITEM_SCHEMA = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        asset_id: { type: "string" },
        pippit_asset_id: { type: "string" },
        url: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        format: { type: "string" },
        duration_ms: { type: "number" },
      },
    },
  ],
};

const GENERATION_PARAM_PROPERTIES = {
  model: {
    type: "string",
    description:
      "Video model key (视频模型 key, default 'Seedance_2.5'). " +
      "Seedance models: 'Seedance_2.5' (480p-4k, 4-30s), 'Seedance_2.5_draft' (480p draft, 4-30s, 9 credits/s), " +
      "'seedance2.0_vision' (Seedance 2.0 VIP, 480p-4k, 4-15s), 'seedance2.0_fast_vision' (Seedance 2.0 Fast VIP, 480p/720p, 4-15s), " +
      "'Seedance_2.0_mini' (720p, 6 credits/s), 'Seedance_2.0_mini_lite' (体验版 720p, 4 credits/s), " +
      "'seedance2.0_direct' (legacy), 'seedance2.0_fast_direct' (legacy), 'Seedance_1.0_fast' (720p/1080p, 2-12s). " +
      "Non-Seedance: 'wan3.0', 'happyhorse-1.1'.",
  },
  duration: {
    type: "integer",
    description:
      "Video duration in seconds (时长/秒). Seedance 2.5 / Wan 3.0: 4-30s (default 10s); Seedance 2.0: 4-15s (default 10s); HappyHorse 1.1: 3-15s (default 5s); Seedance 1.0 Fast: 2-12s (default 5s).",
  },
  aspect_ratio: {
    type: "string",
    enum: ["adaptive", "16:9", "21:9", "9:16", "1:1", "4:3", "3:4"],
    description:
      "Aspect ratio (画面比例, default '16:9'). Note: 'wan3.0' does not support '21:9'; 'happyhorse-1.1' does not support 'adaptive'.",
  },
  resolution: {
    type: "string",
    enum: ["480p", "720p", "1080p", "4k"],
    description:
      "Video resolution (清晰度/分辨率, default '720p'). Automatically omitted for models without a resolution selector (Seedance_2.5_draft, Seedance_2.0_mini_lite, Seedance_2.0_mini, seedance2.0_fast_direct).",
  },
  audio: {
    type: "boolean",
    description:
      "Whether to generate audio (是否保留声音, default true). XiaoYunQue has no native audio toggle; when audio=false, '（全片无对白、无旁白、无背景音乐，静音）' is appended to the prompt and audio_control='prompt_hint' is returned.",
  },
  output_format: {
    type: "string",
    description: "Output video format (输出格式, only 'mp4' is supported by XiaoYunQue).",
  },
  mode: {
    type: "string",
    enum: ["auto", "t2v", "first_last_frame", "reference", "edit", "extend"],
    description:
      "Generation mode (生成模式, default 'auto'): 'auto' (first_frame -> first_last_frame, reference_images/videos/audios -> reference, else t2v), " +
      "'t2v' (文生视频), 'first_last_frame' (首尾帧模式, generate_type=1), 'reference' (全能参考生成), 'edit' (视频编辑, Seedance_2.5 only), 'extend' (视频延长, Seedance_2.5 / Seedance_2.5_draft only).",
  },
  first_frame: {
    ...MEDIA_ITEM_SCHEMA,
    description:
      "First frame image (首帧图片) for 'first_last_frame' mode: HTTP(S) URL, local file path, base64 data URI, or {asset_id,...} from upload_image (must belong to the same account).",
  },
  last_frame: {
    ...MEDIA_ITEM_SCHEMA,
    description:
      "Last frame image (尾帧图片) for 'first_last_frame' mode: HTTP(S) URL, local file path, base64 data URI, or {asset_id,...} from upload_image (must belong to the same account).",
  },
  reference_images: {
    type: "array",
    items: MEDIA_ITEM_SCHEMA,
    description:
      "Reference images (参考图片列表, max 30 on Seedance 2.5 / max 10 on Wan 3.0 / max 9 on Seedance 2.0 & HappyHorse 1.1; reference in prompt as [@图片1], [@图片2]). Each item may be a URL, local path, base64 data URI, or {asset_id,...} uploaded under the same account.",
  },
  reference_videos: {
    type: "array",
    items: MEDIA_ITEM_SCHEMA,
    description:
      "Reference videos (参考视频列表, max 10 on Seedance 2.5 / max 5 on Wan 3.0 / max 3 on Seedance 2.0; reference in prompt as [@视频1]). Each item may be a URL, local path, base64 data URI, or {asset_id,...} uploaded under the same account.",
  },
  reference_audios: {
    type: "array",
    items: MEDIA_ITEM_SCHEMA,
    description:
      "Reference audios (参考音频列表, max 10 on Seedance 2.5 / max 3 on Seedance 2.0; reference in prompt as [@音频1]). Each item may be a URL, local path, base64 data URI, or {asset_id,...} uploaded under the same account.",
  },
  seed: {
    type: "integer",
    description: "Optional random seed integer (随机种子; not supported on 'happyhorse-1.1' or 'Seedance_1.0_fast').",
  },
};

const ACCOUNT_ARG_PROPERTY = {
  account: {
    type: "string",
    description:
      "Optional account selector (可选：指定使用哪个已配置的小云雀账号；可填「模型 → 供应商」页面上的账号备注名、自定义别名、槽位键如 'xiaoyunque' / 'xiaoyunque#xxxxxx'、密钥末 4 位，或 'options' 表示回退 plugins.json 配置；不填默认使用页面当前置顶启用的账号).",
  },
};

async function querySingleAccountInfo(client, signal) {
  if (client.isAccessKeyMode()) {
    const creditData = await client.post("/api/biz/v1/skill/get_credit_balance", {}, { signal });
    const credit = normalizeCreditBalance(creditData);
    return {
      auth_mode: "access_key",
      team_id: client.teamId || "0",
      credit,
    };
  }

  const [workspace, creditData, vipData] = await Promise.all([
    client.getWorkspaceInfo(signal),
    client.post("/commerce/v1/benefits/user_credit", {}, { commerce: true, signal }),
    client.post("/commerce/v1/subscription/user_info", {}, { commerce: true, signal }),
  ]);

  const credit = normalizeCreditBalance(creditData);
  const { cur_vip_level, vip_level_name } = formatVipLevel(vipData?.cur_vip_level);

  return {
    workspace: {
      workspace_id: workspace.workspace_id,
      space_id: workspace.space_id,
      space_idc: workspace.space_idc,
    },
    credit,
    vip: {
      flag: Boolean(vipData?.flag),
      cur_vip_level,
      vip_level_name,
      end_time: Number(vipData?.end_time ?? 0) || 0,
    },
  };
}

function isTaskNotFoundError(err) {
  if (!err || err.isLoginError || err.isAntiBot) return false;
  const ret = err.ret !== undefined && err.ret !== null ? String(err.ret) : "";
  if (ret === "16017" || ret === "16029" || ret === "14004" || err.status === 404) {
    return true;
  }
  const msg = String(err.errmsg || err.message || "");
  return /Run not found for thread_id=|thread.*not.*found|run.*not.*found|owner.*mismatch|线程不存在|任务不存在|无权访问/i.test(
    msg
  );
}

export function createTools(clientOrPool) {
  const hasPool = Boolean(clientOrPool && typeof clientOrPool.resolve === "function");

  function resolveTarget({ account, taskId, directory } = {}) {
    if (!hasPool) {
      return {
        client: clientOrPool,
        slot: null,
        label: null,
        boundByTask: false,
      };
    }
    return clientOrPool.resolve({ account, taskId, directory });
  }

  function resolveForTask(account, ids, directory) {
    if (!hasPool) {
      return {
        client: clientOrPool,
        slot: null,
        label: null,
        boundByTask: false,
      };
    }
    if (account && String(account).trim()) {
      return clientOrPool.resolve({ account, directory });
    }
    const byTask = clientOrPool.resolve({ taskId: ids.task_id, directory });
    if (byTask.boundByTask) return byTask;
    const byRun = clientOrPool.resolve({ taskId: ids.run_id, directory });
    if (byRun.boundByTask) return byRun;
    return byTask;
  }

  function withAccountTag(result, label) {
    if (!hasPool || !label || !result || typeof result !== "object") {
      return result;
    }
    return {
      account: label,
      ...result,
    };
  }

  async function executeTaskBoundOp(args = {}, ctx, opFn) {
    const ids = parseTaskIdentifier(args);
    const directory = ctx?.directory;
    const primary = resolveForTask(args?.account, ids, directory);

    try {
      const res = await opFn(primary.client, ids);
      if (hasPool && primary.slot) {
        clientOrPool.rememberTask(ids.task_id, primary.slot);
        clientOrPool.rememberTask(ids.run_id, primary.slot);
      }
      return withAccountTag(res, primary.label);
    } catch (err) {
      const canFallback =
        hasPool &&
        !(args?.account && String(args.account).trim()) &&
        !primary.boundByTask &&
        isTaskNotFoundError(err) &&
        typeof clientOrPool.listFallbackTargets === "function";
      if (!canFallback) {
        throw err;
      }

      const fallbacks = clientOrPool.listFallbackTargets(primary.slot, directory);
      for (const cand of fallbacks) {
        try {
          const res = await opFn(cand.client, ids);
          if (cand.slot) {
            clientOrPool.rememberTask(ids.task_id, cand.slot);
            clientOrPool.rememberTask(ids.run_id, cand.slot);
          }
          return withAccountTag(res, cand.label);
        } catch (candErr) {
          if (isTaskNotFoundError(candErr)) {
            continue;
          }
          throw candErr;
        }
      }

      throw err;
    }
  }

  return {
    account: {
      description:
        "Query your XiaoYunQue (小云雀) credit balance (POST /api/biz/v1/skill/get_credit_balance in Access-Key mode; " +
        "or workspace info + credit breakdown + VIP subscription status in Cookie mode). Set all_accounts=true to list all configured accounts and balances. Never returns sensitive UIDs. " +
        "(查询小云雀积分余额、工作空间及会员状态；支持多账号选择与 all_accounts 汇总查询)",
      args: {
        type: "object",
        properties: {
          ...ACCOUNT_ARG_PROPERTY,
          all_accounts: {
            type: "boolean",
            description:
              "When true, list all configured XiaoYunQue accounts, their enabled/default status, and credit balance summary (设为 true 时列出所有已配置账号及余额摘要, default false).",
          },
        },
        additionalProperties: false,
      },
      async execute(args = {}, ctx) {
        const signal = ctx?.abort;
        const directory = ctx?.directory;

        if (args?.all_accounts === true) {
          if (!hasPool) {
            const info = await querySingleAccountInfo(clientOrPool, signal);
            return {
              account: "default",
              selected_account: { slot: "default", label: "default" },
              accounts: [
                {
                  slot: "default",
                  label: "default",
                  enabled: true,
                  first: true,
                  selected: true,
                  auth_mode: clientOrPool.isAccessKeyMode() ? "access_key" : "cookie",
                  ...info,
                },
              ],
            };
          }

          const selected = resolveTarget({ account: args?.account, directory });
          const uiAccounts = clientOrPool.listAccounts(directory);
          const legacyClient = clientOrPool.getLegacyClient();
          const hasLegacyCreds =
            typeof legacyClient?.hasCredentials === "function" && legacyClient.hasCredentials();

          if (uiAccounts.length === 0 && !hasLegacyCreds) {
            // Trigger standard missing-credentials instruction message
            await querySingleAccountInfo(legacyClient, signal);
          }

          const targets = uiAccounts.map((acc) => ({
            slot: acc.slot,
            label: acc.label,
            user: acc.user || null,
            alias: acc.alias || null,
            hint: acc.keyHint || null,
            enabled: acc.enabled,
            first: acc.first,
            client: clientOrPool.materializeAccount(acc).client,
          }));

          if (hasLegacyCreds) {
            const anyUiEnabled = uiAccounts.some((a) => a.enabled);
            targets.push({
              slot: "options",
              label: "options",
              user: "options",
              alias: null,
              hint: null,
              enabled: !anyUiEnabled,
              first: !anyUiEnabled,
              client: legacyClient,
            });
          }

          const rows = await Promise.all(
            targets.map(async (t) => {
              const authMode = t.client.isAccessKeyMode() ? "access_key" : "cookie";
              try {
                const info = await querySingleAccountInfo(t.client, signal);
                return omitUndefined({
                  slot: t.slot,
                  label: t.label,
                  user: t.user ?? undefined,
                  alias: t.alias ?? undefined,
                  hint: t.hint ?? undefined,
                  enabled: t.enabled,
                  first: t.first,
                  selected: t.slot === selected.slot,
                  auth_mode: authMode,
                  ...info,
                });
              } catch (err) {
                const safeErr =
                  typeof t.client?.redact === "function"
                    ? t.client.redact(String(err?.message || err))
                    : String(err?.message || err);
                return omitUndefined({
                  slot: t.slot,
                  label: t.label,
                  user: t.user ?? undefined,
                  alias: t.alias ?? undefined,
                  hint: t.hint ?? undefined,
                  enabled: t.enabled,
                  first: t.first,
                  selected: t.slot === selected.slot,
                  auth_mode: authMode,
                  credit: null,
                  error: safeErr,
                });
              }
            })
          );

          return {
            account: selected.label,
            selected_account: {
              slot: selected.slot,
              label: selected.label,
            },
            accounts: rows,
          };
        }

        const target = resolveTarget({ account: args?.account, directory });
        const info = await querySingleAccountInfo(target.client, signal);
        const includeAccountMeta =
          hasPool &&
          (Boolean(directory || clientOrPool.defaultDir) ||
            args?.account !== undefined ||
            target.slot !== "options");
        if (!includeAccountMeta) {
          return info;
        }
        return {
          account: target.label,
          selected_account: {
            slot: target.slot,
            label: target.label,
          },
          ...info,
        };
      },
    },

    list_video_models: {
      description:
        "List available video generation models on XiaoYunQue (小云雀). By default fetches the live model list from POST /api/biz/v1/skill/get_available_model_list " +
        "(or /api/biz/v1/agent/get_available_model_list in Cookie mode; trimmed to key, name, disabled, durations, resolutions, ratios, first_last_frame_support, reference_limits, creation_modes, credits_per_second). " +
        "Set offline=true to use the built-in static model table without network requests, seedance_only=false to include Wan 3.0 and HappyHorse 1.1, " +
        "or with_prices=true to query live per-second credit prices via get_commerce_auth_info. (列出小云雀支持的视频生成模型、参数范围与每秒积分价格)",
      args: {
        type: "object",
        properties: {
          ...ACCOUNT_ARG_PROPERTY,
          seedance_only: {
            type: "boolean",
            description: "Only return models whose key contains 'seedance' (仅列出 Seedance 系列模型, default true).",
          },
          offline: {
            type: "boolean",
            description: "Use the built-in static table of all 11 models without calling the API (离线使用静态模型表, default false).",
          },
          with_prices: {
            type: "boolean",
            description:
              "Query live per-second credit prices via POST /api/biz/v1/commerce/get_commerce_auth_info for each model/resolution (实时查询各分辨率每秒积分价格, default false).",
          },
        },
        additionalProperties: false,
      },
      async execute(args = {}, ctx) {
        const signal = ctx?.abort;
        const { client, label } = resolveTarget({
          account: args?.account,
          directory: ctx?.directory,
        });
        const seedanceOnly = args?.seedance_only !== undefined ? Boolean(args.seedance_only) : true;
        const useOffline = Boolean(args?.offline) || !client.hasCredentials();

        if (useOffline) {
          const allStatic = STATIC_VIDEO_MODELS.map(formatStaticModelForList);
          const filtered = seedanceOnly
            ? allStatic.filter((m) => m.key.toLowerCase().includes("seedance"))
            : allStatic;
          return withAccountTag(
            {
              source: "static",
              default_model: client.defaultModel,
              seedance_only: seedanceOnly,
              models: filtered,
            },
            label
          );
        }

        let liveRes;
        if (client.isAccessKeyMode()) {
          liveRes = await client.post(
            "/api/biz/v1/skill/get_available_model_list",
            {
              scene: "web_turbo_video_generator",
              source_model_key: "",
            },
            { signal }
          );
        } else {
          const workspaceId = await client.ensureWorkspaceId(signal);
          liveRes = await client.post(
            "/api/biz/v1/agent/get_available_model_list",
            {
              scene: "web_turbo_video_generator",
              source_model_key: "",
              user_info: {
                consumer_uid: "0",
                workspace_id: workspaceId,
                app_id: DEFAULT_APP_ID,
              },
            },
            { signal }
          );
        }

        const rawList =
          liveRes?.config?.models ??
          liveRes?.models ??
          liveRes?.available_model_list ??
          (Array.isArray(liveRes) ? liveRes : []);

        let models = rawList.map(normalizeLiveModelItem).filter(Boolean);
        if (seedanceOnly) {
          models = models.filter((m) => m.key.toLowerCase().includes("seedance"));
        }

        if (args?.with_prices && (!client.isAccessKeyMode() || Boolean(client.getCookieHeader()))) {
          // Bounded price queries (< 24 total calls, concurrency 4) to stay well under 40s
          const tasks = [];
          for (const model of models) {
            const resList = Array.isArray(model.resolutions) ? model.resolutions : [null];
            for (const resVal of resList) {
              if (tasks.length >= 24) break;
              tasks.push({ model, resVal });
            }
          }

          const concurrency = 4;
          let idx = 0;
          const worker = async () => {
            while (idx < tasks.length) {
              const current = tasks[idx++];
              const { model, resVal } = current;
              const body = omitUndefined({
                model_name: model.key,
                model_key: model.key,
                resolution: resVal ?? undefined,
                agent_name: "pippit_video_part_agent",
                duration: 1,
                asset_type: 1,
                has_refer_video: false,
                scene: "web_turbo_video_generator",
                parameter_values: resVal ? { resolution: resVal } : {},
              });
              try {
                const authInfo = await client.post("/api/biz/v1/commerce/get_commerce_auth_info", body, {
                  signal,
                  timeoutMs: 8_000,
                  authMode: "cookie",
                });
                if (authInfo?.amount !== undefined) {
                  if (!model.credits_per_second || typeof model.credits_per_second !== "object") {
                    model.credits_per_second = {};
                  }
                  model.credits_per_second[resVal || "default"] = Number(authInfo.amount);
                }
              } catch {
                // Keep static fallback price on error
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
        }

        return withAccountTag(
          {
            source: "live",
            default_model: client.defaultModel,
            seedance_only: seedanceOnly,
            models,
          },
          label
        );
      },
    },

    upload_image: {
      description:
        "Upload an image (from an HTTP/HTTPS URL, local file path, or base64 string; max 30 MB, or max 20 MB on wan3.0; jpg/jpeg/png/webp/bmp/gif/heic/heif) to XiaoYunQue " +
        "(POST /api/biz/v1/skill/upload_file in Access-Key mode or /api/web/v1/common/upload_file in Cookie mode) and return {asset_id, pippit_asset_id, url, width, height, format} " +
        "for use in create_video. Note: uploaded assets belong to the uploading account — pass the same 'account' to create_video. (上传参考图片或首尾帧图片到小云雀；返回的素材归属该上传账号，生成时须使用同一账号)",
      args: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description:
              "Optional account selector (可选：指定上传到哪个小云雀账号；上传返回的 asset_id / pippit_asset_id 与该账号绑定，后续调用 create_video 时必须使用同一个账号).",
          },
          url: {
            type: "string",
            description: "HTTP(S) URL of an image to download and upload to XiaoYunQue.",
          },
          path: {
            type: "string",
            description: "Local file path to an image (jpg, jpeg, png, webp, bmp, gif, heic, heif).",
          },
          base64: {
            type: "string",
            description: "Base64-encoded image string or data:image/...;base64,... URI.",
          },
          filename: {
            type: "string",
            description: "Optional filename (e.g. 'frame.png').",
          },
        },
        additionalProperties: false,
      },
      async execute(args = {}, ctx) {
        const { client, label } = resolveTarget({
          account: args?.account,
          directory: ctx?.directory,
        });
        const uploaded = await uploadImageHelper(client, args, ctx?.abort);
        return withAccountTag(uploaded, label);
      },
    },

    estimate_credits: {
      description:
        "Estimate the credit cost of a XiaoYunQue video generation task and check current balance " +
        "(POST /api/biz/v1/skill/get_credit_balance + static pricing table in Access-Key mode; " +
        "or POST /api/biz/v1/commerce/get_commerce_auth_info + POST /commerce/v1/benefits/user_credit in Cookie mode). " +
        "Returns per_second cost, total credits, check_deduct_status (1 = enough balance), and current balance. " +
        "(预估视频生成所需积分并检查当前账号余额是否充足)",
      args: {
        type: "object",
        properties: {
          ...ACCOUNT_ARG_PROPERTY,
          prompt: {
            type: "string",
            description: "Optional prompt string.",
          },
          ...GENERATION_PARAM_PROPERTIES,
          ref_video_seconds: {
            type: "number",
            minimum: 0,
            description:
              "Total duration in seconds of attached reference videos (参考视频总秒数, used when model pricing_policy is 'output_plus_reference' and for wan3.0 15s/30s duration checks).",
          },
        },
        additionalProperties: false,
      },
      async execute(args = {}, ctx) {
        const signal = ctx?.abort;
        const { client, label } = resolveTarget({
          account: args?.account,
          directory: ctx?.directory,
        });
        const resolved = resolveAndValidateVideoParams(args, {
          defaultModel: client.defaultModel,
          requirePrompt: false,
        });

        let refVideoSeconds = 0;
        if (args.ref_video_seconds !== undefined && args.ref_video_seconds !== null) {
          refVideoSeconds = Math.ceil(Math.max(0, Number(args.ref_video_seconds) || 0));
        } else if (Array.isArray(resolved.reference_videos) && resolved.reference_videos.length > 0) {
          for (const v of resolved.reference_videos) {
            if (v && typeof v === "object" && Number(v.duration_ms) > 0) {
              refVideoSeconds += Math.ceil(Number(v.duration_ms) / 1000);
            }
          }
        }

        const hasReferVideo = Boolean(
          (Array.isArray(resolved.reference_videos) && resolved.reference_videos.length > 0) ||
            refVideoSeconds > 0
        );

        const hasResDim = Boolean(resolved.schema.has_resolution_dimension && !resolved.schema.is_draft);
        const pricingPolicy =
          hasReferVideo && resolved.schema.pricing_policy === "output_plus_reference"
            ? "output_plus_reference"
            : "output_only";
        const effectiveDuration = resolved.duration > 0 ? resolved.duration : resolved.schema.durations.default;
        const billableSeconds =
          pricingPolicy === "output_plus_reference"
            ? effectiveDuration + refVideoSeconds
            : effectiveDuration;

        if (client.isAccessKeyMode()) {
          const creditData = await client.post("/api/biz/v1/skill/get_credit_balance", {}, { signal });
          const balance = normalizeCreditBalance(creditData);
          const perSecond = Number(resolved.static_per_second_credits ?? 0);
          const total = Math.ceil(perSecond * billableSeconds);
          const enoughBalance = balance.total >= total;

          return withAccountTag(
            {
              model: resolved.model,
              resolution: hasResDim ? resolved.effective_resolution : null,
              duration: effectiveDuration,
              has_refer_video: hasReferVideo,
              ref_video_seconds: refVideoSeconds,
              pricing_policy: pricingPolicy,
              per_second: perSecond,
              total,
              estimated_credits: total,
              check_deduct_status: enoughBalance ? 1 : 0,
              enough_balance: enoughBalance,
              balance,
            },
            label
          );
        }

        const authBody = omitUndefined({
          model_name: resolved.model,
          model_key: resolved.model,
          resolution: hasResDim ? resolved.effective_resolution : undefined,
          agent_name: "pippit_video_part_agent",
          duration: 1,
          asset_type: 1,
          has_refer_video: hasReferVideo,
          scene: "web_turbo_video_generator",
          parameter_values: hasResDim ? { resolution: resolved.effective_resolution } : {},
        });

        const [authRes, creditData] = await Promise.all([
          client.post("/api/biz/v1/commerce/get_commerce_auth_info", authBody, { signal }),
          client.post("/commerce/v1/benefits/user_credit", {}, { commerce: true, signal }),
        ]);

        const perSecond = Number(authRes?.amount ?? resolved.static_per_second_credits ?? 0);
        const total = Math.ceil(perSecond * billableSeconds);
        const balance = normalizeCreditBalance(creditData);
        const checkDeductStatus = authRes?.check_deduct_status ?? null;

        return withAccountTag(
          {
            model: resolved.model,
            resolution: hasResDim ? resolved.effective_resolution : null,
            duration: effectiveDuration,
            has_refer_video: hasReferVideo,
            ref_video_seconds: refVideoSeconds,
            pricing_policy: pricingPolicy,
            per_second: perSecond,
            total,
            estimated_credits: total,
            check_deduct_status: checkDeductStatus,
            enough_balance: checkDeductStatus !== null ? checkDeductStatus === 1 : balance.total >= total,
            balance,
          },
          label
        );
      },
    },

    create_video: {
      description:
        "Submit a video generation task on XiaoYunQue (POST /api/biz/v1/skill/submit_run in Access-Key mode or /api/biz/v1/agent/submit_run in Cookie mode). " +
        "Supports Seedance 2.5, Seedance 2.5 Draft (two-stage 480p draft -> final upgrade via draft_task_id), Seedance 2.0 VIP / Fast VIP / Mini / Mini Lite, Seedance 1.0 Fast, Wan 3.0, and HappyHorse 1.1. " +
        "Supports text-to-video (t2v), first-last-frame (first_last_frame), multi-modal reference (reference: [@图片1], [@视频1], [@音频1]), video edit (edit), and video extend (extend). " +
        "Note: Generating videos consumes XiaoYunQue credits; uploaded assets must come from the same account. (创建小云雀视频生成任务；消耗账号积分，复用上传素材时须与 upload_image 使用同一账号)",
      args: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description:
              "Optional account selector (可选：指定使用哪个小云雀账号提交任务；任务创建成功后会自动绑定 task_id 到该账号槽位。注意：若传入 upload_image 返回的 asset_id / pippit_asset_id，必须与上传时使用同一个账号).",
          },
          prompt: {
            type: "string",
            description:
              "Video generation prompt (视频描述提示词; required unless draft_task_id is set). In reference mode, mention materials with [@图片1], [@视频1], [@音频1].",
          },
          ...GENERATION_PARAM_PROPERTIES,
          draft_task_id: {
            type: "string",
            description:
              "Render task ID from a completed Seedance_2.5_draft video (样片转正任务 ID: sends {draft:false, draft_task_id, model:'Seedance_2.5_draft', prompt:''}; must use the same account that generated the draft).",
          },
          wait_seconds: {
            type: "number",
            minimum: 0,
            maximum: 40,
            description:
              "Seconds to wait and poll for completion before returning (0-40, default 0 = return immediately after submission).",
          },
        },
        additionalProperties: false,
      },
      async execute(args = {}, ctx) {
        const signal = ctx?.abort;
        const { client, slot, label } = resolveTarget({
          account: args?.account,
          directory: ctx?.directory,
        });
        const useAccessKey = client.isAccessKeyMode();

        let waitSeconds = 0;
        if (args.wait_seconds !== undefined && args.wait_seconds !== null) {
          const parsedWait = Number(args.wait_seconds);
          if (!Number.isFinite(parsedWait) || parsedWait < 0 || parsedWait > 40) {
            throw new Error("Invalid 'wait_seconds': must be a number between 0 and 40.");
          }
          waitSeconds = parsedWait;
        }

        // If a custom model key is not in the static table, check the live model list before rejecting
        let liveModelItem = null;
        const requestedModel =
          args.model !== undefined && args.model !== null && String(args.model).trim() !== ""
            ? String(args.model).trim()
            : client.defaultModel;
        if (!args.draft_task_id && !findStaticModel(requestedModel) && client.hasCredentials()) {
          try {
            let liveRes;
            if (useAccessKey) {
              liveRes = await client.post(
                "/api/biz/v1/skill/get_available_model_list",
                {
                  scene: "web_turbo_video_generator",
                  source_model_key: "",
                },
                { signal }
              );
            } else {
              const wsId = await client.ensureWorkspaceId(signal);
              liveRes = await client.post(
                "/api/biz/v1/agent/get_available_model_list",
                {
                  scene: "web_turbo_video_generator",
                  source_model_key: "",
                  user_info: {
                    consumer_uid: "0",
                    workspace_id: wsId,
                    app_id: DEFAULT_APP_ID,
                  },
                },
                { signal }
              );
            }
            const rawModels = liveRes?.config?.models ?? liveRes?.models ?? [];
            liveModelItem =
              rawModels.find(
                (m) => m && String(m.key || m.id || "").toLowerCase() === requestedModel.toLowerCase()
              ) ?? null;
          } catch (err) {
            if (err?.isLoginError || err?.isAntiBot) throw err;
          }
        }

        const resolved = resolveAndValidateVideoParams(args, {
          defaultModel: client.defaultModel,
          requirePrompt: !args.draft_task_id,
          liveModelItem,
        });

        let param;
        const images = [];
        const videos = [];
        const audios = [];

        if (resolved.isDraftUpgrade) {
          param = resolved.param;
        } else {
          const imgUploadOpts = {
            assetType: "2",
            maxBytes: resolved.schema.max_image_bytes,
            acceptedFormats: resolved.schema.accepted_image_formats,
            modelKey: resolved.model,
            signal,
          };
          if (resolved.mode === "first_last_frame") {
            images.push(await resolveMediaAssetInput(client, resolved.first_frame, imgUploadOpts));
            if (resolved.last_frame) {
              images.push(await resolveMediaAssetInput(client, resolved.last_frame, imgUploadOpts));
            }
          } else {
            for (const img of resolved.reference_images) {
              images.push(await resolveMediaAssetInput(client, img, imgUploadOpts));
            }
            for (const vid of resolved.reference_videos) {
              videos.push(await resolveMediaAssetInput(client, vid, { assetType: "1", signal }));
            }
            for (const aud of resolved.reference_audios) {
              audios.push(await resolveMediaAssetInput(client, aud, { assetType: "4", signal }));
            }
          }

          param = omitUndefined({
            images,
            videos,
            audios,
            prompt: resolved.prompt,
            duration_sec: resolved.duration,
            ratio: resolved.aspect_ratio,
            resolution: resolved.resolution,
            ...(useAccessKey ? {} : { language: "zh" }),
            model: resolved.model,
            seed: resolved.seed,
            generate_type: resolved.generate_type,
            task_type: resolved.task_type,
            draft: resolved.draft,
          });
        }

        let submitData;
        if (useAccessKey) {
          const toSkillAssets = (arr) =>
            Array.isArray(arr) && arr.length > 0
              ? arr.map((item) => ({
                  pippit_asset_id: String(item.pippit_asset_id ?? item.asset_id),
                }))
              : undefined;

          const videoPartToolParam = resolved.isDraftUpgrade
            ? omitUndefined({
                prompt: resolved.param.prompt ?? "",
                model: resolved.param.model,
                draft: false,
                draft_task_id: resolved.param.draft_task_id,
              })
            : omitUndefined({
                images: toSkillAssets(images),
                prompt: resolved.prompt,
                duration_sec: resolved.duration,
                ratio: resolved.aspect_ratio,
                videos: toSkillAssets(videos),
                audios: toSkillAssets(audios),
                model: resolved.model,
                resolution: resolved.resolution,
                generate_type: resolved.generate_type,
                task_type: resolved.task_type,
                seed: resolved.seed,
                draft: resolved.draft,
              });

          const skillBabiParam = {
            edit_type: "instant_video",
            enter_from: "skill",
            scene_lv1: "ai_agent",
            scene_lv2: "front_tool",
            tab_name: "other",
            tool_id: "instant_video",
          };

          const skillSubmitBody = {
            agent_name: "pippit_video_part_agent",
            call_source: "pippit_cli",
            message: resolved.prompt ?? "",
            video_part_tool_param: videoPartToolParam,
          };

          submitData = await client.post("/api/biz/v1/skill/submit_run", skillSubmitBody, {
            query: { babi_param: JSON.stringify(skillBabiParam) },
            signal,
          });
        } else {
          const workspaceId = await client.ensureWorkspaceId(signal);
          const threadId = randomUUID();
          const runId = randomUUID();
          const messageId = randomUUID();

          const babiParam = {
            user_message_id: messageId,
            enter_from: "web",
            scene_lv1: "ai_agent",
            scene_lv2: "front_tool",
            edit_type: "instant_video",
            tool_id: "instant_video",
            tab_name: "other",
          };

          const runExtra = {
            client_extra: {
              edit_type: "instant_video",
              position: "home",
              entrance_from: "web",
              tab_name: "other",
            },
            babi_param: babiParam,
          };

          const submitBody = {
            thread_id: threadId,
            run_id: runId,
            agent_name: "pippit_video_part_agent",
            entrance_from: "web",
            user_info: {
              consumer_uid: "0",
              workspace_id: workspaceId,
              app_id: DEFAULT_APP_ID,
            },
            message: {
              message_id: messageId,
              role: "user",
              thread_id: threadId,
              run_id: runId,
              created_at: client.now(),
              content: [
                {
                  type: "data",
                  sub_type: "biz/x_data_direct_tool_call_req",
                  data: JSON.stringify({
                    tool_name: "biz/x_tool_name_video_part",
                    param: JSON.stringify(param),
                  }),
                  hidden: false,
                  is_thought: false,
                },
              ],
            },
            run_extra: JSON.stringify(runExtra),
          };

          submitData = await client.post("/api/biz/v1/agent/submit_run", submitBody, {
            query: { babi_param: JSON.stringify(babiParam) },
            signal,
          });
        }

        const returnedThreadId = submitData?.run?.thread_id ?? submitData?.thread_id;
        const returnedRunId = submitData?.run?.run_id ?? submitData?.run_id;
        if (!returnedThreadId || !returnedRunId) {
          throw new Error(
            "XiaoYunQue submit_run response did not contain data.run.thread_id and data.run.run_id."
          );
        }

        const taskId = `${returnedThreadId}:${returnedRunId}`;
        if (hasPool && slot) {
          clientOrPool.rememberTask(taskId, slot);
          clientOrPool.rememberTask(String(returnedRunId), slot);
        }

        const webLink = submitData?.web_thread_link ?? submitData?.run?.web_thread_link ?? undefined;

        const baseResult = omitUndefined({
          task_id: taskId,
          thread_id: String(returnedThreadId),
          run_id: String(returnedRunId),
          web_link: webLink,
          model: resolved.model,
          params_sent: stripAssetUrlsFromParam(param),
          estimated_credits: resolved.static_estimated_credits ?? undefined,
          audio_control: resolved.audio_control,
          warning: resolved.warning,
        });

        if (waitSeconds > 0) {
          const polled = await waitTaskHelper(
            client,
            {
              task_id: taskId,
              timeout_seconds: waitSeconds,
              interval_seconds: Math.min(5, Math.max(0.05, waitSeconds / 2)),
            },
            signal
          );
          return withAccountTag(
            {
              ...baseResult,
              ...polled,
            },
            label
          );
        }

        return withAccountTag(baseResult, label);
      },
    },

    get_task: {
      description:
        "Query the status, ETA, credit consumption, failure reason, and generated video URLs of a XiaoYunQue video task " +
        "(POST /api/biz/v1/skill/get_thread in Access-Key mode or /api/biz/v1/agent/get_run with fallback to get_thread in Cookie mode). " +
        "Pass either task_id ('<thread_id>:<run_id>') or thread_id + run_id. Optional download_dir or output_path downloads completed MP4 video(s) locally. " +
        "(查询小云雀视频生成任务状态、预计剩余时间、积分消耗及结果视频下载链接，可选直接下载 MP4)",
      args: {
        type: "object",
        properties: {
          ...ACCOUNT_ARG_PROPERTY,
          task_id: {
            type: "string",
            description: "Combined task ID '<thread_id>:<run_id>' returned by create_video (任务 ID).",
          },
          thread_id: {
            type: "string",
            description: "Thread ID (会话 thread_id, optional if task_id is provided).",
          },
          run_id: {
            type: "string",
            description: "Run ID (运行 run_id, optional if task_id is provided).",
          },
          download_dir: {
            type: "string",
            description: "Optional local directory to download completed MP4 video(s) into (可选本地下载目录).",
          },
          output_path: {
            type: "string",
            description: "Optional local file path to save the completed MP4 video to (可选本地保存路径).",
          },
        },
        additionalProperties: false,
      },
      async execute(args = {}, ctx) {
        return executeTaskBoundOp(args, ctx, (c) => getTaskHelper(c, args, ctx?.abort));
      },
    },

    wait_task: {
      description:
        "Poll get_task until the XiaoYunQue video task finishes ('completed', 'failed', or 'canceled') or timeout_seconds (default 40s, max 45s) elapses. " +
        "Optional download_dir or output_path downloads completed MP4 video(s) locally. " +
        "If timed_out is true, call wait_task again with the same task_id. (轮询等待视频生成任务完成，单次最长 45 秒；若未完成请再次调用)",
      args: {
        type: "object",
        properties: {
          ...ACCOUNT_ARG_PROPERTY,
          task_id: {
            type: "string",
            description: "Combined task ID '<thread_id>:<run_id>' returned by create_video (任务 ID).",
          },
          thread_id: {
            type: "string",
            description: "Thread ID (optional if task_id is provided).",
          },
          run_id: {
            type: "string",
            description: "Run ID (optional if task_id is provided).",
          },
          timeout_seconds: {
            type: "number",
            minimum: 0.05,
            maximum: 45,
            description: "Maximum seconds to wait in this call (单次等待超时秒数, default 40, max 45).",
          },
          interval_seconds: {
            type: "number",
            minimum: 0.02,
            maximum: 30,
            description: "Polling interval in seconds (轮询间隔秒数, default 5).",
          },
          download_dir: {
            type: "string",
            description: "Optional local directory to download completed MP4 video(s) into (可选本地下载目录).",
          },
          output_path: {
            type: "string",
            description: "Optional local file path to save the completed MP4 video to (可选本地保存路径).",
          },
        },
        additionalProperties: false,
      },
      async execute(args = {}, ctx) {
        return executeTaskBoundOp(args, ctx, (c) => waitTaskHelper(c, args, ctx?.abort));
      },
    },

    cancel_task: {
      description:
        "Cancel a queued or running XiaoYunQue video generation task (POST /api/biz/v1/agent/cancel_run). " +
        "Pass either task_id ('<thread_id>:<run_id>') or thread_id + run_id. (取消排队或生成中的视频任务)",
      args: {
        type: "object",
        properties: {
          ...ACCOUNT_ARG_PROPERTY,
          task_id: {
            type: "string",
            description: "Combined task ID '<thread_id>:<run_id>' to cancel.",
          },
          thread_id: {
            type: "string",
            description: "Thread ID (optional if task_id is provided).",
          },
          run_id: {
            type: "string",
            description: "Run ID (optional if task_id is provided).",
          },
        },
        additionalProperties: false,
      },
      async execute(args = {}, ctx) {
        return executeTaskBoundOp(args, ctx, async (c, { task_id, thread_id, run_id }) => {
          const authMode =
            c.isAccessKeyMode() && c.getCookieHeader() ? "cookie" : undefined;
          const res = await c.post(
            "/api/biz/v1/agent/cancel_run",
            { thread_id, run_id },
            { signal: ctx?.abort, authMode }
          );
          return {
            task_id,
            thread_id,
            run_id,
            canceled: true,
            ...(res && typeof res === "object" ? res : {}),
          };
        });
      },
    },
  };
}
