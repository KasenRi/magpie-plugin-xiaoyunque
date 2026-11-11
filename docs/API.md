# XiaoYunQue (小云雀 / Pippit CN) Video Generation API Reference

This document details both the **Official Access-Key Skill API** (`https://xyq.jianying.com/api/biz/v1/skill/*`, used by `@pippit-dev/cli` and enabled by default in this plugin when an Access Key is configured) and the reverse-engineered **Web Cookie API** of **XiaoYunQue** (`https://www.xiaoyunque.com`, ByteDance's domestic "Pippit" AI video platform) for **Seedance 2.0 / 2.5** (and Wan 3.0 / HappyHorse 1.1 / Seedance 1.0) video generation.

---

## 0. Official Access-Key Skill API (`https://xyq.jianying.com/api/biz/v1/skill/*`) — Default Backend

- **Where to create an Access Key**: [https://www.xiaoyunque.com/cli?tab=api](https://www.xiaoyunque.com/cli?tab=api) (64-hex string, or stored in `~/.pippit/credentials/browser-credential.json` as `{"access_key":"..."}`).
- **Base URL**: `https://xyq.jianying.com`
- **Headers**:
  - `Authorization: Bearer <AccessKey>`
  - `User-Agent: Pippit-CLI/1.0`
  - `Accept: application/json`
  - `Content-Type: application/json` (or `multipart/form-data` for `upload_file`)
  - Optional `X-Team-Id: <teamId>` (when `teamId` is non-empty and not `"0"`)
  - **No `Cookie` header, no `a_bogus` URL signing, no `workspace_id`, and no Shark CAPTCHA risk control (`ret=16014`) on headless Linux servers.**
- **Endpoints**:
  1. `POST /api/biz/v1/skill/get_credit_balance` (`{}`) -> `data: { total_remain_amount: "<credits>" }`
  2. `POST /api/biz/v1/skill/get_available_model_list` (`{ scene: "web_turbo_video_generator", source_model_key: "" }`) -> `data.config.models[]` (returns all 8 live models including `Seedance_2.5`, `Seedance_2.5_draft`, `seedance2.0_vision`, `seedance2.0_fast_vision`, `Seedance_2.0_mini`, `Seedance_2.0_mini_lite`, `wan3.0`, `happyhorse-1.1`).
  3. `POST /api/biz/v1/skill/upload_file` (`multipart/form-data` field `file`) -> `data: { pippit_asset_id: "<id>" }`
  4. `POST /api/biz/v1/skill/submit_run?babi_param=...`
     - Query `babi_param`: `{"edit_type":"instant_video","enter_from":"skill","scene_lv1":"ai_agent","scene_lv2":"front_tool","tab_name":"other","tool_id":"instant_video"}`
     - JSON body:
       ```json
       {
         "agent_name": "pippit_video_part_agent",
         "call_source": "pippit_cli",
         "message": "<prompt>",
         "video_part_tool_param": {
           "images": [{ "pippit_asset_id": "..." }],
           "videos": [{ "pippit_asset_id": "..." }],
           "audios": [{ "pippit_asset_id": "..." }],
           "prompt": "<prompt>",
           "duration_sec": 4,
           "ratio": "16:9",
           "model": "seedance2.0_fast_vision",
           "resolution": "480p",
           "generate_type": 1,
           "task_type": "reference",
           "seed": 42,
           "draft": true,
           "draft_task_id": "..."
         }
       }
       ```
     - Response: `data: { run: { thread_id: "skill_...", run_id: "skill_..." }, web_thread_link: "..." }`
  5. `POST /api/biz/v1/skill/get_thread` (`{ thread_id, run_id }`) -> `data.thread.run_list[]` (same `state` 1=queued, 2/7/8=running, 3=completed, 4=failed, 5=canceled and `biz/x_data_video` artifact schema as the web API).

---

All Web API findings below are backed by:
1. Static analysis of the production web bundles (`/workspace/xiaoyunque/site/main.7f23997939.js`, `home.html`, `sdk-glue.js`, `runtime-v1.0.0.js`, `argus-builder-strategy.3d705abfea.js`, security configs `config_2117.js` / `project_2117.js` / `strategy_2117.js`, and lazy chunks in `/workspace/xiaoyunque/site/chunks/`).
2. Cross-reference with official Pippit Go CLI (`Pippit-dev_cli`), cookie-based Playwright scripts (`XiakeMan777_seedance2.0_XYQ_APi`), and ByteDance sister-site proxies (`jimeng-free-api-all`, `jimeng-mcp-server`).
3. Live probes against `https://www.xiaoyunque.com` using a real web cookie session (note: while read-only web endpoints succeed with cookies, `POST /api/biz/v1/agent/submit_run` on the web path triggers ByteDance Shark risk control `ret=16014` on headless servers, which is why the Access-Key Skill API above is the default backend).

---

## 1. Authentication, Request Wrapper & Security SDKs

### 1.1 Base URLs, Hostnames & App IDs

In `main.7f23997939.js` (modules `226071`, `860297`, `170153`), the web app defines two App IDs and resolves its base URL to same-origin (`""`, i.e., `https://www.xiaoyunque.com`) in production:

```js
// main.7f23997939.js (module 226071 & 860297)
let r={APPID:"795647",NATIVE_APPID:"8700"};
let r="bytedance.net"; // RO.A
// main.7f23997939.js (module 170153)
RG=(0,RB.iu)()?`https://pippit-platform-cn.${RO.A}`:""
```

Every generated service class (`pippitService`, `Nm`, `ZE`, `B6`, `Xo`, `ij`, `oK`, `zq`) uses `genBaseURL(e)`:

```js
// main.7f23997939.js (module 170153)
genBaseURL(e){return"string"==typeof this.baseURL?this.baseURL+e:this.baseURL(e)}
```

- **Web Cookie Host (`https://www.xiaoyunque.com`)**: Accepts standard ByteDance Passport session cookies (`sessionid`, `sessionid_ss`, `sid_tt`, `uid_tt`, `uid_tt_ss`, `sid_guard`, `sid_ucp_v1`, `ssid_ucp_v1`) on `/api/web/v1/*`, `/api/biz/v1/*`, and `/commerce/*`.
- **OpenAPI Skill Host (`https://xyq.jianying.com`)**: Used by the official `Pippit-dev_cli` (`internal/config/config.go`: `DefaultDomain = "https://xyq.jianying.com"`) for `/api/biz/v1/skill/*` endpoints with `Authorization: Bearer <AK>` (`ak_...`).
  - **Live-verified**: Calling `/api/biz/v1/skill/*` on `www.xiaoyunque.com` with cookies returns `401 {"ret":"401","errmsg":"invalid access key"}`. Calling `xyq.jianying.com` with `www.xiaoyunque.com` cookies returns `{"ret":"1002","errmsg":"check login error"}`.

### 1.2 Axios Request Wrappers & Default Headers

Module `170153` in `main.7f23997939.js` creates a base Axios instance `RW` with `withCredentials: true` and default header factory `Rz`:

```js
// main.7f23997939.js (module 170153)
Rz=()=>({appvr:"1.1.4","entrance-from":"web",appid:Rv.APPID,pf:"7"}),
RW=RL.A.create({baseURL:RG,withCredentials:!0,headers:{...Rz()}})
```

Thus, normal browser requests carry default headers:
- `appid: "795647"`
- `appvr: "1.1.4"`
- `entrance-from: "web"`
- `pf: "7"`

However, **live probes confirm** that for `/api/web/v1/*` and `/api/biz/v1/*`, the backend does **not** enforce `appid`, `appvr`, `entrance-from`, or `pf` headers—only `Cookie`, `Content-Type: application/json`, `Origin: https://www.xiaoyunque.com`, and `Referer: https://www.xiaoyunque.com/` are needed.

There are **three** request wrapper families in `main.7f23997939.js` (module `170153`):

#### Wrapper A: Standard Business / Agent API (`RK` / `R$`)
Used by `R5` (`pippitService`), `R6` (`Nm`), `R8` (`ZE`), `RY` (`B6`) for `/api/biz/v1/agent/*`, `/api/biz/v1/commerce/*`, `/api/web/v1/asset/*`, `/api/web/v1/common/*`, etc.

```js
// main.7f23997939.js (module 170153 & module 443715)
R$=async(e,t)=>{
  let i=(0,RC.j$)(e),
      r=(0,RP.vI)((0,RN.vy)({headers:{...Rz(),...i.headers,...t?.headers}}),i);
  return(await RW.request({...i,...t,headers:r.headers,params:{...i.params,...t?.params}})).data
}
```

- **Team Workspace Header (`x-Team-id`)**: Module `443715` (`RN.vy`) checks `localStorage.getItem("xiaoyunque_current_team_id")`. In personal workspace mode it strips `"x-Team-id"` and `"Pippit-Team-Id"`; in team mode it injects `"x-Team-id": "<team_id>"`:
  ```js
  // main.7f23997939.js (module 443715)
  let r="xiaoyunque_current_team_id",a="x-Team-id",s="Pippit-Team-Id";
  function d(e){let t=l(),i={...e?.headers};return delete i[s],t?i[a]=t:delete i[a],{...e,headers:i}}
  ```
- **`submit_run` Query Interceptor (`?babi_param=...`)**: Module `739443` (`RC.j$`) intercepts `POST /api/biz/v1/agent/submit_run`, extracts `babi_param` from the JSON string `data.run_extra`, removes `generate_id` / `generateId` from the query copy, and attaches it as URL query parameter `babi_param`:
  ```js
  // main.7f23997939.js (module 739443)
  let r=/^\/api\/(biz|internal)\/v1\/agent\/submit_run$/;
  function n(e){
    if(!(function(e){if(!e)return!1;let t=s(e);return!!t&&r.test(t)})(e.url)||void 0!==e.params?.babi_param)return e;
    let t=function(e){if("string"!=typeof e||!e.trim())return;try{let t=JSON.parse(e);if(!a(t)||!a(t.babi_param))return;let i={...t.babi_param};return delete i.generate_id,delete i.generateId,JSON.stringify(i)}catch{return}}(a(e.data)?e.data.run_extra:void 0);
    return t?{...e,params:{...e.params,babi_param:t}}:e
  }
  ```
- **Team Canvas Switch Interceptor**: Module `820159` (`RP.vI`) checks if `"x-Team-id"` is present on `submit_run`; if so, it sets `run_extra.client_extra.project_canvas_switch = false`.

#### Wrapper B: Native AppID Override (`RH` / `Pp`)
Used by `Pp` (`Xo`) for `/api/web/v1/workspace/get_user_workspace`, passing `Appid: "8700"` (`NATIVE_APPID`):
```js
// main.7f23997939.js (module 170153)
Pp=new RS.Ay({request:RH({extraHeaders:{Appid:Rv.NATIVE_APPID}}),baseURL:RG})
```
*(Live probe verified `POST /api/web/v1/workspace/get_user_workspace` also succeeds without `Appid` header).*

#### Wrapper C: Jianying Commerce Gateway MD5 Signature (`Rj` -> `Pv`, `PR`, `Pf`)
Used by `Pv` (`ij`, `Appid: "8700"`), `PR` (`oK`, `Appid: "795647"`), and `Pf` (`zq`) for `/commerce/v1/*`, `/commerce/v2/*`, `/commerce/v3/*`, and `/lv/v1/*`.
Module `926948` (`Rw.A`) computes an MD5 `sign` header and `device-time` unix timestamp:

```js
// main.7f23997939.js (module 926948)
let s=function(e){
  let{url:t,pf:i="7",appvr:r="5.8.0",tdid:s=""}=e,
      {pathname:n}=new URL(t.startsWith("http")?t:`https://www.jianying.com${t}`),
      o=Math.floor(Date.now()/1e3);
  return{sign:a()(`9e2c|${n.slice(-7)}|${i}|${r}|${o}|${s}|11ac`).toLowerCase(),"device-time":o}
}
// main.7f23997939.js (module 170153)
Rj=e=>async(t,i)=>{
  let r=t.url||"",a=(0,Rw.A)({url:r,pf:"7",appvr:"5.8.0",tdid:""});
  return(await RW.request({...t,...i,headers:{...Rz(),"sign-ver":1,pf:"7",appvr:"5.8.0",tdid:"",...a,...e?.extraHeaders,...t.headers,...i?.headers}})).data
}
```

- **Formula**:
  - `device-time` = `Math.floor(Date.now() / 1000)` (seconds)
  - `last7` = `pathname.slice(-7)` (e.g. `"_credit"` for `/commerce/v1/benefits/user_credit`, `"er_info"` for `/commerce/v1/subscription/user_info`)
  - `sign` = `md5("9e2c|" + last7 + "|7|5.8.0|" + device_time + "||11ac").toLowerCase()`
  - Required accompanying headers: `Appid: "795647"` (or `"8700"`), `sign-ver: "1"`, `pf: "7"`, `appvr: "5.8.0"`, `tdid: ""`, `device-time: "<sec>"`, `sign: "<md5>"`.
- **Live-verified**: Calling `/commerce/v1/benefits/user_credit` without `sign` / `device-time` / `Appid` returns `{"ret":"1014","errmsg":"system busy"}`; calling `/commerce/v1/subscription/user_info` without them returns `{"ret":"34010105","errmsg":"login error"}`.

### 1.3 Security SDKs (`sdk-glue.js`, `bdms.js`, `runtime-v1.0.0.js`, `argus`)

Four security scripts are loaded in `/workspace/xiaoyunque/site/home.html`:

1. **`sdk-glue.js` (`v1.0.0.66`)**:
   Initialized inline in `home.html`:
   ```js
   // home.html
   window._SdkGlueInit({
     self:{aid:795647,pageId:44487},
     bdms:{
       paths:{include:["^/api","^/commerce","^/lv","^/passport","^/pippit","^/cc","^/feedback","^/luckycat"]},
       ddrt:3,track:{mode:0},aid:795647,pageId:44487
     },
     verifyCenter:{
       interceptPathList:{include:["^/api"]},
       captchaOptions:{showMode:"mask",ele:"captcha_container"},
       nocaptchaOptions:{},
       commonOptions:{aid:795647,pageId:44487}
     }
   });
   ```
   - **`bdms` (`bdms.js` `1.0.1.20` from `lf-c-flwb.bytetos.com`)**: Hooks `window.fetch` and `XMLHttpRequest.prototype` in the browser to append `msToken` and `a_bogus` query parameters to URLs matching `bdms.paths.include` (`^/api`, `^/commerce`, etc.).
   - **`verifyCenter`**: Intercepts `^/api` responses to trigger a mask CAPTCHA when ByteDance Shark anti-bot returns block error codes (`16012`–`16015`).
   - **`csrf` (`secsdk-lastest.umd.js`) is NOT initialized**: Although `sdk-glue.js` defines `defaultExportsMap.csrf` (`https://lf1-cdn-tos.bytegoofy.com/obj/goofy/secsdk/secsdk-lastest.umd.js`), `home.html` omits the `csrf` key in `_SdkGlueInit(...)`. In `sdk-glue.js`:
     ```js
     // sdk-glue.js
     e.csrf&&(o.loadMap.csrf.loadedStatus="Pending", ... window.secsdk.csrf.setProtectedHost({...}))
     ```
     Because `e.csrf` is `undefined`, `secsdk.csrf` remains `"Uninitialized"` and **`x-secsdk-csrf-token` / `passport_csrf_token` headers are never injected or required**.

2. **`runtime-v1.0.0.js` (`@byted/secsdk-strategy`, `project-id="2117"`)**:
   Loads `https://lf-security.bytegoofy.com/ee/security-secsdk/runtime-stable.js` -> `config_2117.js` (`{"sampleRatio":10000}`) -> `security-secsdk-gray/project_2117.js` and `security-secsdk-gray/strategy_2117.js?v=1`.
   Inspection of `strategy_2117.js?v=1` and `project_2117.js` shows that project `2117` only runs a DOM anti-phishing check (`proxyFishing` checking `domain: ["jianying.com"]` in `report_only` mode) and script-tag domain reporting (`sriDomainCheck`):
   ```js
   // strategy_2117.js?v=1 (fetched from lf-security.bytegoofy.com)
   {"conf":{"mode":"report_only","custom":{"domain":["jianying.com"]}},"name":"proxyFishing","listener":["CONTENT_LOADED"]}
   ```
   It does **not** hook `fetch`/`XHR` or sign any requests.

3. **`argus-builder-strategy.3d705abfea.js`**:
   Client-side DOM attribute/URL XSS sanitizer (`bid: "xiaoyunque_web"`). Does not touch API calls.

### 1.4 Is Any Signing Required for `submit_run`? (Comparison with Jimeng)

- **Jimeng (`jimeng-free-api-all`)**:
  - Always appends query parameters `?aid=513695&device_platform=web&region=CN&webId=...&da_version=3.3.2&aigc_features=app_lip_sync` and Jianying MD5 headers (`Device-Time`, `Sign`, `Sign-Ver: 1`) on every `/mweb/v1/*` request (`jimeng-free-api-all/src/api/controllers/core.ts`).
  - For video generation (`/mweb/v1/aigc_draft/generate`), Jimeng's backend enforces `msToken` + `a_bogus` anti-bot verification (`ret: 1000` / Shark block without it), forcing `jimeng-free-api-all` (`src/lib/browser-transport.ts`) to route video submissions through a headless Playwright browser loaded with `bdms.js`.
- **XiaoYunQue (`www.xiaoyunque.com`)**:
  - Does **not** use `aid`, `device_platform`, `web_id`, or `region` query parameters on `/api/biz/v1/*` or `/api/web/v1/*`. Instead, `app_id: "795647"` and `workspace_id` are sent inside the JSON request body (`user_info`), and only `?babi_param=...` is added to `submit_run`.
  - **Live-verified**: All read-only `/api/biz/v1/agent/*` and `/api/biz/v1/commerce/*` endpoints (`get_available_model_list`, `list_user_history`, `get_thread`, `get_run`, `get_commerce_auth_info`, `get_credit_consumption_list`) succeed over plain HTTPS with **only `Cookie` + `Origin`/`Referer`**, no `msToken`, `a_bogus`, `X-Bogus`, or MD5 `sign`.
  - **`UNVERIFIED` for `submit_run` anti-bot enforcement**: Because we did not call `POST /api/biz/v1/agent/submit_run`, it is **`UNVERIFIED`** whether the gateway enforces `bdms.js`'s `msToken` + `a_bogus` on `submit_run` (or only triggers `16012 CommonSharkBlockError` / `16014 VerifySharkBlockError` under high rate). Note that `XiakeMan777/xiaoyunque_v3.py` executes `fetch('/api/biz/v1/agent/submit_run', ...)` inside a Playwright page where `bdms.js` automatically appends `msToken` and `a_bogus`.

---

## 2. Account, Workspace, Credits & VIP Membership

### 2.1 User Workspace (`POST /api/web/v1/workspace/get_user_workspace`)

Returns the user's `workspace_id` (required in `user_info` for `get_available_model_list` and `submit_run`), `space_id`, and `space_idc`.

```js
// main.7f23997939.js (module 170153)
GetUserWorkspaceWeb(e,t){let i=this.genBaseURL("/api/web/v1/workspace/get_user_workspace"),r={};return this.request({url:i,method:"POST",data:r},t)}
```

- **Request**: `POST https://www.xiaoyunque.com/api/web/v1/workspace/get_user_workspace` with body `{}`
- **Live-Verified Response**:
  ```json
  {
    "ret": "0",
    "errmsg": "",
    "svr_time": 1700000000,
    "log_id": "<log_id>",
    "data": {
      "workspace_id": "7600000000000000000",
      "space_id": "7600000000000000001",
      "space_idc": "hl"
    }
  }
  ```

*(Note: User profile fields `uid`, `screen_name`, `avatar_url` are persisted by Passport login into `localStorage.getItem("XYQ_LOGIN_RESULT")`; `GET /api/biz/v1/user/info` returns `404` on `www.xiaoyunque.com`.)*

### 2.2 Credit Balance (`POST /commerce/v1/benefits/user_credit`)

Web equivalent of OpenAPI's `/api/biz/v1/skill/get_credit_balance`. Defined on `Pv` (`ij`) and `PR` (`oK`) in `main.7f23997939.js` and Kotlin commerce SDK `chunks/598699.7827ccd70f.js`:

```js
// main.7f23997939.js (module 170153)
UserCredit(e,t){let i=e||{},r=this.genBaseURL("/commerce/v1/benefits/user_credit"),a={query_scope:i.query_scope,team_id:i.team_id};return this.request({url:r,method:"POST",data:a},t)}
```

- **Headers Required**: Jianying Commerce MD5 headers (Section 1.2 Wrapper C) with `pathname.slice(-7) === "_credit"`:
  - `Appid: "795647"` (or `"8700"`)
  - `pf: "7"`
  - `appvr: "5.8.0"`
  - `sign-ver: "1"`
  - `device-time: "<unix_sec>"`
  - `sign: md5("9e2c|_credit|7|5.8.0|" + device_time + "||11ac")`
- **Request Body**: `{}`
- **Response Structure** (from `chunks/598699.7827ccd70f.js` & `XiakeMan777/xiaoyunque_v3.py`):
  ```json
  {
    "ret": "0",
    "errmsg": "",
    "data": {
      "credit": {
        "gift_credit": 120,
        "purchase_credit": 0,
        "vip_credit": 2000,
        "total_credit": 2120
      }
    }
  }
  ```
  *(Total available credits = `gift_credit + purchase_credit + vip_credit`.)*

### 2.3 Credit Consumption History (`POST /api/biz/v1/commerce/get_credit_consumption_list`)

Works with plain cookies (no MD5 `sign` header needed).

```js
// main.7f23997939.js (module 170153)
GetCreditConsumptionList(e,t){let i=e||{},r=this.genBaseURL("/api/biz/v1/commerce/get_credit_consumption_list"),a={start_date:i.start_date,end_date:i.end_date,scene:i.scene,model:i.model,cursor:i.cursor,page_size:i.page_size,consumer_uid:i.consumer_uid,team_id:i.team_id,project_key:i.project_key};return this.request({url:r,method:"POST",data:a},t)}
```

- **Request**: `{"page_size": 5, "cursor": ""}`
- **Live-Verified Response**:
  ```json
  {
    "ret": "0",
    "errmsg": "",
    "data": {
      "items": [
        {
          "history_id": "<history_id>",
          "create_time": "2026-01-01 12:00",
          "scene_name": "<scene_name>",
          "project_id": "<project_id>",
          "project_name": "<project_name>",
          "thread_id": "canvas_thread_<thread_id>",
          "thread_name": "<project_name>",
          "model_name": "Seedance 2.0 VIP · 720p",
          "prompt": "<user_prompt>",
          "amount": "112",
          "source": "web",
          "scene": 6
        }
      ],
      "next_cursor": "5",
      "has_more": true
    }
  }
  ```

### 2.4 VIP / Membership Status (`POST /commerce/v1/subscription/user_info`)

```js
// main.7f23997939.js (module 170153)
UserInfo(e,t){let i=e||{},r=this.genBaseURL("/commerce/v1/subscription/user_info"),a={scene:i.scene,aid:i.aid,team_id:i.team_id};return this.request({url:r,method:"POST",data:a},t)}
// chunks/760736.5b1acd0155.js (module 449583)
let a={free:"免费版",standard:"基础会员",pro:"标准会员",max:"高级会员",ultra:"超级会员"};
```

- **Headers Required**: Jianying Commerce MD5 headers (`pathname.slice(-7) === "er_info"`).
- **Live-Verified `data` Schema**:
  ```json
  {
    "flag": false,
    "start_time": 0,
    "end_time": 0,
    "is_first_subscribe": false,
    "is_cancel_subscribe": false,
    "uid": "",
    "subscribe_uid": "",
    "subscribe_type": "",
    "product_id": "",
    "subscribe_cycle": 0,
    "cycle_unit": "",
    "vip_real_end": 0,
    "next_renewal_time": 0,
    "cur_vip_level": "",
    "expired_vip_level": "",
    "is_group_vip": false
  }
  ```
  where `flag: true` indicates an active VIP subscription and `cur_vip_level` is one of `"free" | "standard" | "pro" | "max" | "ultra"`.

---

## 3. Video Model List (`POST /api/biz/v1/agent/get_available_model_list`)

### 3.1 Exact Request Body & Why Integer `app_id` Fails

```js
// main.7f23997939.js (module 170153)
GetAvailableModelList(e,t){let i=e||{},r=this.genBaseURL("/api/biz/v1/agent/get_available_model_list"),a={scene:i.scene,user_info:i.user_info,source_model_key:i.source_model_key};return this.request({url:r,method:"POST",data:a},t)}
// chunks/760736.5b1acd0155.js (module 924281)
let s=await n.pippitService.GetAvailableModelList({
  scene:r,
  source_model_key:i||"",
  user_info:{
    consumer_uid:this.$root.loginStore.userConfig.uid||"0",
    workspace_id:this.$root.loginStore.userConfig.workspace_id||"0",
    app_id:o.APPID // "795647" (STRING!)
  }
});
```

> **Critical Detail**: `user_info.app_id` **MUST be a JSON string (`"795647"`)**, not a number (`795647`). Passing `"app_id": 795647` causes Go backend JSON unmarshaling to fail with `{"ret":"-3","errmsg":"bad request"}`. Passing `"app_id": "795647"` (even with `"consumer_uid": "0"` and `"workspace_id": "0"`) returns `200 {"ret":"0", ...}`.

- **Exact Request Body**:
  ```json
  {
    "scene": "web_turbo_video_generator",
    "source_model_key": "",
    "user_info": {
      "consumer_uid": "0",
      "workspace_id": "7600000000000000000",
      "app_id": "795647"
    }
  }
  ```
- **Supported `scene` Values** (from `chunks/760736.5b1acd0155.js` module `924281`, all live-verified):
  - `"web_turbo_video_generator"` — Main video generator (`video_part` tool); returns all 11 video models.
  - `"web_novel_storyboard"` — Novel/short-drama storyboard video generation.
  - `"web_unified_agent"` — Unified agent chat (`Seedance_2.0_mini_lite`, `Seedance_2.0_mini`, `seedance2.0_fast_vision`, `seedance2.0_vision`, `wan3.0`, `seedance2.0_direct`, `seedance2.0_fast_direct`, `Seedance_1.0_fast`).
  - `"web_canvas"` — Canvas agent mode.
  - `"web_novel_canvas"` — Novel canvas mode.
  - `"web_image_agent"` — Image generation models (`Nano_banana_2`, `Seedream_5.0_lite`, `Seedream_4.5`, `Seedream_4.0`, `Seedream_3.1`).
  - `"web_audio_agent"` — Audio/music generation models (`Suno_v5`, `Suno_v5.5`, `Seaweed_audio`).

### 3.2 Complete Live List of Video Models (`scene: "web_turbo_video_generator"`)

The full redacted live response is saved at `/workspace/xiaoyunque/probe/models_live.json`. Below is the complete summary of all **11** models returned live, together with their live-probed credit prices per second from `POST /api/biz/v1/commerce/get_commerce_auth_info`:

| # | `key` / `id` | `name` (`abbreviation`) | Durations (s) | Resolutions (`default`) | Supported Ratios (codes) | Reference Material Limits (`total` / `img` / `vid`, img MB, vid duration) | Generation Modes (`generation_mode` / `first_frame` / `last_frame`) | Live Credit Price / sec (`get_commerce_auth_info`) |
|---|---|---|---|---|---|---|---|---|
| 1 | `Seedance_2.5_draft` | **Seedance 2.5 Draft** (`SD 2.5 Draft`) | `4`–`30`s (def `10`s) | Fixed `480p` draft (`hidden_resolution: false`, no resolution selector) | `0,2,13,3,4,5,6` (`adaptive`, `16:9`, `21:9`, `9:16`, `1:1`, `4:3`, `3:4`) | Total `50`: img `30` (30MB), vid `10` (100MB, `2`–`30.2`s, total `30.2`s) | `reference_generation`, `video_edit`, `video_extend`, `first_last_frame` (`first: true, last: true`) | **9 credits/s** (`480p` draft) |
| 2 | `Seedance_2.5` | **Seedance 2.5** (`SD 2.5`) | `4`–`30`s (def `10`s) | `480p`, `720p` (def), `1080p`, `4k` | `0,2,13,3,4,5,6` | Total `50`: img `30` (30MB), vid `10` (100MB, `2`–`30.2`s, total `30.2`s) | `reference_generation`, `video_edit`, `video_extend`, `first_last_frame` (`first: true, last: true`) | `480p`: **12/s**<br>`720p`: **20/s**<br>`1080p`: **64/s**<br>`4k`: **99/s** |
| 3 | `seedance2.0_fast_vision` | **Seedance 2.0 Fast VIP** (`SD 2.0 Fast VIP`) | `4`–`15`s (def `10`s) | `480p`, `720p` (def) | `0,2,13,3,4,5,6` | Total `12`: img `9` (30MB), vid `3` (100MB, `2`–`15.5`s, total `15.5`s) | `first: true, last: true` | `480p`: **3/s**<br>`720p`: **6/s** |
| 4 | `seedance2.0_vision` | **Seedance 2.0 VIP** (`SD 2.0 VIP`) | `4`–`15`s (def `10`s) | `480p`, `720p` (def), `1080p`, `4k` | `0,2,13,3,4,5,6` | Total `12`: img `9` (30MB), vid `3` (100MB, `2`–`15.5`s, total `15.5`s) | `first: true, last: true` | `480p`: **8/s**<br>`720p`: **14/s**<br>`1080p`: **33/s**<br>`4k`: **80/s** |
| 5 | `Seedance_2.0_mini_lite` | **Seedance 2.0 Mini 体验版** (`2.0 Mini 体验版`) | `4`–`15`s (def `10`s) | `hidden_resolution: true` (720p/default) | `0,2,13,3,4,5,6` | Total `12`: img `9` (30MB), vid `3` (100MB, `2`–`15.5`s, total `15.5`s) | `first: true, last: true` | **4 credits/s** |
| 6 | `Seedance_2.0_mini` | **Seedance 2.0 Mini** (`SD 2.0 Mini`) | `4`–`15`s (def `10`s) | `hidden_resolution: true` (720p/default) | `0,2,13,3,4,5,6` | Total `12`: img `9` (30MB), vid `3` (100MB, `2`–`15.5`s, total `15.5`s) | `first: true, last: true` | **6 credits/s** |
| 7 | `wan3.0` | **Wan 3.0** (`Wan 3.0`) | `4`–`30`s (def `10`s) | `480p`, `720p` (def), `1080p` | `0,2,3,4,5,6` (no `21:9`) | Total `15`: img `10` (20MB), vid `5` (100MB, `1`–`15`s, total `15`s) | `first: true, last: true` | `480p`: **7/s**<br>`720p`: **14/s**<br>`1080p`: **33/s** |
| 8 | `happyhorse-1.1` | **HappyHorse 1.1** (`HappyHorse 1.1`) | `3`–`15`s (def `5`s) | `720p` (def), `1080p` | `2,13,3,4,5,6` (def `2`=`16:9`, no `adaptive`) | Total `9`: img `9` (30MB), vid `0` | Reference only (`first: false, last: false`) | `720p`: **14/s**<br>`1080p`: **18/s** |
| 9 | `seedance2.0_direct` | **Seedance 2.0** (`SD 2.0`, legacy channel) | `4`–`15`s (def `4`s) | `480p` (def), `720p` | `0,2,13,3,4,5,6` | Total `12`: img `9` (30MB), vid `3` (100MB, `2`–`15.5`s, total `15.5`s) | `first: true, last: true` | `480p`: **7/s**<br>`720p`: **8/s** |
| 10 | `seedance2.0_fast_direct` | **Seedance 2.0 Fast** (`SD 2.0 Fast`, legacy channel) | `4`–`15`s (def `10`s) | Default `720p` (`hidden_resolution: false`, no resolution dim) | `0,2,13,3,4,5,6` | Total `12`: img `9` (30MB), vid `3` (100MB, `2`–`15.5`s, total `15.5`s) | `first: true, last: true` | **5 credits/s** |
| 11 | `Seedance_1.0_fast` | **Seedance 1.0 Fast** (`SD 1.0 Fast`) | `2`–`12`s (`supported_duration_list`: `4`–`12`s, def `5`s) | `720p` (def), `1080p` | `0,2,13,3,4,5,6` | Total `1`: img `1` (30MB), vid `0` | First-frame only (`first: true, last: false`) | `720p`: **2/s**<br>`1080p`: **4/s** |

> **Note on Legacy Channels (`old_channel_model_keys`)**:
> `get_available_model_list` returns:
> ```json
> "hide_old_channels_for_free_user": true,
> "old_channel_model_keys": ["seedance2.0_direct", "seedance_2.0_fast", "seedance2.0_fast_direct"]
> ```
> And in `chunks/592381.eb3dee5d56.js` (module `332150` calling `w.l4`), if a non-VIP user selects `seedance2.0_direct` or `seedance2.0_fast_direct`, the web UI rewrites `model` to `"Seedance_2.0_mini_lite"` before submitting.

### 3.3 Ratio & Duration Enum Codes in `get_available_model_list`

In `chunks/592381.eb3dee5d56.js` (module `332150`) and `Pippit-dev_cli/internal/models/describe.go`:

- **`supported_ratio_list` / `default_ratio` integer enum**:
  ```js
  // chunks/592381.eb3dee5d56.js (module 332150)
  let e={0:"adaptive", 2:"16:9", 13:"21:9", 3:"9:16", 4:"1:1", 5:"4:3", 6:"3:4"};
  ```
- **`supported_duration_list` integer enum**:
  - For Seedance 2.0 / 2.5 / Wan 3.0 / HappyHorse 1.1 / Seedance 1.0 Fast, `parameter_config.dimensions` includes a `duration` dimension with `range_config: {min, max, step: 1}` and `supported_duration_list` lists exact integer seconds (e.g. `[4,5,6,...,15]` or `[4,5,...,30]`).
  - Legacy preset enum codes (used by older/non-Seedance models): `0 -> 0` (smartMatch), `10 -> 5` (~5s), `11 -> 10` (~10s), `1 -> 15` (~15s), `2 -> 30` (15–30s), `3 -> 60` (30–60s).

---

## 4. Video Generation Submit (`POST /api/biz/v1/agent/submit_run`)

### 4.1 Endpoint, Headers, Query Params & ID Generation

```js
// main.7f23997939.js (module 170153)
SubmitRun(e,t){
  let i=e||{},r=this.genBaseURL("/api/biz/v1/agent/submit_run"),
      a={thread_id:i.thread_id,run_id:i.run_id,agent_name:i.agent_name,message:i.message,
         user_info:i.user_info,client_info:i.client_info,run_extra:i.run_extra,
         interrupt_id:i.interrupt_id,entrance_from:i.entrance_from};
  return this.request({url:r,method:"POST",data:a},t)
}
```

- **URL**: `POST https://www.xiaoyunque.com/api/biz/v1/agent/submit_run`
  - Optional query param added by interceptor `RC.j$` (module `739443`): `?babi_param=<urlencoded JSON>` extracted from `run_extra.babi_param`.
- **`thread_id` & `run_id` Generation**:
  - In `chunks/592381.eb3dee5d56.js` (module `332150`), when starting a new generation from the home/video generator page, both `thread_id` and `run_id` are generated client-side as standard **UUID v4** strings (`(0,d.Jf)()` / `(0,d.KP)()`).
  - On the infinite canvas (`agent_name: "pippit_video_part_agent_for_canvas"`), `thread_id` is `"canvas_thread_<project_or_thread_id>"` and `run_id` is `"canvas_run_<uuid4>"`.
- **`agent_name`**:
  - `"pippit_video_part_agent"` (standard web video generator & `Pippit-dev_cli`)
  - `"pippit_video_part_agent_for_canvas"` (when called inside a Canvas project)
- **`entrance_from`**: `"web"`
- **`user_info`**:
  ```json
  {
    "consumer_uid": "0",
    "workspace_id": "<workspace_id>",
    "app_id": "795647"
  }
  ```

### 4.2 Exact Construction of `message` & `biz/x_tool_name_video_part`

From `chunks/592381.eb3dee5d56.js` (module `332150`, function `handleGenerateVideo`):

```js
// chunks/592381.eb3dee5d56.js (module 332150)
let eR={
  images:eN,
  videos:eP,
  audios:ej,
  imitation_videos:eD,
  partial_edit_videos:eA,
  characters:eL,
  file_pippit_asset_ids:eM.length>0?eM:void 0,
  links:ew.length>0?ew:void 0,
  prompt:eb,
  duration_sec:eg,
  ratio:ev,
  resolution:ey,
  language:(0,g.v)(),
  model:ek,
  extend_type:eI,
  seed:"custom"===this.seedMode&&null!==this.customSeed?this.customSeed:void 0,
  generate_type:this.isFirstLastFrameMode?N.Cr.FirstLastFrame:void 0,
  task_type:eO
};
eT&&(eR=(0,M.e3)(eR)); // If Seedance_2.5_draft stage 1: sets draft: true, deletes resolution
let eB=(0,d.Jf)(),
    eF=e||a||(0,d.Jf)(),
    eV=(0,d.KP)(),
    eU={
      message_id:eB,
      role:"user",
      thread_id:eF,
      run_id:eV,
      created_at:Date.now(),
      content:[{
        type:"data",
        sub_type:"biz/x_data_direct_tool_call_req",
        data:JSON.stringify({
          tool_name:"biz/x_tool_name_video_part",
          param:JSON.stringify(eR)
        }),
        hidden:!1,
        is_thought:!1
      }]
    };
```

Notice the **double JSON encoding** inside `message.content[0].data`:
1. `param` is `JSON.stringify(eR)` (a JSON string).
2. `content[0].data` is `JSON.stringify({ tool_name: "biz/x_tool_name_video_part", param: JSON.stringify(eR) })` (a JSON string containing `tool_name` and the escaped `param` string).

### 4.3 UI Setting to `param` Field Mapping

| UI Setting | `param` Field | Type | Allowed Values & Behavior |
|---|---|---|---|
| **Prompt** | `prompt` | `string` | Text prompt. When referencing uploaded materials in multi-reference mode, the web UI inserts `[@图片1]`, `[@图片2]`, `[@视频1]`, `[@音频1]` (or `<node-asset>pippit_asset_id</node-asset>` on Canvas; `@image_1` in `Pippit-dev_cli`). |
| **Model** | `model` | `string` | Model key from `get_available_model_list`, e.g. `"Seedance_2.5"`, `"Seedance_2.5_draft"`, `"seedance2.0_vision"`, `"seedance2.0_fast_vision"`, `"Seedance_2.0_mini_lite"`, `"Seedance_2.0_mini"`, `"wan3.0"`, `"happyhorse-1.1"`, `"seedance2.0_direct"`, `"seedance2.0_fast_direct"`, `"Seedance_1.0_fast"`. |
| **Duration** | `duration_sec` | `number` | Integer seconds: `4`–`15` (Seedance 2.0), `4`–`30` (Seedance 2.5 / Wan 3.0), `3`–`15` (HappyHorse 1.1), `4`–`12` (Seedance 1.0 Fast). `0` = smartMatch; `-1` = Seedance 2.5 `video_edit` mode (`this.isEditVideoMode ? -1 : ...`). |
| **Aspect Ratio** | `ratio` | `string` | `"adaptive"` (智能比例), `"16:9"`, `"21:9"`, `"9:16"`, `"1:1"`, `"4:3"`, `"3:4"`. |
| **Resolution / Quality** | `resolution` | `string` | `"480p"`, `"720p"`, `"1080p"`, `"4k"`. Omitted when `model === "Seedance_2.5_draft"` (`delete i.resolution`). Optional/default `"720p"` when `hidden_resolution: true` (`Seedance_2.0_mini_lite`, `Seedance_2.0_mini`). |
| **Generation Mode** (All-Ref vs First/Last Frame) | `generate_type` | `number \| undefined` | `1` (`N.Cr.FirstLastFrame`) when **首尾帧 (First-Last-Frame)** mode is active; omitted (`undefined` / `null`) when **全能参考 (All-Reference)** mode is active. |
| **Seedance 2.5 Sub-Task Type** | `task_type` | `string \| undefined` | Only set when `model` is `"Seedance_2.5"` or `"Seedance_2.5_draft"` (`(0,N.xv)(K)`):<br>- `"reference"` (for `reference_generation` and `first_last_frame`)<br>- `"edit"` (for `video_edit`)<br>- `"extend"` (for `video_extend`)<br>- `"auto"` |
| **Seedance 2.5 Draft (Stage 1 & Stage 2)** | `draft`, `draft_task_id` | `boolean`, `string` | **Stage 1 (Generate 480p Draft, `M.e3`)**: sets `model: "Seedance_2.5_draft"`, `draft: true`, and deletes `resolution`.<br>**Stage 2 (Upgrade Draft to Final Video, `M.qE`)**: sends `{"draft": false, "draft_task_id": "<video.render_task_id>", "model": "Seedance_2.5_draft", "prompt": ""}`. |
| **Reference Images / First & Last Frame** | `images` | `Array<Object>` | Array of `{asset_id, pippit_asset_id, url, width, height, format}`. In First-Last-Frame mode (`generate_type: 1`), `images[0]` is the **first frame** and `images[1]` (if present) is the **last frame**. |
| **Reference Videos** | `videos` | `Array<Object>` | Array of `{asset_id, pippit_asset_id, url, cover_url, duration_ms, width, height}`. |
| **Partial Edit Video** | `partial_edit_videos` | `Array<Object>` | Used in `video_edit` mode: `[{asset_id, pippit_asset_id, url, cover_url, duration_ms, width, height, time_range: {start_ms, end_ms}}]`. |
| **Imitation Video** | `imitation_videos` | `Array<Object>` | Used in imitation mode: `[{asset_id, pippit_asset_id, url, cover_url, duration_ms, width, height}]`. |
| **Reference Audios** | `audios` | `Array<Object>` | Array of `{asset_id, pippit_asset_id, url, duration_ms}`. |
| **Audio On / Off** | *(via `prompt` / `audios`)* | — | Seedance 2.0 / 2.5 generates native synchronized audio/dialogue/SFX automatically; there is **no boolean `generate_audio` field** in `biz/x_tool_name_video_part`. To disable speech/BGM, prompts include instructions such as `"全片无对白，无旁白，无BGM"` (confirmed in live thread history). |
| **Output Format** | *(fixed MP4)* | — | Always outputs `video_mp4` (`mime_type=video_mp4`); no `format` parameter in `biz/x_tool_name_video_part`. |
| **Language** | `language` | `string` | `"zh"` (default on `www.xiaoyunque.com`) or `"en"`. |
| **Seed** | `seed` | `number \| undefined` | Integer seed (e.g. `1234567890`) if custom seed is enabled; omitted/`null` for random seed. |

### 4.4 Complete Example JSON Payloads (`POST /api/biz/v1/agent/submit_run`)

#### Example 1: Cheapest Seedance 2.0 Text-to-Video (T2V)
- **Model**: `"Seedance_2.0_mini_lite"` (4 credits/sec — or `"seedance2.0_fast_vision"` with `"resolution": "480p"` at 3 credits/sec; `"Seedance_1.0_fast"` at `"720p"` is 2 credits/sec)
- **Duration**: `4` seconds (shortest supported duration for Seedance 2.0/2.5; total cost = **16 credits** on `Seedance_2.0_mini_lite` or **12 credits** on `seedance2.0_fast_vision` `480p`)
- **Resolution**: `"480p"`
- **Audio off**: Specified in prompt (`"无对白，无旁白，无背景音乐"`)

```json
{
  "thread_id": "550e8400-e29b-41d4-a716-446655440000",
  "run_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "agent_name": "pippit_video_part_agent",
  "entrance_from": "web",
  "user_info": {
    "consumer_uid": "0",
    "workspace_id": "7600000000000000000",
    "app_id": "795647"
  },
  "message": {
    "message_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "role": "user",
    "thread_id": "550e8400-e29b-41d4-a716-446655440000",
    "run_id": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "created_at": 1700000000000,
    "content": [
      {
        "type": "data",
        "sub_type": "biz/x_data_direct_tool_call_req",
        "data": "{\"tool_name\":\"biz/x_tool_name_video_part\",\"param\":\"{\\\"images\\\":[],\\\"videos\\\":[],\\\"audios\\\":[],\\\"prompt\\\":\\\"一只橘猫在阳光下的窗台上安静打盹，固定镜头，无对白，无旁白，无背景音乐\\\",\\\"duration_sec\\\":4,\\\"ratio\\\":\\\"16:9\\\",\\\"resolution\\\":\\\"480p\\\",\\\"language\\\":\\\"zh\\\",\\\"model\\\":\\\"Seedance_2.0_mini_lite\\\"}\"}",
        "hidden": false,
        "is_thought": false
      }
    ]
  },
  "run_extra": "{\"client_extra\":{\"edit_type\":\"instant_video\",\"position\":\"home\",\"entrance_from\":\"web\",\"tab_name\":\"other\"},\"babi_param\":{\"user_message_id\":\"7c9e6679-7425-40de-944b-e07fc1f90ae7\",\"enter_from\":\"web\",\"scene_lv1\":\"ai_agent\",\"scene_lv2\":\"front_tool\",\"edit_type\":\"instant_video\",\"tool_id\":\"instant_video\",\"tab_name\":\"other\"}}"
}
```

#### Example 2: First-Last-Frame Image-to-Video (I2V)
- Uses `"generate_type": 1` (`FirstLastFrame`) and places the uploaded first frame at `images[0]` and last frame at `images[1]` (for `Seedance_2.5`, also includes `"task_type": "reference"`):

```json
{
  "thread_id": "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
  "run_id": "f1e2d3c4-b5a6-4987-8654-3210fedcba98",
  "agent_name": "pippit_video_part_agent",
  "entrance_from": "web",
  "user_info": {
    "consumer_uid": "0",
    "workspace_id": "7600000000000000000",
    "app_id": "795647"
  },
  "message": {
    "message_id": "11223344-5566-4778-8899-aabbccddeeff",
    "role": "user",
    "thread_id": "a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d",
    "run_id": "f1e2d3c4-b5a6-4987-8654-3210fedcba98",
    "created_at": 1700000000000,
    "content": [
      {
        "type": "data",
        "sub_type": "biz/x_data_direct_tool_call_req",
        "data": "{\"tool_name\":\"biz/x_tool_name_video_part\",\"param\":\"{\\\"images\\\":[{\\\"asset_id\\\":\\\"<asset_id_1>\\\",\\\"pippit_asset_id\\\":\\\"<pippit_asset_id_1>\\\",\\\"width\\\":1672,\\\"height\\\":941,\\\"format\\\":\\\"png\\\",\\\"url\\\":\\\"<signed_image_url_1>\\\"},{\\\"asset_id\\\":\\\"<asset_id_2>\\\",\\\"pippit_asset_id\\\":\\\"<pippit_asset_id_2>\\\",\\\"width\\\":1672,\\\"height\\\":941,\\\"format\\\":\\\"png\\\",\\\"url\\\":\\\"<signed_image_url_2>\\\"}],\\\"videos\\\":[],\\\"audios\\\":[],\\\"prompt\\\":\\\"镜头从首帧平滑过渡到尾帧\\\",\\\"duration_sec\\\":5,\\\"ratio\\\":\\\"16:9\\\",\\\"resolution\\\":\\\"720p\\\",\\\"language\\\":\\\"zh\\\",\\\"model\\\":\\\"Seedance_2.5\\\",\\\"generate_type\\\":1,\\\"task_type\\\":\\\"reference\\\"}\"}",
        "hidden": false,
        "is_thought": false
      }
    ]
  }
}
```

---

## 5. Status Polling, Video Result Extraction & Cancellation

### 5.1 Polling Thread Status (`POST /api/biz/v1/agent/get_thread` & `get_run`)

```js
// main.7f23997939.js (module 170153)
GetThread(e,t){let i=e||{},r=this.genBaseURL("/api/biz/v1/agent/get_thread"),a={thread_id:i.thread_id,scopes:i.scopes,entry_list_query:i.entry_list_query,is_need_fail_reason_detail:i.is_need_fail_reason_detail};return this.request({url:r,method:"POST",data:a},t)}
GetRun(e,t){let i=e||{},r=this.genBaseURL("/api/biz/v1/agent/get_run"),a={thread_id:i.thread_id,run_id:i.run_id,scopes:i.scopes,is_need_fail_reason_detail:i.is_need_fail_reason_detail};return this.request({url:r,method:"POST",data:a},t)}
```

- **Request Body (`get_thread`, live-verified)**:
  ```json
  {
    "thread_id": "<thread_id>",
    "scopes": ["base", "run_list.base", "run_list.entry_list", "entry_list"],
    "is_need_fail_reason_detail": true
  }
  ```
- **Request Body (`get_run`, live-verified)**:
  ```json
  {
    "thread_id": "<thread_id>",
    "run_id": "<run_id>",
    "scopes": ["base", "entry_list"],
    "is_need_fail_reason_detail": true
  }
  ```

### 5.2 Run `state` Values, Estimated Duration & `fail_reason`

In `main.7f23997939.js` and `Pippit-dev_cli/internal/common/get_thread.go` (and verified against live completed & failed runs):

| `run.state` | Meaning | Notes |
|---|---|---|
| `1` | **Queued / Pending** | Run created and waiting in queue. |
| `2` | **Running / Generating** | Video generation in progress. |
| `3` | **Completed / Done** | Video artifact is ready in `run.entry_list` (live-verified). |
| `4` | **Failed** | Run failed; inspect `run.fail_reason` (live-verified). |
| `5` | **Canceled** | Canceled by user via `cancel_run`. |

- **Estimated Generation Time (`biz/x_data_predict_info`)**:
  While running (and preserved after completion), `run.entry_list` includes an assistant message with `sub_type: "biz/x_data_predict_info"`:
  ```json
  {
    "type": "data",
    "sub_type": "biz/x_data_predict_info",
    "data": "{\"predict_duration\":84000,\"generate_start_time\":1700000000}"
  }
  ```
  where `predict_duration` is in **milliseconds** (`84000` ms = 84s) and `generate_start_time` is unix seconds.
- **Failure Object (`run.fail_reason`, live-verified on a failed run)**:
  ```json
  "fail_reason": {
    "code": 99999,
    "message": "内容涉及侵犯他人权益",
    "extra": null,
    "is_not_retryable": false,
    "starling_key": "",
    "payload": "",
    "fallback_message": "",
    "detail": "内容涉及侵犯他人权益"
  }
  ```
- **Actual Credit Consumption on Run (`run.credit_consumption`, live-verified)**:
  ```json
  "credit_consumption": {
    "pre_deduct_credits": "0",
    "actual_deduct_credits": "96",
    "returned_credits": "0",
    "status": 4,
    "updated_at_ms": "1700000000000"
  }
  ```

### 5.3 Where the Generated Video URL Lives in `get_thread` / `get_run`

When `run.state === 3`, iterate over `run.entry_list` to find the entry with `type === 2` (`artifact` object is non-null). Inside `entry.artifact.content[]`, find the item with `sub_type === "biz/x_data_video"`, and `JSON.parse(item.data)`:

```json
{
  "type": 2,
  "message": null,
  "artifact": {
    "artifact_id": "<artifact_id>",
    "thread_id": "<thread_id>",
    "run_id": "<run_id>",
    "content": [
      {
        "type": "data",
        "sub_type": "biz/x_data_video",
        "pippit_asset_id": "<pippit_asset_id>",
        "data": "{\"video\":{\"asset_id\":\"<asset_id>\",\"metadata\":{\"height\":854,\"width\":480,\"duration_ms\":8000,\"md5\":\"<md5>\",\"ratio\":\"9:16\"},\"url\":\"https://v26-xyq-video.jianying.com/<signed_video_path>?mime_type=video_mp4&download=true\",\"download_url\":\"https://v26-xyq-video.jianying.com/<signed_video_path>?mime_type=video_mp4&download=true\",\"preview_url\":\"https://v26-xyq-video.jianying.com/<signed_video_path>?mime_type=video_mp4\",\"cover_url\":\"https://p3-sign.douyinpic.com/<signed_cover_path>\",\"render_task_id\":\"<render_task_id>\",\"vid\":\"<vid>\",\"width\":480,\"height\":854,\"extra\":{\"ark_video_duration_ms\":\"8050\"}}}"
      }
    ]
  }
}
```

Key fields inside parsed `data.video`:
- `video.download_url` / `video.url`: Direct signed MP4 CDN download URL (`https://v*-xyq-video.jianying.com/...&mime_type=video_mp4...&download=true`).
- `video.preview_url`: Streaming MP4 URL.
- `video.cover_url`: Signed cover thumbnail URL.
- `video.asset_id`: EverPhoto asset ID (e.g. `"<asset_id>"`).
- `content[0].pippit_asset_id`: Pippit asset ID (e.g. `"<pippit_asset_id>"`).
- `video.vid`: VOD video ID (e.g. `"<vid>"`).
- `video.render_task_id`: Render task ID (used as `draft_task_id` when upgrading a `Seedance_2.5_draft` video to full resolution).
- `video.metadata`: `{ width, height, duration_ms, md5, ratio }`.

*(Note: In `chunks/345077.637d50dd5c.js` module `513303` and `XiakeMan777/xiaoyunque_v3.py`, fallback URL extraction also checks `video.no_watermark_video_url.download_url`, `video.origin_url`, and `video.transcoded_video.origin.video_url`.)*

### 5.4 Direct Video Result Query (`POST /api/biz/v1/agent/query_generate_video_result`) — `UNVERIFIED` live

Defined in `main.7f23997939.js` (module `170153`) and used in `XiakeMan777/xiaoyunque_v3.py` as a lightweight alternative to `get_thread` (`UNVERIFIED` live because `probe.py` blocks URLs containing `generate`):

```js
// main.7f23997939.js (module 170153)
QueryGenerateVideoResult(e,t){let i=e||{},r=this.genBaseURL("/api/biz/v1/agent/query_generate_video_result"),a={thread_id:i.thread_id,run_id:i.run_id};return this.request({url:r,method:"POST",data:a},t)}
```

### 5.5 Queue Info (`POST /api/biz/v1/agent/get_user_queue_info`) & Speedup

```js
// main.7f23997939.js (module 170153)
GetUserQueueInfo(e,t){let i=e||{},r=this.genBaseURL("/api/biz/v1/agent/get_user_queue_info"),a={uid:i.uid,run_id:i.run_id,need_earliest_submitted_working_run:i.need_earliest_submitted_working_run,thread_id:i.thread_id};return this.request({url:r,method:"POST",data:a},t)}
SpeedUpRunTask(e,t){let i=e||{},r=this.genBaseURL("/api/biz/v1/agent/speed_up_run_task"),a={thread_id:i.thread_id,run_id:i.run_id};return this.request({url:r,method:"POST",data:a},t)}
```

### 5.6 Cancel Run (`POST /api/biz/v1/agent/cancel_run`) — `UNVERIFIED` live

```js
// main.7f23997939.js (module 170153)
CancelRun(e,t){let i=e||{},r=this.genBaseURL("/api/biz/v1/agent/cancel_run"),a={run_id:i.run_id,thread_id:i.thread_id,team_id:i.team_id};return this.request({url:r,method:"POST",data:a},t)}
```

- **Request Body**:
  ```json
  {
    "thread_id": "<thread_id>",
    "run_id": "<run_id>"
  }
  ```

### 5.7 List User History (`POST /api/biz/v1/agent/list_user_history`)

Why `{"cursor":"","count":3}` returned `ret 2 invalid pageToken`: `cursor` must be `"0"` (an integer string offset, not `""`)!

```js
// main.7f23997939.js (module 170153)
ListUserHistory(e,t){let i=e||{},r=this.genBaseURL("/api/biz/v1/agent/list_user_history"),a={cursor:i.cursor,count:i.count,agent_names:i.agent_names,filter:i.filter};return this.request({url:r,method:"POST",data:a},t)}
```

- **Live-Verified Request Body**:
  ```json
  {
    "cursor": "0",
    "count": 10,
    "agent_names": ["pippit_video_part_agent", "pippit_unified_agent"],
    "filter": {}
  }
  ```

---

## 6. Media Upload for References & Asset Resolution

The web client supports two upload paths in `chunks/275509.2a4f521dd2.js` (`uploadOptimizeEnabled: false` vs `true`):

### 6.1 Path A: Direct Multipart Upload (`POST /api/web/v1/common/upload_file`) — `UNVERIFIED` live

Used by `CustomPippitService.uploadFile` in `main.7f23997939.js`, `chunks/275509.2a4f521dd2.js` (module `788747`), and `XiakeMan777/xiaoyunque_v3.py`. This is the simplest single-step upload for a custom client:

```js
// main.7f23997939.js (module 170153)
async uploadFile(e,t){
  let i=this.genBaseURL("/api/web/v1/common/upload_file"),r=new FormData;
  return r.append("file",e.file),
         r.append("asset_type",e.asset_type.toString()),
         void 0!==e.audio_start_time_ms&&r.append("audio_start_time_ms",e.audio_start_time_ms.toString()),
         void 0!==e.audio_end_time_ms&&r.append("audio_end_time_ms",e.audio_end_time_ms.toString()),
         await this.request({url:i,method:"POST",data:r,headers:{"Content-Type":"multipart/form-data"}},t)
}
```

- **Multipart Form Fields**:
  - `file`: Binary file content (`filename`, MIME type e.g. `image/png`, `image/jpeg`, `video/mp4`)
  - `asset_type`:
    - `"1"` = Video (`Video = 1`)
    - `"2"` = Image (`Image = 2`)
    - `"3"` = Document/File (`File = 3`)
    - `"4"` = Audio (`Audio = 4`)
- **Response `data` Fields** (from `chunks/275509.2a4f521dd2.js` module `788747` & `XiakeMan777/xiaoyunque_v3.py`):
  ```json
  {
    "ret": "0",
    "errmsg": "",
    "data": {
      "asset_id": "<asset_id>",
      "pippit_asset_id": "<pippit_asset_id>",
      "file_id": "<pippit_asset_id>",
      "vid": "",
      "download_url": "<signed_image_url>",
      "cover_url": "",
      "uri": "tos-cn-i-wipe09lpyt/<image_uri>",
      "md5": "<md5>",
      "format": "png",
      "mime": "image/png",
      "size": 1143267,
      "width": 1672,
      "height": 941,
      "duration_ms": 0
    }
  }
  ```

### 6.2 Path B: STS Direct Upload (`get_upload_sign` -> ImageX/VOD -> `asset/create_v2`)

When `uploadOptimizeEnabled` is true (`chunks/275509.2a4f521dd2.js` modules `599620` & `378419`):
1. **`POST /api/web/v1/common/get_upload_sign`** with `{"biz": "temp_image"}` (for images; serviceId `"wipe09lpyt"` on `https://imagex.bytedanceapi.com`) or `{"biz": "ever_photo_space"}` (for video/audio; spaceName `"jianying_vcloud_upload"` on `https://vod.bytedanceapi.com`) -> returns AWS SigV4 STS credentials `{access_key_id, secret_access_key, session_token, expired_time, current_time}`.
2. Upload binary via ByteDance `TTUploader` (`ApplyImageUpload` -> TOS PUT -> `CommitImageUpload`, identical to `Pippit-dev_cli/internal/common/upload_media.go`).
3. **`POST /api/web/v1/asset/create_v2`** (`AssetCreateV2`) with:
   ```json
   {
     "asset_source_type": 2,
     "asset_source_id": "<imagex_uri_or_vod_vid>",
     "asset_type": 1,
     "name": "frame1.png",
     "md5": "<md5>",
     "Base": { "Client": "web" }
   }
   ```
   *(Note: In `asset/create_v2`, `asset_type` uses `1 = Image, 2 = Video, 3 = Audio`, unlike `upload_file` where `1 = Video, 2 = Image`!)*
   Returns `PippitAssetID` and `Image.asset_id` / `Image.url` (or polls `POST /api/web/v1/asset/query` with `{"PippitAssetIDS": [id], "NeedEverphotoInfo": true}` until `asset_id` is populated).

### 6.3 What `submit_run` Requires in `param.images` / `param.videos`

In `chunks/592381.eb3dee5d56.js` (module `332150`):
- Each element of `param.images` is:
  ```json
  {
    "asset_id": "<asset_id>",
    "pippit_asset_id": "<pippit_asset_id>",
    "url": "<signed_image_url>",
    "width": 1672,
    "height": 941,
    "format": "png"
  }
  ```
  Cross-checking with `Pippit-dev_cli/internal/common/video_part.go` (`type ImageItem struct { AssetID string; Width int32; Height int32 }`) and `XiakeMan777/xiaoyunque_v3.py` confirms that `asset_id` (plus `width`, `height`, `format`, `url`) is the primary identifier consumed by the backend agent.

### 6.4 Batch Asset URL Refresh (`POST /api/web/v1/common/mget_asset_info`) — `UNVERIFIED` live

Defined in `main.7f23997939.js` (module `170153`) and `chunks/345077.637d50dd5c.js` (module `513303`) to resolve fresh signed URLs for EverPhoto `asset_id`s:

```js
// main.7f23997939.js (module 170153)
MGetAssetInfoWeb(e,t){let i=e||{},r=this.genBaseURL("/api/web/v1/common/mget_asset_info"),a={workspace_id:i.workspace_id,uid:i.uid,asset_ids:i.asset_ids,need_transcode:i.need_transcode,vid_transcode_Map:i.vid_transcode_Map,need_ai_watermark_url:i.need_ai_watermark_url};return this.request({url:r,method:"POST",data:a},t)}
```

---

## 7. Credit Estimate & Pricing Rules

### 7.1 Live Credit Estimate Endpoint (`POST /api/biz/v1/commerce/get_commerce_auth_info`)

Unlike `/commerce/v3/resource/benefit_metadata` (which requires Jianying MD5 headers), `POST /api/biz/v1/commerce/get_commerce_auth_info` works with **plain cookies** and returns both the resolved benefit triplet (`resource_type`, `resource_id`, `benefit_type`), the **unit credit cost (`amount`)**, and whether the user has enough balance (`check_deduct_status: 1`):

- **Live-Verified Request**:
  ```json
  {
    "model_name": "Seedance_2.5",
    "model_key": "Seedance_2.5",
    "resolution": "720p",
    "agent_name": "pippit_video_part_agent",
    "duration": 1,
    "asset_type": 1,
    "has_refer_video": false,
    "scene": "web_turbo_video_generator",
    "parameter_values": {
      "resolution": "720p"
    }
  }
  ```
- **Live-Verified Response**:
  ```json
  {
    "ret": "0",
    "errmsg": "",
    "svr_time": 1700000000,
    "log_id": "<log_id>",
    "data": {
      "resource_id": "cc_biz_video_agent_seedance25_720p",
      "benefit_type": "cc_biz_video_agent_seedance25_720p",
      "resource_type": "aigc",
      "amount": 20,
      "check_deduct_status": 1,
      "duration": ["UserCredit"],
      "used_cnt": 1
    }
  }
  ```

### 7.2 Complete Live-Probed Per-Second Credit Price Table

| Model Key (`model_key`) | Display Name | Resolution | `benefit_type` | Live Credits / sec (`amount`) |
|---|---|---|---|---|
| `Seedance_1.0_fast` | Seedance 1.0 Fast | `720p` | `cc_biz_video_agent_seedance1_fast` | **2** |
| `Seedance_1.0_fast` | Seedance 1.0 Fast | `1080p` | `cc_biz_video_agent_seedance1_fast_1080p` | **4** |
| `seedance2.0_fast_vision` | Seedance 2.0 Fast VIP | `480p` | `cc_biz_video_agent_seedance2_fast_480p` | **3** |
| `seedance2.0_fast_vision` | Seedance 2.0 Fast VIP | `720p` | `cc_biz_video_agent_seedance2_fast_vision` | **6** |
| `Seedance_2.0_mini_lite` | Seedance 2.0 Mini 体验版 | default (`720p`) | `cc_biz_video_agent_seedance2_mini_lite` | **4** |
| `seedance2.0_fast_direct` | Seedance 2.0 Fast (legacy) | default (`720p`) | `cc_biz_video_agent_seedance2_fast_720p` | **5** |
| `Seedance_2.0_mini` | Seedance 2.0 Mini | default (`720p`) | `cc_biz_video_agent_seedance2_mini_720p` | **6** |
| `seedance2.0_direct` | Seedance 2.0 (legacy) | `480p` | `cc_biz_video_agent_seedance2_origin_480p` | **7** |
| `seedance2.0_direct` | Seedance 2.0 (legacy) | `720p` | `cc_biz_video_agent_seedance2_origin` | **8** |
| `seedance2.0_vision` | Seedance 2.0 VIP | `480p` | `cc_biz_video_agent_seedance2_origin_480p` | **8** |
| `seedance2.0_vision` | Seedance 2.0 VIP | `720p` | `cc_biz_video_agent_seedance2_origin_vision` | **14** |
| `seedance2.0_vision` | Seedance 2.0 VIP | `1080p` | `cc_biz_video_agent_seedance2_origin_1080p` | **33** |
| `seedance2.0_vision` | Seedance 2.0 VIP | `4k` | `cc_biz_video_agent_seedance2_origin_vision_4k` | **80** |
| `Seedance_2.5_draft` | Seedance 2.5 Draft | `480p` | `cc_biz_video_agent_seedance25_draft_480p` | **9** |
| `Seedance_2.5` | Seedance 2.5 | `480p` | `cc_biz_video_agent_seedance25_480p` | **12** |
| `Seedance_2.5` | Seedance 2.5 | `720p` | `cc_biz_video_agent_seedance25_720p` | **20** |
| `Seedance_2.5` | Seedance 2.5 | `1080p` | `cc_biz_video_agent_seedance25_1080p` | **64** |
| `Seedance_2.5` | Seedance 2.5 | `4k` | `cc_biz_video_agent_seedance25_4k` | **99** |
| `wan3.0` | Wan 3.0 | `480p` / `720p` / `1080p` | `cc_biz_video_agent_wan3_{480p,720p,1080p}` | **7 / 14 / 33** |
| `happyhorse-1.1` | HappyHorse 1.1 | `720p` / `1080p` | `cc_biz_video_agent_happyhorse_{720p,1080p}` | **14 / 18** |

### 7.3 Total Credit Formula (`output_only` vs `output_plus_reference`)

In `chunks/345077.637d50dd5c.js` (module `438907`) and `models_live.json` (`pricing_rule.quantity_policy_map_by_combination`):

```js
// chunks/345077.637d50dd5c.js (module 438907)
let d=(e.referenceVideoDurationsSec||[]).reduce((e,t)=>e+Math.ceil(l(t)),0),
    u="output_plus_reference"===i ? n+d : n;
return Math.ceil(a * u);
```

- **Without Reference Video (`has_refer_video=false` -> `quantityPolicy: "output_only"`)**:
  $$\text{Total Credits} = \text{amount\_per\_sec} \times \text{duration\_sec}$$
  *(Confirmed against live runs: `Seedance_2.5` 480p 8s = $12 \times 8 = 96$ credits; `seedance2.0_vision` 720p 6s/8s/10s = $84 / 112 / 140$ credits.)*
- **With Reference Video (`has_refer_video=true` -> `quantityPolicy: "output_plus_reference"` for `seedance2.0_direct` / `seedance2.0_fast_direct`, or `"output_only"` for `Seedance_2.5` / `seedance2.0_vision`)**:
  When `quantity_policy_map_by_combination` specifies `"output_plus_reference"`:
  $$\text{Total Credits} = \text{amount\_per\_sec} \times \left(\text{duration\_sec} + \sum \lceil \text{ref\_video\_duration\_sec} \rceil\right)$$

---

## 8. Pre-Moderation (`security/check`), Concurrency & Error Codes

### 8.1 Pre-Moderation (`POST /api/biz/v1/security/check` & `/api/web/v1/security/check`)

Before submitting or importing reference assets (especially for facial/reference images and videos), the web client calls `SecurityCheck` / `SecurityCheckWeb`:

```js
// main.7f23997939.js (module 170153)
SecurityCheck(e,t){
  let i=e||{},r=this.genBaseURL("/api/biz/v1/security/check"),
      a={scene:i.scene,text_list:i.text_list,image_list:i.image_list,video_list:i.video_list,
         skip_face_detection:i.skip_face_detection,audio_list:i.audio_list,file_list:i.file_list,
         pippit_asset_id:i.pippit_asset_id,agent_name:i.agent_name};
  return this.request({url:r,method:"POST",data:a},t)
}
```

- **Live-verified**: Calling `POST /api/biz/v1/security/check` with `{}` returns `200 {"ret":"2","errmsg":"scene is empty","data":null}` (confirming the endpoint is active and accepts cookie auth).
- Common `scene` / `category` values in the bundle: `"novel_seedance2_0"`, `"montage"`, `"avatar"`, `"video_part"`.
- Note: Calling `security/check` prior to `submit_run` is **not strictly required** by `submit_run` itself (`Pippit-dev_cli` and `XiakeMan777/xiaoyunque_v3.py` skip it), because the backend agent performs its own moderation during execution and reports hits in `run.fail_reason`.

### 8.2 Backend Error Codes (`ret` & `fail_reason.code`)

From `main.7f23997939.js` (module `517754` predecessor enum `tx`):

```js
// main.7f23997939.js
tx[tx.ImageLabCVRiskHit=14005]="ImageLabCVRiskHit",
tx[tx.BaseModelReviewFailed=14025]="BaseModelReviewFailed",
tx[tx.MaterialInputLimitExceeded=14026]="MaterialInputLimitExceeded",
tx[tx.RateLimitBeforeExecuteError=16007]="RateLimitBeforeExecuteError",
tx[tx.RunLimitNonVip=16008]="RunLimitNonVip",
tx[tx.RunLimitVip=16009]="RunLimitVip",
tx[tx.UserTooManyOperation=16010]="UserTooManyOperation",
tx[tx.RiskServiceCallFailed=16011]="RiskServiceCallFailed",
tx[tx.CommonSharkBlockError=16012]="CommonSharkBlockError",
tx[tx.PublishSharkBlockError=16013]="PublishSharkBlockError",
tx[tx.VerifySharkBlockError=16014]="VerifySharkBlockError",
tx[tx.VerifyOldSharkBlockError=16015]="VerifyOldSharkBlockError",
tx[tx.ThreadNotFound=16017]="ThreadNotFound",
tx[tx.EagleyePunishRejected=16018]="EagleyePunishRejected",
tx[tx.RunConcurrentExecutionInProgress=16026]="RunConcurrentExecutionInProgress",
tx[tx.ServerPassthroughContent=99999]="ServerPassthroughContent"
```

| Code | Name / Meaning | Notes |
|---|---|---|
| `0` / `"0"` | `OK` | Success |
| `-3` / `"-3"` | `bad request` | Malformed JSON or wrong field type (e.g. integer `app_id` instead of string `"795647"`). |
| `2` / `"2"` | `invalid parameter` | Missing/invalid parameter (e.g. `cursor: ""` instead of `"0"` in `list_user_history`). |
| `401` | `invalid access key` | Sent cookies to AK-only `/api/biz/v1/skill/*` endpoint. |
| `1014` | `system busy` | Sent `/commerce/v1/*` request without Jianying MD5 `sign` / `device-time` / `Appid` headers. |
| `14005` | `ImageLabCVRiskHit` | Reference image/video failed CV content moderation (e.g. real human face restriction or NSFW). |
| `14025` | `BaseModelReviewFailed` | Model output or prompt rejected by safety filter. |
| `14026` | `MaterialInputLimitExceeded` | Exceeded reference image/video count or duration limit. |
| `16007` | `RateLimitBeforeExecuteError` | Rate-limited before execution. |
| `16008` / `16009` | `RunLimitNonVip` / `RunLimitVip` | Concurrency/queue limit reached for non-VIP / VIP user. |
| `16010` | `UserTooManyOperation` | Too many operations in a short window. |
| `16012`–`16015` | `*SharkBlockError` | ByteDance Shark anti-bot triggered (prompts CAPTCHA via `verifyCenter` in browser). |
| `16017` | `ThreadNotFound` | `thread_id` does not exist. |
| `16026` | `RunConcurrentExecutionInProgress` | Another run is already executing on the same thread. |
| `16029` | `OwnerMismatch` | `thread_id` belongs to a different user (live-verified). |
| `99999` | `ServerPassthroughContent` | Generic passthrough code where `message` / `detail` contains the human-readable error reason (live-verified: `"内容涉及侵犯他人权益"`). |
