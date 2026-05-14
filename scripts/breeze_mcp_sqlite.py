#!/usr/bin/env python3

import json
import sqlite3
import sys
from pathlib import Path

PREVIEW_CHARS = 420
TRANSCRIPT_PREVIEW_CHARS = 720


def compact_text(value: str | None, limit: int) -> str:
    if not value:
        return ""
    normalized = " ".join(str(value).split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1] + "…"


def open_db(db_path: str) -> sqlite3.Connection:
    path = Path(db_path).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"SQLite database not found: {path}")
    connection = sqlite3.connect(
        f"file:{path.as_posix()}?mode=ro",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    return connection


def meeting_tags(connection: sqlite3.Connection, meeting_id: int) -> list[str]:
    rows = connection.execute(
        """
        SELECT tags.name
        FROM meeting_tags
        JOIN tags ON tags.id = meeting_tags.tag_id
        WHERE meeting_tags.meeting_id = ?
        ORDER BY tags.name COLLATE NOCASE
        """,
        (meeting_id,),
    ).fetchall()
    return [row["name"] for row in rows]


def meeting_participants(connection: sqlite3.Connection, meeting_id: int) -> list[dict]:
    rows = connection.execute(
        """
        SELECT participants.id, participants.name, participants.email, participants.phone
        FROM meeting_participants
        JOIN participants ON participants.id = meeting_participants.participant_id
        WHERE meeting_participants.meeting_id = ?
        ORDER BY participants.name COLLATE NOCASE
        """,
        (meeting_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "email": row["email"],
            "phone": row["phone"],
        }
        for row in rows
    ]


def meeting_notes(connection: sqlite3.Connection, meeting_id: int) -> list[dict]:
    rows = connection.execute(
        """
        SELECT
            id,
            meeting_id,
            offset_seconds,
            start_offset_seconds,
            end_offset_seconds,
            created_at,
            text
        FROM meeting_notes
        WHERE meeting_id = ?
        ORDER BY start_offset_seconds ASC, offset_seconds ASC, created_at ASC
        """,
        (meeting_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "meeting_id": row["meeting_id"],
            "offset_seconds": row["offset_seconds"],
            "start_offset_seconds": row["start_offset_seconds"],
            "end_offset_seconds": row["end_offset_seconds"],
            "created_at": row["created_at"],
            "text": row["text"],
        }
        for row in rows
    ]


def history_recent(connection: sqlite3.Connection, payload: dict) -> dict:
    limit = max(1, min(int(payload.get("limit", 25)), 100))
    rows = connection.execute(
        """
        SELECT
            id,
            timestamp,
            title,
            saved,
            COALESCE(NULLIF(post_processed_text, ''), transcription_text) AS text,
            source_app_name,
            source_app_identifier,
            source_window_title,
            source_browser_tab_title,
            source_browser_tab_url,
            audio_duration_seconds
        FROM transcription_history
        WHERE deleted_at IS NULL
        ORDER BY timestamp DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return {
        "entries": [
            {
                "id": row["id"],
                "timestamp": row["timestamp"],
                "title": row["title"],
                "saved": bool(row["saved"]),
                "text_preview": compact_text(row["text"], PREVIEW_CHARS),
                "source_app_name": row["source_app_name"],
                "source_app_identifier": row["source_app_identifier"],
                "source_window_title": row["source_window_title"],
                "source_browser_tab_title": row["source_browser_tab_title"],
                "source_browser_tab_url": row["source_browser_tab_url"],
                "audio_duration_seconds": row["audio_duration_seconds"],
            }
            for row in rows
        ]
    }


def history_entry(connection: sqlite3.Connection, payload: dict) -> dict:
    entry_id = int(payload["id"])
    row = connection.execute(
        """
        SELECT
            id,
            file_name,
            timestamp,
            saved,
            title,
            transcription_text,
            post_processed_text,
            post_process_prompt,
            source_app_name,
            source_app_identifier,
            source_window_title,
            source_process_id,
            source_browser_tab_title,
            source_browser_tab_url,
            audio_duration_seconds
        FROM transcription_history
        WHERE deleted_at IS NULL AND id = ?
        """,
        (entry_id,),
    ).fetchone()
    return {"entry": None if row is None else dict(row)}


def history_search(connection: sqlite3.Connection, payload: dict) -> dict:
    query = str(payload.get("query", "")).strip()
    if not query:
        return {"entries": []}
    limit = max(1, min(int(payload.get("limit", 20)), 100))
    pattern = f"%{query}%"
    rows = connection.execute(
        """
        SELECT
            id,
            timestamp,
            title,
            saved,
            COALESCE(NULLIF(post_processed_text, ''), transcription_text) AS text,
            source_app_name,
            source_app_identifier,
            source_window_title,
            source_browser_tab_title,
            source_browser_tab_url,
            audio_duration_seconds
        FROM transcription_history
        WHERE deleted_at IS NULL
          AND (
            title LIKE ? COLLATE NOCASE
            OR transcription_text LIKE ? COLLATE NOCASE
            OR COALESCE(post_processed_text, '') LIKE ? COLLATE NOCASE
            OR COALESCE(source_app_name, '') LIKE ? COLLATE NOCASE
            OR COALESCE(source_window_title, '') LIKE ? COLLATE NOCASE
            OR COALESCE(source_browser_tab_title, '') LIKE ? COLLATE NOCASE
            OR COALESCE(source_browser_tab_url, '') LIKE ? COLLATE NOCASE
          )
        ORDER BY timestamp DESC
        LIMIT ?
        """,
        (pattern, pattern, pattern, pattern, pattern, pattern, pattern, limit),
    ).fetchall()
    return {
        "entries": [
            {
                "id": row["id"],
                "timestamp": row["timestamp"],
                "title": row["title"],
                "saved": bool(row["saved"]),
                "text_preview": compact_text(row["text"], PREVIEW_CHARS),
                "source_app_name": row["source_app_name"],
                "source_app_identifier": row["source_app_identifier"],
                "source_window_title": row["source_window_title"],
                "source_browser_tab_title": row["source_browser_tab_title"],
                "source_browser_tab_url": row["source_browser_tab_url"],
                "audio_duration_seconds": row["audio_duration_seconds"],
            }
            for row in rows
        ]
    }


def meetings_recent(connection: sqlite3.Connection, payload: dict) -> dict:
    limit = max(1, min(int(payload.get("limit", 20)), 100))
    rows = connection.execute(
        """
        SELECT
            id,
            sync_id,
            name,
            started_at,
            ended_at,
            duration_seconds,
            file_name,
            include_system_audio,
            COALESCE(updated_at, ended_at, started_at) AS updated_at,
            COALESCE(is_visible, 1) AS is_visible
        FROM meetings
        WHERE deleted_at IS NULL
        ORDER BY ended_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    meetings = []
    for row in rows:
        meetings.append(
            {
                "id": row["id"],
                "sync_id": row["sync_id"],
                "name": row["name"],
                "started_at": row["started_at"],
                "ended_at": row["ended_at"],
                "duration_seconds": row["duration_seconds"],
                "file_name": row["file_name"],
                "include_system_audio": bool(row["include_system_audio"]),
                "updated_at": row["updated_at"],
                "is_visible": bool(row["is_visible"]),
                "tags": meeting_tags(connection, row["id"]),
            }
        )
    return {"meetings": meetings}


def meeting_entry(connection: sqlite3.Connection, payload: dict) -> dict:
    meeting_id = int(payload["id"])
    row = connection.execute(
        """
        SELECT
            id,
            sync_id,
            name,
            started_at,
            ended_at,
            duration_seconds,
            file_name,
            include_system_audio,
            deleted_at,
            COALESCE(updated_at, ended_at, started_at) AS updated_at,
            COALESCE(is_visible, 1) AS is_visible,
            cloud_audio_key,
            cloud_audio_uploaded_at
        FROM meetings
        WHERE id = ?
        """,
        (meeting_id,),
    ).fetchone()
    if row is None:
        return {"meeting": None}
    meeting = dict(row)
    meeting["include_system_audio"] = bool(meeting["include_system_audio"])
    meeting["is_visible"] = bool(meeting["is_visible"])
    meeting["tags"] = meeting_tags(connection, meeting_id)
    meeting["participants"] = meeting_participants(connection, meeting_id)
    meeting["notes"] = meeting_notes(connection, meeting_id)
    return {"meeting": meeting}


def meeting_transcript(connection: sqlite3.Connection, payload: dict) -> dict:
    meeting_id = int(payload["id"])
    meeting_row = connection.execute(
        "SELECT name FROM meetings WHERE id = ?",
        (meeting_id,),
    ).fetchone()
    transcript_row = connection.execute(
        """
        SELECT transcript_text, segments_json
        FROM meeting_transcripts
        WHERE meeting_id = ?
        """,
        (meeting_id,),
    ).fetchone()
    if meeting_row is None:
        return {"transcript": None}
    segments = []
    text = ""
    if transcript_row is not None:
        text = transcript_row["transcript_text"] or ""
        raw_segments = transcript_row["segments_json"] or "[]"
        try:
            segments = json.loads(raw_segments)
        except json.JSONDecodeError:
            segments = []
    return {
        "transcript": {
            "meeting_id": meeting_id,
            "meeting_name": meeting_row["name"],
            "text": text,
            "text_preview": compact_text(text, TRANSCRIPT_PREVIEW_CHARS),
            "segments": segments,
        }
    }


def meetings_search(connection: sqlite3.Connection, payload: dict) -> dict:
    query = str(payload.get("query", "")).strip()
    if not query:
        return {"meetings": []}
    limit = max(1, min(int(payload.get("limit", 20)), 100))
    include_transcript = bool(payload.get("includeTranscript", False))
    pattern = f"%{query}%"
    rows = connection.execute(
        """
        SELECT DISTINCT
            m.id,
            m.sync_id,
            m.name,
            m.started_at,
            m.ended_at,
            m.duration_seconds,
            m.file_name,
            m.include_system_audio,
            COALESCE(m.updated_at, m.ended_at, m.started_at) AS updated_at,
            COALESCE(m.is_visible, 1) AS is_visible,
            mt.transcript_text
        FROM meetings m
        LEFT JOIN meeting_transcripts mt ON mt.meeting_id = m.id
        WHERE m.deleted_at IS NULL
          AND (
            m.name LIKE ? COLLATE NOCASE
            OR EXISTS (
                SELECT 1
                FROM meeting_transcripts sub_mt
                WHERE sub_mt.meeting_id = m.id
                  AND sub_mt.transcript_text LIKE ? COLLATE NOCASE
            )
            OR EXISTS (
                SELECT 1
                FROM meeting_notes notes
                WHERE notes.meeting_id = m.id
                  AND notes.text LIKE ? COLLATE NOCASE
            )
            OR EXISTS (
                SELECT 1
                FROM meeting_tags link
                JOIN tags ON tags.id = link.tag_id
                WHERE link.meeting_id = m.id
                  AND tags.name LIKE ? COLLATE NOCASE
            )
            OR EXISTS (
                SELECT 1
                FROM meeting_participants link
                JOIN participants ON participants.id = link.participant_id
                WHERE link.meeting_id = m.id
                  AND participants.name LIKE ? COLLATE NOCASE
            )
          )
        ORDER BY m.ended_at DESC
        LIMIT ?
        """,
        (pattern, pattern, pattern, pattern, pattern, limit),
    ).fetchall()
    meetings = []
    for row in rows:
        item = {
            "id": row["id"],
            "sync_id": row["sync_id"],
            "name": row["name"],
            "started_at": row["started_at"],
            "ended_at": row["ended_at"],
            "duration_seconds": row["duration_seconds"],
            "file_name": row["file_name"],
            "include_system_audio": bool(row["include_system_audio"]),
            "updated_at": row["updated_at"],
            "is_visible": bool(row["is_visible"]),
            "tags": meeting_tags(connection, row["id"]),
        }
        if include_transcript:
            item["transcript_preview"] = compact_text(
                row["transcript_text"], TRANSCRIPT_PREVIEW_CHARS
            )
        meetings.append(item)
    return {"meetings": meetings}


COMMANDS = {
    "history_recent": history_recent,
    "history_entry": history_entry,
    "history_search": history_search,
    "meetings_recent": meetings_recent,
    "meeting_entry": meeting_entry,
    "meeting_transcript": meeting_transcript,
    "meetings_search": meetings_search,
}


def main() -> int:
    if len(sys.argv) != 4:
        print(
            json.dumps(
                {
                    "error": "Expected usage: breeze_mcp_sqlite.py <command> <db_path> <payload_json>"
                }
            ),
            file=sys.stderr,
        )
        return 2

    command = sys.argv[1]
    db_path = sys.argv[2]
    payload = json.loads(sys.argv[3])
    if command not in COMMANDS:
        print(json.dumps({"error": f"Unsupported command: {command}"}), file=sys.stderr)
        return 2

    try:
        with open_db(db_path) as connection:
            result = COMMANDS[command](connection, payload)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
