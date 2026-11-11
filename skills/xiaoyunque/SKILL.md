---
name: xiaoyunque
description: "通过小云雀（XiaoYunQue / Pippit CN）规划并生成 AI 视频镜头：支持 Seedance 2.5、Seedance 2.5 样片两阶段转正（Seedance_2.5_draft / draft_task_id）、Seedance 2.0 系列、Wan 3.0（wan3.0）、HappyHorse 1.1（happyhorse-1.1）等 11 个模型，涵盖文生视频（t2v）、首尾帧（first_last_frame）、多模态参考生视频（reference，[@图片1]/[@视频1]/[@音频1]）、视频编辑（edit）与视频延长（extend），内置多账号切换（account 参数）、积分预估与预算门禁、45 秒分片循环轮询、抽帧运动量质检、返工封顶与 CSV 台账记账。当用户输入 /xiaoyunque，或提到小云雀、XiaoYunQue、Pippit、xyq、Seedance 2.5、样片转正、draft_task_id、wan3.0、happyhorse、happyhorse-1.1、视频编辑/延长，或需要查询小云雀多账号积分余额、预估积分与生成视频时，务必调用本技能。"
argument-hint: <work-dir> [plan|estimate|generate|draft|qa|ledger]
---

# /xiaoyunque — 小云雀（XiaoYunQue / Pippit CN）视频生成工作流

本技能封装小云雀（字节跳动 / 剪映旗下 Pippit 国内版）视频生成全流程，统一执行 **规划镜头与选模 → 预估积分与预算门禁 → 提交生成（含 2.5 样片两阶段） → 循环轮询下载 → 抽帧与运动量质检 → 按规返工 → CSV 台账记账** 闭环。

设技能目录 `SKILL_DIR="${XYQ_SKILL_DIR:-.claude/skills/xiaoyunque}"`，工作目录 `WORK=${1:-.}`（存放分镜、参考素材、`clips_raw/` 与 `credits_ledger.csv`）。

---

## 按需阅读的参考手册（Progressive Disclosure）

在选模型排预算、写多模态提示词或做抽帧质检前，按阶段读取对应参考文档：
- **11 模型完整参数与每秒单价、样片两阶段转正、多账号规则、45 秒轮询上限、常见审核失败码与台账规范**：读 [`references/pricing.md`](references/pricing.md)
- **`[@图片1]`/`[@视频1]`/`[@音频1]` 引用语法、首尾帧 vs 多参 vs 编辑/延长、`audio: false` 提示词静音机制与审核规避**：读 [`references/prompting.md`](references/prompting.md)
- **三帧条 + 1:1 首末帧差分 + `tblend` 运动量质检、音轨剥离校验与返工决策树**：读 [`references/qa.md`](references/qa.md)

---

## 两种调用通道

### 通道 ①：宿主 MCP 工具 `mcp__xiaoyunque__<tool>`（交互式单步调用首选）
宿主将 Magpie 的按插件隔离端点 `http://127.0.0.1:3425/mcp/magpie/tools/xiaoyunque` 注册为名为 `xiaoyunque` 的 MCP 服务（与 `updream` 注册 `http://127.0.0.1:3425/mcp/magpie/tools/updream` 相同），暴露以下 8 个工具：
- `mcp__xiaoyunque__account`：查当前或指定账号余额（传 `all_accounts: true` 一次列出全部账号与余额，返回 `selected_account: {slot, label}`）
- `mcp__xiaoyunque__list_video_models`：查可用模型（默认 `seedance_only: true`；传 `seedance_only: false` 查看含 `wan3.0`、`happyhorse-1.1` 在内的全部模型；`offline: true` 读静态表）
- `mcp__xiaoyunque__upload_image`：上传本地/URL/base64 图片拿 `asset_id` / `pippit_asset_id`（**注意：素材与上传账号强绑定，后续 `create_video` 必须使用同一个 `account`**）
- `mcp__xiaoyunque__estimate_credits`：免费预估积分并校验参数与余额（0 积分）
- `mcp__xiaoyunque__create_video`：提交生成任务（自动绑定 `task_id → 账号槽位`）
- `mcp__xiaoyunque__get_task`：单次非阻塞查询任务状态（完成时传 `output_path` / `download_dir` 自动下载 MP4）
- `mcp__xiaoyunque__wait_task`：单次最多轮询 **45 秒**（默认 40 秒）；若返回 `timed_out: true` 且状态仍为 `queued`/`running`，**继续循环调用 `mcp__xiaoyunque__wait_task`** 直至完成
- `mcp__xiaoyunque__cancel_task`：取消排队或运行中的任务

*(若宿主仅挂载了聚合端点 `/mcp/magpie/tools`，工具名对应变为 `mcp__magpie-tools__xiaoyunque_<tool>`。)*

