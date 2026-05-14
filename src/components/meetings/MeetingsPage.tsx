import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { type as getOsType } from "@tauri-apps/plugin-os";
import {
  checkMicrophonePermission,
  checkScreenRecordingPermission,
  requestMicrophonePermission,
  requestScreenRecordingPermission,
} from "tauri-plugin-macos-permissions-api";
import {
  ArrowLeft,
  Clock3,
  Cloud,
  Copy,
  Download,
  Filter,
  Link2,
  Loader2,
  Mail,
  Maximize2,
  Mic,
  MoreHorizontal,
  NotepadText,
  Pause,
  Play,
  RotateCcw,
  Search,
  Send,
  Share2,
  ShieldCheck,
  Square,
  Tag,
  Trash2,
  Users,
  UserPlus,
  X,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  commands,
  type ActiveMeetingInfo,
  type CreateMeetingParticipantRequest,
  type DeletedMeetingEntry,
  type MeetingEntry,
  type MeetingDiarizationStatus,
  type MeetingNote,
  type MeetingParticipant,
  type MeetingSpeakerMapping,
  type MeetingTranscript,
  type UpdateMeetingSpeakerMappingRequest,
  type UpdateMeetingTranscriptSpeakerRequest,
} from "@/bindings";
import { useAuthStore } from "@/stores/authStore";
import { getServerUrl } from "@/lib/serverApi";
import {
  disablePublicMeetingShare,
  enablePublicMeetingShare,
  fetchMeetingShares,
  revokeMeetingShare,
  shareMeetingToEmail,
  type MeetingPublicShare,
  type MeetingUserShare,
} from "@/lib/meetingShareApi";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal, MODAL_TRANSITION_MS } from "../ui/Modal";
import MeetingListCard from "./MeetingListCard";
import {
  formatDateTime,
  formatFutureRelativeTime,
  formatRelativeTime,
} from "@/utils/dateFormat";

const tokenize = (value: string) => value.split(/[^a-z0-9]+/).filter(Boolean);
const NO_TRANSCRIPT_SEGMENTS_DIARIZATION_ERROR =
  "Transcript has no segments to diarize";

const normalizeTag = (value: string) =>
  value.trim().replace(/\s+/g, " ").toUpperCase();

const transcriptHasSpokenContent = (transcript: MeetingTranscript | null) =>
  Boolean(
    transcript?.segments?.some((segment) => segment.text.trim().length > 0) ||
      transcript?.text?.trim().length,
  );

const normalizeDiarizationStatus = (status: MeetingDiarizationStatus) => {
  if (
    !status.error_message?.includes(NO_TRANSCRIPT_SEGMENTS_DIARIZATION_ERROR)
  ) {
    return status;
  }

  return {
    ...status,
    status: "idle",
    started_at: null,
    completed_at: null,
    error_message: null,
  };
};

const maxAllowedDistance = (length: number) => {
  if (length <= 4) return 1;
  if (length <= 7) return 2;
  return 3;
};

