#!/usr/bin/env python3
"""QA inspector for XiaoYunQue raw video clips (qa_clip.py).

For each MP4/MOV clip (single file or directory), produces:
  1. <stem>_strip3.jpg          Start / Mid / End 3-frame horizontal strip
  2. <stem>_first_last_full.jpg Full-resolution [First | Last | Diff] comparison
  3. JSON summary with ffprobe metadata, audio-stream presence check,
     inter-frame motion via `ffmpeg -vf tblend=all_mode=difference,signalstats`,
     and anomaly flags (NEAR_STATIC_STILL_FRAME, HIGH_MOTION_OR_CAMERA_MOVE,
     SUBJECT_GROWTH_OR_BLOOMING, HAS_AUDIO_STREAM).

Uses numpy + Pillow when available and falls back to pure ffmpeg filtergraphs otherwise.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List

try:
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    HAS_NUMPY_PIL = True
except Exception:
    HAS_NUMPY_PIL = False


def probe_clip(clip_path: Path) -> Dict[str, Any]:
    raw = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,width,height,r_frame_rate,duration,nb_frames:format=duration",
            "-of",
            "json",
            str(clip_path),
        ],
        text=True,
    )
    info = json.loads(raw)
    streams = info.get("streams") or []
    v_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not v_stream:
        raise RuntimeError(f"No video stream found in {clip_path}")
    has_audio = any(s.get("codec_type") == "audio" for s in streams)

    dur_str = v_stream.get("duration") or (info.get("format") or {}).get("duration") or "0"
    duration_s = float(dur_str)
    fps_str = v_stream.get("r_frame_rate") or "24/1"
    if "/" in fps_str:
        num, den = fps_str.split("/", 1)
        fps = float(num) / max(float(den), 1.0)
    else:
        fps = float(fps_str)

    return {
        "width": int(v_stream["width"]),
        "height": int(v_stream["height"]),
        "fps": round(fps, 3),
        "duration_s": round(duration_s, 3),
        "nb_frames": int(v_stream["nb_frames"]) if v_stream.get("nb_frames") else None,
        "has_audio_stream": has_audio,
    }


def measure_tblend_motion(clip_path: Path) -> Dict[str, float]:
    out = subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "info",
            "-i",
            str(clip_path),
            "-vf",
            "tblend=all_mode=difference,signalstats,metadata=print:file=-",
            "-f",
            "null",
            "-",
        ],
        stderr=subprocess.STDOUT,
        text=True,
    )
    yavgs: List[float] = []
    for line in out.splitlines():
        if "lavfi.signalstats.YAVG=" in line:
            try:
                yavgs.append(float(line.split("=", 1)[1].strip()))
            except ValueError:
                pass
    if not yavgs:
        return {"step_yavg_mean": 0.0, "step_yavg_p95": 0.0, "step_yavg_max": 0.0}
    yavgs_sorted = sorted(yavgs)
    p95_idx = min(len(yavgs_sorted) - 1, int(round(0.95 * (len(yavgs_sorted) - 1))))
    return {
        "step_yavg_mean": round(sum(yavgs) / len(yavgs), 3),
        "step_yavg_p95": round(yavgs_sorted[p95_idx], 3),
        "step_yavg_max": round(yavgs_sorted[-1], 3),
    }


def extract_frame_png(clip_path: Path, t_sec: float, dst_png: Path, fallback_eof: bool = False) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-ss",
            f"{max(0.0, t_sec):.3f}",
            "-i",
            str(clip_path),
            "-frames:v",
            "1",
            str(dst_png),
        ],
        check=True,
    )
    if not dst_png.is_file() and fallback_eof:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-sseof",
                "-0.5",
                "-i",
                str(clip_path),
                "-update",
                "1",
                str(dst_png),
            ],
            check=True,
        )


def inspect_one_clip(clip_path: Path, out_dir: Path) -> Dict[str, Any]:
    meta = probe_clip(clip_path)
    motion = measure_tblend_motion(clip_path)
    dur = max(0.2, float(meta["duration_s"]))
    frame_step = 1.0 / max(float(meta.get("fps") or 24.0), 1.0)
    t_first = min(0.05, dur * 0.05)
    t_mid = dur * 0.50
    t_last = max(0.0, dur - max(0.10, frame_step * 1.5))

    strip3_jpg = out_dir / f"{clip_path.stem}_strip3.jpg"
    fl_jpg = out_dir / f"{clip_path.stem}_first_last_full.jpg"
    flags: List[str] = []
    pixel_stats: Dict[str, Any] = {}

    with tempfile.TemporaryDirectory(prefix="xyq_qa_") as td:
        td_path = Path(td)
        p0 = td_path / "f0.png"
        pm = td_path / "fm.png"
        p1 = td_path / "f1.png"
        extract_frame_png(clip_path, t_first, p0)
        extract_frame_png(clip_path, t_mid, pm)
        extract_frame_png(clip_path, t_last, p1, fallback_eof=True)

        if HAS_NUMPY_PIL:
            im0 = Image.open(p0).convert("RGB")
            imm = Image.open(pm).convert("RGB")
            im1 = Image.open(p1).convert("RGB")
            w, h = im0.size

            strip = Image.new("RGB", (w * 3, h))
            strip.paste(im0, (0, 0))
            strip.paste(imm, (w, 0))
            strip.paste(im1, (w * 2, 0))
            strip.save(strip3_jpg, quality=90)

            a0 = np.asarray(im0, dtype=np.int16)
            a1 = np.asarray(im1, dtype=np.int16)
            diff = np.abs(a1 - a0)
            diff_vis = np.clip(diff * 4, 0, 255).astype(np.uint8)

            comp = Image.new("RGB", (w * 3, h))
            comp.paste(im0, (0, 0))
            comp.paste(im1, (w, 0))
            comp.paste(Image.fromarray(diff_vis), (w * 2, 0))
            comp.save(fl_jpg, quality=90)

            changed_mask = np.max(diff, axis=2) > 20
            changed_pct = float(np.mean(changed_mask) * 100.0)
            cy0, cy1 = int(h * 0.2), int(h * 0.8)
            cx0, cx1 = int(w * 0.2), int(w * 0.8)
            center_pct = float(np.mean(changed_mask[cy0:cy1, cx0:cx1]) * 100.0)
            border_mask = np.ones_like(changed_mask, dtype=bool)
            border_mask[cy0:cy1, cx0:cx1] = False
            border_pct = float(np.mean(changed_mask[border_mask]) * 100.0) if np.any(border_mask) else 0.0

            pixel_stats = {
                "changed_px_pct": round(changed_pct, 2),
                "center_changed_pct": round(center_pct, 2),
                "border_changed_pct": round(border_pct, 2),
            }
            if motion["step_yavg_mean"] < 0.30 and changed_pct < 15.0:
                flags.append("NEAR_STATIC_STILL_FRAME")
            if motion["step_yavg_mean"] > 4.5 or (border_pct > 55.0 and motion["step_yavg_mean"] > 2.5):
                flags.append("HIGH_MOTION_OR_CAMERA_MOVE")
            if motion["step_yavg_mean"] < 1.2 and center_pct > 35.0 and border_pct < 15.0:
                flags.append("SUBJECT_GROWTH_OR_BLOOMING")
        else:
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", str(p0), "-i", str(pm), "-i", str(p1), "-filter_complex", "hstack=inputs=3", str(strip3_jpg)],
                check=True,
            )
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-v",
                    "error",
                    "-i",
                    str(p0),
                    "-i",
                    str(p1),
                    "-filter_complex",
                    "[0:v][1:v]blend=all_mode=difference[df];[0:v][1:v][df]hstack=inputs=3",
                    str(fl_jpg),
                ],
                check=True,
            )
            if motion["step_yavg_mean"] < 0.30:
                flags.append("NEAR_STATIC_STILL_FRAME")
            if motion["step_yavg_mean"] > 4.5:
                flags.append("HIGH_MOTION_OR_CAMERA_MOVE")

    if meta["has_audio_stream"]:
        flags.append("HAS_AUDIO_STREAM")

    return {
        "clip": str(clip_path),
        "strip3": str(strip3_jpg),
        "first_last_full": str(fl_jpg),
        **meta,
        **motion,
        **pixel_stats,
        "flags": flags,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Frame & motion QA inspector for XiaoYunQue video clips.")
    parser.add_argument("target", help="Single .mp4/.mov file or directory containing clips")
    parser.add_argument("-o", "--out-dir", default="./qa_out", help="Directory for QA contact sheets")
    args = parser.parse_args()

    target = Path(args.target)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if target.is_file():
        clips = [target]
    elif target.is_dir():
        clips = sorted(p for p in target.iterdir() if p.suffix.lower() in (".mp4", ".mov", ".mkv", ".webm"))
    else:
        print(json.dumps({"error": f"Path not found: {target}"}), file=sys.stderr)
        return 1

    results = [inspect_one_clip(c, out_dir) for c in clips]
    print(json.dumps({"count": len(results), "results": results}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