### 通道 ②：无 MCP 独立 CLI 脚本 `scripts/xiaoyunque.py`（子进程 / agy / 批量并行首选）
供没有挂载 MCP 的子进程（如 `agy`、后台批处理脚本）直接通过 HTTP JSON-RPC 调用 Magpie 端点，内置自动循环 `wait`、预算门禁与文件锁 CSV 记账：
```bash
# 查账号（列出所有供应商页面已登录账号及余额）
XYQ_ENV=/path/to/.env python3 "$SKILL_DIR/scripts/xiaoyunque.py" account --all-accounts

# 列出全部 11 个模型（离线静态表，0 请求）
python3 "$SKILL_DIR/scripts/xiaoyunque.py" list-models --all --offline

# 免费预估积分与预算核验（0 积分）
XYQ_ENV=/path/to/.env XYQ_LEDGER="$WORK/credits_ledger.csv" \
  python3 "$SKILL_DIR/scripts/xiaoyunque.py" estimate \
  --account 主号 --purpose s01_v1 --budget-limit 3000 \
  --model seedance2.0_fast_vision --mode reference -d 5 --resolution 720p --aspect-ratio 9:16 \
  -r "$WORK/refs/char.png" -p "手机拍摄，固定机位，[@图片1]中的人物..."

# 一键预估 → 门禁检查 → 创建 → 自动循环 wait 直至出片 → 下载 MP4 → 记入 CSV 台账
XYQ_ENV=/path/to/.env XYQ_LEDGER="$WORK/credits_ledger.csv" \
  python3 "$SKILL_DIR/scripts/xiaoyunque.py" generate \
  --account 主号 --purpose s01_v1 --budget-limit 3000 \
  --model Seedance_2.5_draft --mode t2v -d 5 --aspect-ratio 16:9 --no-audio \
  -p "..." -o "$WORK/clips_raw/s01_draft.mp4"
```
支持子命令：`account`、`list-models`、`upload`、`estimate`、`create`、`generate`、`get`、`wait`（自动循环 ≤45s 分片直至终态）、`cancel`、`ledger`；全局支持 `--account <槽位/备注名/别名/末4位/options>` 与 `--dry-run`。

---

## 小云雀五大平台特性（必知）

1. **多账号与同账号素材绑定（`account` 参数）**
   - 账号在 Magpie Web **「模型 → 供应商 → `小云雀 (XiaoYunQue)`」** 页面统一管理（首选方式 1 粘贴 `https://www.xiaoyunque.com/cli?tab=api` 的官方 Access Key；方式 2 粘贴网页端 Cookie / `xiaoyunque-session.json`）。
   - 凭据优先级：**显式 `account` > 任务历史绑定槽位 > 页面置顶启用账号 > `plugins.json` `options` > 环境变量**，绝不按次轮换账号。
   - **同账号铁律**：`upload_image` 返回的 `asset_id` 归属上传时命中的账号；若用 `--account 二号机` 上传素材，`create_video` 也必须传 `--account 二号机`。
2. **模型矩阵速查（8 个官方 Skill API 模型 + 3 个仅网页端旧模型）**
   - **主力高画质 / 视频编辑与延长**：`Seedance_2.5`（4–30s，`480p:12` / `720p:20` / `1080p:64` / `4k:99` 积分/秒，唯一开放 `edit` 视频编辑与参考音频 `10` 条的模型）。
   - **低成本探路与两阶段样片转正**：`Seedance_2.5_draft`（4–30s，固定 480p **9 积分/秒**，**不支持 `edit` 和参考音频**）；满意后取返回 `videos[0].draft_task_id` 调 `create_video(draft_task_id=...)` 升级正片，无需重抽动态。
   - **高性价比日常出片**：`seedance2.0_fast_vision`（4–15s，`480p:3` / `720p:6` 积分/秒）、`Seedance_2.0_mini_lite`（固定 720p **4 积分/秒**）、`Seedance_2.0_mini`（固定 720p **6 积分/秒**）、`seedance2.0_vision`（4–15s，`480p:8` / `720p:14` / `1080p:33` / `4k:80` 积分/秒）。
   - **非 Seedance 平台模型**：
     - `wan3.0`（4–30s，`480p:7` / `720p:14` / `1080p:33` 积分/秒；不支持 `21:9`；图片 ≤20MB 禁 GIF；参考视频 ≤15s 且**参考视频+输出总时长 ≤30s**）。
     - `happyhorse-1.1`（3–15s 默认 5s，`720p:14` / `1080p:18` 积分/秒；不支持 `adaptive`、**不支持首尾帧与 `seed`**；仅 `t2v` / `reference`；图片支持 `heic/heif` 禁 `bmp/gif`）。
   - **仅网页端旧通道（官方 Access-Key Skill 列表不含）**：`seedance2.0_direct`、`seedance2.0_fast_direct`、`Seedance_1.0_fast`（仅单首帧与 `t2v`，不支持 `reference` 与 `seed`）。
   - **参考视频计价提醒**：在 `Seedance_2.5`、`seedance2.0_vision`、`seedance2.0_fast_vision`、`Seedance_2.0_mini`、`wan3.0` 等模型上传入 `reference_videos` 时，平台将**输入参考视频时长计入计费总秒数**（`output_plus_reference`），务必先跑 `estimate_credits`。
