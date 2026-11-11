import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as pluginModule from "../index.mjs";
import { XiaoYunQuePlugin, _internal } from "../index.mjs";

const FIXED_NOW_MS = 1762800000_000; // unix sec = 1762800000
const FIXED_UNIX_SEC = 1762800000;

function computeExpectedMd5Sign(pathname, unixSec = FIXED_UNIX_SEC) {
  const last7 = pathname.slice(-7);
  return createHash("md5")
    .update(`9e2c|${last7}|7|5.8.0|${unixSec}||11ac`)
    .digest("hex")
    .toLowerCase();
}

async function startFakeXYQServer(t) {
  const savedEnvAccessKey = process.env.XYQ_ACCESS_KEY;
  const savedEnvAccessKeyFile = process.env.XYQ_ACCESS_KEY_FILE;
  delete process.env.XYQ_ACCESS_KEY;
  delete process.env.XYQ_ACCESS_KEY_FILE;

  const state = {
    requests: [],
    validCookie: "sessionid=secret_sess_abc123; sid_tt=secret_sid_xyz789; uid_tt=uid_secret_555",
    validAccessKey: "fake_test_ak_0000000000000000000000000000000000000000000000000000000000000000",
    workspaceCalls: 0,
    workspaceId: "7600000000000000123",
    spaceId: "7600000000000000456",
    runs: new Map(),
    threads: new Map(),
    uploadCounter: 1000,
    skillSubmitCounter: 2000,
    extraLiveModels: [],
    customHandler: null,
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks);
    const url = new URL(req.url, "http://127.0.0.1");

    let parsedBody = null;
    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("application/json") && rawBody.length > 0) {
      try {
        parsedBody = JSON.parse(rawBody.toString("utf8"));
      } catch {
        parsedBody = null;
      }
    }

    const record = {
      method: req.method,
      pathname: url.pathname,
      searchParams: Object.fromEntries(url.searchParams.entries()),
      headers: req.headers,
      rawBody,
      body: parsedBody,
    };
    state.requests.push(record);

    const sendJson = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (state.customHandler) {
      const handled = await state.customHandler(record, sendJson, state);
      if (handled !== false) return;
    }

    // Public sample image endpoint for upload_image URL tests
    if (req.method === "GET" && url.pathname === "/public/sample.png") {
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      ]);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(pngBytes.length),
      });
      res.end(pngBytes);
      return;
    }

    // Public sample video endpoint for download_dir / output_path tests
    if (req.method === "GET" && url.pathname === "/public/sample.mp4") {
      const mp4Bytes = Buffer.from([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
        0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
        0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
      ]);
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(mp4Bytes.length),
      });
      res.end(mp4Bytes);
      return;
    }

    // Official Access-Key Skill API routes (/api/biz/v1/skill/*)
    if (url.pathname.startsWith("/api/biz/v1/skill/")) {
      const authHeader = req.headers.authorization || "";
      if (authHeader !== `Bearer ${state.validAccessKey}`) {
        sendJson(200, {
          ret: "1015",
          errmsg: `invalid access key (received authorization: ${authHeader})`,
          log_id: "log_no_ak_1",
          data: null,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/biz/v1/skill/get_credit_balance") {
        sendJson(200, {
          ret: "0",
          errmsg: "",
          log_id: "log_ak_credit_1",
          data: {
            total_remain_amount: "1242",
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/biz/v1/skill/get_available_model_list") {
        sendJson(200, {
          ret: "0",
          errmsg: "",
          log_id: "log_ak_models_1",
          data: {
            scene: "web_turbo_video_generator",
            config: {
              models: [
                {
                  key: "Seedance_2.5_draft",
                  name: "Seedance 2.5 Draft",
                  disabled: false,
                  supported_ratio_list: [0, 2, 13, 3, 4, 5, 6],
                  total_limit: 50,
                  image_total_limit: 30,
                  video_total_limit: 10,
                  is_support_first_frame_image: true,
                  is_support_last_frame_image: true,
                  creation_mode_config: {
                    modes: [
                      { key: "reference_generation", enabled: true },
                      { key: "video_edit", enabled: true },
                      { key: "video_extend", enabled: true },
                      { key: "first_last_frame", enabled: true },
                    ],
                  },
                  parameter_config: {
                    dimensions: [
                      {
                        key: "duration",
                        default_value: "10",
                        range_config: { min_value: 4, max_value: 30, step: 1 },
                      },
                    ],
                  },
                },
                {
                  key: "Seedance_2.5",
                  name: "Seedance 2.5",
                  disabled: false,
                  supported_ratio_list: [0, 2, 13, 3, 4, 5, 6, 7],
                  total_limit: 50,
                  image_total_limit: 30,
                  video_total_limit: 10,
                  audio_total_limit: 10,
                  is_support_first_frame_image: true,
                  is_support_last_frame_image: true,
                  creation_mode_config: {
                    modes: [
                      { key: "reference_generation", enabled: true },
                      { key: "video_edit", enabled: true },
                      { key: "video_extend", enabled: true },
                      { key: "first_last_frame", enabled: true },
                    ],
                  },
                  parameter_config: {
                    dimensions: [
                      {
                        key: "duration",
                        default_value: "10",
                        range_config: { min_value: 4, max_value: 30, step: 1 },
                      },
                      {
                        key: "resolution",
                        default_value: "720p",
                        option_list: [
                          { value: "480p", disabled: false },
                          { value: "720p", disabled: false },
                          { value: "1080p", disabled: false },
                          { value: "4k", disabled: false },
                        ],
                      },
                    ],
                  },
                },
                {
                  key: "seedance2.0_fast_vision",
                  name: "Seedance 2.0 Fast",
                  disabled: false,
                  supported_ratio_list: [0, 2, 13, 3, 4, 5, 6],
                  total_limit: 12,
                  image_total_limit: 9,
                  video_total_limit: 3,
                  audio_total_limit: 3,
                  is_support_first_frame_image: true,
                  is_support_last_frame_image: true,
                  parameter_config: {
                    dimensions: [
                      {
                        key: "duration",
                        default_value: "10",
                        range_config: { min_value: 4, max_value: 15, step: 1 },
                      },
                      {
                        key: "resolution",
                        default_value: "720p",
                        option_list: [
                          { value: "480p", disabled: false },
                          { value: "720p", disabled: false },
                        ],
                      },
                    ],
                  },
                },
                {
                  key: "wan3.0",
                  name: "Wan 3.0",
                  disabled: false,
                  supported_ratio_list: [0, 2, 3, 4, 5, 6],
                  image_total_limit: 10,
                  video_total_limit: 5,
                  is_support_first_frame_image: true,
                  is_support_last_frame_image: true,
                  parameter_config: {
                    dimensions: [
                      {
                        key: "duration",
                        default_value: "10",
                        range_config: { min_value: 4, max_value: 30, step: 1 },
                      },
                      {
                        key: "resolution",
                        default_value: "720p",
                        option_list: [
                          { value: "480p", disabled: false },
                          { value: "720p", disabled: false },
                          { value: "1080p", disabled: false },
                        ],
                      },
                    ],
                  },
                },
                ...state.extraLiveModels,
              ],
            },
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/biz/v1/skill/upload_file") {
        if (!contentType.includes("multipart/form-data")) {
          sendJson(400, { ret: "-3", errmsg: "Expected multipart/form-data" });
          return;
        }
        const idNum = ++state.uploadCounter;
        sendJson(200, {
          ret: "0",
          errmsg: "",
          log_id: `log_ak_up_${idNum}`,
          data: {
            pippit_asset_id: `484000000${idNum}`,
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/biz/v1/skill/submit_run") {
        const seq = ++state.skillSubmitCounter;
        const threadId = `762742317315386${seq}`;
        const runId = `762742317315393${seq}`;
        const runObj = {
          thread_id: threadId,
          run_id: runId,
          state: 1,
          entry_list: [],
        };
        state.runs.set(`${threadId}:${runId}`, runObj);
        state.threads.set(threadId, {
          thread_id: threadId,
          run_list: [runObj],
        });
        sendJson(200, {
          ret: "0",
          errmsg: "",
          log_id: "log_ak_submit_ok",
          data: {
            run: {
              thread_id: threadId,
              run_id: runId,
            },
            web_thread_link: `https://xyq.jianying.com/home?thread_id=${threadId}`,
          },
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/biz/v1/skill/get_thread") {
        const threadObj = state.threads.get(parsedBody?.thread_id);
        if (!threadObj) {
          sendJson(200, { ret: "16017", errmsg: "ThreadNotFound", log_id: "log_ak_get_thread_404" });
          return;
        }
        sendJson(200, {
          ret: "0",
          errmsg: "",
          log_id: "log_ak_get_thread_ok",
          data: {
            thread: threadObj,
          },
        });
        return;
      }

      sendJson(404, { ret: "404", errmsg: `Unhandled skill route ${req.method} ${url.pathname}` });
      return;
    }

    // Verify cookie is present on API/commerce calls
    const cookieHeader = req.headers.cookie || "";
    if (!cookieHeader.includes("sessionid=")) {
      sendJson(200, {
        ret: "1015",
        errmsg: `check login error (received cookie: ${cookieHeader})`,
        log_id: "log_no_cookie_1",
        data: null,
      });
      return;
    }

    // Workspace endpoint
    if (req.method === "POST" && url.pathname === "/api/web/v1/workspace/get_user_workspace") {
      state.workspaceCalls += 1;
      sendJson(200, {
        ret: "0",
        errmsg: "",
        log_id: "log_ws_1",
        data: {
          workspace_id: state.workspaceId,
          space_id: state.spaceId,
          space_idc: "hl",
        },
      });
      return;
    }

    // Commerce user_credit
    if (req.method === "POST" && url.pathname === "/commerce/v1/benefits/user_credit") {
      sendJson(200, {
        ret: "0",
        errmsg: "",
        log_id: "log_credit_1",
        data: {
          credit: {
            vip_credit: 2000,
            gift_credit: 120,
            purchase_credit: 50,
            free_credits: 30,
            total_credit: 2200,
          },
        },
      });
      return;
    }

    // Commerce subscription user_info
    if (req.method === "POST" && url.pathname === "/commerce/v1/subscription/user_info") {
      sendJson(200, {
        ret: "0",
        errmsg: "",
        log_id: "log_vip_1",
        data: {
          flag: true,
          cur_vip_level: "pro",
          end_time: 1800000000,
          uid: "sensitive_uid_should_not_be_returned_99999",
          subscribe_uid: "sensitive_sub_uid_99999",
        },
      });
      return;
    }

    // get_available_model_list
    if (req.method === "POST" && url.pathname === "/api/biz/v1/agent/get_available_model_list") {
      if (parsedBody?.user_info?.app_id !== "795647") {
        sendJson(200, {
          ret: "-3",
          errmsg: "bad request: app_id must be string 795647",
          log_id: "log_bad_appid",
        });
        return;
      }
      sendJson(200, {
        ret: "0",
        errmsg: "",
        log_id: "log_models_1",
        data: {
          scene: "web_turbo_video_generator",
          config: {
            models: [
              {
                key: "Seedance_2.5_draft",
                name: "Seedance 2.5 Draft",
                disabled: false,
                supported_ratio_list: [0, 2, 13, 3, 4, 5, 6],
                total_limit: 50,
                image_total_limit: 30,
                video_total_limit: 10,
                is_support_first_frame_image: true,
                is_support_last_frame_image: true,
                creation_mode_config: {
                  modes: [
                    { key: "reference_generation", enabled: true },
                    { key: "video_edit", enabled: true },
                    { key: "video_extend", enabled: true },
                    { key: "first_last_frame", enabled: true },
                  ],
                },
                parameter_config: {
                  dimensions: [
                    {
                      key: "duration",
                      default_value: "10",
                      range_config: { min_value: 4, max_value: 30, step: 1 },
                    },
                  ],
                },
              },
              {
                key: "Seedance_2.5",
                name: "Seedance 2.5",
                disabled: false,
                supported_ratio_list: [0, 2, 13, 3, 4, 5, 6, 7],
                total_limit: 50,
                image_total_limit: 30,
                video_total_limit: 10,
                audio_total_limit: 10,
                is_support_first_frame_image: true,
                is_support_last_frame_image: true,
                creation_mode_config: {
                  modes: [
                    { key: "reference_generation", enabled: true },
                    { key: "video_edit", enabled: true },
                    { key: "video_extend", enabled: true },
                    { key: "first_last_frame", enabled: true },
                  ],
                },
                parameter_config: {
                  dimensions: [
                    {
                      key: "duration",
                      default_value: "10",
                      range_config: { min_value: 4, max_value: 30, step: 1 },
                    },
                    {
                      key: "resolution",
                      default_value: "720p",
                      option_list: [
                        { value: "480p", disabled: false },
                        { value: "720p", disabled: false },
                        { value: "1080p", disabled: false },
                        { value: "4k", disabled: false },
                        { value: "8k_disabled", disabled: true },
                      ],
                    },
                  ],
                },
              },
              {
                key: "wan3.0",
                name: "Wan 3.0",
                disabled: false,
                supported_ratio_list: [0, 2, 3, 4, 5, 6],
                image_total_limit: 10,
                video_total_limit: 5,
                is_support_first_frame_image: true,
                is_support_last_frame_image: true,
                parameter_config: {
                  dimensions: [
                    {
                      key: "duration",
                      default_value: "10",
                      range_config: { min_value: 4, max_value: 30, step: 1 },
                    },
                    {
                      key: "resolution",
                      default_value: "720p",
                      option_list: [
                        { value: "480p", disabled: false },
                        { value: "720p", disabled: false },
                        { value: "1080p", disabled: false },
                      ],
                    },
                  ],
                },
              },
              ...state.extraLiveModels,
            ],
          },
        },
      });
      return;
    }

    // get_commerce_auth_info
    if (req.method === "POST" && url.pathname === "/api/biz/v1/commerce/get_commerce_auth_info") {
      const modelKey = parsedBody?.model_key || parsedBody?.model_name;
      const resVal = parsedBody?.resolution;
      let amount = 20;
      if (modelKey === "Seedance_2.5_draft") amount = 9;
      else if (modelKey === "Seedance_2.5" && resVal === "480p") amount = 12;
      else if (modelKey === "Seedance_2.5" && resVal === "720p") amount = 20;
      else if (modelKey === "Seedance_2.5" && resVal === "1080p") amount = 64;
      else if (modelKey === "Seedance_2.5" && resVal === "4k") amount = 99;
      else if (modelKey === "seedance2.0_direct" && resVal === "720p") amount = 8;
      else if (modelKey === "Seedance_2.0_mini_lite") amount = 4;

      sendJson(200, {
        ret: "0",
        errmsg: "",
        log_id: "log_auth_info_1",
        data: {
          resource_id: `cc_biz_video_agent_${modelKey}`,
          benefit_type: `cc_biz_video_agent_${modelKey}`,
          resource_type: "aigc",
          amount,
          check_deduct_status: 1,
        },
      });
      return;
    }

    // upload_file
    if (req.method === "POST" && url.pathname === "/api/web/v1/common/upload_file") {
      if (!contentType.includes("multipart/form-data")) {
        sendJson(400, { ret: "-3", errmsg: "Expected multipart/form-data" });
        return;
      }
      const idNum = ++state.uploadCounter;
      const bodyStr = rawBody.toString("latin1");
      const assetTypeMatch = bodyStr.match(/name="asset_type"\r\n\r\n([^\r\n]+)/);
      const assetType = assetTypeMatch ? assetTypeMatch[1] : "2";
      sendJson(200, {
        ret: "0",
        errmsg: "",
        log_id: `log_up_${idNum}`,
        data: {
          asset_id: `766000000000000${idNum}`,
          pippit_asset_id: `373000000${idNum}`,
          file_id: `373000000${idNum}`,
          download_url: `https://p3-sign.douyinpic.com/tos-cn-i-wipe09lpyt/asset_${idNum}.png?x-expires=1800000000&amp;x-signature=sig_${idNum}`,
          format: assetType === "1" ? "mp4" : assetType === "4" ? "mp3" : "png",
          width: 1280,
          height: 720,
          duration_ms: assetType === "1" ? 5000 : 0,
        },
      });
      return;
    }

    // submit_run
    if (req.method === "POST" && url.pathname === "/api/biz/v1/agent/submit_run") {
      if (parsedBody?.user_info?.app_id !== "795647") {
        sendJson(200, {
          ret: "-3",
          errmsg: "bad request: user_info.app_id must be string '795647'",
          log_id: "log_submit_bad_appid",
        });
        return;
      }
      const threadId = parsedBody.thread_id;
      const runId = parsedBody.run_id;
      const runObj = {
        thread_id: threadId,
        run_id: runId,
        state: 1, // queued initially
        entry_list: [],
      };
      state.runs.set(`${threadId}:${runId}`, runObj);
      state.threads.set(threadId, {
        thread_id: threadId,
        run_list: [runObj],
      });
      sendJson(200, {
        ret: "0",
        errmsg: "",
        log_id: "log_submit_ok",
        data: {
          run: {
            thread_id: threadId,
            run_id: runId,
            state: 1,
          },
          web_thread_link: `https://www.xiaoyunque.com/thread/${threadId}`,
        },
      });
      return;
    }

    // get_run
    if (req.method === "POST" && url.pathname === "/api/biz/v1/agent/get_run") {
      const key = `${parsedBody?.thread_id}:${parsedBody?.run_id}`;
      const runObj = state.runs.get(key);
      if (!runObj) {
        sendJson(200, { ret: "16017", errmsg: "ThreadNotFound", log_id: "log_get_run_404" });
        return;
      }
      sendJson(200, {
        ret: "0",
        errmsg: "",
        log_id: "log_get_run_ok",
        data: {
          run: runObj,
        },
      });
      return;
    }

    // get_thread
    if (req.method === "POST" && url.pathname === "/api/biz/v1/agent/get_thread") {
      const threadObj = state.threads.get(parsedBody?.thread_id);
      if (!threadObj) {
        sendJson(200, { ret: "16017", errmsg: "ThreadNotFound", log_id: "log_get_thread_404" });
        return;
      }
      sendJson(200, {
        ret: "0",
        errmsg: "",
        log_id: "log_get_thread_ok",
        data: {
          thread: threadObj,
        },
      });
      return;
    }

    // cancel_run
    if (req.method === "POST" && url.pathname === "/api/biz/v1/agent/cancel_run") {
      const key = `${parsedBody?.thread_id}:${parsedBody?.run_id}`;
      const runObj = state.runs.get(key);
      if (runObj) {
        runObj.state = 5;
      }
      sendJson(200, {
        ret: "0",
        errmsg: "",
        log_id: "log_cancel_ok",
        data: {},
      });
      return;
    }

    sendJson(404, { ret: "404", errmsg: `Unhandled route ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const tempDir = await mkdtemp(join(tmpdir(), "xyq-plugin-test-"));

  t.after(async () => {
    if (savedEnvAccessKey !== undefined) {
      process.env.XYQ_ACCESS_KEY = savedEnvAccessKey;
    } else {
      delete process.env.XYQ_ACCESS_KEY;
    }
    if (savedEnvAccessKeyFile !== undefined) {
      process.env.XYQ_ACCESS_KEY_FILE = savedEnvAccessKeyFile;
    } else {
      delete process.env.XYQ_ACCESS_KEY_FILE;
    }
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  return { server, baseUrl, tempDir, state };
}

test("index.mjs exports only the plugin function and _internal, and all tools satisfy Magpie schema rules", async (t) => {
  const f = await startFakeXYQServer(t);

  const exportedFunctions = Object.entries(pluginModule).filter(([, v]) => typeof v === "function");
  assert.equal(exportedFunctions.length, 1, "index.mjs must export exactly one function");
  assert.equal(exportedFunctions[0][0], "XiaoYunQuePlugin");
  assert.equal(typeof _internal, "object");
  assert.notEqual(_internal, null);

  const hooks = await XiaoYunQuePlugin(
    { directory: f.tempDir },
    {
      baseUrl: f.baseUrl,
      cookie: f.state.validCookie,
      now: FIXED_NOW_MS,
    }
  );

  assert.ok(hooks && typeof hooks.tool === "object");
  const toolNames = Object.keys(hooks.tool);
  assert.deepEqual(toolNames, [
    "account",
    "list_video_models",
    "upload_image",
    "estimate_credits",
    "create_video",
    "get_task",
    "wait_task",
    "cancel_task",
  ]);

  const nameRegex = /^[A-Za-z0-9_-]{1,48}$/;
  for (const [name, def] of Object.entries(hooks.tool)) {
    assert.match(name, nameRegex, `Tool name ${name} must match ^[A-Za-z0-9_-]{1,48}$`);
    assert.equal(typeof def.description, "string");
    assert.ok(def.description.length > 20);
    assert.ok(def.args && typeof def.args === "object");
    assert.equal(def.args.type, "object");
    assert.equal(typeof def.args.properties, "object");
    assert.equal(typeof def.execute, "function");
  }
});

test("missing cookie returns clear configuration instructions, while offline list_video_models works without credentials", async (t) => {
  const f = await startFakeXYQServer(t);
  const savedCookie = process.env.XYQ_COOKIE;
  const savedCookieFile = process.env.XYQ_COOKIE_FILE;
  delete process.env.XYQ_COOKIE;
  delete process.env.XYQ_COOKIE_FILE;
  t.after(() => {
    if (savedCookie !== undefined) process.env.XYQ_COOKIE = savedCookie;
    if (savedCookieFile !== undefined) process.env.XYQ_COOKIE_FILE = savedCookieFile;
  });

  const hooks = await XiaoYunQuePlugin({}, { baseUrl: f.baseUrl });

  // Offline / credential-less list_video_models returns static table
  const seedanceList = await hooks.tool.list_video_models.execute({});
  assert.equal(seedanceList.source, "static");
  assert.equal(seedanceList.models.length, 9);
  assert.ok(seedanceList.models.every((m) => m.key.toLowerCase().includes("seedance")));

  const allList = await hooks.tool.list_video_models.execute({ offline: true, seedance_only: false });
  assert.equal(allList.models.length, 11);

  // Calling account without cookies throws clear configuration instructions
  await assert.rejects(
    () => hooks.tool.account.execute({}),
    /XiaoYunQue cookies are not configured.*DevTools.*Application.*Cookies.*sessionid/i
  );
});

test("cookie file parsing supports all 4 formats, filters by xiaoyunque.com domain, and re-reads when mtime changes", async (t) => {
  const f = await startFakeXYQServer(t);

  // Format (a): Browser extension JSON export {"cookies":[...], "localStorage":[...]}
  const extJson = JSON.stringify({
    cookies: [
      { name: "sessionid", value: "sess_from_ext_a", domain: ".xiaoyunque.com" },
      { name: "sid_tt", value: "sid_from_ext_a", domain: "www.xiaoyunque.com" },
      { name: "evil_cookie", value: "should_be_filtered", domain: ".bilibili.com" },
      { name: "other_domain", value: "ignored", domain: "notxiaoyunque.com" },
    ],
    localStorage: [{ key: "XYQ_LOGIN_RESULT", value: "{}" }],
  });
  const parsedA = _internal.parseCookieFileContent(extJson);
  assert.equal(parsedA.cookieHeader, "sessionid=sess_from_ext_a; sid_tt=sid_from_ext_a");

  // Format (b): Plain JSON array [{name, value}]
  const plainJson = JSON.stringify([
    { name: "sessionid", value: "sess_from_arr_b" },
    { name: "uid_tt", value: "uid_from_arr_b", domain: "xiaoyunque.com" },
    { name: "foreign", value: "no", domain: "example.com" },
  ]);
  const parsedB = _internal.parseCookieFileContent(plainJson);
  assert.equal(parsedB.cookieHeader, "sessionid=sess_from_arr_b; uid_tt=uid_from_arr_b");

  // Format (c): Netscape cookies.txt (including #HttpOnly_ prefix)
  const netscapeTxt = [
    "# Netscape HTTP Cookie File",
    "# https://curl.se/docs/http-cookies.html",
    "",
    "#HttpOnly_.xiaoyunque.com\tTRUE\t/\tTRUE\t1800000000\tsessionid\tsess_from_netscape_c",
    "www.xiaoyunque.com\tFALSE\t/\tTRUE\t1800000000\tttwid\tttwid_val_c",
    ".douyin.com\tTRUE\t/\tTRUE\t1800000000\tsessionid\twrong_domain_cookie",
  ].join("\n");
  const parsedC = _internal.parseCookieFileContent(netscapeTxt);
  assert.equal(parsedC.cookieHeader, "sessionid=sess_from_netscape_c; ttwid=ttwid_val_c");

  // Format (d): Raw Cookie header text file
  const rawTxt = "Cookie: sessionid=sess_from_raw_d; sid_guard=guard_d\n";
  const parsedD = _internal.parseCookieFileContent(rawTxt);
  assert.equal(parsedD.cookieHeader, "sessionid=sess_from_raw_d; sid_guard=guard_d");

  // Test mtime change re-reading in XiaoYunQueClient
  const cookieFilePath = join(f.tempDir, "xyq-cookies.json");
  await writeFile(cookieFilePath, extJson);
  const pastTime = new Date(Date.now() - 10_000);
  await utimes(cookieFilePath, pastTime, pastTime);

  const hooks = await XiaoYunQuePlugin(
    {},
    {
      baseUrl: f.baseUrl,
      cookieFile: cookieFilePath,
      now: FIXED_NOW_MS,
    }
  );

  await hooks.tool.account.execute({});
  const firstWsReq = f.state.requests.find((r) => r.pathname === "/api/web/v1/workspace/get_user_workspace");
  assert.equal(firstWsReq.headers.cookie, "sessionid=sess_from_ext_a; sid_tt=sid_from_ext_a");

  // Now update the cookie file and bump its mtime
  await writeFile(cookieFilePath, rawTxt);
  const futureTime = new Date(Date.now() + 10_000);
  await utimes(cookieFilePath, futureTime, futureTime);

  await hooks.tool.cancel_task.execute({ task_id: "t_1:r_1" });
  const cancelReq = f.state.requests.find((r) => r.pathname === "/api/biz/v1/agent/cancel_run");
  assert.equal(cancelReq.headers.cookie, "sessionid=sess_from_raw_d; sid_guard=guard_d");
});

test("commerce MD5 sign headers, workspace auto-fetch & caching, teamId header, and account non-sensitive output", async (t) => {
  const f = await startFakeXYQServer(t);
  const hooks = await XiaoYunQuePlugin(
    {},
    {
      baseUrl: f.baseUrl,
      cookie: f.state.validCookie,
      teamId: "team_42",
      now: FIXED_NOW_MS,
    }
  );

  const acc = await hooks.tool.account.execute({});
  assert.deepEqual(acc, {
    workspace: {
      workspace_id: "7600000000000000123",
      space_id: "7600000000000000456",
      space_idc: "hl",
    },
    credit: {
      vip_credit: 2000,
      gift_credit: 120,
      purchase_credit: 50,
      free_credits: 30,
      total: 2200,
    },
    vip: {
      flag: true,
      cur_vip_level: "pro",
      vip_level_name: "pro (标准会员)",
      end_time: 1800000000,
    },
  });
  assert.ok(!("uid" in acc.vip), "account must never return uid");
  assert.doesNotMatch(JSON.stringify(acc), /sensitive_uid/);

  // Verify commerce MD5 sign headers on both /commerce/v1/benefits/user_credit and /commerce/v1/subscription/user_info
  const creditReq = f.state.requests.find((r) => r.pathname === "/commerce/v1/benefits/user_credit");
  const vipReq = f.state.requests.find((r) => r.pathname === "/commerce/v1/subscription/user_info");
  assert.ok(creditReq);
  assert.ok(vipReq);

  assert.equal(creditReq.headers.appid, "795647");
  assert.equal(creditReq.headers.pf, "7");
  assert.equal(creditReq.headers.appvr, "5.8.0");
  assert.equal(creditReq.headers["sign-ver"], "1");
  assert.equal(creditReq.headers.tdid, "");
  assert.equal(creditReq.headers["device-time"], String(FIXED_UNIX_SEC));
  assert.equal(creditReq.headers.sign, computeExpectedMd5Sign("/commerce/v1/benefits/user_credit", FIXED_UNIX_SEC));
  assert.equal(creditReq.headers["x-team-id"], "team_42");
  assert.equal(creditReq.headers.origin, "https://www.xiaoyunque.com");
  assert.equal(creditReq.headers.referer, "https://www.xiaoyunque.com/home");

  assert.equal(vipReq.headers["device-time"], String(FIXED_UNIX_SEC));
  assert.equal(vipReq.headers.sign, computeExpectedMd5Sign("/commerce/v1/subscription/user_info", FIXED_UNIX_SEC));

  // Verify workspace is cached and not re-fetched on subsequent calls
  assert.equal(f.state.workspaceCalls, 1);
  const liveModels = await hooks.tool.list_video_models.execute({ with_prices: true });
  assert.equal(f.state.workspaceCalls, 1, "workspace_id should be cached in memory");
  assert.equal(liveModels.source, "live");
  assert.equal(liveModels.models.length, 2, "seedance_only=true filters out wan3.0");
  assert.equal(liveModels.models[0].key, "Seedance_2.5_draft");
  assert.equal(liveModels.models[0].resolutions, "server default 720p");
  assert.equal(liveModels.models[0].credits_per_second.default, 9);
  assert.deepEqual(liveModels.models[1].resolutions, ["480p", "720p", "1080p", "4k"]);
  assert.ok(liveModels.models[1].ratios.includes("2:1"), "Should map Pippit CLI ratio code 7 to 2:1");
  assert.equal(liveModels.models[1].credits_per_second["720p"], 20);
});

test("model validation, Seedance_2.5_draft handling, output_format rejection, audio=false prompt suffix, and unknown live model warning", async (t) => {
  const f = await startFakeXYQServer(t);
  const hooks = await XiaoYunQuePlugin(
    {},
    {
      baseUrl: f.baseUrl,
      cookie: f.state.validCookie,
      workspaceId: "7600000000000000123",
      now: FIXED_NOW_MS,
    }
  );

  const reqCountBefore = f.state.requests.length;

  // 1. Bad aspect_ratio on wan3.0 ('21:9' is not supported on wan3.0)
  await assert.rejects(
    () =>
      hooks.tool.create_video.execute({
        prompt: "Test wan ratio",
        model: "wan3.0",
        aspect_ratio: "21:9",
      }),
    /Invalid 'aspect_ratio' \("21:9"\) for model "wan3\.0"\. Allowed values: adaptive, 16:9, 9:16, 1:1, 4:3, 3:4/
  );

  // 2. Bad aspect_ratio on happyhorse-1.1 ('adaptive' is not supported on happyhorse-1.1)
  await assert.rejects(
    () =>
      hooks.tool.create_video.execute({
        prompt: "Test happyhorse ratio",
        model: "happyhorse-1.1",
        aspect_ratio: "adaptive",
      }),
    /Invalid 'aspect_ratio' \("adaptive"\) for model "happyhorse-1\.1"\. Allowed values: 16:9, 21:9, 9:16, 1:1, 4:3, 3:4/
  );

  // 3. Bad duration on seedance2.0_vision (4..15s allowed)
  await assert.rejects(
    () =>
      hooks.tool.create_video.execute({
        prompt: "Test duration",
        model: "seedance2.0_vision",
        duration: 25,
      }),
    /Invalid 'duration' \(25\) for model "seedance2\.0_vision"\. Allowed range: 4\.\.15 seconds/
  );

  // 4. Bad resolution on seedance2.0_fast_vision (only 480p, 720p allowed)
  await assert.rejects(
    () =>
      hooks.tool.create_video.execute({
        prompt: "Test resolution",
        model: "seedance2.0_fast_vision",
        resolution: "1080p",
      }),
    /Invalid 'resolution' \("1080p"\) for model "seedance2\.0_fast_vision"\. Allowed values: 480p, 720p/
  );

  // 5. output_format "mov" rejected
  await assert.rejects(
    () =>
      hooks.tool.create_video.execute({
        prompt: "Test mov",
        output_format: "mov",
      }),
    /Invalid 'output_format' \("mov"\): XiaoYunQue only outputs MP4 \("mp4"\)/
  );

  assert.equal(f.state.requests.length, reqCountBefore, "Validation failures must not send HTTP requests");

  // 6. Seedance_2.5_draft + audio: false -> no resolution in param, draft: true, prompt suffix + audio_control: "prompt_hint"
  const draftCreated = await hooks.tool.create_video.execute({
    prompt: "一只橘猫在窗台打盹",
    model: "Seedance_2.5_draft",
    duration: 6,
    aspect_ratio: "16:9",
    audio: false,
  });

  assert.equal(draftCreated.model, "Seedance_2.5_draft");
  assert.equal(draftCreated.audio_control, "prompt_hint");
  assert.equal(draftCreated.params_sent.draft, true);
  assert.equal("resolution" in draftCreated.params_sent, false, "Seedance_2.5_draft must omit resolution");
  assert.equal(draftCreated.params_sent.task_type, "reference");
  assert.equal(
    draftCreated.params_sent.prompt,
    "一只橘猫在窗台打盹（全片无对白、无旁白、无背景音乐，静音）"
  );
  assert.equal(draftCreated.estimated_credits, 54); // 9 credits/s * 6s

  // Verify exact submit_run request shape on the wire
  const submitReq = f.state.requests.findLast((r) => r.pathname === "/api/biz/v1/agent/submit_run");
  assert.ok(submitReq);
  assert.equal(submitReq.body.agent_name, "pippit_video_part_agent");
  assert.equal(submitReq.body.entrance_from, "web");
  assert.strictEqual(submitReq.body.user_info.app_id, "795647", "user_info.app_id must be a string '795647'");
  assert.equal(submitReq.body.user_info.workspace_id, "7600000000000000123");
  assert.equal(submitReq.body.user_info.consumer_uid, "0");

  // Double-encoded param inside message.content[0].data
  const content0 = submitReq.body.message.content[0];
  assert.equal(content0.type, "data");
  assert.equal(content0.sub_type, "biz/x_data_direct_tool_call_req");
  const outerData = JSON.parse(content0.data);
  assert.equal(outerData.tool_name, "biz/x_tool_name_video_part");
  assert.equal(typeof outerData.param, "string", "outerData.param must be a JSON string (double-encoded)");
  const innerParam = JSON.parse(outerData.param);
  assert.deepEqual(innerParam.images, []);
  assert.deepEqual(innerParam.videos, []);
  assert.deepEqual(innerParam.audios, []);
  assert.equal(innerParam.draft, true);
  assert.equal("resolution" in innerParam, false);

  // babi_param query param matches run_extra.babi_param
  assert.ok(submitReq.searchParams.babi_param, "submit_run must include ?babi_param= query param");
  const queryBabi = JSON.parse(submitReq.searchParams.babi_param);
  const runExtra = JSON.parse(submitReq.body.run_extra);
  assert.deepEqual(queryBabi, runExtra.babi_param);
  assert.equal(queryBabi.user_message_id, submitReq.body.message.message_id);

  // 7. Seedance 2.5 draft -> final upgrade via draft_task_id
  const upgradeRes = await hooks.tool.create_video.execute({
    draft_task_id: "44511698700",
  });
  assert.deepEqual(upgradeRes.params_sent, {
    draft: false,
    draft_task_id: "44511698700",
    model: "Seedance_2.5_draft",
    prompt: "",
  });

  // 8. Unknown model key allowed with warning if live get_available_model_list contains it
  f.state.extraLiveModels.push({
    key: "Seedance_3.0_preview",
    name: "Seedance 3.0 Preview",
    disabled: false,
    supported_ratio_list: [0, 2, 3],
    parameter_config: {
      dimensions: [
        { key: "duration", default_value: "5", range_config: { min_value: 4, max_value: 10, step: 1 } },
        { key: "resolution", default_value: "1080p", option_list: [{ value: "1080p", disabled: false }] },
      ],
    },
  });
  const customModelRes = await hooks.tool.create_video.execute({
    prompt: "Testing future model",
    model: "Seedance_3.0_preview",
    duration: 5,
    resolution: "1080p",
  });
  assert.equal(customModelRes.model, "Seedance_3.0_preview");
  assert.match(customModelRes.warning, /not in the static model table/i);
});

test("upload_image multipart upload, first_last_frame mode -> generate_type 1 + images order, and estimate_credits", async (t) => {
  const f = await startFakeXYQServer(t);
  const hooks = await XiaoYunQuePlugin(
    {},
    {
      baseUrl: f.baseUrl,
      cookie: f.state.validCookie,
      workspaceId: "7600000000000000123",
      now: FIXED_NOW_MS,
    }
  );

  // Write two local PNG files for first_frame and last_frame
  const firstFramePath = join(f.tempDir, "first.png");
  const lastFramePath = join(f.tempDir, "last.png");
  const validPngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04]);
  await writeFile(firstFramePath, validPngBytes);
  await writeFile(lastFramePath, validPngBytes);

  // Test upload_image tool directly with local path
  const uploadedFirst = await hooks.tool.upload_image.execute({ path: firstFramePath });
  assert.equal(uploadedFirst.asset_id, "7660000000000001001");
  assert.equal(uploadedFirst.pippit_asset_id, "3730000001001");
  assert.equal(uploadedFirst.width, 1280);
  assert.equal(uploadedFirst.height, 720);
  assert.equal(uploadedFirst.format, "png");
  assert.ok(!uploadedFirst.url.includes("&amp;"), "upload_image URL must be HTML-unescaped");

  // Reject invalid image format (.txt)
  const txtPath = join(f.tempDir, "notes.txt");
  await writeFile(txtPath, "hello world");
  await assert.rejects(
    () => hooks.tool.upload_image.execute({ path: txtPath }),
    /Unsupported image format/
  );

  // First-last-frame generation using uploaded object for first_frame and local path for last_frame
  const flCreated = await hooks.tool.create_video.execute({
    prompt: "镜头从首帧平滑过渡到尾帧",
    model: "Seedance_2.5",
    duration: 5,
    aspect_ratio: "16:9",
    resolution: "720p",
    first_frame: uploadedFirst,
    last_frame: lastFramePath,
  });

  assert.equal(flCreated.params_sent.generate_type, 1);
  assert.equal(flCreated.params_sent.task_type, "reference");
  assert.equal(flCreated.params_sent.images.length, 2);
  assert.equal(flCreated.params_sent.images[0].asset_id, "7660000000000001001", "images[0] must be first_frame");
  assert.equal(flCreated.params_sent.images[1].asset_id, "7660000000000001002", "images[1] must be last_frame");
  assert.equal("url" in flCreated.params_sent.images[0], false, "params_sent must strip asset URLs");

  // However, the wire param sent to submit_run must keep the asset URLs
  const submitReq = f.state.requests.findLast((r) => r.pathname === "/api/biz/v1/agent/submit_run");
  const wireParam = JSON.parse(JSON.parse(submitReq.body.message.content[0].data).param);
  assert.equal(wireParam.generate_type, 1);
  assert.equal(wireParam.images[0].asset_id, "7660000000000001001");
  assert.equal(wireParam.images[1].asset_id, "7660000000000001002");
  assert.match(wireParam.images[0].url, /^https:\/\/p3-sign\.douyinpic\.com\//);

  // Test estimate_credits for Seedance_2.5_draft (no resolution sent) and seedance2.0_direct (output_plus_reference)
  const estDraft = await hooks.tool.estimate_credits.execute({
    model: "Seedance_2.5_draft",
    duration: 8,
  });
  assert.equal(estDraft.per_second, 9);
  assert.equal(estDraft.total, 72);
  assert.equal(estDraft.check_deduct_status, 1);
  assert.equal(estDraft.balance.total, 2200);
  const draftAuthReq = f.state.requests.findLast((r) => r.pathname === "/api/biz/v1/commerce/get_commerce_auth_info");
  assert.equal("resolution" in draftAuthReq.body, false, "get_commerce_auth_info must omit resolution for Seedance_2.5_draft");
  assert.deepEqual(draftAuthReq.body.parameter_values, {});

  const estDirect = await hooks.tool.estimate_credits.execute({
    model: "seedance2.0_direct",
    resolution: "720p",
    duration: 6,
    ref_video_seconds: 4.2,
  });
  assert.equal(estDirect.pricing_policy, "output_plus_reference");
  assert.equal(estDirect.per_second, 8);
  assert.equal(estDirect.total, 8 * (6 + 5)); // 6s + ceil(4.2s)=5s -> 11s * 8 = 88
});

test("get_task normalization for queued/running/completed (with &amp; in URL)/failed, fallback to get_thread, and wait_task timeout", async (t) => {
  const f = await startFakeXYQServer(t);
  const hooks = await XiaoYunQuePlugin(
    {},
    {
      baseUrl: f.baseUrl,
      cookie: f.state.validCookie,
      workspaceId: "7600000000000000123",
      now: FIXED_NOW_MS,
    }
  );

  const created = await hooks.tool.create_video.execute({
    prompt: "Test lifecycle",
    model: "Seedance_2.5",
    duration: 5,
  });
  const taskId = created.task_id;
  const runObj = f.state.runs.get(taskId);

  // 1. State 1 -> queued
  const qRes = await hooks.tool.get_task.execute({ task_id: taskId });
  assert.equal(qRes.status, "queued");
  assert.equal(qRes.state, 1);

  // 2. State 2 -> running with biz/x_data_predict_info
  runObj.state = 2;
  runObj.entry_list = [
    {
      type: 1,
      message: {
        content: [
          {
            type: "data",
            sub_type: "biz/x_data_predict_info",
            data: JSON.stringify({
              predict_duration: 80_000, // 80s
              generate_start_time: FIXED_UNIX_SEC - 20, // started 20s ago -> ETA ~60s
            }),
          },
        ],
      },
    },
  ];
  const rRes = await hooks.tool.get_task.execute({ task_id: taskId });
  assert.equal(rRes.status, "running");
  assert.equal(rRes.eta_seconds, 60);

  // 3. wait_task timeout while still running
  const timedOut = await hooks.tool.wait_task.execute({
    task_id: taskId,
    timeout_seconds: 0.12,
    interval_seconds: 0.04,
  });
  assert.equal(timedOut.timed_out, true);
  assert.equal(timedOut.status, "running");
  assert.match(timedOut.message, /Call wait_task again/i);

  // 4. State 3 -> completed with realistic biz/x_data_video artifact containing &amp; in URL
  runObj.state = 3;
  runObj.credit_consumption = {
    pre_deduct_credits: "0",
    actual_deduct_credits: "100",
    returned_credits: "0",
    status: 4,
  };
  runObj.entry_list.push({
    type: 2,
    artifact: {
      artifact_id: "4780000001",
      thread_id: created.thread_id,
      run_id: created.run_id,
      content: [
        {
          type: "data",
          sub_type: "biz/x_data_video",
          pippit_asset_id: "4788888888",
          data: JSON.stringify({
            video: {
              asset_id: "7670000000000001",
              metadata: {
                width: 1280,
                height: 720,
                duration_ms: 5000,
                ratio: "16:9",
              },
              url: "https://v26-xyq-video.jianying.com/video/tos/cn/v1.mp4?a=1&amp;mime_type=video_mp4&amp;download=true",
              download_url:
                "https://v26-xyq-video.jianying.com/video/tos/cn/v1.mp4?a=1&amp;mime_type=video_mp4&amp;download=true",
              preview_url: "https://v26-xyq-video.jianying.com/video/tos/cn/v1_preview.mp4?a=1&amp;mime_type=video_mp4",
              cover_url: "https://p3-sign.douyinpic.com/cover.jpg?x=1&amp;y=2",
              render_task_id: "44511698700",
              vid: "v0dc76g100001",
              width: 1280,
              height: 720,
            },
          }),
        },
      ],
    },
  });

  const cRes = await hooks.tool.get_task.execute({ task_id: taskId });
  assert.equal(cRes.status, "completed");
  assert.deepEqual(cRes.credit_consumption, {
    actual_deduct_credits: 100,
    returned_credits: 0,
  });
  assert.equal(cRes.videos.length, 1);
  assert.equal(
    cRes.videos[0].video_url,
    "https://v26-xyq-video.jianying.com/video/tos/cn/v1.mp4?a=1&mime_type=video_mp4&download=true"
  );
  assert.equal(
    cRes.videos[0].preview_url,
    "https://v26-xyq-video.jianying.com/video/tos/cn/v1_preview.mp4?a=1&mime_type=video_mp4"
  );
  assert.equal(cRes.videos[0].cover_url, "https://p3-sign.douyinpic.com/cover.jpg?x=1&y=2");
  assert.equal(cRes.videos[0].width, 1280);
  assert.equal(cRes.videos[0].height, 720);
  assert.equal(cRes.videos[0].duration_ms, 5000);
  assert.equal(cRes.videos[0].render_task_id, "44511698700");
  assert.equal(cRes.videos[0].draft_task_id, "44511698700");
  assert.equal(cRes.videos[0].pippit_asset_id, "4788888888");

  // 5. State 4 -> failed with fail_reason
  runObj.state = 4;
  runObj.fail_reason = {
    code: 99999,
    message: "内容涉及侵犯他人权益",
    detail: "内容涉及侵犯他人权益",
  };
  const fRes = await hooks.tool.get_task.execute({
    thread_id: created.thread_id,
    run_id: created.run_id,
  });
  assert.equal(fRes.status, "failed");
  assert.deepEqual(fRes.fail_reason, {
    code: 99999,
    message: "内容涉及侵犯他人权益",
  });
});

test("ret 1015 -> login error, ret 16012 -> anti-bot error, and cookie values redacted from all errors", async (t) => {
  const f = await startFakeXYQServer(t);
  const secretCookie = "sessionid=super_secret_sess_999; sid_tt=super_secret_sid_888";

  const hooks = await XiaoYunQuePlugin(
    {},
    {
      baseUrl: f.baseUrl,
      cookie: secretCookie,
      workspaceId: "7600000000000000123",
      now: FIXED_NOW_MS,
    }
  );

  // 1. ret 1015 -> login error message with cookie values redacted even if server echoes them
  f.state.customHandler = async (req, sendJson) => {
    if (req.pathname === "/api/biz/v1/agent/cancel_run") {
      sendJson(200, {
        ret: "1015",
        errmsg: `login expired for ${secretCookie}`,
        log_id: "log_1015_test",
      });
      return true;
    }
    return false;
  };

  let loginErr = null;
  try {
    await hooks.tool.cancel_task.execute({ task_id: "t1:r1" });
  } catch (err) {
    loginErr = err;
  }
  assert.ok(loginErr);
  assert.match(loginErr.message, /cookie expired or invalid, re-export cookies/i);
  assert.match(loginErr.message, /ret=1015/);
  assert.match(loginErr.message, /log_id=log_1015_test/);
  assert.ok(!loginErr.message.includes("super_secret_sess_999"), "sessionid value must be redacted");
  assert.ok(!loginErr.message.includes("super_secret_sid_888"), "sid_tt value must be redacted");
  assert.match(loginErr.message, /\[REDACTED\]/);

  // 2. ret 16012 -> anti-bot verification required message
  f.state.customHandler = async (req, sendJson) => {
    if (req.pathname === "/api/biz/v1/agent/cancel_run") {
      sendJson(200, {
        ret: "16012",
        errmsg: "CommonSharkBlockError",
        log_id: "log_16012_shark",
        starling_key: "shark_block_key",
      });
      return true;
    }
    return false;
  };

  let sharkErr = null;
  try {
    await hooks.tool.cancel_task.execute({ task_id: "t1:r1" });
  } catch (err) {
    sharkErr = err;
  }
  assert.ok(sharkErr);
  assert.match(
    sharkErr.message,
    /anti-bot verification required: open www\.xiaoyunque\.com in a browser, pass the captcha, re-export cookies/i
  );
  assert.match(sharkErr.message, /ret=16012/);
  assert.match(sharkErr.message, /log_id=log_16012_shark/);
  assert.match(sharkErr.message, /starling_key=shark_block_key/);
});

test("get_task fallback to get_thread + .mp4 regex fallback, upload_image URL/base64/>30MB, and create_video wait_seconds", async (t) => {
  const f = await startFakeXYQServer(t);
  const hooks = await XiaoYunQuePlugin(
    {},
    {
      baseUrl: f.baseUrl,
      cookie: f.state.validCookie,
      workspaceId: "7600000000000000123",
      now: FIXED_NOW_MS,
    }
  );

  // 1. upload_image via URL and base64, and > 30MB rejection
  const fromUrl = await hooks.tool.upload_image.execute({
    url: `${f.baseUrl}/public/sample.png`,
  });
  assert.equal(fromUrl.format, "png");

  const b64Png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa]).toString("base64");
  const fromB64 = await hooks.tool.upload_image.execute({
    base64: `data:image/png;base64,${b64Png}`,
    filename: "inline.png",
  });
  assert.equal(fromB64.format, "png");

  const oversizedB64 = Buffer.alloc(_internal.MAX_UPLOAD_BYTES + 16, 0x41).toString("base64");
  await assert.rejects(
    () => hooks.tool.upload_image.execute({ base64: oversizedB64 }),
    /exceeds the 30 MB maximum limit/
  );

  // 2. Make get_run fail so get_task falls back to get_thread, and test .mp4 regex fallback
  f.state.customHandler = async (req, sendJson, state) => {
    if (req.pathname === "/api/biz/v1/agent/get_run") {
      sendJson(500, { ret: "-1", errmsg: "get_run unavailable" });
      return true;
    }
    if (req.pathname === "/api/biz/v1/agent/submit_run") {
      const threadId = req.body.thread_id;
      const runId = req.body.run_id;
      const completedRun = {
        thread_id: threadId,
        run_id: runId,
        state: 3,
        entry_list: [
          {
            type: 1,
            message: {
              content: [
                {
                  type: "text",
                  data: "Result ready: https://v26-xyq-video.jianying.com/fallback/out.mp4?token=1&amp;flag=2",
                },
              ],
            },
          },
        ],
      };
      state.threads.set(threadId, {
        thread_id: threadId,
        run_list: [completedRun],
      });
      sendJson(200, {
        ret: "0",
        errmsg: "",
        data: {
          run: { thread_id: threadId, run_id: runId, state: 3 },
        },
      });
      return true;
    }
    return false;
  };

  const waited = await hooks.tool.create_video.execute({
    prompt: "Test wait_seconds and get_thread fallback",
    model: "Seedance_2.0_mini_lite",
    duration: 4,
    wait_seconds: 1,
  });

  assert.equal(waited.status, "completed");
  assert.equal(waited.timed_out, false);
  assert.equal(waited.videos.length, 1);
  assert.equal(
    waited.videos[0].video_url,
    "https://v26-xyq-video.jianying.com/fallback/out.mp4?token=1&flag=2"
  );
});

test("Access-Key backend: accessKey / accessKeyFile / XYQ_ACCESS_KEY priority, Bearer header, no cookies or a_bogus, and file hot-reload", async (t) => {
  const f = await startFakeXYQServer(t);

  // 1. Plain-text accessKeyFile and JSON browser-credential.json parsing + hot-reload
  const akFilePath = join(f.tempDir, "access_key");
  await writeFile(akFilePath, `  ${f.state.validAccessKey}\n`, "utf8");

  const hooksFromFile = await XiaoYunQuePlugin(
    {},
    {
      skillBaseUrl: f.baseUrl,
      baseUrl: f.baseUrl,
      accessKeyFile: akFilePath,
      // Even when a cookie is present, Access-Key mode must be the default
      cookie: f.state.validCookie,
      teamId: "889900",
      now: FIXED_NOW_MS,
    }
  );

  const accRes = await hooksFromFile.tool.account.execute({});
  assert.equal(accRes.auth_mode, "access_key");
  assert.equal(accRes.team_id, "889900");
  assert.deepEqual(accRes.credit, {
    total: 1242,
    total_remain_amount: "1242",
  });

  const skillCreditReq = f.state.requests.findLast(
    (r) => r.pathname === "/api/biz/v1/skill/get_credit_balance"
  );
  assert.ok(skillCreditReq, "account must call POST /api/biz/v1/skill/get_credit_balance in Access-Key mode");
  assert.equal(skillCreditReq.headers.authorization, `Bearer ${f.state.validAccessKey}`);
  assert.equal(skillCreditReq.headers["user-agent"], "Pippit-CLI/1.0");
  assert.equal(skillCreditReq.headers["x-team-id"], "889900");
  assert.equal(skillCreditReq.headers.cookie, undefined, "Skill API must not send Cookie header");
  assert.equal("a_bogus" in skillCreditReq.searchParams, false, "Skill API must not add a_bogus");
  assert.equal("aid" in skillCreditReq.searchParams, false, "Skill API must not add web query params");
  assert.equal(f.state.workspaceCalls, 0, "Access-Key mode must not call get_user_workspace");

  // 2. Hot-reload accessKeyFile when updated to pippit-cli browser-credential.json format
  const rotatedKey = "rotated_test_ak_1111111111111111111111111111111111111111111111111111111111111111";
  f.state.validAccessKey = rotatedKey;
  await writeFile(
    akFilePath,
    JSON.stringify({ access_key: rotatedKey, updated_at: "2026-11-11T00:00:00Z" }),
    "utf8"
  );
  const futureTime = new Date(Date.now() + 10_000);
  await utimes(akFilePath, futureTime, futureTime);

  const accResAfterReload = await hooksFromFile.tool.account.execute({});
  assert.equal(accResAfterReload.credit.total, 1242);
  const reloadedReq = f.state.requests.findLast(
    (r) => r.pathname === "/api/biz/v1/skill/get_credit_balance"
  );
  assert.equal(reloadedReq.headers.authorization, `Bearer ${rotatedKey}`);

  // 3. Env XYQ_ACCESS_KEY fallback when options omit accessKey / accessKeyFile
  const envKey = "env_test_ak_2222222222222222222222222222222222222222222222222222222222222222";
  f.state.validAccessKey = envKey;
  process.env.XYQ_ACCESS_KEY = envKey;

  const hooksFromEnv = await XiaoYunQuePlugin(
    {},
    {
      baseUrl: f.baseUrl,
      now: FIXED_NOW_MS,
    }
  );
  const envAcc = await hooksFromEnv.tool.account.execute({});
  assert.equal(envAcc.auth_mode, "access_key");
  assert.equal(envAcc.team_id, "0");
  const envReq = f.state.requests.findLast(
    (r) => r.pathname === "/api/biz/v1/skill/get_credit_balance"
  );
  assert.equal(envReq.headers.authorization, `Bearer ${envKey}`);
  assert.equal("x-team-id" in envReq.headers, false, "X-Team-Id must be omitted when teamId is 0/empty");
});

test("Access-Key backend: list_video_models, estimate_credits, upload_image, create_video, get_task/wait_task MP4 download, and key redaction", async (t) => {
  const f = await startFakeXYQServer(t);
  const hooks = await XiaoYunQuePlugin(
    {},
    {
      baseUrl: f.baseUrl,
      accessKey: f.state.validAccessKey,
      now: FIXED_NOW_MS,
    }
  );

  // 1. list_video_models via /api/biz/v1/skill/get_available_model_list
  const liveModels = await hooks.tool.list_video_models.execute({ seedance_only: false });
  assert.equal(liveModels.source, "live");
  assert.ok(liveModels.models.some((m) => m.key === "Seedance_2.5"));
  assert.ok(liveModels.models.some((m) => m.key === "seedance2.0_fast_vision"));
  assert.ok(liveModels.models.some((m) => m.key === "wan3.0"));
  const modelListReq = f.state.requests.findLast(
    (r) => r.pathname === "/api/biz/v1/skill/get_available_model_list"
  );
  assert.ok(modelListReq);
  assert.deepEqual(modelListReq.body, {
    scene: "web_turbo_video_generator",
    source_model_key: "",
  });
  assert.equal(f.state.workspaceCalls, 0);

  // 2. estimate_credits via /api/biz/v1/skill/get_credit_balance + static pricing table
  const estFast = await hooks.tool.estimate_credits.execute({
    model: "seedance2.0_fast",
    resolution: "480p",
    duration: 4,
  });
  assert.equal(estFast.model, "seedance2.0_fast_vision");
  assert.equal(estFast.resolution, "480p");
  assert.equal(estFast.duration, 4);
  assert.equal(estFast.per_second, 3);
  assert.equal(estFast.total, 12);
  assert.equal(estFast.enough_balance, true);
  assert.equal(estFast.check_deduct_status, 1);
  assert.equal(estFast.balance.total, 1242);

  // 3. upload_image via /api/biz/v1/skill/upload_file
  const sampleImgPath = join(f.tempDir, "frame1.png");
  await writeFile(sampleImgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const uploaded = await hooks.tool.upload_image.execute({ path: sampleImgPath });
  assert.equal(uploaded.pippit_asset_id, "4840000001001");
  assert.equal(uploaded.asset_id, "4840000001001");
  assert.equal(uploaded.format, "png");
  const uploadReq = f.state.requests.findLast((r) => r.pathname === "/api/biz/v1/skill/upload_file");
  assert.ok(uploadReq);
  assert.match(uploadReq.rawBody.toString("latin1"), /name="file"; filename="frame1\.png"/);

  // 4. create_video in Access-Key mode (T2V with Seedance 2.0 Fast, 480p, 4s, audio=false)
  const createdT2V = await hooks.tool.create_video.execute({
    prompt: "a cat walking on a beach at sunset",
    model: "seedance2.0_fast_vision",
    resolution: "480p",
    duration: 4,
    aspect_ratio: "16:9",
    audio: false,
    seed: 7,
  });
  assert.equal(createdT2V.model, "seedance2.0_fast_vision");
  assert.equal(createdT2V.estimated_credits, 12);
  assert.equal(createdT2V.audio_control, "prompt_hint");

  const submitT2VReq = f.state.requests.findLast((r) => r.pathname === "/api/biz/v1/skill/submit_run");
  assert.ok(submitT2VReq);
  const babiParam = JSON.parse(submitT2VReq.searchParams.babi_param);
  assert.equal(babiParam.enter_from, "skill");
  assert.equal(babiParam.tool_id, "instant_video");
  assert.equal(submitT2VReq.body.agent_name, "pippit_video_part_agent");
  assert.equal(submitT2VReq.body.call_source, "pippit_cli");
  assert.deepEqual(submitT2VReq.body.video_part_tool_param, {
    prompt: `a cat walking on a beach at sunset${_internal.SILENT_PROMPT_SUFFIX}`,
    duration_sec: 4,
    ratio: "16:9",
    model: "seedance2.0_fast_vision",
    resolution: "480p",
    seed: 7,
  });

  // 5. create_video first_last_frame in Access-Key mode sends images: [{ pippit_asset_id }]
  const createdFL = await hooks.tool.create_video.execute({
    prompt: "camera pans smoothly",
    model: "Seedance_2.5",
    resolution: "720p",
    duration: 5,
    first_frame: uploaded,
    last_frame: sampleImgPath,
  });
  assert.equal(createdFL.params_sent.generate_type, 1);
  assert.equal(createdFL.params_sent.task_type, "reference");
  const submitFLReq = f.state.requests.findLast((r) => r.pathname === "/api/biz/v1/skill/submit_run");
  assert.deepEqual(submitFLReq.body.video_part_tool_param.images, [
    { pippit_asset_id: "4840000001001" },
    { pippit_asset_id: "4840000001002" },
  ]);
  assert.equal(submitFLReq.body.video_part_tool_param.generate_type, 1);
  assert.equal(submitFLReq.body.video_part_tool_param.task_type, "reference");

  // 6. get_task / wait_task via /api/biz/v1/skill/get_thread + local MP4 download
  const runObj = f.state.runs.get(createdT2V.task_id);
  runObj.state = 3;
  runObj.credit_consumption = {
    actual_deduct_credits: "36",
    returned_credits: "0",
  };
  runObj.entry_list.push({
    type: 2,
    artifact: {
      artifact_id: "4780000999",
      thread_id: createdT2V.thread_id,
      run_id: createdT2V.run_id,
      content: [
        {
          type: "data",
          sub_type: "biz/x_data_video",
          pippit_asset_id: "4849999999",
          data: JSON.stringify({
            video: {
              asset_id: "7670000000009999",
              metadata: {
                width: 854,
                height: 480,
                duration_ms: 4000,
                ratio: "16:9",
              },
              url: `${f.baseUrl}/public/sample.mp4?download=true&amp;v=1`,
              download_url: `${f.baseUrl}/public/sample.mp4?download=true&amp;v=1`,
              preview_url: `${f.baseUrl}/public/sample.mp4?preview=true`,
              cover_url: `${f.baseUrl}/public/sample.png`,
              render_task_id: "44511999999",
              vid: "v0dc76g199999",
              width: 854,
              height: 480,
            },
          }),
        },
      ],
    },
  });

  const outMp4Path = join(f.tempDir, "downloaded", "test-out.mp4");
  const waitedRes = await hooks.tool.wait_task.execute({
    task_id: createdT2V.task_id,
    timeout_seconds: 2,
    interval_seconds: 0.05,
    output_path: outMp4Path,
  });
  assert.equal(waitedRes.status, "completed");
  assert.equal(waitedRes.timed_out, false);
  assert.equal(waitedRes.videos.length, 1);
  assert.equal(waitedRes.videos[0].local_path, outMp4Path);
  assert.equal(waitedRes.downloaded_files.length, 1);
  assert.equal(waitedRes.downloaded_files[0].path, outMp4Path);
  const savedBytes = await readFile(outMp4Path);
  assert.equal(savedBytes.length, 24);
  assert.equal(savedBytes.subarray(4, 8).toString("ascii"), "ftyp");

  // 7. Access-Key secret redaction on error
  f.state.customHandler = async (req, sendJson) => {
    if (req.pathname === "/api/biz/v1/skill/get_credit_balance") {
      sendJson(200, {
        ret: "1015",
        errmsg: `bad bearer ${f.state.validAccessKey}`,
        log_id: "log_ak_1015",
      });
      return true;
    }
    return false;
  };

  let akErr = null;
  try {
    await hooks.tool.account.execute({});
  } catch (err) {
    akErr = err;
  }
  assert.ok(akErr);
  assert.match(akErr.message, /Access Key invalid or expired/i);
  assert.ok(!akErr.message.includes(f.state.validAccessKey), "Access Key value must be redacted from error messages");
  assert.match(akErr.message, /\[REDACTED\]/);
});


