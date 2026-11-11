#!/usr/bin/env python3
"""XiaoYunQue (小云雀 / Pippit CN) video generation CLI via Magpie MCP JSON-RPC.

Environment variables (all overridable via CLI flags):
  - XYQ_ENV             Path to .env file (chmod 600) containing MAGPIE_API_KEY and optional MAGPIE_URL
                        (default: ./.env in current working directory)
  - XYQ_ACCOUNT         Optional default account selector (slot key, remark, alias, key last-4, or 'options')
  - XYQ_LEDGER          Path to credits_ledger.csv (default: ./credits_ledger.csv)
  - XYQ_OUTPUT          Default output directory or .mp4 path (default: ./clips_raw)
  - XYQ_PURPOSE_PREFIX  Optional prefix for per-project budget accounting (auto-derived from --purpose if unset)
  - XYQ_BUDGET_LIMIT    Default credit cap per project/prefix (default: 3000)

Subcommands:
  - account      Query XiaoYunQue account(s) and credit balance (0 credits)
  - list-models  List available video models (online or --offline static table, 0 credits)
  - upload       Upload a local/URL image and return asset_id bound to that account (0 credits)
  - estimate     Estimate credits and check local ledger budget gate without creating a task (0 credits)
  - create       Check budget/rework gate and submit create_video without waiting (supports --dry-run)
  - generate     Estimate -> budget/rework gate -> create_video -> auto-loop wait -> download MP4 -> log CSV ledger
  - get          Single non-blocking get_task status check (0 credits)
  - wait         Auto-loop wait_task (<=45s per RPC slice) until completed/failed/canceled and download MP4
  - cancel       Cancel a queued or running task
  - ledger       Summarize local credits_ledger.csv totals, per-account spend, and rework counts (0 credits)
"""
import argparse
import csv
import datetime as dt
import fcntl
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_MAGPIE_URL = "http://127.0.0.1:3425/mcp/magpie/tools/xiaoyunque"
LEDGER_HEADERS = [
    "timestamp",
    "purpose",
    "account",
    "model",
    "duration",
    "mode",
    "task_id",
    "credits",
    "rework_reason",
    "output_file",
]

KNOWN_MODELS = (
    "Seedance_2.5",
    "Seedance_2.5_draft",
    "seedance2.0_vision",
    "seedance2.0_fast_vision",
    "Seedance_2.0_mini",
    "Seedance_2.0_mini_lite",
    "wan3.0",
    "happyhorse-1.1",
    "seedance2.0_direct",
    "seedance2.0_fast_direct",
    "Seedance_1.0_fast",
    # Convenient aliases accepted by the plugin
    "seedance_2.5",
    "seedance_2.5_draft",
    "seedance_2.0",
    "seedance_2.0_fast",
    "seedance_2.0_mini",
    "seedance_2.0_mini_lite",
    "wan_3.0",
    "happyhorse_1.1",
)


def default_env_path() -> Path:
    val = os.environ.get("XYQ_ENV", "").strip()
    return Path(val) if val else (Path.cwd() / ".env")


def default_account() -> Optional[str]:
    val = os.environ.get("XYQ_ACCOUNT", "").strip()
    return val or None


def default_ledger_path() -> Path:
    val = os.environ.get("XYQ_LEDGER", "").strip()
    return Path(val) if val else (Path.cwd() / "credits_ledger.csv")


def default_output_path() -> Path:
    val = os.environ.get("XYQ_OUTPUT", "").strip()
    return Path(val) if val else (Path.cwd() / "clips_raw")


def default_budget_limit() -> float:
    val = os.environ.get("XYQ_BUDGET_LIMIT", "").strip()
    if val:
        try:
            return float(val)
        except ValueError:
            pass
    return 3000.0


def load_env(env_path: Path) -> Dict[str, str]:
    env: Dict[str, str] = {}
    if env_path.is_file():
        st_mode = env_path.stat().st_mode & 0o777
        if st_mode & 0o077:
            print(
                f"[xiaoyunque] Security warning: {env_path} has mode {oct(st_mode)}; recommend `chmod 600 {env_path}`.",
                file=sys.stderr,
            )
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    for k in ("MAGPIE_URL", "MAGPIE_API_KEY"):
        if k in os.environ and os.environ[k]:
            env[k] = os.environ[k]
    return env


def _redact_secret(text: str, secret: Optional[str]) -> str:
    if secret and len(secret) >= 4 and secret in text:
        return text.replace(secret, "***REDACTED***")
    return text


def parse_rpc_or_sse(raw_text: str) -> Dict[str, Any]:
    """Parse either plain JSON-RPC response or Streamable HTTP SSE lines."""
    stripped = raw_text.strip()
    if stripped.startswith("{"):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

    last_msg: Optional[Dict[str, Any]] = None
    for line in stripped.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data_str = line[len("data:") :].strip()
            if data_str.startswith("{"):
                try:
                    obj = json.loads(data_str)
                    if isinstance(obj, dict):
                        last_msg = obj
                except json.JSONDecodeError:
                    continue
    if last_msg is not None:
        return last_msg
    raise RuntimeError(f"Unable to parse Magpie MCP response: {stripped[:500]}")


