#!/usr/bin/env python3
"""Quick local test for Senko diarization + transcript speaker alignment."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, help="Path to meeting audio (WAV preferred).")
    parser.add_argument(
        "--transcript",
        required=True,
        help="Path to transcript JSON with segments: [{\"start\":..,\"end\":..,\"text\":\"...\"}]",
    )
    parser.add_argument(
        "--python",
        default=sys.executable,
        help="Python executable to run meetings_diarize.py (defaults to current interpreter).",
    )
    return parser.parse_args()


def overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def assign_speakers(
    transcript_segments: list[dict[str, Any]],
    diarization_segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    assigned: list[dict[str, Any]] = []
    for segment in transcript_segments:
        start = float(segment.get("start", 0.0))
        end = max(start, float(segment.get("end", start)))
        scores: dict[str, float] = {}
        for diar in diarization_segments:
            speaker = str(diar.get("speaker", "")).strip()
            if not speaker:
                continue
            value = overlap(start, end, float(diar["start"]), float(diar["end"]))
            if value <= 0.0:
                continue
            scores[speaker] = scores.get(speaker, 0.0) + value
        speaker = max(scores.items(), key=lambda item: item[1])[0] if scores else None
        enriched = dict(segment)
        enriched["speaker_id"] = speaker
        assigned.append(enriched)
    return assigned


def main() -> int:
    args = parse_args()
    root = Path(__file__).resolve().parents[1]
    diarize_script = root / "scripts" / "meetings_diarize.py"
    if not diarize_script.exists():
        raise FileNotFoundError(f"Missing script: {diarize_script}")

    transcript_path = Path(args.transcript).expanduser().resolve()
    audio_path = Path(args.audio).expanduser().resolve()
    transcript_data = json.loads(transcript_path.read_text())
    if isinstance(transcript_data, dict):
        transcript_segments = transcript_data.get("segments", [])
    else:
        transcript_segments = transcript_data
    if not isinstance(transcript_segments, list):
        raise ValueError("Transcript JSON must be a list or object with `segments` list.")

    completed = subprocess.run(
        [
            args.python,
            str(diarize_script),
            "--input",
            str(audio_path),
            "--device",
            "auto",
            "--quiet",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        print(completed.stderr.strip() or completed.stdout.strip(), file=sys.stderr)
        return completed.returncode

    diarization = json.loads(completed.stdout)
    diarization_segments = diarization.get("merged_segments", [])
    if not isinstance(diarization_segments, list):
        diarization_segments = []

    assigned_segments = assign_speakers(transcript_segments, diarization_segments)
    payload = {
        "diarization_segment_count": len(diarization_segments),
        "assigned_segment_count": len(assigned_segments),
        "segments": assigned_segments,
    }
    print(json.dumps(payload, indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
