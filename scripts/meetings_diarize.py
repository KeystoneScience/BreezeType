#!/usr/bin/env python3
"""Run Senko diarization on a 16 kHz mono WAV input and emit compact JSON."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Path to 16 kHz mono WAV file.")
    parser.add_argument(
        "--device",
        default="auto",
        help="Senko device (auto/cpu/cuda/mps). Defaults to auto.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Silence Senko logging output.",
    )
    return parser.parse_args()


def _normalize_segments(raw_segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for segment in raw_segments:
        speaker = str(segment.get("speaker", "")).strip()
        if not speaker:
            continue
        start = float(segment.get("start", 0.0))
        end = float(segment.get("end", start))
        if end < start:
            start, end = end, start
        if end - start <= 0.0:
            continue
        normalized.append({"start": start, "end": end, "speaker": speaker})
    return normalized


def main() -> int:
    args = _parse_args()
    input_path = Path(args.input).expanduser().resolve()
    if not input_path.is_file():
        print(
            json.dumps({"error": f"Input audio not found: {input_path}"}),
            file=sys.stderr,
        )
        return 2

    try:
        import senko  # type: ignore
    except Exception as exc:  # pragma: no cover
        print(
            json.dumps({"error": f"Failed to import senko: {exc}"}),
            file=sys.stderr,
        )
        return 3

    try:
        diarizer = senko.Diarizer(
            device=args.device,
            warmup=True,
            quiet=bool(args.quiet),
        )
        result = diarizer.diarize(str(input_path))
        if not isinstance(result, dict):
            result = {}
        merged = result.get("merged_segments", [])
        if not isinstance(merged, list):
            merged = []
        payload = {"merged_segments": _normalize_segments(merged)}
        print(json.dumps(payload, ensure_ascii=True))
        return 0
    except Exception as exc:  # pragma: no cover
        print(
            json.dumps({"error": f"Senko diarization failed: {exc}"}),
            file=sys.stderr,
        )
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