const boundedLevenshtein = (a: string, b: string, maxDistance: number) => {
  const lengthA = a.length;
  const lengthB = b.length;
  if (Math.abs(lengthA - lengthB) > maxDistance) return maxDistance + 1;

  const previous = Array(lengthB + 1).fill(0);
  const current = Array(lengthB + 1).fill(0);
  for (let j = 0; j <= lengthB; j += 1) {
    previous[j] = j;
  }

  for (let i = 1; i <= lengthA; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    const charA = a[i - 1];

    for (let j = 1; j <= lengthB; j += 1) {
      const cost = charA === b[j - 1] ? 0 : 1;
      const deletion = previous[j] + 1;
      const insertion = current[j - 1] + 1;
      const substitution = previous[j - 1] + cost;
      const value = Math.min(deletion, insertion, substitution);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > maxDistance) return maxDistance + 1;

    for (let j = 0; j <= lengthB; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[lengthB];
};

const fuzzyMatch = (text: string, query: string): boolean => {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return true;

  const normalizedText = text.toLowerCase();
  const words = tokenize(normalizedText);
  const tokens = tokenize(normalizedQuery);

  return tokens.every((token) => {
    if (token.length <= 2) {
      return words.some((word) => word.startsWith(token));
    }

    if (normalizedText.includes(token)) return true;

    const maxDistance = maxAllowedDistance(token.length);
    return words.some((word) => {
      if (Math.abs(word.length - token.length) > maxDistance) return false;
      return boundedLevenshtein(token, word, maxDistance) <= maxDistance;
    });
  });
};

const scoreTextMatch = (text: string, query: string): number => {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return 0;

  const normalizedText = text.toLowerCase();
  const words = tokenize(normalizedText);
  const tokens = tokenize(normalizedQuery);
  if (tokens.length === 0) return 0;

  let score = 0;
  for (const token of tokens) {
    if (token.length <= 2) {
      const matched = words.some((word) => word.startsWith(token));
      if (!matched) return 0;
      score += 2;
      continue;
    }

    if (normalizedText.includes(token)) {
      score += 3;
      continue;
    }

    const maxDistance = maxAllowedDistance(token.length);
    const matched = words.some((word) => {
      if (Math.abs(word.length - token.length) > maxDistance) return false;
      return boundedLevenshtein(token, word, maxDistance) <= maxDistance;
    });

    if (!matched) return 0;
    score += 1;
  }

  return score;
};

const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  const padded = (value: number) => value.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${padded(minutes)}:${padded(remaining)}`;
  }
  return `${minutes}:${padded(remaining)}`;
};

const formatNoteTimestamp = (seconds: number) =>
  formatDuration(
    Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0,
  );

const getNoteRange = (note: MeetingNote) => {
  const start = Number.isFinite(note.start_offset_seconds)
    ? Math.max(0, note.start_offset_seconds)
    : Math.max(0, note.offset_seconds);
  const end = Number.isFinite(note.end_offset_seconds)
    ? Math.max(start, note.end_offset_seconds)
    : start;
  return { start, end };
};

const formatNoteRange = (note: MeetingNote) => {
  const { start, end } = getNoteRange(note);
  if (Math.abs(end - start) < 1) {
    return formatNoteTimestamp(start);
  }
  return `${formatNoteTimestamp(start)}-${formatNoteTimestamp(end)}`;
};

const formatNoteCreatedAt = (timestamp: number, language: string) => {
  const seconds = Number.isFinite(timestamp)
    ? Math.max(0, Math.round(timestamp))
    : 0;
  const raw = String(seconds);
  return {
    relative: formatRelativeTime(raw, language),
    absolute: formatDateTime(raw, language),
  };
};

type MeetingLiveTranscriptUpdate = {
  meeting_id: number;
  transcript: MeetingTranscript;
};

const LIVE_TRANSCRIPT_POLL_INTERVAL_MS = 1000;
const DELETE_FADE_MS = 260;
const PERMANENT_DELETE_COMMIT_DELAY_MS = 5000;
const DIARIZATION_STATUS_POLL_MS = 2000;
const TRANSCRIPT_PROCESSING_RETRY_MS = 2000;
const TRANSCRIPT_PROCESSING_MAX_ATTEMPTS = 90;
const SPEAKER_CHIP_COLORS = [
  "#0EA5E9",
  "#22C55E",
  "#F59E0B",
  "#EC4899",
  "#A855F7",
  "#14B8A6",
  "#F97316",
  "#6366F1",
];

const liveTranscriptSnapshotsMatch = (
  left: MeetingTranscript,
  right: MeetingTranscript,
) => {
  if (
    left.text !== right.text ||
    left.segments.length !== right.segments.length
  ) {
    return false;
  }

  const leftLast = left.segments[left.segments.length - 1];
  const rightLast = right.segments[right.segments.length - 1];
  if (!leftLast || !rightLast) {
    return leftLast === rightLast;
  }

  return (
    leftLast.start === rightLast.start &&
    leftLast.end === rightLast.end &&
    leftLast.text === rightLast.text &&
    leftLast.speaker_id === rightLast.speaker_id
  );
};

export interface MeetingFocusRequest {
  id: number;
  nonce: number;
}

interface MeetingsPageProps {
  focusRequest?: MeetingFocusRequest | null;
}

type MeetingDeletePhase = "fading";
type SpeakerEditorMode = "global" | "segment";

type TranscriptPreparingStateProps = {
  fullscreen?: boolean;
  ariaLabel?: string;
  statusLabel?: string;
  readyContent?: React.ReactNode;
  revealing?: boolean;
};

const TRANSCRIPT_READY_REVEAL_MS = 900;

const isTransientMeetingAudioError = (message: string | null | undefined) => {
  const normalized = message?.toLowerCase() ?? "";
  if (!normalized) return false;

  return (
    normalized.includes("no such file or directory") ||
    normalized.includes("os error 2") ||
    (normalized.includes("audio file") &&
      (normalized.includes("finaliz") ||
        normalized.includes("not available") ||
        normalized.includes("not found")))
  );
};

const TRANSCRIPT_PREPARING_GRID_COLUMNS = 23;
const TRANSCRIPT_PREPARING_GRID_ROWS = 13;
const TRANSCRIPT_PREPARING_ITERATION_MS = 167;
const TRANSCRIPT_PREPARING_DOTS = Array.from(
  {
    length: TRANSCRIPT_PREPARING_GRID_COLUMNS * TRANSCRIPT_PREPARING_GRID_ROWS,
  },
  (_, index) => {
    const x = index % TRANSCRIPT_PREPARING_GRID_COLUMNS;
    const y = Math.floor(index / TRANSCRIPT_PREPARING_GRID_COLUMNS);
    return {
      index,
      x,
      y,
    };
  },
);

const seedTranscriptPreparingGrid = (seed = 0) =>
  TRANSCRIPT_PREPARING_DOTS.map(({ index, x, y }) => {
    const wave =
      Math.sin((x + seed * 3) * 1.37) +
      Math.cos((y - seed) * 1.61) +
      Math.sin((index + seed * 17) * 0.41);
    return wave > 1.08 || (x + y + seed) % 11 === 0;
  });

const getTranscriptPreparingCell = (cells: boolean[], x: number, y: number) => {
  const wrappedX =
    (x + TRANSCRIPT_PREPARING_GRID_COLUMNS) % TRANSCRIPT_PREPARING_GRID_COLUMNS;
  const wrappedY =
    (y + TRANSCRIPT_PREPARING_GRID_ROWS) % TRANSCRIPT_PREPARING_GRID_ROWS;
  return cells[wrappedY * TRANSCRIPT_PREPARING_GRID_COLUMNS + wrappedX];
};

const getTranscriptPreparingLiveNeighborCount = (
  cells: boolean[],
  x: number,
  y: number,
) => {
  let count = 0;
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue;
      if (getTranscriptPreparingCell(cells, x + offsetX, y + offsetY)) {
        count += 1;
      }
    }
  }
  return count;
};

const addTranscriptPreparingActivity = (
  cells: boolean[],
  generation: number,
) => {
  const next = [...cells];
  const originX = (generation * 5 + 4) % TRANSCRIPT_PREPARING_GRID_COLUMNS;
  const originY = (generation * 3 + 2) % TRANSCRIPT_PREPARING_GRID_ROWS;
  const pattern = [
    [0, 0],
    [1, 0],
    [2, 0],
    [2, -1],
    [1, -2],
  ];

  for (const [offsetX, offsetY] of pattern) {
    const x =
      (originX + offsetX + TRANSCRIPT_PREPARING_GRID_COLUMNS) %
      TRANSCRIPT_PREPARING_GRID_COLUMNS;
    const y =
      (originY + offsetY + TRANSCRIPT_PREPARING_GRID_ROWS) %
      TRANSCRIPT_PREPARING_GRID_ROWS;
    next[y * TRANSCRIPT_PREPARING_GRID_COLUMNS + x] = true;
  }

  return next;
};

const advanceTranscriptPreparingGrid = (
  cells: boolean[],
  generation: number,
) => {
  let next = TRANSCRIPT_PREPARING_DOTS.map(({ x, y }) => {
    const isAlive = getTranscriptPreparingCell(cells, x, y);
    const neighbors = getTranscriptPreparingLiveNeighborCount(cells, x, y);
    return isAlive ? neighbors === 2 || neighbors === 3 : neighbors === 3;
  });

  const activeCount = next.reduce(
    (count, isAlive) => count + Number(isAlive),
    0,
  );
  if (activeCount < 28 || generation % 18 === 0) {
    next = addTranscriptPreparingActivity(next, generation);
  }

  if (activeCount > Math.floor(next.length * 0.52)) {
    next = seedTranscriptPreparingGrid(generation);
  }

  return next;
};

const TRANSCRIPT_PREPARING_REDUCED_MOTION_DOTS = TRANSCRIPT_PREPARING_DOTS.map(
  ({ index, x, y }) => ({
    index,
    x,
    y,
    active: (x + y) % 4 === 0 || index % 19 === 0,
  }),
);

const TRANSCRIPT_PREPARING_LINES = [
  {
    tone: "blue",
    variants: [
      "Speaker 1: We should be able to tighten the next version.",
      "Speaker 1: The next pass should keep the important decisions.",
      "Speaker 1: I think the clearest thing is the follow-up list.",
    ],
  },
  {
    tone: "green",
    variants: [
      "Speaker 2: The main thing is making the flow feel clear.",
      "Speaker 2: That part should stay simple enough to scan.",
      "Speaker 2: We can group the open questions after the summary.",
    ],
  },
  {
    tone: "orange",
    variants: [
      "Speaker 3: I can take the follow-up and send the notes.",
      "Speaker 3: The deadline changed, but the owner is the same.",
      "Speaker 3: Let's make sure that action item is captured.",
    ],
  },
  {
    tone: "blue",
    variants: [
      "Speaker 1: Let's keep the summary focused on decisions.",
      "Speaker 1: The useful part is what changed and who owns it.",
      "Speaker 1: That section can be shorter and more direct.",
    ],
  },
  {
    tone: "green",
    variants: [
      "Speaker 2: That gives everyone a cleaner next step.",
      "Speaker 2: The transcript should make the handoff obvious.",
      "Speaker 2: We can turn the last point into a task.",
    ],
  },
] as const;

const TranscriptPreparingState: React.FC<TranscriptPreparingStateProps> = ({
  fullscreen = false,
  ariaLabel = "Preparing transcript",
  statusLabel = "Preparing",
  readyContent,
  revealing = false,
}) => {
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [grid, setGrid] = useState(() => ({
    cells: prefersReducedMotion
      ? TRANSCRIPT_PREPARING_REDUCED_MOTION_DOTS.map((dot) => dot.active)
      : seedTranscriptPreparingGrid(),
    generation: 0,
  }));

  useEffect(() => {
    if (prefersReducedMotion) return;

    const interval = window.setInterval(() => {
      setGrid((current) => {
        const generation = current.generation + 1;
        return {
          cells: advanceTranscriptPreparingGrid(current.cells, generation),
          generation,
        };
      });
    }, TRANSCRIPT_PREPARING_ITERATION_MS);

    return () => window.clearInterval(interval);
  }, [prefersReducedMotion]);

  const ghostFrame = Math.floor(grid.generation / 8);

  return (
    <div
      className={`meeting-transcript-preparing-shell ${
        fullscreen
          ? "meeting-transcript-preparing-shell--fullscreen"
          : "meeting-transcript-preparing-shell--inline"
      }`}
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
    >
      <div
        className={`meeting-transcript-preparing ${
          fullscreen
            ? "meeting-transcript-preparing--fullscreen"
            : "meeting-transcript-preparing--inline"
        } ${revealing ? "meeting-transcript-preparing--revealing" : ""}`}
        aria-hidden="true"
      >
        {readyContent ? (
          <div className="meeting-transcript-preparing__ready">
            {readyContent}
          </div>
        ) : (
          <div className="meeting-transcript-preparing__ghost">
            {TRANSCRIPT_PREPARING_LINES.map((line, index) => (
              <div
                key={`${line.tone}-${index}`}
                className={`meeting-transcript-preparing__ghost-line meeting-transcript-preparing__ghost-line--${line.tone}`}
                style={
                  {
                    "--line-index": index,
                  } as React.CSSProperties & Record<string, number>
                }
              >
                <span className="meeting-transcript-preparing__speaker-spot" />
                <span className="meeting-transcript-preparing__ghost-text">
                  {line.variants[(ghostFrame + index) % line.variants.length]}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="meeting-transcript-preparing__field" />
        <div
          className="meeting-transcript-preparing__matrix"
          style={
            {
              "--grid-columns": TRANSCRIPT_PREPARING_GRID_COLUMNS,
              "--grid-rows": TRANSCRIPT_PREPARING_GRID_ROWS,
            } as React.CSSProperties & Record<string, number>
          }
        >
          {TRANSCRIPT_PREPARING_DOTS.map((dot) => (
            <span
              key={dot.index}
              className={`meeting-transcript-preparing__dot ${
                grid.cells[dot.index]
                  ? "meeting-transcript-preparing__dot--active"
                  : ""
              }`}
            />
          ))}
        </div>
      </div>
      <div
        className={`meeting-transcript-preparing-status ${
          revealing ? "meeting-transcript-preparing-status--revealing" : ""
        }`}
      >
        {statusLabel}
      </div>
    </div>
  );
};

const MeetingsPage: React.FC<MeetingsPageProps> = ({ focusRequest = null }) => {
  const { t, i18n } = useTranslation();
  const [meetings, setMeetings] = useState<MeetingEntry[]>([]);
  const [deletedMeetings, setDeletedMeetings] = useState<DeletedMeetingEntry[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [activeMeeting, setActiveMeeting] = useState<ActiveMeetingInfo | null>(
    null,
  );
  const [liveTranscript, setLiveTranscript] = useState<MeetingTranscript>({
    text: "",
    segments: [],
  });
  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedTagFilter, setSelectedTagFilter] = useState<string | null>(
    null,
  );
  const [stopInProgress, setStopInProgress] = useState(false);
  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [tagEditorId, setTagEditorId] = useState<number | null>(null);
  const [tagQuery, setTagQuery] = useState("");
  const [lastRecordedId, setLastRecordedId] = useState<number | null>(null);
  const [recordingNotes, setRecordingNotes] = useState<MeetingNote[]>([]);
  const [recordingNoteDraft, setRecordingNoteDraft] = useState("");
  const [recordingNoteStartOffset, setRecordingNoteStartOffset] = useState<
    number | null
  >(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<number | null>(
    null,
  );
  const [detailTranscript, setDetailTranscript] =
    useState<MeetingTranscript | null>(null);
  const [detailTranscriptLoading, setDetailTranscriptLoading] = useState(false);
  const [detailTranscriptRevealActive, setDetailTranscriptRevealActive] =
    useState(false);
  const [detailSpeakerMappings, setDetailSpeakerMappings] = useState<
    MeetingSpeakerMapping[]
  >([]);
  const [detailDiarizationStatus, setDetailDiarizationStatus] =
    useState<MeetingDiarizationStatus | null>(null);
  const [detailTranscriptFullscreenOpen, setDetailTranscriptFullscreenOpen] =
    useState(false);
  const [
    detailTranscriptFullscreenMounted,
    setDetailTranscriptFullscreenMounted,
  ] = useState(false);
  const [
    detailTranscriptFullscreenVisible,
    setDetailTranscriptFullscreenVisible,
  ] = useState(false);
  const [detailTranscriptMenuOpen, setDetailTranscriptMenuOpen] =
    useState(false);
  const [
    detailTranscriptFullscreenMenuOpen,
    setDetailTranscriptFullscreenMenuOpen,
  ] = useState(false);
  const [detailNotesPanelOpen, setDetailNotesPanelOpen] = useState(false);
  const [detailParticipantsModalOpen, setDetailParticipantsModalOpen] =
    useState(false);
  const [detailSharingModalOpen, setDetailSharingModalOpen] = useState(false);
  const [deleteConfirmMeeting, setDeleteConfirmMeeting] =
    useState<MeetingEntry | null>(null);
  const [deleteConfirmInProgress, setDeleteConfirmInProgress] = useState(false);
  const [speakerEditorRawId, setSpeakerEditorRawId] = useState<string | null>(
    null,
  );
  const [speakerEditorMounted, setSpeakerEditorMounted] = useState(false);
  const [speakerEditorVisible, setSpeakerEditorVisible] = useState(false);
  const [speakerEditorMode, setSpeakerEditorMode] =
    useState<SpeakerEditorMode>("global");
  const [speakerEditorSegmentIndex, setSpeakerEditorSegmentIndex] = useState<
    number | null
  >(null);
  const [speakerEditorSearch, setSpeakerEditorSearch] = useState("");
  const [speakerEditorDisplayName, setSpeakerEditorDisplayName] = useState("");
  const [speakerEditorColor, setSpeakerEditorColor] = useState(
    SPEAKER_CHIP_COLORS[0],
  );
  const [speakerEditorParticipantId, setSpeakerEditorParticipantId] = useState<
    number | null
  >(null);
  const [speakerEditorSaving, setSpeakerEditorSaving] = useState(false);
  const [speakerEditorCreating, setSpeakerEditorCreating] = useState(false);
  const [speakerEditorNewParticipantName, setSpeakerEditorNewParticipantName] =
    useState("");
  const [
    speakerEditorNewParticipantEmail,
    setSpeakerEditorNewParticipantEmail,
  ] = useState("");
  const [
    speakerEditorNewParticipantPhone,
    setSpeakerEditorNewParticipantPhone,
  ] = useState("");
  const [detailNotes, setDetailNotes] = useState<MeetingNote[]>([]);
  const [detailNotesLoading, setDetailNotesLoading] = useState(false);
  const [detailNoteDraft, setDetailNoteDraft] = useState("");
  const [detailNoteOffset, setDetailNoteOffset] = useState<number | null>(null);
  const [detailAudioLoading, setDetailAudioLoading] = useState(false);
  const [detailIsPlaying, setDetailIsPlaying] = useState(false);
  const [detailPlayerVisible, setDetailPlayerVisible] = useState(false);
  const [detailPlayerMeetingId, setDetailPlayerMeetingId] = useState<
    number | null
  >(null);
  const [detailPlaybackTime, setDetailPlaybackTime] = useState(0);
  const [detailPlaybackDuration, setDetailPlaybackDuration] = useState(0);
  const [detailPlayerDragging, setDetailPlayerDragging] = useState(false);
  const [savingTranscriptSegmentIndex, setSavingTranscriptSegmentIndex] =
    useState<number | null>(null);
  const [participants, setParticipants] = useState<MeetingParticipant[]>([]);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState<
    number[]
  >([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantSaveInFlight, setParticipantSaveInFlight] = useState(false);
  const [newParticipantName, setNewParticipantName] = useState("");
  const [newParticipantEmail, setNewParticipantEmail] = useState("");
  const [newParticipantPhone, setNewParticipantPhone] = useState("");
  const [newParticipantPhotoDataUrl, setNewParticipantPhotoDataUrl] = useState<
    string | null
  >(null);
  const [creatingParticipant, setCreatingParticipant] = useState(false);
  const [participantQuery, setParticipantQuery] = useState("");
  const [audioUrls, setAudioUrls] = useState<Record<number, string>>({});
  const [activeAudioId, setActiveAudioId] = useState<number | null>(null);
  const [audioLoadingId, setAudioLoadingId] = useState<number | null>(null);
  const [downloadInProgressId, setDownloadInProgressId] = useState<
    number | null
  >(null);
  const [meetingPublicShare, setMeetingPublicShare] =
    useState<MeetingPublicShare | null>(null);
  const [meetingUserShares, setMeetingUserShares] = useState<
    MeetingUserShare[]
  >([]);
  const [meetingSharesLoading, setMeetingSharesLoading] = useState(false);
  const [meetingShareBusy, setMeetingShareBusy] = useState(false);
  const [meetingShareError, setMeetingShareError] = useState<string | null>(
    null,
  );
  const [meetingShareMessage, setMeetingShareMessage] = useState<string | null>(
    null,
  );
  const [shareEmailDraft, setShareEmailDraft] = useState("");
  const [deletePhaseByMeetingId, setDeletePhaseByMeetingId] = useState<
    Record<number, MeetingDeletePhase>
  >({});
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const tagMenuRef = useRef<HTMLDivElement | null>(null);
  const detailTranscriptMenuRef = useRef<HTMLDivElement | null>(null);
  const detailTranscriptFullscreenMenuRef = useRef<HTMLDivElement | null>(null);
  const detailNoteInputRef = useRef<HTMLInputElement | null>(null);
  const detailAudioRef = useRef<HTMLAudioElement | null>(null);
  const fullscreenCloseTimerRef = useRef<number | null>(null);
  const speakerEditorCloseTimerRef = useRef<number | null>(null);
  const speakerEditorResetPendingRef = useRef(false);
  const detailPlayerDraggingRef = useRef(false);
  const liveTranscriptRef = useRef<HTMLDivElement | null>(null);
  const selectedMeetingIdRef = useRef<number | null>(selectedMeetingId);
  const diarizationAutoRequestedRef = useRef<Set<number>>(new Set());
  const diarizationStatusRef = useRef<string | null>(null);
  const detailTranscriptWasPreparingRef = useRef(false);
  const detailTranscriptRevealTimerRef = useRef<number | null>(null);
  const softDeleteTimersRef = useRef<Record<number, number>>({});
  const permanentDeleteTimersRef = useRef<
    Record<number, { fadeTimer: number; commitTimer: number }>
  >({});
  selectedMeetingIdRef.current = selectedMeetingId;
  const authToken = useAuthStore((state) => state.token);
  const authUserId = useAuthStore((state) => state.user?.user_id);
  const hasDetailTranscriptContent =
    transcriptHasSpokenContent(detailTranscript);
  const isFreshDetailMeeting =
    selectedMeetingId !== null && selectedMeetingId === lastRecordedId;
  const isDetailTranscriptProcessing =
    isFreshDetailMeeting &&
    detailTranscriptLoading &&
    !hasDetailTranscriptContent;
  const isDetailTranscriptPreparing =
    isDetailTranscriptProcessing ||
    detailDiarizationStatus?.status === "running";

  const sortedMeetings = useMemo(
    () => [...meetings].sort((a, b) => b.ended_at - a.ended_at),
    [meetings],
  );
  const sortedDeletedMeetings = useMemo(
    () => [...deletedMeetings].sort((a, b) => b.deleted_at - a.deleted_at),
    [deletedMeetings],
  );
  const normalizedTagFilter = selectedTagFilter
    ? normalizeTag(selectedTagFilter)
    : null;
  const filteredMeetings = useMemo(() => {
    const scoped = normalizedTagFilter
      ? sortedMeetings.filter((meeting) =>
          meeting.tags?.some(
            (tag) => normalizeTag(tag) === normalizedTagFilter,
          ),
        )
      : sortedMeetings;

    if (!searchQuery.trim()) {
      return scoped;
    }

    return scoped.filter((meeting) => {
      const tagText = (meeting.tags ?? []).join(" ");
      return fuzzyMatch(`${meeting.name} ${tagText}`, searchQuery);
    });
  }, [normalizedTagFilter, searchQuery, sortedMeetings]);
  const tagOptions = useMemo(() => {
    const map = new Map<string, string>();
    availableTags.forEach((tag) => {
      const normalized = normalizeTag(tag);
      if (!normalized) return;
      if (!map.has(normalized)) {
        map.set(normalized, normalized);
      }
    });
    return Array.from(map.values()).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
  }, [availableTags]);
  const activeTagMeeting = useMemo(
    () => meetings.find((meeting) => meeting.id === tagEditorId) ?? null,
    [meetings, tagEditorId],
  );
  const selectedMeeting = useMemo(
    () => meetings.find((meeting) => meeting.id === selectedMeetingId) ?? null,
    [meetings, selectedMeetingId],
  );
  const activePlaybackSegmentIndex = useMemo(() => {
    if (
      !detailPlayerVisible ||
      detailPlayerMeetingId === null ||
      detailPlayerMeetingId !== selectedMeetingId
    ) {
      return null;
    }

    const segments = detailTranscript?.segments ?? [];
    if (segments.length === 0) return null;

    const currentTime = Math.max(0, detailPlaybackTime);
    const index = segments.findIndex((segment, segmentIndex) => {
      const start = Number.isFinite(segment.start)
        ? Math.max(0, segment.start)
        : 0;
      const rawEnd = Number.isFinite(segment.end) ? segment.end : start;
      const nextStart = segments[segmentIndex + 1]?.start;
      const hasNextStart =
        typeof nextStart === "number" && Number.isFinite(nextStart);
      const end =
        rawEnd > start
          ? rawEnd
          : hasNextStart
            ? Math.max(start, nextStart)
            : start + 0.5;

      if (segmentIndex === segments.length - 1) {
        return currentTime >= start && currentTime <= end + 0.25;
      }

      return currentTime >= start && currentTime < end;
    });

    return index >= 0 ? index : null;
  }, [
    detailPlaybackTime,
    detailPlayerMeetingId,
    detailPlayerVisible,
    detailTranscript?.segments,
    selectedMeetingId,
  ]);
  const selectedMeetingParticipants = useMemo(() => {
    const selected = new Set(selectedParticipantIds);
    return participants.filter((participant) => selected.has(participant.id));
  }, [participants, selectedParticipantIds]);
  const activeMeetingUserShares = useMemo(
    () => meetingUserShares.filter((share) => share.is_active),
    [meetingUserShares],
  );
  const filteredParticipants = useMemo(() => {
    const query = participantQuery.trim().toLowerCase();
    if (!query) return participants;
    return participants.filter((participant) => {
      const haystack = [
        participant.name,
        participant.email ?? "",
        participant.phone ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [participantQuery, participants]);
  const detailSpeakerOrder = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    if (!detailTranscript?.segments?.length) return ordered;
    for (const segment of detailTranscript.segments) {
      const speaker = segment.speaker_id?.trim();
      if (!speaker) continue;
      if (seen.has(speaker)) continue;
      seen.add(speaker);
      ordered.push(speaker);
    }
    return ordered;
  }, [detailTranscript?.segments]);
  const detailSpeakerMappingsByRaw = useMemo(() => {
    const map = new Map<string, MeetingSpeakerMapping>();
    for (const mapping of detailSpeakerMappings) {
      map.set(mapping.raw_speaker_id, mapping);
    }
    return map;
  }, [detailSpeakerMappings]);
  const detailSpeakerChips = useMemo(() => {
    return detailSpeakerOrder.map((rawSpeakerId, index) => {
      const mapping = detailSpeakerMappingsByRaw.get(rawSpeakerId);
      const color =
        mapping?.color?.trim() ||
        SPEAKER_CHIP_COLORS[index % SPEAKER_CHIP_COLORS.length];
      const displayName =
        mapping?.display_name?.trim() || `Unassigned Speaker ${index + 1}`;
      return {
        rawSpeakerId,
        index,
        color,
        displayName,
        participantId: mapping?.participant_id ?? null,
      };
    });
  }, [detailSpeakerMappingsByRaw, detailSpeakerOrder]);
  const speakerEditorFilteredParticipants = useMemo(() => {
    const query = speakerEditorSearch.trim().toLowerCase();
    if (!query) return participants;
    return participants.filter((participant) => {
      const haystack = [
        participant.name,
        participant.email ?? "",
        participant.phone ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [participants, speakerEditorSearch]);
  const tagSuggestions = useMemo(() => {
    if (!activeTagMeeting) return [];
    const normalizedExisting = new Set(
      (activeTagMeeting.tags ?? []).map((tag) => normalizeTag(tag)),
    );
    const query = tagQuery.trim();
    if (!query) {
      return tagOptions.filter((tag) => !normalizedExisting.has(tag));
    }
    const scored = tagOptions
      .filter((tag) => !normalizedExisting.has(tag))
      .map((tag) => ({
        tag,
        score: scoreTextMatch(tag, query),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) =>
        b.score !== a.score
          ? b.score - a.score
          : a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }),
      );
    return scored.map((item) => item.tag);
  }, [activeTagMeeting, tagOptions, tagQuery]);

  const getCurrentRecordingOffset = () => {
    if (!activeMeeting) return 0;
    return Math.max(0, Date.now() / 1000 - activeMeeting.started_at);
  };

  const ensureMeetingPermissions = async (): Promise<{
    canStart: boolean;
    includeSystemAudio: boolean;
  }> => {
    try {
      const osType = await getOsType();
      if (osType !== "macos") {
        return { canStart: true, includeSystemAudio: true };
      }

      let hasMicrophone = await checkMicrophonePermission();
      if (!hasMicrophone) {
        await requestMicrophonePermission();
        hasMicrophone = await checkMicrophonePermission();
      }

      if (!hasMicrophone) {
        toast.error(
          "Microphone permission is required. Allow it in System Settings, then start the meeting again.",
        );
        return { canStart: false, includeSystemAudio: false };
      }

      let hasScreenRecording = await checkScreenRecordingPermission();
      if (!hasScreenRecording) {
        await requestScreenRecordingPermission();
        hasScreenRecording = await checkScreenRecordingPermission();
      }

      if (!hasScreenRecording) {
        toast.error(
          "Screen Recording permission is off. Meeting will continue with microphone only until this permission is allowed.",
        );
      }

      return {
        canStart: true,
        includeSystemAudio: hasScreenRecording,
      };
    } catch (error) {
      console.error("Failed to verify meeting permissions:", error);
      return { canStart: true, includeSystemAudio: true };
    }
  };

  const loadMeetings = async () => {
    setLoading(true);
    try {
      const result = await commands.getMeetings();
      if (result.status === "ok") {
        setMeetings(result.data);
      } else {
        toast.error(result.error);
      }
    } finally {
      setLoading(false);
    }
  };

  const loadDeletedMeetings = async () => {
    const result = await commands.getDeletedMeetings();
    if (result.status === "ok") {
      setDeletedMeetings(result.data);
    } else {
      toast.error(result.error ?? t("meetingsPage.deleteError"));
    }
  };

  const loadTags = async () => {
    const result = await commands.getMeetingTags();
    if (result.status === "ok") {
      setAvailableTags(result.data);
    }
  };

  const refreshRecordingState = async (): Promise<ActiveMeetingInfo | null> => {
    const result = await commands.getActiveMeeting();
    if (result.status === "ok") {
      const active = result.data ?? null;
      setIsRecording(Boolean(active));
      setActiveMeeting(active);
      if (active) {
        setSelectedMeetingId(null);
        setRecordingElapsedSeconds(
          Math.max(0, Date.now() / 1000 - active.started_at),
        );
        const [notesResult, transcriptResult] = await Promise.all([
          commands.getMeetingNotes(active.id),
          commands.getActiveMeetingLiveTranscript(),
        ]);
        if (notesResult.status === "ok") {
          setRecordingNotes(notesResult.data);
        }
        if (transcriptResult.status === "ok") {
          setLiveTranscript(
            transcriptResult.data ?? {
              text: "",
              segments: [],
            },
          );
        } else {
          setLiveTranscript({ text: "", segments: [] });
        }
      } else {
        setRecordingNotes([]);
        setLiveTranscript({ text: "", segments: [] });
        setRecordingNoteStartOffset(null);
        setRecordingElapsedSeconds(0);
      }
      return active;
    }
    setIsRecording(false);
    setActiveMeeting(null);
    setRecordingNotes([]);
    setLiveTranscript({ text: "", segments: [] });
    setRecordingNoteStartOffset(null);
    setRecordingElapsedSeconds(0);
    return null;
  };

  const toggleAudio = async (meeting: MeetingEntry) => {
    if (activeAudioId === meeting.id) {
      setActiveAudioId(null);
      return;
    }

    const existing = audioUrls[meeting.id];
    if (existing) {
      setActiveAudioId(meeting.id);
      return;
    }

    setAudioLoadingId(meeting.id);
    try {
      const result = await commands.getMeetingAudioFilePath(meeting.file_name);
      if (result.status === "ok") {
        const url = convertFileSrc(`${result.data}`, "asset");
        setAudioUrls((prev) => ({ ...prev, [meeting.id]: url }));
        setActiveAudioId(meeting.id);
      } else {
        toast.error(result.error ?? t("meetingsPage.audioError"));
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("meetingsPage.audioError"),
      );
    } finally {
      setAudioLoadingId(null);
    }
  };

  const resetDetailPlayback = () => {
    const audio = detailAudioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    setDetailIsPlaying(false);
    setDetailPlayerVisible(false);
    setDetailPlayerMeetingId(null);
    setDetailPlaybackTime(0);
    setDetailPlaybackDuration(0);
    setDetailPlayerDragging(false);
  };

  const openMeetingDetail = (meeting: MeetingEntry) => {
    resetDetailPlayback();
    setSelectedMeetingId(meeting.id);
    setDetailTranscriptFullscreenOpen(false);
    setDetailTranscriptMenuOpen(false);
    setDetailTranscriptFullscreenMenuOpen(false);
    setDetailNotesPanelOpen(false);
    setDetailParticipantsModalOpen(false);
    setDetailSharingModalOpen(false);
    setDeleteConfirmMeeting(null);
    setDetailNoteOffset(
      Number.isFinite(meeting.duration_seconds)
        ? Math.max(0, meeting.duration_seconds)
        : 0,
    );
    setDetailNoteDraft("");
  };

  const closeMeetingDetail = () => {
    resetDetailPlayback();
    setSelectedMeetingId(null);
    setDetailTranscript(null);
    setDetailSpeakerMappings([]);
    setDetailDiarizationStatus(null);
    setDetailTranscriptFullscreenOpen(false);
    setDetailTranscriptMenuOpen(false);
    setDetailTranscriptFullscreenMenuOpen(false);
    setDetailNotesPanelOpen(false);
    setDetailParticipantsModalOpen(false);
    setDetailSharingModalOpen(false);
    setDeleteConfirmMeeting(null);
    setDeleteConfirmInProgress(false);
    setDetailNotes([]);
    setDetailNoteOffset(null);
    setDetailNoteDraft("");
    setDetailIsPlaying(false);
    setSavingTranscriptSegmentIndex(null);
    setParticipantQuery("");
    closeSpeakerEditor();
    diarizationStatusRef.current = null;
    if (detailAudioRef.current) {
      detailAudioRef.current.pause();
    }
  };

  const clearSoftDeleteTimer = (meetingId: number) => {
    const timer = softDeleteTimersRef.current[meetingId];
    if (typeof timer !== "number") return;
    window.clearTimeout(timer);
    delete softDeleteTimersRef.current[meetingId];
  };

  const clearPermanentDeleteTimers = (meetingId: number) => {
    const timers = permanentDeleteTimersRef.current[meetingId];
    if (!timers) return;
    window.clearTimeout(timers.fadeTimer);
    window.clearTimeout(timers.commitTimer);
    delete permanentDeleteTimersRef.current[meetingId];
  };

  const clearMeetingUIState = (meetingId: number) => {
    setAudioUrls((prev) => {
      if (!(meetingId in prev)) return prev;
      const next = { ...prev };
      delete next[meetingId];
      return next;
    });
    if (renameId === meetingId) {
      cancelRename();
    }
    if (tagEditorId === meetingId) {
      setTagEditorId(null);
      setTagQuery("");
    }
    if (activeAudioId === meetingId) {
      setActiveAudioId(null);
    }
    if (lastRecordedId === meetingId) {
      setLastRecordedId(null);
    }
    if (selectedMeetingId === meetingId) {
      closeMeetingDetail();
    }
  };

  const saveTranscriptSegmentEdit = async (
    segmentIndex: number,
    rawText: string,
  ) => {
    if (!selectedMeeting || !detailTranscript) {
      return;
    }

    const normalizedText = rawText.trim();
    const current = detailTranscript.segments[segmentIndex];
    if (!current) {
      return;
    }

    if (normalizedText === current.text.trim()) {
      if (current.text !== normalizedText) {
        const nextSegments = [...detailTranscript.segments];
        nextSegments[segmentIndex] = {
          ...nextSegments[segmentIndex],
          text: normalizedText,
        };
        const nextText = nextSegments
          .map((segment) => segment.text.trim())
          .filter((text) => text.length > 0)
          .join(" ");
        setDetailTranscript({
          text: nextText,
          segments: nextSegments,
        });
      }
      return;
    }

    setSavingTranscriptSegmentIndex(segmentIndex);
    try {
      const result = await commands.updateMeetingTranscriptSegment(
        selectedMeeting.id,
        segmentIndex,
        normalizedText,
      );
      if (result.status === "ok") {
        setDetailTranscript(result.data);
      } else {
        toast.error(result.error ?? t("meetingsPage.transcriptError"));
      }
    } finally {
      setSavingTranscriptSegmentIndex(null);
    }
  };

  const getDefaultSpeakerName = (rawSpeakerId: string) => {
    const index = detailSpeakerOrder.findIndex(
      (value) => value === rawSpeakerId,
    );
    if (index >= 0) {
      return `Unassigned Speaker ${index + 1}`;
    }
    return "Unassigned Speaker";
  };

  const getSpeakerMeta = (rawSpeakerId?: string | null) => {
    const normalized = rawSpeakerId?.trim();
    if (!normalized) {
      return {
        rawSpeakerId: null,
        displayName: "Unassigned Speaker",
        color: SPEAKER_CHIP_COLORS[0],
      };
    }
    const chipIndex = detailSpeakerOrder.findIndex(
      (value) => value === normalized,
    );
    const mapping = detailSpeakerMappingsByRaw.get(normalized);
    const color =
      mapping?.color?.trim() ||
      SPEAKER_CHIP_COLORS[
        (chipIndex >= 0 ? chipIndex : 0) % SPEAKER_CHIP_COLORS.length
      ];
    const displayName =
      mapping?.display_name?.trim() ||
      (chipIndex >= 0
        ? `Unassigned Speaker ${chipIndex + 1}`
        : "Unassigned Speaker");
    return {
      rawSpeakerId: normalized,
      displayName,
      color,
      participantId: mapping?.participant_id ?? null,
    };
  };

  const loadSpeakerMappings = async (meetingId: number) => {
    const result = await commands.getMeetingSpeakerMappings(meetingId);
    if (result.status === "ok") {
      if (selectedMeetingIdRef.current === meetingId) {
        setDetailSpeakerMappings(result.data);
      }
      return result.data;
    }
    return [];
  };

  const loadDiarizationStatus = async (meetingId: number) => {
    const result = await commands.getMeetingDiarizationStatus(meetingId);
    if (result.status === "ok") {
      const nextStatus = normalizeDiarizationStatus(result.data);
      if (selectedMeetingIdRef.current !== meetingId) {
        return nextStatus;
      }
      const previous = diarizationStatusRef.current;
      diarizationStatusRef.current = nextStatus.status;
      setDetailDiarizationStatus(nextStatus);
      if (previous === "running" && nextStatus.status === "completed") {
        toast.success("Speakers identified.");
        const transcriptResult = await commands.getMeetingTranscript(meetingId);
        if (
          transcriptResult.status === "ok" &&
          selectedMeetingIdRef.current === meetingId
        ) {
          setDetailTranscript(transcriptResult.data);
        }
        await loadSpeakerMappings(meetingId);
      } else if (previous === "running" && nextStatus.status === "failed") {
        toast.error(
          nextStatus.error_message ?? "Speaker identification failed.",
        );
      }
      return nextStatus;
    }
    return null;
  };

  const runDiarization = async (meetingId: number, force = false) => {
    if (!force && diarizationAutoRequestedRef.current.has(meetingId)) {
      return;
    }
    diarizationAutoRequestedRef.current.add(meetingId);
    const result = await commands.runMeetingDiarization(meetingId);
    if (result.status === "ok") {
      const nextStatus = normalizeDiarizationStatus(result.data);
      if (selectedMeetingIdRef.current === meetingId) {
        diarizationStatusRef.current = nextStatus.status;
        setDetailDiarizationStatus(nextStatus);
      }
      return;
    }
    diarizationAutoRequestedRef.current.delete(meetingId);
    if (selectedMeetingIdRef.current === meetingId) {
      toast.error(result.error ?? "Couldn't start speaker identification.");
    }
  };

  const openSpeakerEditor = (
    rawSpeakerId: string | null,
    options: { mode: SpeakerEditorMode; segmentIndex?: number } = {
      mode: "global",
    },
  ) => {
    if (speakerEditorCloseTimerRef.current !== null) {
      window.clearTimeout(speakerEditorCloseTimerRef.current);
      speakerEditorCloseTimerRef.current = null;
    }
    speakerEditorResetPendingRef.current = false;
    const meta = getSpeakerMeta(rawSpeakerId);
    setSpeakerEditorMounted(true);
    window.requestAnimationFrame(() => setSpeakerEditorVisible(true));
    setSpeakerEditorRawId(rawSpeakerId);
    setSpeakerEditorMode(options.mode);
    setSpeakerEditorSegmentIndex(
      options.mode === "segment" ? (options.segmentIndex ?? null) : null,
    );
    setSpeakerEditorDisplayName(meta.displayName);
    setSpeakerEditorColor(meta.color);
    setSpeakerEditorParticipantId(meta.participantId ?? null);
    setSpeakerEditorSearch("");
    setSpeakerEditorCreating(false);
    setSpeakerEditorNewParticipantName("");
    setSpeakerEditorNewParticipantEmail("");
    setSpeakerEditorNewParticipantPhone("");
  };

  const resetSpeakerEditor = () => {
    setSpeakerEditorRawId(null);
    setSpeakerEditorMode("global");
    setSpeakerEditorSegmentIndex(null);
    setSpeakerEditorSearch("");
    setSpeakerEditorDisplayName("");
    setSpeakerEditorParticipantId(null);
    setSpeakerEditorCreating(false);
    setSpeakerEditorNewParticipantName("");
    setSpeakerEditorNewParticipantEmail("");
    setSpeakerEditorNewParticipantPhone("");
  };

  const closeSpeakerEditor = () => {
    setSpeakerEditorVisible(false);
    speakerEditorResetPendingRef.current = true;
    if (speakerEditorCloseTimerRef.current !== null) {
      window.clearTimeout(speakerEditorCloseTimerRef.current);
    }
    speakerEditorCloseTimerRef.current = window.setTimeout(() => {
      setSpeakerEditorMounted(false);
      speakerEditorCloseTimerRef.current = null;
      if (speakerEditorResetPendingRef.current) {
        speakerEditorResetPendingRef.current = false;
        resetSpeakerEditor();
      }
    }, MODAL_TRANSITION_MS);
  };

  const openGlobalSpeakerEditor = (rawSpeakerId: string) => {
    openSpeakerEditor(rawSpeakerId, { mode: "global" });
  };

  const openSegmentSpeakerEditor = (
    rawSpeakerId: string | null,
    segmentIndex: number,
  ) => {
    openSpeakerEditor(rawSpeakerId, {
      mode: "segment",
      segmentIndex,
    });
  };

  const upsertSpeakerMapping = async (
    rawSpeakerId: string,
    displayName: string,
    color: string,
    participantId: number | null,
  ) => {
    if (!selectedMeeting) return null;
    const payload: UpdateMeetingSpeakerMappingRequest = {
      raw_speaker_id: rawSpeakerId,
      display_name: displayName,
      color,
      participant_id: participantId,
    };
    const result = await commands.updateMeetingSpeakerMapping(
      selectedMeeting.id,
      payload,
    );
    if (result.status === "ok") {
      setDetailSpeakerMappings(result.data);
      return result.data;
    }
    toast.error(result.error ?? "Couldn't update speaker.");
    return null;
  };

  const updateSingleTranscriptSegmentSpeaker = async (
    segmentIndex: number,
    speakerId: string | null,
  ) => {
    if (!selectedMeeting) return null;
    const request: UpdateMeetingTranscriptSpeakerRequest = {
      segment_index: segmentIndex,
      speaker_id: speakerId,
      apply_to_all_with_same_speaker: false,
    };
    const result = await commands.updateMeetingTranscriptSegmentSpeaker(
      selectedMeeting.id,
      request,
    );
    if (result.status === "ok") {
      setDetailTranscript(result.data);
      return result.data;
    }
    toast.error(result.error ?? "Couldn't update transcript speaker.");
    return null;
  };

  const saveSpeakerEditor = async () => {
    if (!selectedMeeting) return;
    const display = speakerEditorDisplayName.trim();
    if (!display.length) {
      toast.error("Speaker name cannot be empty.");
      return;
    }

    setSpeakerEditorSaving(true);
    try {
      if (speakerEditorMode === "global") {
        if (!speakerEditorRawId) {
          toast.error("Couldn't update speaker.");
          return;
        }
        const mappings = await upsertSpeakerMapping(
          speakerEditorRawId,
          display,
          speakerEditorColor,
          speakerEditorParticipantId,
        );
        if (mappings) {
          closeSpeakerEditor();
        }
        return;
      }

      const segmentIndex = speakerEditorSegmentIndex;
      if (segmentIndex === null || segmentIndex < 0) {
        toast.error("Couldn't update this phrase speaker.");
        return;
      }

      let targetRawSpeakerId: string | null = null;
      if (speakerEditorParticipantId !== null) {
        targetRawSpeakerId =
          detailSpeakerMappings.find(
            (mapping) => mapping.participant_id === speakerEditorParticipantId,
          )?.raw_speaker_id ?? null;
      }
      if (!targetRawSpeakerId) {
        const normalizedDisplay = display.toLowerCase();
        targetRawSpeakerId =
          detailSpeakerMappings.find(
            (mapping) =>
              mapping.display_name.trim().toLowerCase() === normalizedDisplay,
          )?.raw_speaker_id ?? null;
      }

      const currentMeta = speakerEditorRawId
        ? detailSpeakerMappingsByRaw.get(speakerEditorRawId)
        : null;
      const currentDisplay =
        currentMeta?.display_name?.trim() ||
        (speakerEditorRawId ? getDefaultSpeakerName(speakerEditorRawId) : "");
      const currentColor = currentMeta?.color?.trim() || speakerEditorColor;
      const currentParticipantId = currentMeta?.participant_id ?? null;
      const changedFromCurrent =
        display !== currentDisplay ||
        speakerEditorColor !== currentColor ||
        (speakerEditorParticipantId ?? null) !== currentParticipantId;

      if (targetRawSpeakerId === speakerEditorRawId && changedFromCurrent) {
        targetRawSpeakerId = null;
      }

      if (!targetRawSpeakerId) {
        targetRawSpeakerId = `manual_segment_${selectedMeeting.id}_${segmentIndex}_${Date.now()}`;
        const mappings = await upsertSpeakerMapping(
          targetRawSpeakerId,
          display,
          speakerEditorColor,
          speakerEditorParticipantId,
        );
        if (!mappings) {
          return;
        }
      }

      const transcript = await updateSingleTranscriptSegmentSpeaker(
        segmentIndex,
        targetRawSpeakerId,
      );
      if (transcript) {
        closeSpeakerEditor();
      }
    } finally {
      setSpeakerEditorSaving(false);
    }
  };

  const leaveSpeakerUnassigned = async () => {
    if (!selectedMeeting) return;
    setSpeakerEditorSaving(true);
    try {
      if (speakerEditorMode === "global") {
        if (!speakerEditorRawId) {
          toast.error("Couldn't reset speaker.");
          return;
        }
        const mappings = await upsertSpeakerMapping(
          speakerEditorRawId,
          getDefaultSpeakerName(speakerEditorRawId),
          speakerEditorColor,
          null,
        );
        if (mappings) {
          closeSpeakerEditor();
        }
        return;
      }

      const segmentIndex = speakerEditorSegmentIndex;
      if (segmentIndex === null || segmentIndex < 0) {
        toast.error("Couldn't reset this phrase speaker.");
        return;
      }

      const transcript = await updateSingleTranscriptSegmentSpeaker(
        segmentIndex,
        null,
      );
      if (transcript) {
        closeSpeakerEditor();
      }
    } finally {
      setSpeakerEditorSaving(false);
    }
  };

  const assignSpeakerToParticipant = async (
    participant: MeetingParticipant,
  ) => {
    setSpeakerEditorDisplayName(participant.name);
    setSpeakerEditorParticipantId(participant.id);
    setSpeakerEditorCreating(false);
  };

  const createParticipantAndAssignSpeaker = async () => {
    if (!selectedMeeting) return;
    const name = speakerEditorNewParticipantName.trim();
    if (!name.length) {
      toast.error("Participant name is required.");
      return;
    }
    setSpeakerEditorSaving(true);
    try {
      const createPayload: CreateMeetingParticipantRequest = {
        name,
        email: speakerEditorNewParticipantEmail.trim() || null,
        phone: speakerEditorNewParticipantPhone.trim() || null,
        photo_data_url: null,
      };
      const createResult = await commands.createParticipant(createPayload);
      if (createResult.status !== "ok") {
        toast.error(createResult.error ?? "Couldn't create participant.");
        return;
      }

      const participant = createResult.data;
      setParticipants((prev) => {
        const exists = prev.some((item) => item.id === participant.id);
        if (exists) return prev;
        return [...prev, participant].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        );
      });

      if (speakerEditorMode === "global") {
        if (!speakerEditorRawId) {
          toast.error("Couldn't assign speaker.");
          return;
        }
        const mappings = await upsertSpeakerMapping(
          speakerEditorRawId,
          participant.name,
          speakerEditorColor,
          participant.id,
        );
        if (mappings) {
          closeSpeakerEditor();
        }
        return;
      }

      const segmentIndex = speakerEditorSegmentIndex;
      if (segmentIndex === null || segmentIndex < 0) {
        toast.error("Couldn't assign this phrase speaker.");
        return;
      }

      let targetRawSpeakerId =
        detailSpeakerMappings.find(
          (mapping) => mapping.participant_id === participant.id,
        )?.raw_speaker_id ?? null;
      if (!targetRawSpeakerId) {
        targetRawSpeakerId = `manual_segment_${selectedMeeting.id}_${segmentIndex}_${Date.now()}`;
        const mappings = await upsertSpeakerMapping(
          targetRawSpeakerId,
          participant.name,
          speakerEditorColor,
          participant.id,
        );
        if (!mappings) {
          return;
        }
      }

      const transcript = await updateSingleTranscriptSegmentSpeaker(
        segmentIndex,
        targetRawSpeakerId,
      );
      if (transcript) {
        closeSpeakerEditor();
      }
    } finally {
      setSpeakerEditorSaving(false);
    }
  };

  const renderDetailTranscriptRevealContent = (
    meeting: MeetingEntry,
    options: { fullscreen?: boolean } = {},
  ) => {
    if (detailTranscript?.segments?.length) {
      const visibleSegments = detailTranscript.segments.slice(
        0,
        options.fullscreen ? 18 : 8,
      );

      return (
        <div className="meeting-transcript-ready-preview">
          <div className="flex flex-col gap-2">
            {visibleSegments.map((segment, index) => {
              const speakerMeta = getSpeakerMeta(segment.speaker_id);
              return (
                <div
                  key={`ready-${meeting.id}-${segment.start}-${index}`}
                  className="flex w-full items-start gap-3 rounded-lg border border-transparent px-3 py-2 text-left text-sm"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span
                        className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{
                          borderColor: `${speakerMeta.color}66`,
                          backgroundColor: `${speakerMeta.color}20`,
                          color: speakerMeta.color,
                        }}
                      >
                        {speakerMeta.displayName}
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                        {formatNoteTimestamp(segment.start)}
                      </span>
                    </div>
                    <div className="min-h-[20px] w-full rounded-md px-1 text-text">
                      {segment.text}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    if (detailTranscript?.text?.trim()) {
      return (
        <div className="meeting-transcript-ready-preview">
          <p className="text-sm text-text whitespace-pre-wrap">
            {detailTranscript.text}
          </p>
        </div>
      );
    }

    return null;
  };

  const renderDetailTranscriptContent = (
    meeting: MeetingEntry,
    options: { fullscreen?: boolean } = {},
  ) => {
    if (isDetailTranscriptPreparing || detailTranscriptRevealActive) {
      return (
        <TranscriptPreparingState
          fullscreen={options.fullscreen}
          revealing={detailTranscriptRevealActive}
          ariaLabel={t("meetingsPage.preparingTranscript", {
            defaultValue: "Preparing transcript",
          })}
          statusLabel={t("meetingsPage.preparing", {
            defaultValue: "Preparing",
          })}
          readyContent={
            detailTranscriptRevealActive
              ? renderDetailTranscriptRevealContent(meeting, options)
              : undefined
          }
        />
      );
    }

    if (detailTranscriptLoading) {
      return (
        <div
          className={
            options.fullscreen
              ? "flex h-full items-start pt-4 text-sm text-muted"
              : "py-6 text-sm text-muted"
          }
        >
          Loading transcript...
        </div>
      );
    }

    if (detailTranscript?.segments?.length) {
      return (
        <div
          className={
            options.fullscreen ? "h-full overflow-y-auto pr-1" : "mt-4"
          }
        >
          <div className="flex flex-col gap-2">
            {detailTranscript.segments.map((segment, index) => {
              const isActive =
                detailNoteOffset !== null &&
                Math.abs(detailNoteOffset - segment.start) < 0.5;
              const isPlaybackSegment = activePlaybackSegmentIndex === index;
              const isSegmentPlaying = isPlaybackSegment && detailIsPlaying;
              const isSavingEdit = savingTranscriptSegmentIndex === index;
              const speakerMeta = getSpeakerMeta(segment.speaker_id);
              return (
                <div
                  key={`${segment.start}-${index}`}
                  onMouseDown={(event) => {
                    const target = event.target as HTMLElement;
                    if (!target.closest("[data-transcript-editor='true']")) {
                      setDetailNoteOffset(segment.start);
                    }
                  }}
                  className={`group flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition ${
                    isPlaybackSegment
                      ? "border-transparent bg-blue-500/10"
                      : isActive
                        ? "border-border/70 bg-transparent"
                        : "border-transparent hover:border-border hover:bg-accent/5"
                  }`}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          openSegmentSpeakerEditor(
                            segment.speaker_id ?? null,
                            index,
                          );
                        }}
                        className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-opacity hover:opacity-90"
                        style={{
                          borderColor: `${speakerMeta.color}66`,
                          backgroundColor: `${speakerMeta.color}20`,
                          color: speakerMeta.color,
                        }}
                      >
                        {speakerMeta.displayName}
                      </button>
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                        {formatNoteTimestamp(segment.start)}
                      </span>
                    </div>
                    <div
                      data-transcript-editor="true"
                      contentEditable={!isSavingEdit}
                      suppressContentEditableWarning
                      onMouseDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => event.stopPropagation()}
                      onFocus={() => setDetailNoteOffset(segment.start)}
                      onBlur={(event) => {
                        void saveTranscriptSegmentEdit(
                          index,
                          event.currentTarget.textContent ?? "",
                        );
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          event.currentTarget.blur();
                          return;
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.currentTarget.textContent = segment.text;
                          event.currentTarget.blur();
                        }
                      }}
                      className={`min-h-[20px] w-full rounded-md px-1 text-text outline-none transition ${
                        isSavingEdit
                          ? "opacity-60"
                          : "focus:bg-accent/10 focus:ring-1 focus:ring-accent/30"
                      }`}
                    >
                      {segment.text}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void playMeetingSegment(meeting, segment.start);
                    }}
                    disabled={detailAudioLoading}
                    className={`flex h-7 w-7 items-center justify-center text-muted transition-colors ${
                      detailAudioLoading ? "opacity-40" : "hover:text-text"
                    } ${isPlaybackSegment ? "text-accent" : ""} opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`}
                    title={
                      detailAudioLoading
                        ? t("meetingsPage.audioLoading")
                        : isSegmentPlaying
                          ? "Pause"
                          : t("meetingsPage.play")
                    }
                    aria-label={
                      detailAudioLoading
                        ? t("meetingsPage.audioLoading")
                        : isSegmentPlaying
                          ? "Pause"
                          : t("meetingsPage.play")
                    }
                  >
                    {isSegmentPlaying ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    if (detailTranscript?.text?.trim()) {
      return (
        <div
          className={
            options.fullscreen ? "h-full overflow-y-auto pr-1" : "mt-4"
          }
        >
          <p className="text-sm text-text whitespace-pre-wrap">
            {detailTranscript.text}
          </p>
        </div>
      );
    }

    return (
      <div className="py-6 text-sm text-muted">
        {t("meetingsPage.transcriptEmpty")}
      </div>
    );
  };

  const renderDetailPlaybackBar = () => {
    if (!selectedMeeting) return null;

    const isVisible =
      detailPlayerVisible && detailPlayerMeetingId === selectedMeeting.id;
    const duration = Math.max(
      detailPlaybackDuration,
      selectedMeeting.duration_seconds,
      detailPlaybackTime,
      0,
    );
    const currentTime = Math.min(detailPlaybackTime, duration);
    const progressPercent =
      duration > 0
        ? Math.min(100, Math.max(0, (currentTime / duration) * 100))
        : 0;

    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[140] flex justify-center px-4">
        <div
          className={`liquid-glass flex w-full max-w-2xl items-center gap-3 rounded-full px-3 py-2 shadow-[0_18px_50px_-24px_rgb(0_0_0_/_0.45)] transition-[opacity,transform] duration-300 ease-out ${
            isVisible
              ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
              : "pointer-events-none translate-y-4 scale-[0.98] opacity-0"
          }`}
          aria-hidden={!isVisible}
        >
          <button
            type="button"
            onClick={() => void toggleDetailPlayerPlayback()}
            disabled={detailAudioLoading}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-[0_8px_24px_-12px_rgb(37_99_235_/_0.7)] transition-all duration-150 hover:bg-blue-500 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-400"
            title={
              detailAudioLoading
                ? t("meetingsPage.audioLoading")
                : detailIsPlaying
                  ? "Pause"
                  : t("meetingsPage.play")
            }
            aria-label={
              detailAudioLoading
                ? t("meetingsPage.audioLoading")
                : detailIsPlaying
                  ? "Pause meeting playback"
                  : "Play meeting playback"
            }
          >
            {detailIsPlaying ? (
              <Pause className="h-4 w-4" fill="currentColor" />
            ) : (
              <Play className="h-4 w-4 translate-x-px" fill="currentColor" />
            )}
          </button>

          <span className="min-w-[38px] text-xs tabular-nums text-muted">
            {formatDuration(currentTime)}
          </span>
          <input
            type="range"
            min="0"
            max={duration || 0}
            step="0.01"
            value={currentTime}
            onChange={handleDetailPlayerSeek}
            onMouseDown={() => setDetailPlayerDragging(true)}
            onTouchStart={() => setDetailPlayerDragging(true)}
            className="h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full border border-black/5 bg-white/70 shadow-[0_4px_12px_-10px_rgb(0_0_0_/_0.4)] backdrop-blur-2xl focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_rgba(59,130,246,0.45),0_0_0_4px_rgba(59,130,246,0.16)] dark:border-white/10 dark:bg-zinc-900/70"
            style={{
              background: `linear-gradient(to right, rgb(37 99 235) 0%, rgb(37 99 235) ${progressPercent}%, color-mix(in srgb, var(--color-border) 80%, transparent) ${progressPercent}%, color-mix(in srgb, var(--color-border) 80%, transparent) 100%)`,
            }}
            aria-label="Meeting playback timeline"
          />
          <span className="min-w-[38px] text-right text-xs tabular-nums text-muted">
            {formatDuration(duration)}
          </span>
        </div>
      </div>
    );
  };

  const renderDetailNotesPanel = (options: { fullscreen?: boolean } = {}) => {
    const expandedWidthClass = options.fullscreen
      ? "max-w-[24rem]"
      : "max-w-[22rem]";
    const panelWidthClass = options.fullscreen ? "w-[24rem]" : "w-[22rem]";
    const listClass = options.fullscreen
      ? "mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto"
      : "mt-4 max-h-72 space-y-2 overflow-y-auto";

    return (
      <div
        className={`overflow-hidden transition-[max-width,opacity,margin] duration-300 ease-out ${
          detailNotesPanelOpen
            ? `${expandedWidthClass} opacity-100 ${options.fullscreen ? "ml-4" : "mt-4 ml-4"}`
            : "max-w-0 opacity-0 pointer-events-none"
        }`}
      >
        <div
          className={`${panelWidthClass} ${
            options.fullscreen ? "h-full" : ""
          } flex flex-col rounded-xl border border-border bg-background/35 p-4`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-text">
              {t("meetingsPage.notesTitle")}
            </div>
            {detailNoteOffset !== null && (
              <span className="rounded-full border border-border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                {formatNoteTimestamp(detailNoteOffset)}
              </span>
            )}
          </div>
          <div className="mt-3">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <input
                ref={detailNoteInputRef}
                value={detailNoteDraft}
                onChange={(event) => setDetailNoteDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void addDetailNote();
                  }
                }}
                placeholder={t("meetingsPage.notesPlaceholder")}
                className="flex-1 bg-transparent text-sm text-text placeholder:text-muted focus:outline-none"
              />
            </div>
            <p className="mt-2 text-[11px] text-muted">
              {t("meetingsPage.notesHint")}
            </p>
          </div>
          <div className={listClass}>
            {detailNotesLoading ? (
              <p className="text-xs text-muted">
                {t("meetingsPage.notesLoading")}
              </p>
            ) : detailNotes.length === 0 ? (
              <p className="text-xs text-muted">
                {t("meetingsPage.notesEmpty")}
              </p>
            ) : (
              detailNotes.map((note) => {
                const createdAt = formatNoteCreatedAt(
                  note.created_at,
                  i18n.language,
                );
                return (
                  <div
                    key={note.id}
                    className="rounded-lg border border-border/70 bg-surface/60 px-3 py-2 text-text"
                  >
                    <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
                      <span title={createdAt.absolute}>
                        {createdAt.relative}
                      </span>
                      <span>{formatNoteRange(note)}</span>
                    </div>
                    <p className="mt-1 text-sm whitespace-pre-wrap break-words">
                      {note.text}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderParticipantsModalContent = () => {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border border-border bg-background/35 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">
              {t("meetingsPage.participants.linkedTitle", {
                defaultValue: "Linked participants",
              })}
            </div>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
              {selectedParticipantIds.length}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="flex -space-x-2">
              {selectedMeetingParticipants.slice(0, 5).map((participant) =>
                participant.photo_data_url ? (
                  <img
                    key={participant.id}
                    src={participant.photo_data_url}
                    alt={participant.name}
                    className="h-7 w-7 rounded-full border border-surface object-cover"
                  />
                ) : (
                  <span
                    key={participant.id}
                    className="flex h-7 w-7 items-center justify-center rounded-full border border-surface bg-border text-[10px] font-semibold text-muted"
                  >
                    {participant.name.slice(0, 1).toUpperCase()}
                  </span>
                ),
              )}
              {selectedMeetingParticipants.length > 5 && (
                <span className="flex h-7 w-7 items-center justify-center rounded-full border border-surface bg-background text-[10px] font-semibold text-muted">
                  +{selectedMeetingParticipants.length - 5}
                </span>
              )}
            </div>
            <span className="text-xs text-muted">
              {selectedMeetingParticipants.length === 0
                ? "No participants linked yet."
                : `${selectedMeetingParticipants.length} participant${
                    selectedMeetingParticipants.length === 1 ? "" : "s"
                  } linked`}
            </span>
          </div>
          <input
            value={participantQuery}
            onChange={(event) => setParticipantQuery(event.target.value)}
            placeholder="Search existing participants"
            className="mt-3 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-text placeholder:text-muted focus:outline-none"
          />
          <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-border bg-surface/50 p-2">
            {participantsLoading ? (
              <p className="px-2 py-2 text-xs text-muted">
                Loading participants...
              </p>
            ) : filteredParticipants.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted">
                {participants.length === 0
                  ? "No participants yet."
                  : "No participants match your search."}
              </p>
            ) : (
              filteredParticipants.map((participant) => {
                const isSelected = selectedParticipantIds.includes(
                  participant.id,
                );
                return (
                  <button
                    key={participant.id}
                    type="button"
                    onClick={() => {
                      void toggleMeetingParticipant(participant.id);
                    }}
                    disabled={participantSaveInFlight}
                    className={`mb-1 flex w-full items-center justify-between rounded-md border px-2 py-2 text-left text-xs transition-colors ${
                      isSelected
                        ? "border-accent/30 bg-accent/10 text-text"
                        : "border-border bg-background/60 text-text hover:bg-accent/5"
                    } ${participantSaveInFlight ? "opacity-70" : ""}`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {participant.photo_data_url ? (
                        <img
                          src={participant.photo_data_url}
                          alt={participant.name}
                          className="h-6 w-6 rounded-full object-cover"
                        />
                      ) : (
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-border text-[10px] font-semibold text-muted">
                          {participant.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {participant.name}
                        </span>
                        <span className="block truncate text-[10px] text-muted">
                          {participant.email ||
                            participant.phone ||
                            "No contact info"}
                        </span>
                      </span>
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
                      {isSelected ? "Linked" : "Link"}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-background/35 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t("meetingsPage.participants.addTitle", {
              defaultValue: "Add participant",
            })}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <input
              value={newParticipantName}
              onChange={(event) => setNewParticipantName(event.target.value)}
              placeholder="Name"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-text placeholder:text-muted focus:outline-none"
            />
            <input
              value={newParticipantEmail}
              onChange={(event) => setNewParticipantEmail(event.target.value)}
              placeholder="Email"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-text placeholder:text-muted focus:outline-none"
            />
            <input
              value={newParticipantPhone}
              onChange={(event) => setNewParticipantPhone(event.target.value)}
              placeholder="Phone"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-text placeholder:text-muted focus:outline-none"
            />
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                void handleParticipantPhotoPicked(event);
              }}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted file:mr-2 file:rounded file:border-0 file:bg-border file:px-2 file:py-1 file:text-xs file:text-text"
            />
          </div>
          {newParticipantPhotoDataUrl && (
            <div className="mt-2">
              <img
                src={newParticipantPhotoDataUrl}
                alt="New participant preview"
                className="h-10 w-10 rounded-full object-cover"
              />
            </div>
          )}
          <div className="mt-4">
            <Button
              size="sm"
              onClick={() => {
                void createNewParticipant();
              }}
              disabled={creatingParticipant || !newParticipantName.trim()}
              className="flex items-center gap-2"
            >
              <UserPlus className="h-3.5 w-3.5" />
              {creatingParticipant ? "Creating..." : "Create participant"}
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderSharingModalContent = () => {
    if (!selectedMeeting) return null;

    if (!authToken) {
      return (
        <div className="rounded-2xl border border-border/70 bg-surface/60 p-4">
          <p className="text-sm font-medium text-text">
            {t("meetingsPage.sharing.signInRequired", {
              defaultValue: "Sign in required",
            })}
          </p>
          <p className="mt-1 text-sm leading-6 text-muted">
            {t("meetingsPage.sharing.signInDescription", {
              defaultValue:
                "Sign in to upload this meeting to your BreezeType cloud account and manage sharing.",
            })}
          </p>
        </div>
      );
    }

    if (!selectedMeeting.sync_id) {
      return (
        <div className="rounded-2xl border border-border/70 bg-surface/60 p-4">
          <p className="text-sm font-medium text-text">
            {t("meetingsPage.sharing.preparingMeeting", {
              defaultValue: "Preparing meeting",
            })}
          </p>
          <p className="mt-1 text-sm leading-6 text-muted">
            {meetingSharesLoading
              ? t("meetingsPage.sharing.uploadingMeeting", {
                  defaultValue:
                    "Uploading this meeting to your BreezeType cloud account...",
                })
              : t("meetingsPage.sharing.notReady", {
                  defaultValue:
                    "This meeting is not ready for cloud sharing yet. Try again in a moment.",
                })}
          </p>
          {meetingSharesLoading ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("meetingsPage.sharing.preparingSettings", {
                defaultValue: "Preparing sharing settings...",
              })}
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 dark:border-blue-400/20 dark:bg-blue-400/10">
          <div className="flex gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-300">
              <Cloud className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-medium text-text">
                {t("meetingsPage.sharing.cloudNoticeTitle", {
                  defaultValue:
                    "Sharing uploads this meeting to BreezeType Cloud.",
                })}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">
                {t("meetingsPage.sharing.cloudNoticeBody", {
                  defaultValue:
                    "It is stored securely in your cloud account. Only people you choose can access it, unless you create a public URL that anyone with the link can open.",
                })}
              </p>
            </div>
          </div>
        </div>

        {meetingSharesLoading ? (
          <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-surface/60 p-4 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("meetingsPage.sharing.preparingSettings", {
              defaultValue: "Preparing sharing settings...",
            })}
          </div>
        ) : null}

        <section className="rounded-2xl border border-border/70 bg-surface/60 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-text">
                <Link2 className="h-4 w-4 text-muted" />
                {t("meetingsPage.sharing.publicUrl", {
                  defaultValue: "Public URL",
                })}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted">
                {t("meetingsPage.sharing.publicUrlDescription", {
                  defaultValue:
                    "Create a short link for people who do not need a BreezeType account. Disable it anytime.",
                })}
              </p>
            </div>
            {meetingPublicShare?.url ? (
              <Button
                size="sm"
                variant="secondary"
                className="min-h-9 rounded-xl px-3 py-2 text-xs"
                onClick={() => void disablePublicShareForSelectedMeeting()}
                disabled={meetingShareBusy}
              >
                {t("meetingsPage.sharing.makePrivate", {
                  defaultValue: "Make private",
                })}
              </Button>
            ) : (
              <Button
                size="sm"
                className="min-h-9 rounded-xl px-3 py-2 text-xs"
                onClick={() => void enablePublicShareForSelectedMeeting()}
                disabled={meetingShareBusy || meetingSharesLoading}
              >
                {t("meetingsPage.sharing.createLink", {
                  defaultValue: "Create link",
                })}
              </Button>
            )}
          </div>

          {meetingPublicShare?.url ? (
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-border/60 bg-background/70 px-3 py-2">
              <a
                href={meetingPublicShare.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-xs text-accent"
              >
                {meetingPublicShare.url}
              </a>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                className="h-8 w-8 rounded-lg"
                onClick={() => void copyPublicShareUrl()}
                title="Copy public link"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl border border-border/70 bg-surface/60 p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background/70 text-muted">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-text">
                <Mail className="h-4 w-4 text-muted" />
                {t("meetingsPage.sharing.shareByEmail", {
                  defaultValue: "Share by email",
                })}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted">
                {t("meetingsPage.sharing.shareByEmailDescription", {
                  defaultValue:
                    "We will send a secure invite. Recipients sign in or create an account with that email before viewing.",
                })}
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Input
              value={shareEmailDraft}
              onChange={(event) => setShareEmailDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void shareSelectedMeetingToEmail();
                }
              }}
              placeholder="teammate@company.com"
              className="h-10 text-sm"
            />
            <Button
              size="sm"
              className="min-h-10 rounded-xl px-3 py-2 text-xs"
              onClick={() => void shareSelectedMeetingToEmail()}
              disabled={
                meetingShareBusy ||
                meetingSharesLoading ||
                !shareEmailDraft.trim().length
              }
            >
              <Send className="h-3.5 w-3.5" />
              {t("meetingsPage.sharing.send", { defaultValue: "Send" })}
            </Button>
          </div>

          <div className="mt-4 space-y-2">
            {activeMeetingUserShares.length === 0 ? (
              <p className="text-xs text-muted">
                {t("meetingsPage.sharing.noEmailInvites", {
                  defaultValue: "No email invites yet.",
                })}
              </p>
            ) : (
              activeMeetingUserShares.map((share) => (
                <div
                  key={share.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">
                      {share.target_name || share.target_email}
                    </p>
                    <p className="truncate text-[11px] text-muted">
                      {share.target_user_id
                        ? "BreezeType account"
                        : "Invite sent"}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-8 rounded-xl px-3 py-1.5 text-[11px]"
                    onClick={() => void revokeSelectedMeetingShare(share.id)}
                    disabled={meetingShareBusy}
                  >
                    {t("meetingsPage.sharing.revoke", {
                      defaultValue: "Revoke",
                    })}
                  </Button>
                </div>
              ))
            )}
          </div>
        </section>

        {(meetingShareError || meetingShareMessage) && (
          <p
            className={`rounded-xl px-3 py-2 text-xs ${
              meetingShareError
                ? "bg-red-500/10 text-red-500"
                : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            }`}
          >
            {meetingShareError || meetingShareMessage}
          </p>
        )}
      </div>
    );
  };

  const updateRecordingNoteDraft = (nextValue: string) => {
    const wasEmpty = recordingNoteDraft.trim().length === 0;
    const isEmpty = nextValue.trim().length === 0;
    if (wasEmpty && !isEmpty) {
      setRecordingNoteStartOffset(getCurrentRecordingOffset());
    }
    if (isEmpty) {
      setRecordingNoteStartOffset(null);
    }
    setRecordingNoteDraft(nextValue);
  };

  const addRecordingNote = async () => {
    const trimmed = recordingNoteDraft.trim();
    if (!trimmed) return;
    const endOffsetSeconds = getCurrentRecordingOffset();
    const startOffsetSeconds = recordingNoteStartOffset ?? endOffsetSeconds;
    const result = await commands.addMeetingNoteSpan(
      startOffsetSeconds,
      endOffsetSeconds,
      trimmed,
    );
    if (result.status === "ok") {
      setRecordingNotes((prev) =>
        [...prev, result.data].sort(
          (a, b) => a.start_offset_seconds - b.start_offset_seconds,
        ),
      );
      setRecordingNoteDraft("");
      setRecordingNoteStartOffset(null);
    } else {
      toast.error(result.error ?? t("meetingsPage.noteError"));
    }
  };

  const ensureMeetingAudioUrl = async (
    meeting: MeetingEntry,
  ): Promise<string | null> => {
    const existing = audioUrls[meeting.id];
    if (existing) return existing;

    setDetailAudioLoading(true);
    try {
      const result = await commands.getMeetingAudioFilePath(meeting.file_name);
      if (result.status === "ok") {
        const url = convertFileSrc(`${result.data}`, "asset");
        setAudioUrls((prev) => ({ ...prev, [meeting.id]: url }));
        return url;
      }
      toast.error(result.error ?? t("meetingsPage.audioError"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("meetingsPage.audioError"),
      );
    } finally {
      setDetailAudioLoading(false);
    }

    return null;
  };

  const playMeetingAt = async (meeting: MeetingEntry, start: number) => {
    const url = await ensureMeetingAudioUrl(meeting);
    if (!url) return;

    const audio = detailAudioRef.current;
    if (!audio) return;

    const sourceChanged = audio.src !== url;
    if (sourceChanged) {
      audio.src = url;
      setDetailPlaybackDuration(0);
    }

    setDetailPlayerMeetingId(meeting.id);
    setDetailPlayerVisible(true);

    const seekAndPlay = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      const safeStart =
        duration > 0 ? Math.min(Math.max(start, 0), duration - 0.1) : start;
      audio.currentTime = Math.max(0, safeStart);
      setDetailPlaybackTime(Math.max(0, safeStart));
      if (duration > 0) {
        setDetailPlaybackDuration(duration);
      }
      audio
        .play()
        .then(() => {
          setDetailIsPlaying(true);
        })
        .catch((error) => {
          setDetailIsPlaying(false);
          console.warn("Failed to play meeting audio segment:", error);
        });
    };

    if (
      !sourceChanged &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0
    ) {
      seekAndPlay();
      return;
    }

    const handleLoaded = () => {
      audio.removeEventListener("loadedmetadata", handleLoaded);
      seekAndPlay();
    };
    audio.addEventListener("loadedmetadata", handleLoaded);
    audio.load();
  };

  const playMeetingFromBeginning = async (meeting: MeetingEntry) => {
    await playMeetingAt(meeting, 0);
  };

  const playMeetingSegment = async (meeting: MeetingEntry, start: number) => {
    const activeSegment =
      activePlaybackSegmentIndex !== null
        ? detailTranscript?.segments?.[activePlaybackSegmentIndex]
        : null;
    const isSameSegment =
      !!activeSegment && Math.abs(activeSegment.start - start) < 0.5;

    if (isSameSegment && detailIsPlaying) {
      detailAudioRef.current?.pause();
      return;
    }

    await playMeetingAt(meeting, start);
  };

  const toggleDetailPlayerPlayback = async () => {
    if (!selectedMeeting) return;

    const audio = detailAudioRef.current;
    if (!audio || !audio.src || detailPlayerMeetingId !== selectedMeeting.id) {
      await playMeetingFromBeginning(selectedMeeting);
      return;
    }

    if (detailIsPlaying) {
      audio.pause();
      return;
    }

    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    if (duration > 0 && audio.currentTime >= duration - 0.1) {
      audio.currentTime = 0;
      setDetailPlaybackTime(0);
    }

    setDetailPlayerVisible(true);
    try {
      await audio.play();
      setDetailIsPlaying(true);
    } catch (error) {
      setDetailIsPlaying(false);
      console.warn("Failed to play meeting audio:", error);
    }
  };

  const handleDetailPlayerSeek = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const nextTime = Number.parseFloat(event.target.value);
    if (!Number.isFinite(nextTime)) return;

    const boundedTime = Math.max(0, nextTime);
    setDetailPlaybackTime(boundedTime);

    const audio = detailAudioRef.current;
    if (audio) {
      audio.currentTime = boundedTime;
    }
  };

  const addDetailNote = async () => {
    if (!selectedMeeting) return;
    const trimmed = detailNoteDraft.trim();
    if (!trimmed) return;
    const offset =
      detailNoteOffset ?? Math.max(0, selectedMeeting.duration_seconds);
    const result = await commands.addMeetingNoteAt(
      selectedMeeting.id,
      offset,
      trimmed,
    );
    if (result.status === "ok") {
      setDetailNotes((prev) => {
        const next = [...prev, result.data];
        return next.sort(
          (a, b) => a.start_offset_seconds - b.start_offset_seconds,
        );
      });
      setDetailNoteDraft("");
    } else {
      toast.error(result.error ?? t("meetingsPage.noteError"));
    }
  };

  const copyTranscript = async () => {
    if (!detailTranscript) return;
    const buildClipboardTranscript = () => {
      const segments = detailTranscript.segments ?? [];
      if (segments.length === 0) {
        return detailTranscript.text.trim();
      }

      const grouped: Array<{ speaker: string; text: string }> = [];
      for (const segment of segments) {
        const text = segment.text.trim();
        if (!text) continue;
        const speakerName = getSpeakerMeta(segment.speaker_id).displayName;
        const previous = grouped[grouped.length - 1];
        if (previous && previous.speaker === speakerName) {
          previous.text = `${previous.text} ${text}`.trim();
        } else {
          grouped.push({ speaker: speakerName, text });
        }
      }

      if (grouped.length === 0) {
        return detailTranscript.text.trim();
      }

      return grouped
        .map((entry) => `${entry.speaker}: ${entry.text}`)
        .join("\n\n");
    };

    const transcriptForClipboard = buildClipboardTranscript();
    if (!transcriptForClipboard) return;

    try {
      await navigator.clipboard.writeText(transcriptForClipboard);
      toast.success(t("meetingsPage.transcriptCopied"));
    } catch (error) {
      toast.error(t("meetingsPage.transcriptCopyError"));
    }
  };

  const loadParticipantContext = async (meetingId: number) => {
    setParticipantsLoading(true);
    try {
      const [allParticipantsResult, meetingParticipantsResult] =
        await Promise.all([
          commands.getParticipants(),
          commands.getMeetingParticipants(meetingId),
        ]);

      if (allParticipantsResult.status === "ok") {
        setParticipants(allParticipantsResult.data);
      }
      if (meetingParticipantsResult.status === "ok") {
        setSelectedParticipantIds(
          meetingParticipantsResult.data.map((participant) => participant.id),
        );
      } else {
        setSelectedParticipantIds([]);
      }
    } finally {
      setParticipantsLoading(false);
    }
  };

  const saveMeetingParticipants = async (
    meetingId: number,
    participantIds: number[],
  ) => {
    setParticipantSaveInFlight(true);
    try {
      const deduped = Array.from(new Set(participantIds));
      const result = await commands.setMeetingParticipants(meetingId, deduped);
      if (result.status === "ok") {
        setSelectedParticipantIds(
          result.data.map((participant) => participant.id),
        );
      } else {
        toast.error(result.error ?? "Couldn't update participants.");
      }
    } finally {
      setParticipantSaveInFlight(false);
    }
  };

  const toggleMeetingParticipant = async (participantId: number) => {
    if (!selectedMeeting) return;
    const existing = new Set(selectedParticipantIds);
    if (existing.has(participantId)) {
      existing.delete(participantId);
    } else {
      existing.add(participantId);
    }
    await saveMeetingParticipants(selectedMeeting.id, Array.from(existing));
  };

  const handleParticipantPhotoPicked = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      setNewParticipantPhotoDataUrl(null);
      return;
    }
    const reader = new FileReader();
    const dataUrl = await new Promise<string | null>((resolve) => {
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : null;
        resolve(result);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    setNewParticipantPhotoDataUrl(dataUrl);
  };

  const createNewParticipant = async () => {
    if (!selectedMeeting) return;
    const request: CreateMeetingParticipantRequest = {
      name: newParticipantName.trim(),
      email: newParticipantEmail.trim() || null,
      phone: newParticipantPhone.trim() || null,
      photo_data_url: newParticipantPhotoDataUrl,
    };
    if (!request.name) {
      toast.error("Participant name is required.");
      return;
    }

    setCreatingParticipant(true);
    try {
      const result = await commands.createParticipant(request);
      if (result.status !== "ok") {
        toast.error(result.error ?? "Couldn't create participant.");
        return;
      }
      const created = result.data;
      setParticipants((prev) =>
        [...prev, created].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        ),
      );
      setNewParticipantName("");
      setNewParticipantEmail("");
      setNewParticipantPhone("");
      setNewParticipantPhotoDataUrl(null);
      await saveMeetingParticipants(selectedMeeting.id, [
        ...selectedParticipantIds,
        created.id,
      ]);
    } finally {
      setCreatingParticipant(false);
    }
  };

  const clearMeetingShareState = () => {
    setMeetingPublicShare(null);
    setMeetingUserShares([]);
    setMeetingSharesLoading(false);
    setMeetingShareBusy(false);
    setMeetingShareError(null);
    setMeetingShareMessage(null);
    setShareEmailDraft("");
  };

  const getMeetingSharingErrorMessage = (error: unknown, fallback: string) => {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    const normalizedMessage = message.toLowerCase();

    if (normalizedMessage.includes("error decoding response body")) {
      return "BreezeType couldn't read the cloud sync response. Try again in a moment.";
    }
    if (message === "Meeting not found.") {
      return "This meeting is not available in your BreezeType cloud account yet. Try again in a moment.";
    }

    return message || fallback;
  };

  const syncMeetingsForCloudActions = async () => {
    if (!authToken || !authUserId) {
      return false;
    }

    try {
      const result = await commands.syncMeetingsWithServer(
        getServerUrl(),
        authToken,
        authUserId,
      );
      if (result.status !== "ok") {
        const message = getMeetingSharingErrorMessage(
          result.error,
          "Couldn't sync meetings.",
        );
        toast.error(message);
        setMeetingShareError(message);
        return false;
      }
    } catch (error) {
      const message = getMeetingSharingErrorMessage(
        error,
        "Couldn't sync meetings.",
      );
      toast.error(message);
      setMeetingShareError(message);
      return false;
    }

    return true;
  };

  const loadMeetingShareState = async (
    syncId: string,
    options: { silent?: boolean } = {},
  ) => {
    if (!syncId || !authToken) {
      clearMeetingShareState();
      return;
    }
    const { silent = false } = options;
    if (!silent) {
      setMeetingSharesLoading(true);
    }
    setMeetingShareError(null);
    try {
      const data = await fetchMeetingShares(getServerUrl(), authToken, syncId);
      setMeetingPublicShare(data.public_share);
      setMeetingUserShares(data.user_shares);
    } catch (error) {
      setMeetingPublicShare(null);
      setMeetingUserShares([]);
      setMeetingShareError(
        getMeetingSharingErrorMessage(
          error,
          "Couldn't load meeting sharing settings.",
        ),
      );
    } finally {
      setMeetingSharesLoading(false);
    }
  };

  const openSharingForSelectedMeeting = async () => {
    if (!selectedMeeting || meetingShareBusy) return;

    setDetailSharingModalOpen(true);
    setMeetingShareError(null);
    setMeetingShareMessage(null);

    if (!authToken || !authUserId) {
      clearMeetingShareState();
      return;
    }

    setMeetingSharesLoading(true);
    setMeetingShareBusy(true);
    try {
      const synced = await syncMeetingsForCloudActions();
      if (!synced) return;

      let syncId = selectedMeeting.sync_id;
      const result = await commands.getMeetings();
      if (result.status === "ok") {
        setMeetings(result.data);
        const refreshedMeeting = result.data.find(
          (meeting) => meeting.id === selectedMeeting.id,
        );
        syncId = refreshedMeeting?.sync_id || syncId;
      }

      if (!syncId) {
        setMeetingShareError(
          "This meeting is not ready for cloud sharing yet.",
        );
        return;
      }

      await loadMeetingShareState(syncId, { silent: true });
    } catch (error) {
      setMeetingShareError(
        getMeetingSharingErrorMessage(
          error,
          "Couldn't prepare meeting sharing.",
        ),
      );
    } finally {
      setMeetingSharesLoading(false);
      setMeetingShareBusy(false);
    }
  };

  const enablePublicShareForSelectedMeeting = async () => {
    if (!selectedMeeting?.sync_id || !authToken || meetingShareBusy) return;

    setMeetingShareBusy(true);
    setMeetingShareError(null);
    setMeetingShareMessage(null);

    try {
      const synced = await syncMeetingsForCloudActions();
      if (!synced) {
        return;
      }
      const share = await enablePublicMeetingShare(
        getServerUrl(),
        authToken,
        selectedMeeting.sync_id,
      );
      setMeetingPublicShare(share);
      setMeetingShareMessage("Public link enabled.");
    } catch (error) {
      setMeetingShareError(
        error instanceof Error ? error.message : "Couldn't enable public link.",
      );
    } finally {
      setMeetingShareBusy(false);
    }
  };

  const disablePublicShareForSelectedMeeting = async () => {
    if (!selectedMeeting?.sync_id || !authToken || meetingShareBusy) return;

    setMeetingShareBusy(true);
    setMeetingShareError(null);
    setMeetingShareMessage(null);

    try {
      await disablePublicMeetingShare(
        getServerUrl(),
        authToken,
        selectedMeeting.sync_id,
      );
      setMeetingPublicShare(null);
      setMeetingShareMessage(
        "Public link disabled. Existing URL no longer works.",
      );
    } catch (error) {
      setMeetingShareError(
        error instanceof Error
          ? error.message
          : "Couldn't disable public link.",
      );
    } finally {
      setMeetingShareBusy(false);
    }
  };

  const shareSelectedMeetingToEmail = async () => {
    if (!selectedMeeting?.sync_id || !authToken || meetingShareBusy) return;
    const email = shareEmailDraft.trim().toLowerCase();
    if (!email) {
      setMeetingShareError("Enter an email address.");
      return;
    }

    setMeetingShareBusy(true);
    setMeetingShareError(null);
    setMeetingShareMessage(null);
    try {
      const synced = await syncMeetingsForCloudActions();
      if (!synced) {
        return;
      }
      await shareMeetingToEmail(
        getServerUrl(),
        authToken,
        selectedMeeting.sync_id,
        email,
      );
      setShareEmailDraft("");
      setMeetingShareMessage(`Invite sent to ${email}.`);
      await loadMeetingShareState(selectedMeeting.sync_id, { silent: true });
    } catch (error) {
      setMeetingShareError(
        error instanceof Error ? error.message : "Couldn't share meeting.",
      );
    } finally {
      setMeetingShareBusy(false);
    }
  };

  const revokeSelectedMeetingShare = async (shareId: string) => {
    if (!selectedMeeting?.sync_id || !authToken || meetingShareBusy) return;

    setMeetingShareBusy(true);
    setMeetingShareError(null);
    setMeetingShareMessage(null);
    try {
      await revokeMeetingShare(
        getServerUrl(),
        authToken,
        selectedMeeting.sync_id,
        shareId,
      );
      setMeetingShareMessage("Meeting access revoked.");
      await loadMeetingShareState(selectedMeeting.sync_id, { silent: true });
    } catch (error) {
      setMeetingShareError(
        error instanceof Error
          ? error.message
          : "Couldn't revoke sharing access.",
      );
    } finally {
      setMeetingShareBusy(false);
    }
  };

  const copyPublicShareUrl = async () => {
    if (!meetingPublicShare?.url) return;
    try {
      await navigator.clipboard.writeText(meetingPublicShare.url);
      toast.success("Public link copied.");
    } catch (error) {
      toast.error("Couldn't copy public link.");
    }
  };

  useEffect(() => {
    const initialize = async () => {
      await refreshRecordingState();
      await loadMeetings();
      await loadDeletedMeetings();
      await loadTags();
    };
    void initialize();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenStarted: (() => void) | null = null;
    let unlistenStopped: (() => void) | null = null;
    let unlistenUpdated: (() => void) | null = null;

    const refreshMeetings = async () => {
      if (cancelled) return;
      await loadMeetings();
      if (cancelled) return;
      await loadTags();
    };

    const syncRecordingState = async () => {
      if (cancelled) return;
      const active = await refreshRecordingState();
      if (!active) {
        setRecordingNoteDraft("");
        setRecordingNoteStartOffset(null);
      }
    };

    const setup = async () => {
      const [started, stopped, updated] = await Promise.all([
        listen<ActiveMeetingInfo>("meeting-recording-started", (event) => {
          setLastRecordedId(null);
          setActiveMeeting(event.payload);
          setIsRecording(true);
          setSelectedMeetingId(null);
          setRecordingNotes([]);
          setRecordingNoteDraft("");
          setRecordingNoteStartOffset(null);
          setLiveTranscript({ text: "", segments: [] });
          void syncRecordingState();
        }),
        listen<MeetingEntry>("meeting-recording-stopped", (event) => {
          setLastRecordedId(event.payload.id);
          setMeetings((prev) => {
            const filtered = prev.filter(
              (entry) => entry.id !== event.payload.id,
            );
            return [event.payload, ...filtered];
          });
          openMeetingDetail(event.payload);
          void syncRecordingState();
          void refreshMeetings();
        }),
        listen("meetings-updated", () => {
          void refreshMeetings();
        }),
      ]);

      if (cancelled) {
        started();
        stopped();
        updated();
        return;
      }

      unlistenStarted = started;
      unlistenStopped = stopped;
      unlistenUpdated = updated;
    };

    void setup();

    return () => {
      cancelled = true;
      if (unlistenStarted) {
        unlistenStarted();
      }
      if (unlistenStopped) {
        unlistenStopped();
      }
      if (unlistenUpdated) {
        unlistenUpdated();
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      Object.keys(softDeleteTimersRef.current).forEach((meetingId) => {
        clearSoftDeleteTimer(Number(meetingId));
      });
      Object.keys(permanentDeleteTimersRef.current).forEach((meetingId) => {
        clearPermanentDeleteTimers(Number(meetingId));
      });
    };
  }, []);

  useEffect(() => {
    detailPlayerDraggingRef.current = detailPlayerDragging;
  }, [detailPlayerDragging]);

  useEffect(() => {
    if (!detailPlayerDragging) return;

    const stopDragging = () => setDetailPlayerDragging(false);
    document.addEventListener("mouseup", stopDragging);
    document.addEventListener("touchend", stopDragging);

    return () => {
      document.removeEventListener("mouseup", stopDragging);
      document.removeEventListener("touchend", stopDragging);
    };
  }, [detailPlayerDragging]);

  useEffect(() => {
    if (!detailIsPlaying) return;

    let frameId = 0;
    const tick = () => {
      const audio = detailAudioRef.current;
      if (audio && !detailPlayerDraggingRef.current) {
        setDetailPlaybackTime(audio.currentTime || 0);
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          setDetailPlaybackDuration(audio.duration);
        }
      }
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [detailIsPlaying]);

  useEffect(() => {
    if (!activeMeeting) {
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const activeMeetingId = activeMeeting.id;

    const refreshLiveTranscript = async () => {
      const result = await commands.getActiveMeetingLiveTranscript();
      if (cancelled || result.status !== "ok") {
        return;
      }
      const nextTranscript = result.data;
      if (nextTranscript) {
        setLiveTranscript((current) =>
          liveTranscriptSnapshotsMatch(current, nextTranscript)
            ? current
            : nextTranscript,
        );
      }
    };

    const setup = async () => {
      unlisten = await listen<MeetingLiveTranscriptUpdate>(
        "meeting-live-transcript",
        (event) => {
          if (event.payload.meeting_id !== activeMeetingId) {
            return;
          }
          setLiveTranscript((current) =>
            liveTranscriptSnapshotsMatch(current, event.payload.transcript)
              ? current
              : event.payload.transcript,
          );
        },
      );
    };

    void setup();
    void refreshLiveTranscript();
    const pollId = window.setInterval(() => {
      void refreshLiveTranscript();
    }, LIVE_TRANSCRIPT_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(pollId);
      if (unlisten) {
        unlisten();
      }
    };
  }, [activeMeeting?.id]);

  useEffect(() => {
    if (!activeMeeting) {
      setRecordingElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      setRecordingElapsedSeconds(
        Math.max(0, Date.now() / 1000 - activeMeeting.started_at),
      );
    };

    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(interval);
  }, [activeMeeting]);

  useEffect(() => {
    if (!selectedMeetingId) {
      setDetailTranscriptFullscreenOpen(false);
      setDetailTranscriptMenuOpen(false);
      setDetailTranscriptFullscreenMenuOpen(false);
      setDetailNotesPanelOpen(false);
      setDetailParticipantsModalOpen(false);
      setDetailSharingModalOpen(false);
    }
    if (detailTranscriptRevealTimerRef.current !== null) {
      window.clearTimeout(detailTranscriptRevealTimerRef.current);
      detailTranscriptRevealTimerRef.current = null;
    }
    setDetailTranscriptRevealActive(false);
    detailTranscriptWasPreparingRef.current = false;
  }, [selectedMeetingId]);

  useEffect(() => {
    if (isDetailTranscriptPreparing) {
      if (detailTranscriptRevealTimerRef.current !== null) {
        window.clearTimeout(detailTranscriptRevealTimerRef.current);
        detailTranscriptRevealTimerRef.current = null;
      }
      setDetailTranscriptRevealActive(false);
      detailTranscriptWasPreparingRef.current = true;
      return;
    }

    if (detailTranscriptWasPreparingRef.current && hasDetailTranscriptContent) {
      setDetailTranscriptRevealActive(true);
      if (detailTranscriptRevealTimerRef.current !== null) {
        window.clearTimeout(detailTranscriptRevealTimerRef.current);
      }
      detailTranscriptRevealTimerRef.current = window.setTimeout(() => {
        setDetailTranscriptRevealActive(false);
        detailTranscriptRevealTimerRef.current = null;
      }, TRANSCRIPT_READY_REVEAL_MS);
    } else if (!hasDetailTranscriptContent) {
      setDetailTranscriptRevealActive(false);
    }

    detailTranscriptWasPreparingRef.current = false;
  }, [hasDetailTranscriptContent, isDetailTranscriptPreparing]);

  useEffect(() => {
    if (detailTranscriptFullscreenOpen) {
      if (fullscreenCloseTimerRef.current !== null) {
        window.clearTimeout(fullscreenCloseTimerRef.current);
        fullscreenCloseTimerRef.current = null;
      }
      setDetailTranscriptFullscreenMounted(true);
      const frame = window.requestAnimationFrame(() => {
        setDetailTranscriptFullscreenVisible(true);
      });
      return () => window.cancelAnimationFrame(frame);
    }

    setDetailTranscriptFullscreenVisible(false);
    if (!detailTranscriptFullscreenMounted) return;
    if (fullscreenCloseTimerRef.current !== null) {
      window.clearTimeout(fullscreenCloseTimerRef.current);
    }
    fullscreenCloseTimerRef.current = window.setTimeout(() => {
      setDetailTranscriptFullscreenMounted(false);
      setDetailTranscriptFullscreenMenuOpen(false);
      fullscreenCloseTimerRef.current = null;
    }, MODAL_TRANSITION_MS);
  }, [detailTranscriptFullscreenOpen, detailTranscriptFullscreenMounted]);

  useEffect(() => {
    return () => {
      if (fullscreenCloseTimerRef.current !== null) {
        window.clearTimeout(fullscreenCloseTimerRef.current);
      }
      if (speakerEditorCloseTimerRef.current !== null) {
        window.clearTimeout(speakerEditorCloseTimerRef.current);
      }
      if (detailTranscriptRevealTimerRef.current !== null) {
        window.clearTimeout(detailTranscriptRevealTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!detailTranscriptFullscreenOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDetailTranscriptFullscreenOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [detailTranscriptFullscreenOpen]);

  useEffect(() => {
    if (detailTranscriptFullscreenOpen) return;
    setDetailTranscriptFullscreenMenuOpen(false);
  }, [detailTranscriptFullscreenOpen]);

  useEffect(() => {
    if (!detailTranscriptFullscreenOpen) return;
    setDetailTranscriptMenuOpen(false);
  }, [detailTranscriptFullscreenOpen]);

  useEffect(() => {
    if (!isRecording) return;
    const container = liveTranscriptRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [isRecording, liveTranscript.text]);

  useEffect(() => {
    if (!filterOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!filterMenuRef.current) return;
      if (!filterMenuRef.current.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [filterOpen]);

  useEffect(() => {
    if (tagEditorId === null) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!tagMenuRef.current) return;
      if (!tagMenuRef.current.contains(event.target as Node)) {
        setTagEditorId(null);
        setTagQuery("");
      }
    };
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [tagEditorId]);

  useEffect(() => {
    if (!detailTranscriptMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!detailTranscriptMenuRef.current) return;
      if (!detailTranscriptMenuRef.current.contains(event.target as Node)) {
        setDetailTranscriptMenuOpen(false);
      }
    };
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [detailTranscriptMenuOpen]);

  useEffect(() => {
    if (!detailTranscriptFullscreenMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!detailTranscriptFullscreenMenuRef.current) return;
      if (
        !detailTranscriptFullscreenMenuRef.current.contains(
          event.target as Node,
        )
      ) {
        setDetailTranscriptFullscreenMenuOpen(false);
      }
    };
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [detailTranscriptFullscreenMenuOpen]);

  useEffect(() => {
    if (!selectedMeetingId) {
      setDetailTranscript(null);
      setDetailNotes([]);
      setDetailSpeakerMappings([]);
      setDetailDiarizationStatus(null);
      setDetailTranscriptLoading(false);
      setDetailNotesLoading(false);
      setParticipants([]);
      setSelectedParticipantIds([]);
      setParticipantsLoading(false);
      setNewParticipantName("");
      setNewParticipantEmail("");
      setNewParticipantPhone("");
      setNewParticipantPhotoDataUrl(null);
      setSavingTranscriptSegmentIndex(null);
      setDetailParticipantsModalOpen(false);
      setDetailSharingModalOpen(false);
      setParticipantQuery("");
      closeSpeakerEditor();
      diarizationStatusRef.current = null;
      clearMeetingShareState();
      return;
    }

    let cancelled = false;
    let transcriptRetryTimer: number | null = null;
    const selectedMeetingIsFresh = selectedMeetingId === lastRecordedId;

    setDetailTranscript(null);
    setDetailNotes([]);
    setDetailSpeakerMappings([]);
    setDetailDiarizationStatus(null);
    setDetailTranscriptLoading(true);
    setDetailNotesLoading(true);
    diarizationStatusRef.current = null;

    const initializeDiarization = async (
      transcript: MeetingTranscript | null,
    ) => {
      await loadSpeakerMappings(selectedMeetingId);
      if (cancelled) return;
      const status = await loadDiarizationStatus(selectedMeetingId);
      if (cancelled) return;

      const hasSegments = Boolean(transcript?.segments?.length);
      const hasAssignedSpeaker = Boolean(
        transcript?.segments?.some((segment) => !!segment.speaker_id?.trim()),
      );
      const shouldRun =
        hasSegments &&
        !hasAssignedSpeaker &&
        (status?.status === "idle" || status?.status === "failed" || !status);
      if (shouldRun) {
        await runDiarization(selectedMeetingId);
      }
    };

    const loadTranscript = async (attempt = 1) => {
      const result = await commands.getMeetingTranscript(selectedMeetingId);
      if (cancelled) return;

      if (result.status === "ok") {
        setDetailTranscript(result.data);
        setDetailTranscriptLoading(false);
        void initializeDiarization(result.data);
        return;
      }

      const message = result.error ?? t("meetingsPage.transcriptError");
      if (
        selectedMeetingIsFresh &&
        isTransientMeetingAudioError(message) &&
        attempt < TRANSCRIPT_PROCESSING_MAX_ATTEMPTS
      ) {
        transcriptRetryTimer = window.setTimeout(() => {
          transcriptRetryTimer = null;
          void loadTranscript(attempt + 1);
        }, TRANSCRIPT_PROCESSING_RETRY_MS);
        return;
      }

      setDetailTranscriptLoading(false);
      toast.error(message);
    };

    const loadNotes = async () => {
      const result = await commands.getMeetingNotes(selectedMeetingId);
      if (cancelled) return;
      if (result.status === "ok") {
        setDetailNotes(result.data);
      }
      setDetailNotesLoading(false);
    };

    const loadParticipants = async () => {
      await loadParticipantContext(selectedMeetingId);
    };

    void loadTranscript();
    void loadNotes();
    void loadParticipants();

    return () => {
      cancelled = true;
      if (transcriptRetryTimer !== null) {
        window.clearTimeout(transcriptRetryTimer);
      }
    };
  }, [lastRecordedId, selectedMeetingId, t]);

  useEffect(() => {
    if (!selectedMeetingId) return;
    if (detailDiarizationStatus?.status !== "running") return;

    const poll = () => {
      void loadDiarizationStatus(selectedMeetingId);
    };
    poll();
    const intervalId = window.setInterval(poll, DIARIZATION_STATUS_POLL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [selectedMeetingId, detailDiarizationStatus?.status]);

  useEffect(() => {
    if (selectedMeetingId && !selectedMeeting) {
      closeMeetingDetail();
    }
  }, [selectedMeetingId, selectedMeeting]);

  useEffect(() => {
    if (!detailSharingModalOpen || !selectedMeeting || !authToken) {
      clearMeetingShareState();
    }
  }, [detailSharingModalOpen, selectedMeeting?.id, authToken]);

  useEffect(() => {
    if (!focusRequest || isRecording) return;
    const meeting = meetings.find((entry) => entry.id === focusRequest.id);
    if (!meeting) return;

    setSelectedMeetingId(meeting.id);
    setDetailNoteOffset(
      Number.isFinite(meeting.duration_seconds)
        ? Math.max(0, meeting.duration_seconds)
        : 0,
    );
    setDetailNoteDraft("");
  }, [focusRequest?.nonce, focusRequest?.id, isRecording, meetings]);

  useEffect(() => {
    if (!selectedMeetingId) return;
    setDetailIsPlaying(false);
    setDetailPlayerVisible(false);
    setDetailPlayerMeetingId(null);
    setDetailPlaybackTime(0);
    setDetailPlaybackDuration(0);
    setDetailPlayerDragging(false);
    setSavingTranscriptSegmentIndex(null);
    setDetailParticipantsModalOpen(false);
    setDetailSharingModalOpen(false);
    setParticipantQuery("");
    if (detailAudioRef.current) {
      detailAudioRef.current.pause();
    }
  }, [selectedMeetingId]);

  const handleStart = async () => {
    const permissionState = await ensureMeetingPermissions();
    if (!permissionState.canStart) {
      return;
    }
    let startError: string | null = null;

    try {
      const result = await commands.startMeetingRecording({
        name: null,
        include_system_audio: permissionState.includeSystemAudio,
      });
      if (result.status === "ok") {
        setIsRecording(true);
        setActiveMeeting(result.data);
        setRecordingNotes([]);
        setRecordingNoteDraft("");
        setRecordingNoteStartOffset(null);
        setLiveTranscript({ text: "", segments: [] });
        setSelectedMeetingId(null);
      } else {
        startError = result.error ?? t("meetingsPage.startError");
      }
    } catch (error) {
      startError =
        error instanceof Error ? error.message : t("meetingsPage.startError");
    }

    const backendRecording = await refreshRecordingState();
    if (backendRecording) {
      setLastRecordedId(null);
      toast.success(t("meetingsPage.recordingStarted"));
      return;
    }

    toast.error(startError ?? t("meetingsPage.startError"));
  };

  const handleStop = async () => {
    setStopInProgress(true);
    let stopError: string | null = null;

    try {
      const result = await commands.stopMeetingRecording({
        name: null,
      });
      if (result.status === "ok") {
        setLastRecordedId(result.data.id);
        setMeetings((prev) => {
          const filtered = prev.filter((entry) => entry.id !== result.data.id);
          return [result.data, ...filtered];
        });
        openMeetingDetail(result.data);
        toast.success(t("meetingsPage.recordingStopped"));
      } else {
        stopError = result.error ?? t("meetingsPage.stopError");
      }
    } catch (error) {
      stopError =
        error instanceof Error ? error.message : t("meetingsPage.stopError");
    }

    const activeAfterStop = await refreshRecordingState();
    if (!activeAfterStop) {
      setRecordingNotes([]);
      setRecordingNoteDraft("");
      setRecordingNoteStartOffset(null);
    }
    setStopInProgress(false);

    if (stopError) {
      toast.error(stopError);
    }
  };

  const startRename = (entry: Pick<MeetingEntry, "id" | "name">) => {
    setRenameId(entry.id);
    setRenameValue(entry.name);
  };

  const cancelRename = () => {
    setRenameId(null);
    setRenameValue("");
  };

  const saveRename = async (entry: Pick<MeetingEntry, "id" | "name">) => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      toast.error(t("meetingsPage.renameEmpty"));
      cancelRename();
      return;
    }
    if (trimmed === entry.name.trim()) {
      cancelRename();
      return;
    }
    const result = await commands.renameMeeting(entry.id, trimmed);
    if (result.status === "ok") {
      setMeetings((prev) =>
        prev.map((item) =>
          item.id === entry.id ? { ...item, name: trimmed } : item,
        ),
      );
      setActiveMeeting((prev) =>
        prev && prev.id === entry.id ? { ...prev, name: trimmed } : prev,
      );
      cancelRename();
    } else {
      toast.error(result.error ?? t("meetingsPage.renameError"));
    }
  };

  const applyTags = async (entry: MeetingEntry, nextTags: string[]) => {
    const deduped: string[] = [];
    const seen = new Set<string>();
    nextTags
      .map((tag) => normalizeTag(tag))
      .filter(Boolean)
      .forEach((tag) => {
        if (seen.has(tag)) return;
        seen.add(tag);
        deduped.push(tag);
      });

    const result = await commands.setMeetingTags(entry.id, deduped);
    if (result.status !== "ok") {
      toast.error(result.error ?? t("meetingsPage.deleteError"));
      return;
    }
    setMeetings((prev) =>
      prev.map((item) =>
        item.id === entry.id ? { ...item, tags: result.data } : item,
      ),
    );
    await loadTags();
  };

  const addTag = async (entry: MeetingEntry, rawTag: string) => {
    const normalized = normalizeTag(rawTag);
    if (!normalized) return;
    const existing = entry.tags ?? [];
    const existingNormalized = new Set(
      existing.map((tag) => normalizeTag(tag)),
    );
    if (existingNormalized.has(normalized)) return;
    const canonical =
      tagOptions.find((tag) => tag === normalized) ?? normalized;
    await applyTags(entry, [...existing, canonical]);
    setTagQuery("");
  };

  const removeTag = async (entry: MeetingEntry, tag: string) => {
    const normalized = normalizeTag(tag);
    const nextTags = (entry.tags ?? []).filter(
      (item) => normalizeTag(item) !== normalized,
    );
    await applyTags(entry, nextTags);
  };

  const upsertDeletedMeeting = (entry: DeletedMeetingEntry) => {
    setDeletedMeetings((prev) => {
      const next = [entry, ...prev.filter((item) => item.id !== entry.id)];
      return next.sort((a, b) => b.deleted_at - a.deleted_at);
    });
  };

  const upsertMeeting = (entry: MeetingEntry) => {
    setMeetings((prev) => {
      const index = prev.findIndex((item) => item.id === entry.id);
      if (index >= 0) {
        const next = [...prev];
        next[index] = entry;
        return next;
      }
      return [entry, ...prev];
    });
  };

  const removeDeletePhase = (meetingId: number) => {
    setDeletePhaseByMeetingId((current) => {
      if (!(meetingId in current)) return current;
      const next = { ...current };
      delete next[meetingId];
      return next;
    });
  };

  const restoreMeetingFromTrash = async (meetingId: number) => {
    clearSoftDeleteTimer(meetingId);
    clearPermanentDeleteTimers(meetingId);
    removeDeletePhase(meetingId);

    const result = await commands.restoreMeeting(meetingId);
    if (result.status !== "ok") {
      toast.error(result.error ?? t("meetingsPage.restoreError"));
      await loadMeetings();
      await loadDeletedMeetings();
      return;
    }

    upsertMeeting(result.data);
    setDeletedMeetings((prev) => prev.filter((item) => item.id !== meetingId));
    await loadTags();
    toast.success(t("meetingsPage.restoreSuccess"));
  };

  const handleDelete = async (entry: MeetingEntry) => {
    if (deletePhaseByMeetingId[entry.id]) return false;

    const result = await commands.deleteMeeting(entry.id);
    if (result.status !== "ok") {
      toast.error(result.error ?? t("meetingsPage.deleteError"));
      return false;
    }

    setDeletePhaseByMeetingId((current) => ({
      ...current,
      [entry.id]: "fading",
    }));
    clearMeetingUIState(entry.id);
    await loadTags();

    clearSoftDeleteTimer(entry.id);
    softDeleteTimersRef.current[entry.id] = window.setTimeout(() => {
      setMeetings((prev) => prev.filter((item) => item.id !== entry.id));
      upsertDeletedMeeting(result.data);
      removeDeletePhase(entry.id);
      clearSoftDeleteTimer(entry.id);
    }, DELETE_FADE_MS);

    toast(t("meetingsPage.movedToTrash"), {
      duration: PERMANENT_DELETE_COMMIT_DELAY_MS,
      action: {
        label: t("common.undo"),
        onClick: () => {
          void restoreMeetingFromTrash(entry.id);
        },
      },
    });

    return true;
  };

  const openDeleteConfirm = (entry: MeetingEntry) => {
    setDetailTranscriptMenuOpen(false);
    setDetailTranscriptFullscreenMenuOpen(false);
    setDeleteConfirmMeeting(entry);
  };

  const closeDeleteConfirm = () => {
    if (deleteConfirmInProgress) return;
    setDeleteConfirmMeeting(null);
  };

  const confirmDeleteMeeting = async () => {
    if (!deleteConfirmMeeting) return;
    setDeleteConfirmInProgress(true);
    try {
      const deleted = await handleDelete(deleteConfirmMeeting);
      if (deleted) {
        setDeleteConfirmMeeting(null);
      }
    } finally {
      setDeleteConfirmInProgress(false);
    }
  };

  const undoPendingPermanentDelete = (meetingId: number) => {
    clearPermanentDeleteTimers(meetingId);
    removeDeletePhase(meetingId);
  };

  const handlePermanentDelete = async (entry: DeletedMeetingEntry) => {
    if (deletePhaseByMeetingId[entry.id]) return;
    if (!window.confirm(t("meetingsPage.permanentDeleteConfirm"))) {
      return;
    }

    setDeletePhaseByMeetingId((current) => ({
      ...current,
      [entry.id]: "fading",
    }));

    const fadeTimer = window.setTimeout(() => {
      // phase already switched; this timer is only tracked for cleanup/undo symmetry
    }, DELETE_FADE_MS);
    const commitTimer = window.setTimeout(() => {
      void (async () => {
        const result = await commands.deleteMeetingPermanently(entry.id);
        clearPermanentDeleteTimers(entry.id);
        if (result.status !== "ok") {
          removeDeletePhase(entry.id);
          toast.error(result.error ?? t("meetingsPage.permanentDeleteError"));
          return;
        }
        setDeletedMeetings((prev) =>
          prev.filter((item) => item.id !== entry.id),
        );
        removeDeletePhase(entry.id);
        toast.success(t("meetingsPage.permanentDeleteDone"));
      })();
    }, PERMANENT_DELETE_COMMIT_DELAY_MS);

    permanentDeleteTimersRef.current[entry.id] = {
      fadeTimer,
      commitTimer,
    };

    toast(t("meetingsPage.permanentDeletePending"), {
      duration: PERMANENT_DELETE_COMMIT_DELAY_MS,
      action: {
        label: t("common.undo"),
        onClick: () => {
          undoPendingPermanentDelete(entry.id);
        },
      },
    });
  };

  const handleRestoreFromTrash = async (entry: DeletedMeetingEntry) => {
    await restoreMeetingFromTrash(entry.id);
  };

  const handleDownload = async (entry: MeetingEntry) => {
    if (downloadInProgressId === entry.id) {
      return;
    }
    setDownloadInProgressId(entry.id);
    try {
      const result = await commands.downloadMeeting(entry.id);
      if (result.status === "ok") {
        toast.success(t("meetingsPage.downloaded"));
      } else {
        toast.error(result.error ?? t("meetingsPage.downloadError"));
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("meetingsPage.downloadError"),
      );
    } finally {
      setDownloadInProgressId((current) =>
        current === entry.id ? null : current,
      );
    }
  };

  const formatEndedAt = (timestamp: number) => {
    const relative = formatRelativeTime(String(timestamp), i18n.language);
    const absolute = formatDateTime(String(timestamp), i18n.language);
    return { relative, absolute };
  };

  const formatPurgeAt = (timestamp: number) => {
    const relative = formatFutureRelativeTime(String(timestamp), i18n.language);
    const absolute = formatDateTime(String(timestamp), i18n.language);
    return { relative, absolute };
  };

  return (
    <div className="mx-auto w-full max-w-[980px]">
      <section className="w-full px-4 py-6">
        <div className="flex flex-col gap-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="app-display">{t("meetingsPage.title")}</h1>
              <p className="app-caption mt-2">{t("meetingsPage.subtitle")}</p>
            </div>
            <div className="flex items-center gap-2">
              {!isRecording && !selectedMeetingId && (
                <Button
                  onClick={handleStart}
                  className="flex cursor-pointer items-center gap-2"
                >
                  <Mic width={16} height={16} />
                  {t("meetingsPage.startButton")}
                </Button>
              )}
            </div>
          </div>
          {isRecording && activeMeeting && (
            <div className="liquid-glass rounded-3xl p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <input
                    value={
                      renameId === activeMeeting.id
                        ? renameValue
                        : activeMeeting.name
                    }
                    onFocus={() => {
                      if (renameId !== activeMeeting.id) {
                        startRename(activeMeeting);
                      }
                    }}
                    onChange={(event) => {
                      if (renameId !== activeMeeting.id) {
                        startRename(activeMeeting);
                      }
                      setRenameValue(event.target.value);
                    }}
                    onBlur={() => {
                      if (renameId === activeMeeting.id) {
                        void saveRename(activeMeeting);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRename();
                        event.currentTarget.blur();
                      }
                    }}
                    aria-label={t("meetingsPage.rename")}
                    title={t("meetingsPage.rename")}
                    className="h-9 w-full max-w-[38rem] rounded-md border border-transparent bg-transparent px-1 text-xl font-medium text-zinc-900 outline-none transition-colors hover:border-border/70 hover:bg-background/20 focus:border-border focus:bg-background/45 focus:ring-1 focus:ring-accent/30 dark:text-zinc-100"
                  />
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    {t("meetingsPage.liveNotepad", {
                      defaultValue: "Live local meeting notepad",
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-black/5 bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-600 dark:border-white/10 dark:text-blue-500">
                    LIVE
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full border border-black/5 px-3 py-1 text-xs font-semibold text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                    <Clock3 className="h-3.5 w-3.5" />
                    {formatDuration(recordingElapsedSeconds)}
                  </span>
                  <Button
                    variant="danger"
                    onClick={handleStop}
                    disabled={stopInProgress}
                    className="flex items-center gap-2"
                  >
                    <Square width={16} height={16} />
                    {stopInProgress
                      ? t("meetingsPage.stopping")
                      : t("meetingsPage.stopButton")}
                  </Button>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="rounded-2xl border border-black/5 bg-white/55 p-4 dark:border-white/10 dark:bg-zinc-900/55">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {t("meetingsPage.transcriptTitle")}
                    </h3>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {t("meetingsPage.wordCount", {
                        defaultValue: "{{count}} words",
                        count: (liveTranscript.text.trim().match(/\S+/g) ?? [])
                          .length,
                      })}
                    </span>
                  </div>
                  <div
                    ref={liveTranscriptRef}
                    className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto pr-1"
                  >
                    {!liveTranscript.text.trim() ? (
                      <p className="text-sm text-muted">
                        Listening for speech...
                      </p>
                    ) : (
                      <p className="rounded-lg border border-border/60 bg-surface/70 px-3 py-2 text-sm leading-6 text-text whitespace-pre-wrap">
                        {liveTranscript.text}
                      </p>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-background/40 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-text">
                      {t("meetingsPage.notesTitle")}
                    </h3>
                    <span className="text-xs text-muted">
                      {t("meetingsPage.notesCount", {
                        count: recordingNotes.length,
                      })}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted">
                    {t("meetingsPage.notesSubtitle")}
                  </p>
                  {recordingNoteStartOffset !== null && (
                    <p className="mt-2 text-[11px] text-muted">
                      {t("meetingsPage.writingSince", {
                        defaultValue: "Writing since {{time}}",
                        time: formatNoteTimestamp(recordingNoteStartOffset),
                      })}
                    </p>
                  )}
                  <div className="mt-3">
                    <textarea
                      value={recordingNoteDraft}
                      onChange={(event) =>
                        updateRecordingNoteDraft(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void addRecordingNote();
                        }
                      }}
                      placeholder={t("meetingsPage.notesPlaceholder")}
                      className="min-h-24 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/25"
                    />
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button
                      size="sm"
                      onClick={() => void addRecordingNote()}
                      disabled={!recordingNoteDraft.trim()}
                    >
                      {t("meetingsPage.saveNote", {
                        defaultValue: "Save note",
                      })}
                    </Button>
                  </div>
                  <div className="mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
                    {recordingNotes.length === 0 ? (
                      <p className="text-xs text-muted">
                        {t("meetingsPage.notesEmpty")}
                      </p>
                    ) : (
                      recordingNotes.map((note) => {
                        const createdAt = formatNoteCreatedAt(
                          note.created_at,
                          i18n.language,
                        );
                        return (
                          <div
                            key={note.id}
                            className="rounded-lg border border-border/70 bg-surface/60 px-3 py-2 text-text"
                          >
                            <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
                              <span title={createdAt.absolute}>
                                {createdAt.relative}
                              </span>
                              <span>{formatNoteRange(note)}</span>
                            </div>
                            <p className="mt-1 text-sm whitespace-pre-wrap break-words">
                              {note.text}
                            </p>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {!isRecording && selectedMeeting && (
            <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={closeMeetingDetail}
                  className="flex h-5 w-4 cursor-pointer items-center justify-start text-muted opacity-70 transition-opacity hover:opacity-100"
                  aria-label={t("meetingsPage.back")}
                  title={t("meetingsPage.back")}
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="w-full min-w-0">
                  <input
                    value={
                      renameId === selectedMeeting.id
                        ? renameValue
                        : selectedMeeting.name
                    }
                    onFocus={() => {
                      if (renameId !== selectedMeeting.id) {
                        startRename(selectedMeeting);
                      }
                    }}
                    onChange={(event) => {
                      if (renameId !== selectedMeeting.id) {
                        startRename(selectedMeeting);
                      }
                      setRenameValue(event.target.value);
                    }}
                    onBlur={() => {
                      if (renameId === selectedMeeting.id) {
                        void saveRename(selectedMeeting);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelRename();
                        event.currentTarget.blur();
                      }
                    }}
                    aria-label={t("meetingsPage.rename")}
                    title={t("meetingsPage.rename")}
                    className="h-8 w-full rounded-md border border-transparent bg-transparent px-0 text-base font-semibold text-text outline-none transition-colors hover:border-border/70 hover:bg-background/20 focus:border-border focus:bg-background/45 focus:ring-1 focus:ring-accent/30"
                  />
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span>
                      {formatDateTime(
                        String(selectedMeeting.ended_at),
                        i18n.language,
                      )}
                    </span>
                    <span className="before:content-['•']" aria-hidden />
                    <span>
                      {t("meetingsPage.durationLabel", {
                        time: formatDuration(selectedMeeting.duration_seconds),
                      })}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {(selectedMeeting.tags ?? []).length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      {(selectedMeeting.tags ?? []).map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted"
                        >
                          {normalizeTag(tag)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-6">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-text">
                    {t("meetingsPage.transcriptTitle")}
                  </div>
                  <div className="flex items-center gap-1">
                    {detailDiarizationStatus?.status === "failed" &&
                      hasDetailTranscriptContent &&
                      !detailDiarizationStatus.error_message?.includes(
                        NO_TRANSCRIPT_SEGMENTS_DIARIZATION_ERROR,
                      ) && (
                        <button
                          type="button"
                          onClick={() => {
                            void runDiarization(selectedMeeting.id, true);
                          }}
                          className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:text-text"
                        >
                          {t("common.retry", { defaultValue: "Retry" })}
                        </button>
                      )}
                    <button
                      type="button"
                      onClick={() => {
                        setDetailTranscriptMenuOpen(false);
                        setDetailTranscriptFullscreenOpen(true);
                      }}
                      disabled={
                        detailTranscriptLoading ||
                        isDetailTranscriptPreparing ||
                        (!detailTranscript?.text &&
                          !detailTranscript?.segments?.length)
                      }
                      className="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:text-text disabled:opacity-50"
                      title="Open fullscreen transcript"
                      aria-label="Open fullscreen transcript"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void playMeetingFromBeginning(selectedMeeting)
                      }
                      disabled={detailAudioLoading}
                      className="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:text-text disabled:opacity-50"
                      title={
                        detailAudioLoading
                          ? t("meetingsPage.audioLoading")
                          : "Play from beginning"
                      }
                      aria-label={
                        detailAudioLoading
                          ? t("meetingsPage.audioLoading")
                          : "Play meeting from beginning"
                      }
                    >
                      <Play className="h-3.5 w-3.5" />
                    </button>
                    <div className="relative" ref={detailTranscriptMenuRef}>
                      <button
                        type="button"
                        onClick={() =>
                          setDetailTranscriptMenuOpen((current) => !current)
                        }
                        className="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:text-text"
                        title="Transcript actions"
                        aria-label="Transcript actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                      {detailTranscriptMenuOpen && (
                        <div className="absolute right-0 z-50 mt-2 w-48 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
                          <button
                            type="button"
                            onClick={() => {
                              void handleDownload(selectedMeeting);
                              setDetailTranscriptMenuOpen(false);
                            }}
                            disabled={
                              downloadInProgressId === selectedMeeting.id
                            }
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent/5 disabled:opacity-50"
                          >
                            <Download className="h-3.5 w-3.5 text-muted" />
                            <span>{t("meetingsPage.download")}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void copyTranscript();
                              setDetailTranscriptMenuOpen(false);
                            }}
                            disabled={
                              detailTranscriptLoading ||
                              isDetailTranscriptPreparing ||
                              !detailTranscript?.text
                            }
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent/5 disabled:opacity-50"
                          >
                            <Copy className="h-3.5 w-3.5 text-muted" />
                            <span>{t("meetingsPage.transcriptCopy")}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDetailNotesPanelOpen((current) => !current);
                              setDetailParticipantsModalOpen(false);
                              setDetailSharingModalOpen(false);
                              setDetailTranscriptMenuOpen(false);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent/5"
                          >
                            <NotepadText className="h-3.5 w-3.5 text-muted" />
                            <span>{t("meetingsPage.notesTitle")}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDetailParticipantsModalOpen(true);
                              setDetailSharingModalOpen(false);
                              setDetailNotesPanelOpen(false);
                              setDetailTranscriptMenuOpen(false);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent/5"
                          >
                            <Users className="h-3.5 w-3.5 text-muted" />
                            <span>
                              {t("meetingsPage.participants.title", {
                                defaultValue: "Participants",
                              })}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDetailParticipantsModalOpen(false);
                              setDetailNotesPanelOpen(false);
                              setDetailTranscriptMenuOpen(false);
                              void openSharingForSelectedMeeting();
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent/5"
                          >
                            <Share2 className="h-3.5 w-3.5 text-muted" />
                            <span>
                              {t("meetingsPage.sharing.title", {
                                defaultValue: "Sharing",
                              })}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => openDeleteConfirm(selectedMeeting)}
                            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-red-500 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>{t("common.delete")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {detailSpeakerChips.length > 0 && (
                  <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                    {detailSpeakerChips.map((speaker) => (
                      <button
                        key={speaker.rawSpeakerId}
                        type="button"
                        onClick={() =>
                          openGlobalSpeakerEditor(speaker.rawSpeakerId)
                        }
                        className="shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-opacity hover:opacity-90"
                        style={{
                          borderColor: `${speaker.color}66`,
                          backgroundColor: `${speaker.color}20`,
                          color: speaker.color,
                        }}
                      >
                        {speaker.displayName}
                      </button>
                    ))}
                  </div>
                )}
                {detailDiarizationStatus?.status === "failed" &&
                  hasDetailTranscriptContent &&
                  !detailDiarizationStatus.error_message?.includes(
                    NO_TRANSCRIPT_SEGMENTS_DIARIZATION_ERROR,
                  ) && (
                    <div className="mt-3 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                      {detailDiarizationStatus.error_message ||
                        "Couldn't identify speakers for this meeting."}
                    </div>
                  )}
                <div className="flex items-start">
                  <div className="min-w-0 flex-1">
                    <div className="relative">
                      {renderDetailTranscriptContent(selectedMeeting)}
                    </div>
                  </div>
                  {!detailTranscriptFullscreenOpen && renderDetailNotesPanel()}
                </div>
              </div>

              <audio
                ref={detailAudioRef}
                className="hidden"
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const audio = event.currentTarget;
                  if (Number.isFinite(audio.duration) && audio.duration > 0) {
                    setDetailPlaybackDuration(audio.duration);
                  }
                  setDetailPlaybackTime(audio.currentTime || 0);
                }}
                onDurationChange={(event) => {
                  const audio = event.currentTarget;
                  if (Number.isFinite(audio.duration) && audio.duration > 0) {
                    setDetailPlaybackDuration(audio.duration);
                  }
                }}
                onTimeUpdate={(event) => {
                  if (!detailPlayerDraggingRef.current) {
                    setDetailPlaybackTime(event.currentTarget.currentTime || 0);
                  }
                }}
                onPlay={() => {
                  setDetailIsPlaying(true);
                  setDetailPlayerVisible(true);
                }}
                onPause={() => setDetailIsPlaying(false)}
                onEnded={() => {
                  const audio = detailAudioRef.current;
                  if (audio) {
                    setDetailPlaybackTime(audio.duration || 0);
                  }
                  setDetailIsPlaying(false);
                }}
              />
              {renderDetailPlaybackBar()}
            </div>
          )}

          {!isRecording && !selectedMeeting && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-base font-semibold text-text">
                    {t("meetingsPage.listTitle")}
                  </h3>
                  <div className="flex items-center gap-2">
                    <div
                      ref={searchContainerRef}
                      className={`relative flex h-7 items-center gap-2 rounded-full border border-transparent transition-all duration-200 ease-out ${
                        searchOpen
                          ? "w-56 bg-border/60 border-border px-2"
                          : "w-7 bg-transparent px-1"
                      }`}
                    >
                      <button
                        type="button"
                        className="flex h-6 w-6 items-center justify-center text-muted transition-colors hover:text-text"
                        onClick={() => {
                          if (searchOpen) {
                            setSearchOpen(false);
                            setSearchQuery("");
                          } else {
                            setSearchOpen(true);
                            requestAnimationFrame(() => {
                              searchInputRef.current?.focus();
                            });
                          }
                        }}
                        aria-label={t("common.search")}
                      >
                        <Search className="h-3.5 w-3.5" />
                      </button>
                      {searchOpen && (
                        <input
                          ref={searchInputRef}
                          value={searchQuery}
                          onChange={(event) =>
                            setSearchQuery(event.target.value)
                          }
                          placeholder={t("meetingsPage.searchPlaceholder")}
                          className="flex-1 bg-transparent pr-6 text-xs text-text placeholder:text-muted focus:outline-none"
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setSearchOpen(false);
                          setSearchQuery("");
                        }}
                        className={`absolute right-2 text-muted transition-opacity duration-150 hover:text-text ${
                          searchOpen
                            ? "opacity-100 delay-150"
                            : "opacity-0 pointer-events-none"
                        }`}
                        aria-label={t("common.close")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="relative" ref={filterMenuRef}>
                      <button
                        type="button"
                        className={`flex h-7 w-7 items-center justify-center text-muted transition-colors hover:text-text ${
                          selectedTagFilter ? "text-text" : ""
                        }`}
                        onClick={() => setFilterOpen((current) => !current)}
                        aria-label={t("meetingsPage.filter")}
                        title={t("meetingsPage.filter")}
                      >
                        <Filter className="h-3.5 w-3.5" />
                      </button>
                      {filterOpen && (
                        <div className="absolute right-0 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-surface shadow-lg z-50">
                          <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-muted">
                            {t("meetingsPage.filterTitle")}
                          </div>
                          <div className="max-h-64 overflow-y-auto">
                            <button
                              type="button"
                              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/5 ${
                                !selectedTagFilter ? "text-accent" : "text-text"
                              }`}
                              onClick={() => {
                                setSelectedTagFilter(null);
                                setFilterOpen(false);
                              }}
                            >
                              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-border text-[10px] text-muted">
                                <Filter className="h-3 w-3" />
                              </span>
                              <span>{t("meetingsPage.filterAll")}</span>
                            </button>
                            {tagOptions.length === 0 && (
                              <div className="px-3 py-2 text-xs text-muted">
                                {t("meetingsPage.filterEmpty")}
                              </div>
                            )}
                            {tagOptions.map((tag) => {
                              const isActive =
                                normalizedTagFilter === normalizeTag(tag);
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/5 ${
                                    isActive ? "text-accent" : "text-text"
                                  }`}
                                  onClick={() => {
                                    setSelectedTagFilter(tag);
                                    setFilterOpen(false);
                                  }}
                                >
                                  <span className="flex h-5 w-5 items-center justify-center rounded-md bg-border text-[10px] text-muted">
                                    <Tag className="h-3 w-3" />
                                  </span>
                                  <span className="truncate">
                                    {normalizeTag(tag)}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {loading ? (
                  <div className="py-10 text-center text-sm text-muted">
                    {t("meetingsPage.loading")}
                  </div>
                ) : filteredMeetings.length === 0 ? (
                  <div className="py-10 text-center">
                    <p className="text-sm font-medium text-text">
                      {searchQuery.trim() || selectedTagFilter
                        ? t("common.noResults")
                        : t("meetingsPage.emptyTitle")}
                    </p>
                    {!searchQuery.trim() && !selectedTagFilter && (
                      <p className="mt-2 text-xs text-muted">
                        {t("meetingsPage.emptyBody")}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="mt-4 flex flex-col gap-3">
                    {filteredMeetings.map((meeting) => {
                      const rowFadingOut =
                        deletePhaseByMeetingId[meeting.id] === "fading";
                      return (
                        <MeetingListCard
                          key={meeting.id}
                          meeting={meeting}
                          isTagMenuOpen={tagEditorId === meeting.id}
                          tagQuery={tagQuery}
                          tagSuggestions={tagSuggestions}
                          isFadingOut={rowFadingOut}
                          isLastRecorded={meeting.id === lastRecordedId}
                          tagMenuRef={
                            tagEditorId === meeting.id ? tagMenuRef : null
                          }
                          onOpenDetail={() => openMeetingDetail(meeting)}
                          onToggleTagMenu={() => {
                            if (tagEditorId === meeting.id) {
                              setTagEditorId(null);
                              setTagQuery("");
                            } else {
                              setTagEditorId(meeting.id);
                              setTagQuery("");
                            }
                          }}
                          onCloseTagMenu={() => {
                            setTagEditorId(null);
                            setTagQuery("");
                          }}
                          onTagQueryChange={(value) => setTagQuery(value)}
                          onAddTag={(tag) => addTag(meeting, tag)}
                          onRemoveTag={(tag) => removeTag(meeting, tag)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-base font-semibold text-text">
                      {t("meetingsPage.deletedTitle")}
                    </h3>
                    <p className="mt-1 text-xs text-muted">
                      {t("meetingsPage.deletedSubtitle")}
                    </p>
                  </div>
                  <span className="text-xs text-muted">
                    {t("meetingsPage.count", {
                      count: sortedDeletedMeetings.length,
                    })}
                  </span>
                </div>

                {sortedDeletedMeetings.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted">
                    {t("meetingsPage.deletedEmpty")}
                  </div>
                ) : (
                  <div className="mt-4 flex flex-col gap-3">
                    {sortedDeletedMeetings.map((meeting) => {
                      const deleted = formatEndedAt(meeting.deleted_at);
                      const purge = formatPurgeAt(meeting.purge_at);
                      const rowFadingOut =
                        deletePhaseByMeetingId[meeting.id] === "fading";
                      return (
                        <div
                          key={`deleted-${meeting.id}`}
                          className={`rounded-xl border border-border bg-background/30 px-4 py-3 transition-[max-height,opacity,transform,border-color,padding] duration-300 ease-out ${
                            rowFadingOut
                              ? "max-h-0 -translate-y-1 overflow-hidden border-transparent py-0 opacity-0"
                              : "max-h-[220px] opacity-100"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h4 className="text-sm font-medium text-text">
                                {meeting.name}
                              </h4>
                              <p className="mt-1 text-xs text-muted">
                                <span title={deleted.absolute}>
                                  {t("meetingsPage.deletedAt", {
                                    time: deleted.relative,
                                  })}
                                </span>
                              </p>
                              <p className="mt-1 text-xs text-muted">
                                <span title={purge.absolute}>
                                  {t("meetingsPage.permanentDeleteAt", {
                                    time: purge.relative,
                                  })}
                                </span>
                              </p>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  void handleRestoreFromTrash(meeting);
                                }}
                                disabled={rowFadingOut}
                                className={`flex h-8 w-8 items-center justify-center text-muted transition-colors ${
                                  rowFadingOut
                                    ? "opacity-40"
                                    : "hover:text-text"
                                }`}
                                title={t("meetingsPage.restore")}
                                aria-label={t("meetingsPage.restore")}
                              >
                                <RotateCcw className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  void handlePermanentDelete(meeting);
                                }}
                                disabled={rowFadingOut}
                                className={`flex h-8 w-8 items-center justify-center text-muted transition-colors ${
                                  rowFadingOut
                                    ? "opacity-40"
                                    : "hover:text-red-400"
                                }`}
                                title={t("meetingsPage.deleteForever")}
                                aria-label={t("meetingsPage.deleteForever")}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
          {speakerEditorMounted && selectedMeeting && (
            <div
              className={`fixed inset-0 z-[130] bg-background/65 backdrop-blur-[2px] transition-opacity duration-[320ms] ease-out ${
                speakerEditorVisible ? "opacity-100" : "opacity-0"
              }`}
            >
              <div className="mx-auto flex h-full w-full max-w-2xl items-center justify-center p-4 pt-[calc(var(--titlebar-height)+0.75rem)]">
                <div
                  className={`w-full rounded-2xl border border-border bg-surface p-4 shadow-2xl transition-opacity duration-[320ms] ease-out will-change-[opacity] ${
                    speakerEditorVisible ? "opacity-100" : "opacity-0"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-text">
                        {speakerEditorMode === "segment"
                          ? "Assign Speaker (This Phrase)"
                          : "Assign Speaker"}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {speakerEditorMode === "segment"
                          ? "This only updates the clicked phrase."
                          : "This updates all matching speaker lines."}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={closeSpeakerEditor}
                      className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:text-text"
                      title={t("common.close")}
                      aria-label={t("common.close")}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                    <div>
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                        {t("meetingsPage.speakerEditor.displayName", {
                          defaultValue: "Display name",
                        })}
                      </label>
                      <input
                        value={speakerEditorDisplayName}
                        onChange={(event) =>
                          setSpeakerEditorDisplayName(event.target.value)
                        }
                        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text placeholder:text-muted focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                        {t("meetingsPage.speakerEditor.color", {
                          defaultValue: "Color",
                        })}
                      </label>
                      <div className="mt-1 flex items-center gap-2">
                        {SPEAKER_CHIP_COLORS.map((color) => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => setSpeakerEditorColor(color)}
                            className={`h-6 w-6 rounded-full border transition-transform ${
                              speakerEditorColor === color
                                ? "scale-110 border-white/80"
                                : "border-border"
                            }`}
                            style={{ backgroundColor: color }}
                            aria-label={`Use color ${color}`}
                            title={color}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl border border-border/80 bg-background/35 p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                      {t("meetingsPage.speakerEditor.existingTeamMembers", {
                        defaultValue: "Existing team members",
                      })}
                    </div>
                    <input
                      value={speakerEditorSearch}
                      onChange={(event) =>
                        setSpeakerEditorSearch(event.target.value)
                      }
                      placeholder="Search people"
                      className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-text placeholder:text-muted focus:outline-none"
                    />
                    <div className="mt-2 max-h-32 overflow-y-auto space-y-1 pr-1">
                      {speakerEditorFilteredParticipants
                        .slice(0, 8)
                        .map((participant) => {
                          const isSelected =
                            speakerEditorParticipantId === participant.id;
                          return (
                            <button
                              key={participant.id}
                              type="button"
                              onClick={() =>
                                void assignSpeakerToParticipant(participant)
                              }
                              className={`flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                                isSelected
                                  ? "border-accent/40 bg-accent/10 text-text"
                                  : "border-border bg-background/70 text-text hover:bg-accent/5"
                              }`}
                            >
                              <span className="truncate">
                                {participant.name}
                              </span>
                              <span className="truncate text-[10px] text-muted">
                                {participant.email || participant.phone || ""}
                              </span>
                            </button>
                          );
                        })}
                      {speakerEditorFilteredParticipants.length === 0 && (
                        <p className="text-xs text-muted">
                          {t("meetingsPage.speakerEditor.noMatches", {
                            defaultValue: "No matches found.",
                          })}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() =>
                        setSpeakerEditorCreating((current) => !current)
                      }
                      className="text-xs font-semibold text-muted transition-colors hover:text-text"
                    >
                      {speakerEditorCreating
                        ? "Hide create speaker"
                        : "Create new speaker"}
                    </button>
                    {speakerEditorCreating && (
                      <div className="mt-2 grid gap-2 rounded-xl border border-border/80 bg-background/35 p-3 sm:grid-cols-3">
                        <input
                          value={speakerEditorNewParticipantName}
                          onChange={(event) =>
                            setSpeakerEditorNewParticipantName(
                              event.target.value,
                            )
                          }
                          placeholder="Name"
                          className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-text placeholder:text-muted focus:outline-none"
                        />
                        <input
                          value={speakerEditorNewParticipantEmail}
                          onChange={(event) =>
                            setSpeakerEditorNewParticipantEmail(
                              event.target.value,
                            )
                          }
                          placeholder="Email (optional)"
                          className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-text placeholder:text-muted focus:outline-none"
                        />
                        <input
                          value={speakerEditorNewParticipantPhone}
                          onChange={(event) =>
                            setSpeakerEditorNewParticipantPhone(
                              event.target.value,
                            )
                          }
                          placeholder="Role/phone (optional)"
                          className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-text placeholder:text-muted focus:outline-none"
                        />
                        <div className="sm:col-span-3 flex justify-end">
                          <Button
                            size="sm"
                            onClick={() =>
                              void createParticipantAndAssignSpeaker()
                            }
                            disabled={
                              speakerEditorSaving ||
                              !speakerEditorNewParticipantName.trim()
                            }
                          >
                            {t("meetingsPage.speakerEditor.createAndAssign", {
                              defaultValue: "Create + Assign",
                            })}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => void leaveSpeakerUnassigned()}
                      disabled={speakerEditorSaving}
                      className="text-xs font-semibold text-muted transition-colors hover:text-text disabled:opacity-50"
                    >
                      {speakerEditorMode === "segment"
                        ? "Clear phrase speaker"
                        : "Leave as unassigned"}
                    </button>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={closeSpeakerEditor}
                        disabled={speakerEditorSaving}
                      >
                        {t("common.cancel", { defaultValue: "Cancel" })}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void saveSpeakerEditor()}
                        disabled={
                          speakerEditorSaving ||
                          !speakerEditorDisplayName.trim()
                        }
                      >
                        {speakerEditorSaving
                          ? "Saving..."
                          : speakerEditorMode === "segment"
                            ? "Save phrase speaker"
                            : "Save speaker"}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {detailTranscriptFullscreenMounted && selectedMeeting && (
            <div
              className={`fixed inset-0 z-[120] bg-background/75 backdrop-blur-sm transition-opacity duration-[320ms] ease-out ${
                detailTranscriptFullscreenVisible ? "opacity-100" : "opacity-0"
              }`}
            >
              <div className="mx-auto flex h-full w-full max-w-6xl flex-col p-4 pt-[calc(var(--titlebar-height)+0.75rem)]">
                <div
                  className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl transition-opacity duration-[320ms] ease-out will-change-[opacity] ${
                    detailTranscriptFullscreenVisible
                      ? "opacity-100"
                      : "opacity-0"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
                    <div>
                      <div className="text-sm font-semibold text-text">
                        {t("meetingsPage.transcriptTitle")}
                      </div>
                      <div className="text-xs text-muted">
                        {selectedMeeting.name}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          void playMeetingFromBeginning(selectedMeeting)
                        }
                        disabled={detailAudioLoading}
                        className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:text-text disabled:opacity-50"
                        title={
                          detailAudioLoading
                            ? t("meetingsPage.audioLoading")
                            : "Play from beginning"
                        }
                        aria-label={
                          detailAudioLoading
                            ? t("meetingsPage.audioLoading")
                            : "Play meeting from beginning"
                        }
                      >
                        <Play className="h-4 w-4" />
                      </button>
                      <div
                        className="relative"
                        ref={detailTranscriptFullscreenMenuRef}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setDetailTranscriptFullscreenMenuOpen(
                              (current) => !current,
                            )
                          }
                          className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:text-text"
                          title="Transcript actions"
                          aria-label="Transcript actions"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                        {detailTranscriptFullscreenMenuOpen && (
                          <div className="absolute right-0 z-50 mt-2 w-48 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
                            <button
                              type="button"
                              onClick={() => {
                                void handleDownload(selectedMeeting);
                                setDetailTranscriptFullscreenMenuOpen(false);
                              }}
                              disabled={
                                downloadInProgressId === selectedMeeting.id
                              }
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent/5 disabled:opacity-50"
                            >
                              <Download className="h-3.5 w-3.5 text-muted" />
                              <span>{t("meetingsPage.download")}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                void copyTranscript();
                                setDetailTranscriptFullscreenMenuOpen(false);
                              }}
                              disabled={
                                detailTranscriptLoading ||
                                isDetailTranscriptPreparing ||
                                !detailTranscript?.text
                              }
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent/5 disabled:opacity-50"
                            >
                              <Copy className="h-3.5 w-3.5 text-muted" />
                              <span>{t("meetingsPage.transcriptCopy")}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDetailNotesPanelOpen((current) => !current);
                                setDetailParticipantsModalOpen(false);
                                setDetailSharingModalOpen(false);
                                setDetailTranscriptFullscreenMenuOpen(false);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent/5"
                            >
                              <NotepadText className="h-3.5 w-3.5 text-muted" />
                              <span>{t("meetingsPage.notesTitle")}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDetailTranscriptFullscreenOpen(false);
                                setDetailParticipantsModalOpen(true);
                                setDetailSharingModalOpen(false);
                                setDetailNotesPanelOpen(false);
                                setDetailTranscriptFullscreenMenuOpen(false);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent/5"
                            >
                              <Users className="h-3.5 w-3.5 text-muted" />
                              <span>
                                {t("meetingsPage.participants.title", {
                                  defaultValue: "Participants",
                                })}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDetailTranscriptFullscreenOpen(false);
                                setDetailParticipantsModalOpen(false);
                                setDetailNotesPanelOpen(false);
                                setDetailTranscriptFullscreenMenuOpen(false);
                                void openSharingForSelectedMeeting();
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors hover:bg-accent/5"
                            >
                              <Share2 className="h-3.5 w-3.5 text-muted" />
                              <span>
                                {t("meetingsPage.sharing.title", {
                                  defaultValue: "Sharing",
                                })}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDetailTranscriptFullscreenMenuOpen(false);
                                openDeleteConfirm(selectedMeeting);
                              }}
                              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-red-500 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              <span>{t("common.delete")}</span>
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setDetailTranscriptFullscreenOpen(false)}
                        className="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:text-text"
                        title={t("common.close")}
                        aria-label={t("common.close")}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="min-h-0 flex flex-1 flex-col p-4">
                    {detailSpeakerChips.length > 0 && (
                      <div className="mb-3 flex shrink-0 gap-2 overflow-x-auto pb-1">
                        {detailSpeakerChips.map((speaker) => (
                          <button
                            key={`fullscreen-${speaker.rawSpeakerId}`}
                            type="button"
                            onClick={() =>
                              openGlobalSpeakerEditor(speaker.rawSpeakerId)
                            }
                            className="shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-opacity hover:opacity-90"
                            style={{
                              borderColor: `${speaker.color}66`,
                              backgroundColor: `${speaker.color}20`,
                              color: speaker.color,
                            }}
                          >
                            {speaker.displayName}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="min-h-0 flex flex-1 items-start">
                      <div className="min-h-0 min-w-0 flex-1">
                        {renderDetailTranscriptContent(selectedMeeting, {
                          fullscreen: true,
                        })}
                      </div>
                      {renderDetailNotesPanel({ fullscreen: true })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          <Modal
            title="Participants"
            subtitle={selectedMeeting ? selectedMeeting.name : undefined}
            open={detailParticipantsModalOpen && Boolean(selectedMeeting)}
            width="lg"
            onClose={() => setDetailParticipantsModalOpen(false)}
          >
            {renderParticipantsModalContent()}
          </Modal>
          <Modal
            title="Meeting Sharing"
            subtitle={selectedMeeting ? selectedMeeting.name : undefined}
            open={detailSharingModalOpen && Boolean(selectedMeeting)}
            width="md"
            onClose={() => setDetailSharingModalOpen(false)}
          >
            {renderSharingModalContent()}
          </Modal>
          <Modal
            title="Delete meeting?"
            subtitle={deleteConfirmMeeting?.name}
            open={Boolean(deleteConfirmMeeting)}
            width="sm"
            onClose={closeDeleteConfirm}
          >
            <div className="space-y-5">
              <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                {t("meetingsPage.deleteDescription", {
                  defaultValue:
                    "This meeting will be moved to Recently deleted and hidden from your meetings list. It can be restored for 30 days before it is permanently deleted.",
                })}
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={closeDeleteConfirm}
                  disabled={deleteConfirmInProgress}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    void confirmDeleteMeeting();
                  }}
                  disabled={deleteConfirmInProgress}
                >
                  {deleteConfirmInProgress ? "Deleting..." : t("common.delete")}
                </Button>
              </div>
            </div>
          </Modal>
        </div>
      </section>
    </div>
  );
};

export default MeetingsPage;