def _candidate_tool_names(base_tool: str, magpie_url: str) -> List[str]:
    clean_url = magpie_url.rstrip("/")
    prefixed = base_tool if base_tool.startswith("xiaoyunque_") else f"xiaoyunque_{base_tool}"
    unprefixed = base_tool[len("xiaoyunque_") :] if base_tool.startswith("xiaoyunque_") else base_tool
    if clean_url.endswith("/mcp/magpie/tools"):
        return [prefixed, unprefixed]
    return [unprefixed, prefixed]


def _rpc_post(magpie_url: str, api_key: Optional[str], rpc_name: str, arguments: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    payload = {
        "jsonrpc": "2.0",
        "id": int(time.time() * 1000) % 1_000_000_000,
        "method": "tools/call",
        "params": {
            "name": rpc_name,
            "arguments": arguments,
        },
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    req = urllib.request.Request(
        magpie_url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        msg = _redact_secret(f"HTTP {exc.code} from {magpie_url}: {err_body[:400]}", api_key)
        raise RuntimeError(msg) from None
    except Exception as exc:
        msg = _redact_secret(f"Failed to reach Magpie MCP ({magpie_url}): {exc}", api_key)
        raise RuntimeError(msg) from None

    return parse_rpc_or_sse(_redact_secret(body, api_key))


def call_xyq_tool(
    tool_name: str,
    arguments: Dict[str, Any],
    env_path: Path,
    timeout: int = 65,
    retries: int = 2,
) -> Dict[str, Any]:
    env = load_env(env_path)
    magpie_url = env.get("MAGPIE_URL", DEFAULT_MAGPIE_URL)
    api_key = env.get("MAGPIE_API_KEY")
    clean_args = {k: v for k, v in arguments.items() if v is not None}

    candidates = _candidate_tool_names(tool_name, magpie_url)
    last_err: Optional[Exception] = None

    for attempt in range(retries + 1):
        try:
            rpc_msg = _rpc_post(magpie_url, api_key, candidates[0], clean_args, timeout=timeout)
            if "error" in rpc_msg and rpc_msg["error"]:
                err_obj = rpc_msg["error"]
                err_code = err_obj.get("code")
                err_text = str(err_obj.get("message") or err_obj)
                if err_code == -32602 and "unknown tool" in err_text.lower() and len(candidates) > 1:
                    rpc_msg = _rpc_post(magpie_url, api_key, candidates[1], clean_args, timeout=timeout)
            if "error" in rpc_msg and rpc_msg["error"]:
                raise RuntimeError(f"MCP error on {tool_name}: {json.dumps(rpc_msg['error'], ensure_ascii=False)}")

            result = rpc_msg.get("result") or {}
            is_error = bool(result.get("isError"))
            content_items = result.get("content") or []
            text_parts = [item.get("text", "") for item in content_items if isinstance(item, dict) and item.get("type") == "text"]
            combined = "\n".join(p for p in text_parts if p).strip()
            if is_error:
                raise RuntimeError(f"Tool {tool_name} failed: {combined or json.dumps(result, ensure_ascii=False)}")
            if not combined:
                return result if isinstance(result, dict) else {"raw": result}
            try:
                parsed = json.loads(combined)
                return parsed if isinstance(parsed, dict) else {"data": parsed}
            except json.JSONDecodeError:
                return {"text": combined}
        except Exception as exc:
            last_err = exc
            transient = any(
                tok in str(exc).lower()
                for tok in ("timed out", "connection reset", "temporarily unavailable", "incomplete read", "http 502", "http 503", "http 504")
            )
            # Never auto-retry create_video on ambiguous timeout to avoid duplicate credit charges.
            if tool_name == "create_video" or not transient or attempt >= retries:
                raise
            time.sleep(1.5 * (attempt + 1))
    assert last_err is not None
    raise last_err


# -------------------------- Ledger & Budget Gate --------------------------


def derive_purpose_prefix(purpose: str, explicit_prefix: Optional[str]) -> str:
    if explicit_prefix and explicit_prefix.strip():
        return explicit_prefix.strip()
    val = os.environ.get("XYQ_PURPOSE_PREFIX", "").strip()
    if val:
        return val
    if "_" in purpose:
        return purpose.split("_", 1)[0] + "_"
    return purpose


def base_shot_key(purpose: str) -> str:
    return re.sub(r"_v\d+$", "", purpose.strip())


def read_ledger_rows(ledger_path: Path) -> List[Dict[str, str]]:
    if not ledger_path.is_file():
        return []
    with ledger_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return list(reader)


def summarize_ledger(ledger_path: Path, prefix: Optional[str] = None) -> Dict[str, Any]:
    rows = read_ledger_rows(ledger_path)
    total_credits = 0.0
    prefix_credits = 0.0
    by_account: Dict[str, float] = {}
    by_model: Dict[str, float] = {}
    shot_attempts: Dict[str, int] = {}
    rework_rows = 0

    for row in rows:
        purpose = (row.get("purpose") or "").strip()
        if prefix and not purpose.startswith(prefix):
            counted_in_prefix = False
        else:
            counted_in_prefix = True
        try:
            cred = float(row.get("credits") or 0.0)
        except ValueError:
            cred = 0.0

        total_credits += cred
        if counted_in_prefix:
            prefix_credits += cred
            acc = (row.get("account") or "default").strip() or "default"
            mdl = (row.get("model") or "unknown").strip() or "unknown"
            by_account[acc] = round(by_account.get(acc, 0.0) + cred, 3)
            by_model[mdl] = round(by_model.get(mdl, 0.0) + cred, 3)
            if cred > 0:
                bkey = base_shot_key(purpose)
                shot_attempts[bkey] = shot_attempts.get(bkey, 0) + 1
            if (row.get("rework_reason") or "").strip():
                rework_rows += 1

    return {
        "ledger_path": str(ledger_path),
        "total_rows": len(rows),
        "total_credits_all": round(total_credits, 3),
        "purpose_prefix": prefix or "",
        "prefix_credits_used": round(prefix_credits, 3),
        "by_account": by_account,
        "by_model": by_model,
        "shot_paid_attempts": shot_attempts,
        "rework_entries": rework_rows,
    }


def append_ledger_row(
    ledger_path: Path,
    *,
    purpose: str,
    account: str,
    model: str,
    duration: Any,
    mode: str,
    task_id: str,
    credits: float,
    rework_reason: str = "",
    output_file: str = "",
) -> None:
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    with ledger_path.open("a+", encoding="utf-8", newline="") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            f.seek(0, os.SEEK_END)
            need_header = f.tell() == 0
            writer = csv.DictWriter(f, fieldnames=LEDGER_HEADERS)
            if need_header:
                writer.writeheader()
            writer.writerow(
                {
                    "timestamp": dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds"),
                    "purpose": purpose,
                    "account": account,
                    "model": model,
                    "duration": duration,
                    "mode": mode,
                    "task_id": task_id,
                    "credits": round(float(credits), 3),
                    "rework_reason": rework_reason,
                    "output_file": output_file,
                }
            )
            f.flush()
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def enforce_budget_and_rework_gate(
    *,
    ledger_path: Path,
    purpose: str,
    purpose_prefix: Optional[str],
    budget_limit: float,
    estimated_credits: float,
    max_reworks: int,
    rework_reason: str,
) -> Dict[str, Any]:
    prefix = derive_purpose_prefix(purpose, purpose_prefix)
    summary = summarize_ledger(ledger_path, prefix=prefix)
    used = float(summary["prefix_credits_used"])
    projected = round(used + float(estimated_credits), 3)
    if budget_limit > 0 and projected > budget_limit:
        raise RuntimeError(
            f"Budget gate blocked '{purpose}': prefix '{prefix}' used={used} + estimated={estimated_credits} "
            f"= {projected} > budget_limit={budget_limit}. Raise --budget-limit after user approval."
        )

    bkey = base_shot_key(purpose)
    prior_attempts = int(summary["shot_paid_attempts"].get(bkey, 0))
    max_total_attempts = max(1, int(max_reworks) + 1)
    if prior_attempts >= max_total_attempts:
        raise RuntimeError(
            f"Rework cap blocked '{purpose}': shot '{bkey}' already has {prior_attempts} paid attempts "
            f"(max_reworks={max_reworks}, total cap={max_total_attempts}). Switch framing/mode or ask user."
        )
    if prior_attempts >= 1 and not rework_reason.strip() and re.search(r"_v([2-9]|\d{2,})$", purpose):
        print(
            f"[xiaoyunque] Note: '{purpose}' looks like a rework (prior attempts={prior_attempts}); "
            "pass --rework-reason to record why in credits_ledger.csv.",
            file=sys.stderr,
        )

    return {
        "purpose_prefix": prefix,
        "used_before": used,
        "estimated_credits": estimated_credits,
        "projected_after": projected,
        "budget_limit": budget_limit,
        "prior_paid_attempts_for_shot": prior_attempts,
    }


# -------------------------- Argument Builders --------------------------


def _media_item_arg(raw: str) -> Any:
    s = raw.strip()
    if s.startswith("{"):
        return json.loads(s)
    if s.startswith("http://") or s.startswith("https://") or s.startswith("data:"):
        return s
    p = Path(s)
    if p.exists():
        return str(p.resolve())
    # Could be an already uploaded asset_id
    return s


def build_video_tool_args(args: argparse.Namespace, for_estimate: bool = False) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    if getattr(args, "account", None):
        payload["account"] = args.account
    if getattr(args, "model", None):
        payload["model"] = args.model
    if getattr(args, "duration", None) is not None:
        payload["duration"] = args.duration
    if getattr(args, "resolution", None):
        payload["resolution"] = args.resolution
    if getattr(args, "aspect_ratio", None):
        payload["aspect_ratio"] = args.aspect_ratio
    if getattr(args, "mode", None):
        payload["mode"] = args.mode

    if for_estimate:
        ref_vids = getattr(args, "ref_video", None) or []
        if getattr(args, "ref_video_duration", None) is not None:
            payload["reference_video_duration_seconds"] = args.ref_video_duration
        if ref_vids:
            payload["has_refer_video"] = True
        return payload

    if getattr(args, "draft_task_id", None):
        payload["draft_task_id"] = args.draft_task_id
        if getattr(args, "prompt", None) is not None:
            payload["prompt"] = args.prompt
        return payload

    if getattr(args, "prompt", None) is not None:
        payload["prompt"] = args.prompt
    if getattr(args, "audio", None) is not None:
        payload["audio"] = bool(args.audio)
    if getattr(args, "seed", None) is not None:
        payload["seed"] = args.seed
    if getattr(args, "first_frame", None):
        payload["first_frame"] = _media_item_arg(args.first_frame)
    if getattr(args, "last_frame", None):
        payload["last_frame"] = _media_item_arg(args.last_frame)
    if getattr(args, "ref_image", None):
        payload["reference_images"] = [_media_item_arg(x) for x in args.ref_image]
    if getattr(args, "ref_video", None):
        payload["reference_videos"] = [_media_item_arg(x) for x in args.ref_video]
    if getattr(args, "ref_audio", None):
        payload["reference_audios"] = [_media_item_arg(x) for x in args.ref_audio]
    if getattr(args, "wait_seconds", None) is not None:
        payload["wait_seconds"] = args.wait_seconds
    return payload


def resolve_output_target(raw_output: Optional[str], purpose: str, task_id: str) -> Tuple[Optional[str], Optional[str]]:
    target = Path(raw_output) if raw_output else default_output_path()
    if str(target).lower().endswith(".mp4"):
        target.parent.mkdir(parents=True, exist_ok=True)
        return str(target.resolve()), None
    target.mkdir(parents=True, exist_ok=True)
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", purpose.strip() or task_id.split(":")[-1])
    out_file = target / f"{safe_stem}.mp4"
    return str(out_file.resolve()), None


def loop_wait_task(
    *,
    task_id: str,
    account: Optional[str],
    env_path: Path,
    slice_seconds: int = 40,
    interval_seconds: int = 5,
    max_wait_seconds: int = 900,
    output_path: Optional[str] = None,
    download_dir: Optional[str] = None,
) -> Dict[str, Any]:
    slice_sec = max(1, min(45, int(slice_seconds)))
    interval_sec = max(1, min(30, int(interval_seconds)))
    deadline = time.monotonic() + max(5, int(max_wait_seconds))
    iteration = 0
    last_res: Dict[str, Any] = {}

    while True:
        iteration += 1
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            last_res["cli_max_wait_exceeded"] = True
            return last_res
        this_slice = max(1, min(slice_sec, int(remaining)))
        wait_args: Dict[str, Any] = {
            "task_id": task_id,
            "timeout_seconds": this_slice,
            "interval_seconds": min(interval_sec, this_slice),
        }
        if account:
            wait_args["account"] = account
        if output_path:
            wait_args["output_path"] = output_path
        elif download_dir:
            wait_args["download_dir"] = download_dir

        last_res = call_xyq_tool("wait_task", wait_args, env_path=env_path, timeout=this_slice + 20)
        status = str(last_res.get("status") or "").lower()
        timed_out = bool(last_res.get("timed_out"))
        print(
            f"[xiaoyunque] wait slice #{iteration}: task_id={task_id} status={status} timed_out={timed_out} "
            f"account={last_res.get('account', account or 'default')}",
            file=sys.stderr,
        )
        if status in ("completed", "failed", "canceled") or not timed_out:
            return last_res


# -------------------------- Subcommand Handlers --------------------------


def cmd_account(args: argparse.Namespace) -> int:
    tool_args: Dict[str, Any] = {}
    if args.account:
        tool_args["account"] = args.account
    if args.all_accounts:
        tool_args["all_accounts"] = True
    res = call_xyq_tool("account", tool_args, env_path=Path(args.env))
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


def cmd_list_models(args: argparse.Namespace) -> int:
    tool_args: Dict[str, Any] = {
        "seedance_only": not bool(args.all),
        "offline": bool(args.offline),
        "with_prices": bool(args.with_prices),
    }
    if args.account:
        tool_args["account"] = args.account
    res = call_xyq_tool("list_video_models", tool_args, env_path=Path(args.env))
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


def cmd_upload(args: argparse.Namespace) -> int:
    src = (args.source or args.file or args.url or "").strip()
    if not src:
        raise RuntimeError("upload requires a local file path or URL.")
    tool_args: Dict[str, Any] = {}
    if args.account:
        tool_args["account"] = args.account
    if args.filename:
        tool_args["filename"] = args.filename
    if src.startswith("http://") or src.startswith("https://"):
        tool_args["url"] = src
    elif src.startswith("data:"):
        tool_args["base64"] = src
    else:
        p = Path(src)
        if not p.is_file():
            raise RuntimeError(f"Local file not found: {src}")
        tool_args["path"] = str(p.resolve())

    if args.dry_run:
        print(json.dumps({"dry_run": True, "tool": "upload_image", "arguments": tool_args}, ensure_ascii=False, indent=2))
        return 0

    res = call_xyq_tool("upload_image", tool_args, env_path=Path(args.env), timeout=65)
    res["same_account_note"] = (
        f"Asset belongs to account '{res.get('account', args.account or 'default')}'; "
        "pass the same --account when calling create / generate."
    )
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


def cmd_estimate(args: argparse.Namespace) -> int:
    env_path = Path(args.env)
    est_args = build_video_tool_args(args, for_estimate=True)
    est = call_xyq_tool("estimate_credits", est_args, env_path=env_path)
    estimated_val = float(est.get("estimated_credits") or est.get("total") or 0.0)
    gate = enforce_budget_and_rework_gate(
        ledger_path=Path(args.ledger),
        purpose=args.purpose or "adhoc_estimate",
        purpose_prefix=args.purpose_prefix,
        budget_limit=float(args.budget_limit),
        estimated_credits=estimated_val,
        max_reworks=int(args.max_reworks),
        rework_reason=args.rework_reason or "",
    )
    out = {"estimate": est, "budget_gate": gate}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def _prepare_and_check_create(args: argparse.Namespace) -> Tuple[Dict[str, Any], Dict[str, Any], float]:
    env_path = Path(args.env)
    create_args = build_video_tool_args(args, for_estimate=False)

    if args.draft_task_id:
        # Draft-to-final upgrade uses Seedance_2.5_draft render_task_id; estimate conservatively or 0 if dry-run.
        est_model = args.model or "Seedance_2.5"
        est_dur = args.duration or 5
        est_res = args.resolution or "720p"
        if args.dry_run:
            est = {"model": est_model, "duration": est_dur, "resolution": est_res, "estimated_credits": 0, "note": "dry-run draft upgrade"}
        else:
            est = call_xyq_tool(
                "estimate_credits",
                {"model": est_model, "duration": est_dur, "resolution": est_res, **({"account": args.account} if args.account else {})},
                env_path=env_path,
            )
    else:
        if not (args.prompt and args.prompt.strip()):
            raise RuntimeError("--prompt (-p) is required unless --draft-task-id is provided.")
        est_args = build_video_tool_args(args, for_estimate=True)
        est = call_xyq_tool("estimate_credits", est_args, env_path=env_path)

    estimated_val = float(est.get("estimated_credits") or est.get("total") or 0.0)
    gate = enforce_budget_and_rework_gate(
        ledger_path=Path(args.ledger),
        purpose=args.purpose,
        purpose_prefix=args.purpose_prefix,
        budget_limit=float(args.budget_limit),
        estimated_credits=estimated_val,
        max_reworks=int(args.max_reworks),
        rework_reason=args.rework_reason or "",
    )
    return create_args, {"estimate": est, "budget_gate": gate}, estimated_val


def cmd_create(args: argparse.Namespace) -> int:
    create_args, preflight, _ = _prepare_and_check_create(args)
    if args.dry_run:
        print(
            json.dumps(
                {"dry_run": True, "tool": "create_video", "arguments": create_args, **preflight},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    created = call_xyq_tool("create_video", create_args, env_path=Path(args.env), timeout=65, retries=0)
    print(json.dumps({"created": created, **preflight}, ensure_ascii=False, indent=2))
    return 0


def cmd_generate(args: argparse.Namespace) -> int:
    env_path = Path(args.env)
    create_args, preflight, estimated_val = _prepare_and_check_create(args)
    if args.dry_run:
        print(
            json.dumps(
                {"dry_run": True, "tool": "generate", "create_arguments": create_args, **preflight},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    created = call_xyq_tool("create_video", create_args, env_path=env_path, timeout=65, retries=0)
    task_id = str(created.get("task_id") or "")
    if not task_id:
        raise RuntimeError(f"create_video did not return task_id: {json.dumps(created, ensure_ascii=False)}")

    used_account = str(created.get("account") or args.account or "default")
    output_path, download_dir = resolve_output_target(args.output, args.purpose, task_id)

    final_res = loop_wait_task(
        task_id=task_id,
        account=args.account,
        env_path=env_path,
        slice_seconds=args.slice_seconds,
        interval_seconds=args.interval,
        max_wait_seconds=args.max_wait,
        output_path=output_path,
        download_dir=download_dir,
    )

    status = str(final_res.get("status") or "").lower()
    cc = final_res.get("credit_consumption") or {}
    if status == "completed":
        actual_credits = float(cc.get("actual_deduct_credits") if cc.get("actual_deduct_credits") is not None else estimated_val)
    else:
        actual_credits = float(cc.get("actual_deduct_credits") or 0.0)

    videos = final_res.get("videos") or []
    saved_file = ""
    if videos and isinstance(videos[0], dict):
        saved_file = str(videos[0].get("local_path") or videos[0].get("output_path") or output_path or "")

    append_ledger_row(
        Path(args.ledger),
        purpose=args.purpose,
        account=str(final_res.get("account") or used_account),
        model=str(created.get("model") or args.model or "Seedance_2.5"),
        duration=created.get("duration") or args.duration or "",
        mode=str(created.get("mode") or args.mode or "auto"),
        task_id=task_id,
        credits=actual_credits,
        rework_reason=args.rework_reason or "",
        output_file=saved_file if status == "completed" else f"STATUS:{status}",
    )

    print(
        json.dumps(
            {
                "created": created,
                "final": final_res,
                "logged_credits": actual_credits,
                "ledger": str(Path(args.ledger)),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if status == "completed" else 2


def cmd_get(args: argparse.Namespace) -> int:
    task_id = (args.task_id or args.task_id_flag or "").strip()
    if not task_id:
        raise RuntimeError("get requires task_id.")
    tool_args: Dict[str, Any] = {"task_id": task_id}
    if args.account:
        tool_args["account"] = args.account
    if args.output:
        if args.output.lower().endswith(".mp4"):
            tool_args["output_path"] = str(Path(args.output).resolve())
        else:
            tool_args["download_dir"] = str(Path(args.output).resolve())
    res = call_xyq_tool("get_task", tool_args, env_path=Path(args.env))
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


def cmd_wait(args: argparse.Namespace) -> int:
    task_id = (args.task_id or args.task_id_flag or "").strip()
    if not task_id:
        raise RuntimeError("wait requires task_id.")
    output_path: Optional[str] = None
    download_dir: Optional[str] = None
    if args.output:
        if args.output.lower().endswith(".mp4"):
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            output_path = str(Path(args.output).resolve())
        else:
            Path(args.output).mkdir(parents=True, exist_ok=True)
            download_dir = str(Path(args.output).resolve())

    final_res = loop_wait_task(
        task_id=task_id,
        account=args.account,
        env_path=Path(args.env),
        slice_seconds=args.slice_seconds,
        interval_seconds=args.interval,
        max_wait_seconds=args.max_wait,
        output_path=output_path,
        download_dir=download_dir,
    )

    if args.purpose:
        status = str(final_res.get("status") or "").lower()
        cc = final_res.get("credit_consumption") or {}
        actual_credits = float(cc.get("actual_deduct_credits") or 0.0)
        videos = final_res.get("videos") or []
        saved_file = ""
        if videos and isinstance(videos[0], dict):
            saved_file = str(videos[0].get("local_path") or videos[0].get("output_path") or output_path or "")
        append_ledger_row(
            Path(args.ledger),
            purpose=args.purpose,
            account=str(final_res.get("account") or args.account or "default"),
            model=str(final_res.get("model") or ""),
            duration="",
            mode="wait_resume",
            task_id=task_id,
            credits=actual_credits,
            rework_reason=args.rework_reason or "",
            output_file=saved_file if status == "completed" else f"STATUS:{status}",
        )

    print(json.dumps(final_res, ensure_ascii=False, indent=2))
    return 0 if str(final_res.get("status") or "").lower() == "completed" else 2


def cmd_cancel(args: argparse.Namespace) -> int:
    task_id = (args.task_id or args.task_id_flag or "").strip()
    if not task_id:
        raise RuntimeError("cancel requires task_id.")
    tool_args: Dict[str, Any] = {"task_id": task_id}
    if args.account:
        tool_args["account"] = args.account
    if args.dry_run:
        print(json.dumps({"dry_run": True, "tool": "cancel_task", "arguments": tool_args}, ensure_ascii=False, indent=2))
        return 0
    res = call_xyq_tool("cancel_task", tool_args, env_path=Path(args.env))
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


def cmd_ledger(args: argparse.Namespace) -> int:
    summary = summarize_ledger(Path(args.ledger), prefix=args.purpose_prefix)
    cap = float(args.budget_limit)
    summary["budget_limit"] = cap
    summary["budget_remaining"] = round(cap - float(summary["prefix_credits_used"]), 3)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


# -------------------------- CLI Parser Setup --------------------------


def _add_common_flags(p: argparse.ArgumentParser) -> None:
    p.add_argument("--env", default=str(default_env_path()), help="Path to .env with MAGPIE_API_KEY / MAGPIE_URL")
    p.add_argument(
        "--account",
        default=default_account(),
        help="Account selector (Providers slot key, remark name, alias, key last-4, or 'options')",
    )
    p.add_argument("--dry-run", action="store_true", help="Validate/estimate only without mutating remote state")


def _add_video_generation_flags(p: argparse.ArgumentParser, require_purpose: bool = False) -> None:
    p.add_argument("--purpose", required=require_purpose, default="adhoc_shot_v1", help="Shot identifier for ledger & budget gate (e.g. ep01_s01_v1)")
    p.add_argument("--purpose-prefix", default=None, help="Prefix for per-film budget aggregation (auto-derived from --purpose if omitted)")
    p.add_argument("--ledger", default=str(default_ledger_path()), help="Path to credits_ledger.csv")
    p.add_argument("--budget-limit", type=float, default=default_budget_limit(), help="Credit budget cap for this purpose prefix (default: 3000)")
    p.add_argument("--max-reworks", type=int, default=3, help="Max paid reworks per base shot (default: 3 -> 4 total attempts)")
    p.add_argument("--rework-reason", default="", help="Reason recorded in ledger when reworking a shot")
    p.add_argument("--model", default="Seedance_2.5", choices=KNOWN_MODELS, help="XiaoYunQue model ID")
    p.add_argument("--mode", default=None, choices=("auto", "t2v", "first_last_frame", "reference", "edit", "extend"), help="Creation mode")
    p.add_argument("-d", "--duration", type=int, default=5, help="Output video duration in seconds")
    p.add_argument("--resolution", default=None, choices=("480p", "720p", "1080p", "4k"), help="Output resolution")
    p.add_argument("--aspect-ratio", default=None, choices=("adaptive", "16:9", "21:9", "9:16", "1:1", "4:3", "3:4"), help="Aspect ratio")
    audio_grp = p.add_mutually_exclusive_group()
    audio_grp.add_argument("--audio", dest="audio", action="store_true", default=None, help="Keep native audio generation")
    audio_grp.add_argument("--no-audio", dest="audio", action="store_false", help="Append XiaoYunQue silent prompt hint (audio=false)")
    p.add_argument("--seed", type=int, default=None, help="Random seed (not supported on happyhorse-1.1 or Seedance_1.0_fast)")
    p.add_argument("--first-frame", default=None, help="First frame local path, URL, or uploaded asset_id")
    p.add_argument("--last-frame", default=None, help="Last frame local path, URL, or uploaded asset_id")
    p.add_argument("-r", "--ref-image", action="append", default=[], help="Reference image path/URL/asset_id (repeatable: [@图片1], [@图片2], ...)")
    p.add_argument("--ref-video", action="append", default=[], help="Reference video path/URL/asset_id (repeatable: [@视频1], ...)")
    p.add_argument("--ref-audio", action="append", default=[], help="Reference audio path/URL/asset_id (repeatable: [@音频1], ...)")
    p.add_argument("--ref-video-duration", type=float, default=None, help="Total reference video seconds for accurate output_plus_reference estimation")
    p.add_argument("--draft-task-id", default=None, help="Upgrade an approved Seedance_2.5_draft render_task_id to final video")
    p.add_argument("-p", "--prompt", default=None, help="Video generation prompt")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="XiaoYunQue (小云雀 / Pippit CN) video generation CLI via Magpie MCP.")
    sub = parser.add_subparsers(dest="subcommand", required=True)

    # account
    p_acc = sub.add_parser("account", help="Query XiaoYunQue account balance(s) (0 credits)")
    _add_common_flags(p_acc)
    p_acc.add_argument("--all-accounts", action="store_true", help="List all configured accounts and balances")
    p_acc.set_defaults(func=cmd_account)

    # list-models / models
    for name in ("list-models", "models"):
        p_mod = sub.add_parser(name, help="List available XiaoYunQue video models (0 credits)")
        _add_common_flags(p_mod)
        p_mod.add_argument("--all", action="store_true", help="Include non-Seedance models (wan3.0, happyhorse-1.1)")
        p_mod.add_argument("--offline", action="store_true", help="Use built-in static schema table without network requests")
        p_mod.add_argument("--with-prices", action="store_true", help="Query live per-second pricing where supported")
        p_mod.set_defaults(func=cmd_list_models)

    # upload
    p_up = sub.add_parser("upload", help="Upload image to XiaoYunQue (bound to the selected account, 0 credits)")
    _add_common_flags(p_up)
    p_up.add_argument("source", nargs="?", default=None, help="Local image path or URL")
    p_up.add_argument("--file", default=None, help="Local image path")
    p_up.add_argument("--url", default=None, help="Remote image URL")
    p_up.add_argument("--filename", default=None, help="Optional filename override")
    p_up.set_defaults(func=cmd_upload)

    # estimate
    p_est = sub.add_parser("estimate", help="Estimate credits and verify local ledger budget gate (0 credits)")
    _add_common_flags(p_est)
    _add_video_generation_flags(p_est, require_purpose=False)
    p_est.set_defaults(func=cmd_estimate)

    # create
    p_crt = sub.add_parser("create", help="Check budget gate and submit create_video without waiting")
    _add_common_flags(p_crt)
    _add_video_generation_flags(p_crt, require_purpose=True)
    p_crt.add_argument("--wait-seconds", type=int, default=0, help="Optional initial wait inside create_video (0..40)")
    p_crt.set_defaults(func=cmd_create)

    # generate
    p_gen = sub.add_parser("generate", help="Estimate -> budget gate -> create -> auto-loop wait -> download MP4 -> log CSV")
    _add_common_flags(p_gen)
    _add_video_generation_flags(p_gen, require_purpose=True)
    p_gen.add_argument("--wait-seconds", type=int, default=0, help="Optional initial wait inside create_video (0..40)")
    p_gen.add_argument("--slice-seconds", type=int, default=40, help="Per-call wait_task timeout (<=45s, default 40)")
    p_gen.add_argument("--interval", type=int, default=5, help="Poll interval seconds inside wait_task (default 5)")
    p_gen.add_argument("--max-wait", type=int, default=900, help="Total CLI wait cap across looped slices (default 900s)")
    p_gen.add_argument("-o", "--output", default=None, help="Output .mp4 path or directory (default: $XYQ_OUTPUT or ./clips_raw)")
    p_gen.set_defaults(func=cmd_generate)

    # get
    p_get = sub.add_parser("get", help="Single non-blocking get_task query (0 credits)")
    _add_common_flags(p_get)
    p_get.add_argument("task_id", nargs="?", default=None, help="Task ID (<thread_id>:<run_id>)")
    p_get.add_argument("--task-id", dest="task_id_flag", default=None, help="Task ID (<thread_id>:<run_id>)")
    p_get.add_argument("-o", "--output", default=None, help="Optional .mp4 path or directory to download if completed")
    p_get.set_defaults(func=cmd_get)

    # wait
    p_wait = sub.add_parser("wait", help="Auto-loop wait_task (<=45s slices) until terminal state and download MP4")
    _add_common_flags(p_wait)
    p_wait.add_argument("task_id", nargs="?", default=None, help="Task ID (<thread_id>:<run_id>)")
    p_wait.add_argument("--task-id", dest="task_id_flag", default=None, help="Task ID (<thread_id>:<run_id>)")
    p_wait.add_argument("--slice-seconds", type=int, default=40, help="Per-call wait_task timeout (1..45s, default 40)")
    p_wait.add_argument("--interval", type=int, default=5, help="Poll interval seconds inside wait_task (default 5)")
    p_wait.add_argument("--max-wait", type=int, default=900, help="Total CLI wait cap across looped slices (default 900s)")
    p_wait.add_argument("-o", "--output", default=None, help="Optional .mp4 path or directory to download when completed")
    p_wait.add_argument("--purpose", default=None, help="If set, append final result to credits_ledger.csv")
    p_wait.add_argument("--ledger", default=str(default_ledger_path()), help="Path to credits_ledger.csv")
    p_wait.add_argument("--rework-reason", default="", help="Optional rework note when logging to ledger")
    p_wait.set_defaults(func=cmd_wait)

    # cancel
    p_can = sub.add_parser("cancel", help="Cancel a queued or running video task")
    _add_common_flags(p_can)
    p_can.add_argument("task_id", nargs="?", default=None, help="Task ID (<thread_id>:<run_id>)")
    p_can.add_argument("--task-id", dest="task_id_flag", default=None, help="Task ID (<thread_id>:<run_id>)")
    p_can.set_defaults(func=cmd_cancel)

    # ledger
    p_led = sub.add_parser("ledger", help="Summarize local credits_ledger.csv (offline, 0 credits)")
    p_led.add_argument("--ledger", default=str(default_ledger_path()), help="Path to credits_ledger.csv")
    p_led.add_argument("--purpose-prefix", default=os.environ.get("XYQ_PURPOSE_PREFIX", ""), help="Filter by purpose prefix")
    p_led.add_argument("--budget-limit", type=float, default=default_budget_limit(), help="Budget cap for remaining calculation")
    p_led.set_defaults(func=cmd_ledger)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return int(args.func(args))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
