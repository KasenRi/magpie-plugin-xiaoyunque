# 小云雀（XiaoYunQue / Pippit CN）模型参数、计价、多账号与错误码手册

## 目录
1. [11 个视频模型完整参数与单价表](#1-11-个视频模型完整参数与单价表)
2. [参考视频计价规则（`output_plus_reference`）](#2-参考视频计价规则output_plus_reference)
3. [`Seedance_2.5_draft` 样片两阶段转正流程](#3-seedance_25_draft-样片两阶段转正流程)
4. [多账号管理、`account` 参数与同账号素材规则](#4-多账号管理account-参数与同账号素材规则)
5. [单次 `wait_task` ≤45 秒分片轮询机制](#5-单次-wait_task-45-秒分片轮询机制)
6. [常见审核失败码与风控排查表](#6-常见审核失败码与风控排查表)
7. [预算门禁与 `credits_ledger.csv` 台账规范](#7-预算门禁与-credits_ledgercsv-台账规范)

---

## 1. 11 个视频模型完整参数与单价表

小云雀线上共存在 **11 个视频模型**：其中 **前 8 个**同时在官方 Access-Key Skill API（`/api/biz/v1/skill/get_available_model_list`）与网页端开放，**后 3 个**仅出现在网页端 `agent/get_available_model_list` 旧通道列表中（官方 Skill 列表不返回，生产环境优先选前 8 个）。

| 模型 ID (`model`) | 通道 | 时长 (`duration`) | 分辨率 (`resolution`) | 支持画幅 (`aspect_ratio`) | 首尾帧 | `seed` | 参考上限 (`总/图/视/音`) | 素材格式与大小限制 | 支持模式 (`mode`) | 每秒积分 (`credits/s`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `Seedance_2.5` *(默认)* | Skill + Web | `4`–`30`s (默认 `10`s) | `480p`, `720p`*(默认)*, `1080p`, `4k` | `adaptive`, `16:9`, `21:9`, `9:16`, `1:1`, `4:3`, `3:4` | 首✅ 尾✅ | ✅ | `50 / 30 / 10 / 10` | 图 ≤30MB (`jpg/png/webp/bmp/gif`) | `t2v`, `first_last_frame`, `reference`, `edit`, `extend` | `480p`: **12**<br>`720p`: **20**<br>`1080p`: **64**<br>`4k`: **99** |
| `Seedance_2.5_draft` | Skill + Web | `4`–`30`s (默认 `10`s) | 固定 `480p` 样片（不传 `resolution`） | 同上 | 首✅ 尾✅ | ✅ | `50 / 30 / 10 / 0` | 图 ≤30MB；**禁参考音频** | `t2v`, `first_last_frame`, `reference`, `extend` + `draft_task_id`转正（**不支持 `edit`**） | **9** |
| `seedance2.0_vision` *(别名 `seedance_2.0`)* | Skill + Web | `4`–`15`s (默认 `10`s) | `480p`, `720p`*(默认)*, `1080p`, `4k` | 同上 | 首✅ 尾✅ | ✅ | `12 / 9 / 3 / 3` | 图 ≤30MB | `t2v`, `first_last_frame`, `reference` | `480p`: **8**<br>`720p`: **14**<br>`1080p`: **33**<br>`4k`: **80** |
| `seedance2.0_fast_vision` *(别名 `seedance_2.0_fast`)* | Skill + Web | `4`–`15`s (默认 `10`s) | `480p`, `720p`*(默认)* | 同上 | 首✅ 尾✅ | ✅ | `12 / 9 / 3 / 3` | 图 ≤30MB | `t2v`, `first_last_frame`, `reference` | `480p`: **3**<br>`720p`: **6** |
| `Seedance_2.0_mini` | Skill + Web | `4`–`15`s (默认 `10`s) | 固定 `720p`（不传 `resolution`） | 同上 | 首✅ 尾✅ | ✅ | `12 / 9 / 3 / 3` | 图 ≤30MB | `t2v`, `first_last_frame`, `reference` | **6** |
| `Seedance_2.0_mini_lite` | Skill + Web | `4`–`15`s (默认 `10`s) | 固定 `720p`（不传 `resolution`） | 同上 | 首✅ 尾✅ | ✅ | `12 / 9 / 3 / 3` | 图 ≤30MB | `t2v`, `first_last_frame`, `reference` | **4** |
| `wan3.0` | Skill + Web | `4`–`30`s (默认 `10`s) | `480p`, `720p`*(默认)*, `1080p` | **不支持 `21:9`**，支持其余 6 种 | 首✅ 尾✅ | ✅ | `12 / 9 / 3 / 3` | **图 ≤20MB 且不支持 `gif`**；参视单条/总长 ≤15s 且**参视+输出总长 ≤30s** | `t2v`, `first_last_frame`, `reference` | `480p`: **7**<br>`720p`: **14**<br>`1080p`: **33** |
| `happyhorse-1.1` | Skill + Web | `3`–`15`s (默认 `5`s) | `720p`*(默认)*, `1080p` | **不支持 `adaptive`**，支持其余 6 种 | 首❌ 尾❌ | ❌ | `12 / 9 / 3 / 3` | 图 ≤30MB，**支持 `heic/heif`，不支持 `bmp/gif`** | `t2v`, `reference` | `720p`: **14**<br>`1080p`: **18** |
| `seedance2.0_direct` | 仅 Web | `4`–`15`s (默认 `4`s) | `480p`*(默认)*, `720p` | 同 `Seedance_2.5` | 首✅ 尾✅ | ✅ | `12 / 9 / 3 / 0` | 图 ≤30MB；无参考音频 | `t2v`, `first_last_frame`, `reference` | `480p`: **7**<br>`720p`: **8** |
| `seedance2.0_fast_direct` | 仅 Web | `4`–`15`s (默认 `10`s) | 固定 `720p` | 同 `Seedance_2.5` | 首✅ 尾✅ | ✅ | `12 / 9 / 3 / 0` | 图 ≤30MB；无参考音频 | `t2v`, `first_last_frame`, `reference` | **5** |
| `Seedance_1.0_fast` | 仅 Web | `2`–`12`s (默认 `5`s) | `720p`*(默认)*, `1080p` | 同 `Seedance_2.5` | 仅首✅ 尾❌ | ❌ | `1 / 1 / 0 / 0` | 仅单张首帧图，不支持多参 | `t2v`, `first_last_frame`(单首帧) | `720p`: **2**<br>`1080p`: **4** |

### 选模策略建议
- **快速低成本验证构图/动作**：`seedance2.0_fast_vision` `480p`（4 秒仅 **12 积分**）或 `Seedance_2.0_mini_lite`（4 秒 **16 积分**）。
- **需要锁死动态再升高清（Seedance 2.5 主力镜）**：先跑 `Seedance_2.5_draft`（5 秒 **45 积分**）挑出最佳动态，再用 `draft_task_id` 转正，避免直接在 `Seedance_2.5` `1080p`（5 秒 **320 积分**）抽卡浪费预算。
- **视频局部重绘/替换元素（`edit`）**：全平台仅 `Seedance_2.5` 开启了 `video_edit`，不可用 `Seedance_2.5_draft`。
- **3 秒超短镜或 iPhone HEIC 原图直传**：可选 `happyhorse-1.1`（`3`–`15`s，原生支持 `heic/heif`，但不可传 `seed` 或 `first_frame`）。

---

## 2. 参考视频计价规则（`output_plus_reference`）

线上商业化规则对以下 7 个模型声明了 **“按秒计价，此模型输入参考视频时长计入总时长”**（`pricing_policy: "output_plus_reference"`）：
- `Seedance_2.5`
- `seedance2.0_vision`
- `seedance2.0_fast_vision`
- `Seedance_2.0_mini`
- `wan3.0`
- `seedance2.0_direct`
- `seedance2.0_fast_direct`

例如：使用 `Seedance_2.5` `720p`（20 积分/秒）生成 5 秒视频，同时传入一段 4 秒参考视频，则计费时长为 `5 + 4 = 9` 秒，预计消耗 `9 × 20 = 180` 积分。传入参考视频前请先裁短至只保留必要片段，并用 `estimate_credits`（传入 `reference_video_duration_seconds` 或完整 `reference_videos`）核对扣费。

---

## 3. `Seedance_2.5_draft` 样片两阶段转正流程

1. **阶段一：生成 480p 样片（9 积分/秒）**
   - 调用 `create_video` 指定 `model: "Seedance_2.5_draft"`（不要依赖高分辨率，插件会自动发送 `draft: true` 并省略 `resolution`）。
   - 循环 `wait_task` 完成后，检查 `videos[0]`，提取其中的 `draft_task_id`（即服务端返回的 `render_task_id`）。
2. **阶段二：样片一键升级正片**
   - 对人工/质检挑中的满意样片，调用 `create_video` 传入 `draft_task_id: "<上一步的 draft_task_id>"`（并使用与阶段一**相同的 `account`**）。
   - 插件会自动构造 `{ draft: false, draft_task_id, model: "Seedance_2.5_draft", prompt: "" }` 请求体将样片升级为正片。
   - CLI 一键调用示例：
     ```bash
     # 阶段一：跑样片
     python3 "$SKILL_DIR/scripts/xiaoyunque.py" generate \
       --purpose ep01_s02_draft --model Seedance_2.5_draft -d 5 --aspect-ratio 16:9 \
       -p "..." -o "$WORK/clips_raw/ep01_s02_draft.mp4"
     # 从输出 JSON 中拿到 draft_task_id 后，阶段二：转正片
     python3 "$SKILL_DIR/scripts/xiaoyunque.py" generate \
       --purpose ep01_s02_final --draft-task-id "<draft_task_id>" \
       -o "$WORK/clips_raw/ep01_s02_final.mp4"
     ```

---

## 4. 多账号管理、`account` 参数与同账号素材规则

1. **在 Magpie 添加多个小云雀账号**
   - 打开 Magpie Web **「模型 → 供应商 → `小云雀 (XiaoYunQue)`」**。
   - 点击登录：首选 **方式 1（Access Key）**，粘贴在 `https://www.xiaoyunque.com/cli?tab=api` 创建的密钥，并在「账号备注名」填入易读标签（如 `主号`、`备用号`）。保存后卡片会自动展示该 Access Key 账号的当前积分余额。
2. **账号命中优先级**
   - `显式传入 account 参数` > `任务已绑定槽位（task_id → slot）` > `供应商页面置顶且已启用的账号` > `plugins.json 的 options` > `环境变量 XYQ_*`。
   - `account` 参数支持模糊匹配：完整槽位键（如 `xiaoyunque#5eelvy`）、登录备注名（`二号机`）、页面自定义别名、密钥末 4 位，或 `"options"`（强制使用 `plugins.json` 凭据）。
   - 插件**绝不会**在不同请求之间按次轮换（round-robin）账号。
3. **跨工具同账号规则**
   - **上传与生成必须同号**：`upload_image` 返回的 `asset_id` / `pippit_asset_id` 存储在对应小云雀账号空间下，换另一个账号调 `create_video` 引用该 `asset_id` 会报无权限或资源不存在。用 `xiaoyunque.py generate -r local.png --account 二号机` 时，脚本会自动把 `--account 二号机` 同时传给 `upload_image`、`estimate_credits`、`create_video` 与 `wait_task`。
   - **任务查询自动粘性**：`create_video` 成功后插件在内存记录 `task_id → slot`，即使中途在网页端把别的账号置顶，正在跑的 `get_task` / `wait_task` / `cancel_task` 仍会回到原创建账号；若 Magpie 重启导致内存映射清空且默认账号报 `ret=16017`（任务不存在），插件会自动遍历其余启用账号兜底找回任务。

---

## 5. 单次 `wait_task` ≤45 秒分片轮询机制

Magpie 插件宿主对任意单次 MCP 工具执行设有 **55 秒硬超时**。为此，`xiaoyunque_wait_task` 将 `timeout_seconds` 限制在 **`1`–`45` 秒**（默认 `40` 秒，轮询间隔默认 `5` 秒）。
- 当返回 `{"status": "running", "timed_out": true, ...}`（或 `status: "queued"`）时，说明任务仍在小云雀服务端正常排队/渲染，**切勿重新调用 `create_video`**。
- 直接继续调用 `xiaoyunque_wait_task(task_id=..., timeout_seconds=40, output_path=...)`，通常循环 2–6 次即可拿到 `status: "completed"` 并自动下载 MP4。
- 使用 `scripts/xiaoyunque.py wait` 或 `generate` 时，客户端已在循环中自动串联多次 `wait_task`（默认总等待上限 `--max-wait 900` 秒）。

---

## 6. 常见审核失败码与风控排查表

| 错误码 (`ret` / `fail_code`) | 典型标识 / 文案 | 触发原因 | 处置办法 |
| :--- | :--- | :--- | :--- |
| `14005` | `ImageLabCVRiskHit` | 首尾帧或参考图触发视觉安全/敏感人脸/暴露检测 | 更换参考图、裁掉无关敏感背景或适度降低人脸特写占比后重试 |
| `14025` | `BaseModelReviewFailed` | 提示词或中间生成结果触发基础模型安全审核 | 删除激烈冲突、危险动作或敏感词，改为客观镜头语言重试 |
| `14026` | 输出视频审核未通过 | 成片画面或伴生语音触发后置审核 | 传 `--no-audio`（`audio: false`）排除语音误触，并收敛动作描述 |
| `99999` | `内容涉及侵犯他人权益` | 真人明星肖像、知名动漫/影视 IP 或品牌词命中版权保护 | 去掉具体人名/IP 名，用通用服装发型特征描述；必要时从 `Seedance_2.5` 退回 `seedance2.0_vision` 或 `wan3.0` |
| `16008` / `16009` | 积分余额不足 | 当前命中的账号剩余积分低于本次预估扣费 | 跑 `account --all-accounts` 查看其余账号余额，用 `--account <充裕账号>` 提交 |
| `16012`–`16015` | Shark 风控 / 滑块验证 | 使用网页端 Cookie 后端在无头服务器上调用 `submit_run` 被风控拦截 | 在 `https://www.xiaoyunque.com/cli?tab=api` 创建官方 Access Key 并在供应商页面以方式 1 登录 |
| `16017` / `16029` | `ThreadNotFound` | 指定 `account` 与创建该任务的账号不一致，或会话已在网页端删除 | 不传 `account` 让插件自动粘性/遍历查找，或指定原创建账号 |
| `1015` / `34010105` | 登录态失效 | 网页端 Cookie 过期或 Access Key 已吊销 | 更新供应商页面对应账号的 Access Key 或重新导出 Cookie |

---

## 7. 预算门禁与 `credits_ledger.csv` 台账规范

每次真实提交生成任务后（无论通过 `scripts/xiaoyunque.py` 还是直接调 MCP 工具），都在项目工作目录的 `credits_ledger.csv` 追加一行记录，表头固定为：

```csv
timestamp,purpose,account,model,duration,mode,task_id,credits,output_file
```

- **预算门禁**：按 `purpose` 前缀（如 `ep01_s01_v1` 自动提取前缀 `ep01_`）累计已消耗积分；当 `已消耗 + 本次预估 > budget_limit`（默认 `3000`）时立即阻断提交并汇报给用户确认。
- **失败不计扣费**：生成状态为 `failed` 或 `canceled` 且平台退回积分（`actual_deduct_credits == 0`）的任务，`credits` 记为 `0`，保留 `task_id` 备查。
- **返工留痕**：同一分镜返工时在 `purpose` 中递增版本号（`_v2`, `_v3`, `_v4`）并传入 `--rework-reason`；同一分镜已有 4 条有效生成记录（首试 + 3 次返工）时停止自动重抽，改换构图方案或请示用户。