3. **`audio: false` 是提示词级静音（非底层硬件静音开关）**
   - 小云雀 `video_part_tool_param` 没有独立的布尔静音字段。传入 `audio: false`（CLI `--no-audio`）时，插件会在提示词末尾自动追加 `"（全片无对白、无旁白、无背景音乐，静音）"`（返回 `audio_control: "prompt_hint"`）。
   - 生成的 MP4 容器仍可能带有空白或微弱环境音轨；**凡不需原生语音的镜头，后期剪辑拼接时一律用 `ffmpeg -an` 剥离音轨**。
4. **单次 `wait_task` ≤ 45 秒硬上限**
   - 受 Magpie 单次工具调用 55 秒超时保护限制，`wait_task` 单次最多等待 45 秒。视频生成通常耗时 1–4 分钟，直接调 MCP 时看到 `timed_out: true` 属正常现象，循环再次调用 `wait_task` 即可（无需重提任务！）；用 `scripts/xiaoyunque.py wait` 或 `generate` 则由脚本自动循环等待。
5. **常见审核与风控错误码速查**
   - `14005` (`ImageLabCVRiskHit`)：参考图/首帧触发视觉安全或人脸敏感审核 → 更换或裁切图片重试。
   - `14025` (`BaseModelReviewFailed`) / `14026`：提示词或生成画面触发模型安全审核 → 柔化敏感动作/绝对化措辞后重试。
   - `99999` (`内容涉及侵犯他人权益`)：触发真人肖像/明星/IP 版权保护 → 避免写具体名人/品牌词，改用中性外观描述，或切换 `seedance2.0_vision` / `wan3.0`。
   - `16008` / `16009`：当前账号积分不足 → 用 `account(all_accounts=true)` 检查其他已启用账号并用 `account` 参数切换。
   - `16012`–`16015`：网页端 Cookie 触发 Shark 滑块风控 → 改用官方 Access Key 登录。

---

## 标准六步工作流

1. **规划分镜与复用检查（先读 [`references/prompting.md`](references/prompting.md)）**
   - 先检索 `$WORK/clips_raw/` 是否已有合格片段可直接 0 积分复用。
   - 高单价复杂镜头（如 `Seedance_2.5` 1080p 64 积分/秒）优先先跑一条 `Seedance_2.5_draft`（9 积分/秒）或 `seedance2.0_fast_vision`（480p 3 积分/秒）探路验构图与运动，确认满意再升级正片。
2. **免费预估与预算门禁（先读 [`references/pricing.md`](references/pricing.md)）**
   - 设定本片预算上限（`--budget-limit`，默认 3000 积分）与统一 `purpose` 前缀（如 `ep01_`）。
   - 批量生成前逐条跑 `estimate_credits` / `xiaoyunque.py estimate`（0 积分），确认 `已消耗 + 本批预估 + 20% 返工预留 <= 预算上限`。
3. **提交生成（独立镜头后台并行）**
   - 互不依赖的分镜并行启动 `xiaoyunque.py generate`（或并发调 `mcp__xiaoyunque__create_video` 后循环 `wait_task`）。
   - 多模态参考（`mode: "reference"`）在提示词中用 `[@图片1]`、`[@视频1]`、`[@音频1]` 明确指代每个素材的角色与动作边界。
4. **抽帧与运动量质检（先读 [`references/qa.md`](references/qa.md)）**
   - 出片后禁止盲剪，运行质检脚本生成三帧条、1:1 首末帧差分图与 `tblend` 运动量指标：
     ```bash
     python3 "$SKILL_DIR/scripts/qa_clip.py" "$WORK/clips_raw/" -o "$WORK/qa_out"
     ```
   - 目视检查 `_strip3.jpg` 与 `_first_last_full.jpg`：核查主体变形/穿模、比例失真、异常静止或剧烈乱晃、非预期字幕水印，以及是否携带多余音轨。
5. **按规返工（单镜最多返工 3 次）**
   - 半段合格的素材优先用 `ffmpeg` 截取可用区间；确需重做时单镜最多返工 3 次（连首试共 4 次），每次返工传入 `--rework-reason "原因与改法"` 留痕。连续两次 `reference` 比例或构图失控时，改用锁死构图的首帧走 `first_last_frame`。
6. **台账核对与结算**
   - 交付前运行 `python3 "$SKILL_DIR/scripts/xiaoyunque.py" ledger --ledger "$WORK/credits_ledger.csv" --purpose-prefix ep01_` 汇总实扣积分、返工次数与失败单（失败单记 0 积分）。

---

## 安全与红线守则

- **先预估后提交**：未经 `estimate` 核对预算不得直接跑高单价（1080p/4K/长时长）生成。
- **同号传图同号生片**：指定 `account` 时，上传素材与创建任务必须保持同一 `account`。
- **`timed_out: true` 只续等不重提**：`wait_task` 超时说明任务仍在后台渲染，严禁误判为失败而重复调用 `create_video` 造成双倍扣费。
- **凭据绝对保密**：Access Key、Cookie 与 `MAGPIE_API_KEY` 仅从 Magpie 供应商槽位或权限 `0600` 的 `.env` 读取，严禁打印到终端、写入台账或提交进仓库。
