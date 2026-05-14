/* eslint-disable i18next/no-literal-string */
import { commands } from "@/bindings";
import { listen } from "@tauri-apps/api/event";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clipboard,
  ClipboardCheck,
  ClipboardList,
  Copy,
  Keyboard,
  ListChecks,
  Mic2,
  PartyPopper,
  Video,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import breezeTraceSvg from "../../assets/breeze_trace.svg?raw";
import BreezeTypeHand from "../icons/BreezeTypeHand";
import BreezeTypeTextLogo from "../icons/BreezeTypeTextLogo";
import { FnKeyToggle } from "../settings/FnKeyToggle";

export type TutorialStepId =
  | "dictation"
  | "clipboard"
  | "tasks"
  | "meetings"
  | "finish";

export interface HelpTutorialStep {
  id: TutorialStepId;
  eyebrow: string;
  title: string;
  description: string;
  action: string;
}

export interface HelpTutorialLabels {
  skip: string;
  previous: string;
  next: string;
  stepStatus: (current: number, total: number) => string;
}

export interface HelpTutorialShortcuts {
  dictation: string;
  clipboard: string;
  quickTask: string;
}

interface HelpTutorialPlayerProps {
  steps: HelpTutorialStep[];
  labels: HelpTutorialLabels;
  shortcuts: HelpTutorialShortcuts;
  onClose: () => void;
}

interface TutorialCompositionProps {
  steps: HelpTutorialStep[];
  stepIndex: number;
  frame: number;
  labels: HelpTutorialLabels;
  shortcuts: HelpTutorialShortcuts;
  practiceState: PracticeState;
  onStartDictationPractice: () => void;
  onCompleteDictationPractice: (transcript?: string | null) => void;
  onCopyPhrase: (phraseId: ClipboardPhraseId) => void;
  onClipboardPaste: (phraseId: ClipboardPhraseId, value: string) => void;
  onTaskDraftChange: (value: string) => void;
  onCreateTask: () => void;
  onClose: () => void;
}

type ClipboardPhraseId = "first" | "second";

interface PracticeState {
  dictationStarted: boolean;
  dictationComplete: boolean;
  dictationTranscript: string | null;
  clipboardCopied: Record<ClipboardPhraseId, boolean>;
  clipboardPasted: Record<ClipboardPhraseId, boolean>;
  taskDraft: string;
  taskCreated: boolean;
}

const TUTORIAL_FPS = 30;
const TUTORIAL_FRAMES_PER_STEP = 126;
const TUTORIAL_LOOP_START_FRAME = 18;
const TUTORIAL_DICTATION_SETTLE_MS = 650;
const DICTATION_PHRASE = "Send Jordan the launch notes before noon.";
const CLIPBOARD_PHRASES: Record<ClipboardPhraseId, string> = {
  first: "Launch note: pricing page is ready for review.",
  second: "Follow-up: send the meeting recap after lunch.",
};
const TASK_EXAMPLE = "Follow up with Maya tomorrow #launch";

const stepIconById: Record<TutorialStepId, LucideIcon> = {
  dictation: Mic2,
  clipboard: ClipboardList,
  tasks: ListChecks,
  meetings: Video,
  finish: PartyPopper,
};

const stepAccentById: Record<TutorialStepId, string> = {
  dictation: "#2563EB",
  clipboard: "#0891B2",
  tasks: "#16A34A",
  meetings: "#EA580C",
  finish: "#2563EB",
};

const initialPracticeState: PracticeState = {
  dictationStarted: false,
  dictationComplete: false,
  dictationTranscript: null,
  clipboardCopied: { first: false, second: false },
  clipboardPasted: { first: false, second: false },
  taskDraft: "",
  taskCreated: false,
};

const ease = (value: number) => 1 - Math.pow(1 - value, 4);

const interpolate = (
  value: number,
  input: [number, number],
  output: [number, number],
) => {
  const [inputStart, inputEnd] = input;
  const [outputStart, outputEnd] = output;
  const progress =
    inputEnd === inputStart
      ? 1
      : Math.min(
          1,
          Math.max(0, (value - inputStart) / (inputEnd - inputStart)),
        );
  return outputStart + (outputEnd - outputStart) * progress;
};

const clamp = (
  frame: number,
  input: [number, number],
  output: [number, number],
) => {
  const easedFrame = ease(interpolate(frame, input, [0, 1]));
  return interpolate(easedFrame, [0, 1], output);
};

const shortcutTokens = (shortcut: string) =>
  shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

const displayShortcutToken = (token: string) => {
  const normalized = token.trim().toLowerCase();
  const displayMap: Record<string, string> = {
    cmd: "Cmd",
    command: "Cmd",
    commandorcontrol: "Cmd",
    commandorctrl: "Cmd",
    meta: "Cmd",
    ctrl: "Ctrl",
    control: "Ctrl",
    shift: "Shift",
    alt: "Alt",
    option: "Option",
    escape: "Esc",
    esc: "Esc",
    space: "Space",
    tab: "Tab",
    enter: "Enter",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
  };

  return displayMap[normalized] || token.toUpperCase();
};

const formatShortcutText = (shortcut: string) =>
  shortcutTokens(shortcut).map(displayShortcutToken).join(" + ") || "Not set";

const normalizeTranscriptText = (value: string | null | undefined) => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length > 0 ? normalized : null;
};

const isTextEntryTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
};

const normalizeShortcutToken = (token: string) => {
  const normalized = token.trim().toLowerCase();
  const aliases: Record<string, string> = {
    cmd: "command",
    meta: "command",
    super: "command",
    commandorcontrol: "command",
    commandorctrl: "command",
    control: "ctrl",
    alt: "option",
    escape: "esc",
    arrowup: "up",
    arrowdown: "down",
    arrowleft: "left",
    arrowright: "right",
    " ": "space",
  };

  return aliases[normalized] || normalized;
};

const eventKeyToken = (event: KeyboardEvent) => {
  if (/^Key[A-Z]$/.test(event.code)) {
    return event.code.replace("Key", "").toLowerCase();
  }
  if (/^Digit\d$/.test(event.code)) {
    return event.code.replace("Digit", "");
  }
  if (/^F\d+$/.test(event.code)) {
    return event.code.toLowerCase();
  }

  const codeMap: Record<string, string> = {
    Escape: "esc",
    Space: "space",
    Tab: "tab",
    Enter: "enter",
    Backspace: "backspace",
    Delete: "delete",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Minus: "-",
    Equal: "=",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Backquote: "`",
  };

  return normalizeShortcutToken(codeMap[event.code] || event.key);
};

const shortcutMatchesEvent = (shortcut: string, event: KeyboardEvent) => {
  const tokens = shortcutTokens(shortcut).map(normalizeShortcutToken);
  if (tokens.length === 0) return false;

  const wantsCommand = tokens.includes("command");
  const wantsCtrl = tokens.includes("ctrl");
  const wantsShift = tokens.includes("shift");
  const wantsOption = tokens.includes("option");
  const keyToken = eventKeyToken(event);
  const nonModifierTokens = tokens.filter(
    (token) =>
      token !== "command" &&
      token !== "ctrl" &&
      token !== "shift" &&
      token !== "option",
  );

  return (
    event.metaKey === wantsCommand &&
    event.ctrlKey === wantsCtrl &&
    event.shiftKey === wantsShift &&
    event.altKey === wantsOption &&
    nonModifierTokens.length === 1 &&
    nonModifierTokens[0] === keyToken
  );
};

const InstructionPill: React.FC<{
  icon?: LucideIcon;
  children: React.ReactNode;
}> = ({ icon: Icon = Keyboard, children }) => (
  <div className="inline-flex max-w-full items-start gap-2 rounded-2xl bg-white/70 px-3.5 py-2 text-[13px] font-semibold leading-[1.25] text-zinc-600 shadow-[0_10px_28px_-24px_rgb(15_23_42_/_0.45)]">
    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
    <span className="min-w-0">{children}</span>
  </div>
);

const ShortcutBadge: React.FC<{ shortcut: string }> = ({ shortcut }) => (
  <div className="inline-flex items-center gap-1.5 rounded-[18px] bg-zinc-950 px-3 py-2 text-[13px] font-semibold text-white shadow-[0_14px_34px_-26px_rgb(15_23_42_/_0.85)]">
    {shortcutTokens(shortcut).map((token) => (
      <React.Fragment key={token}>
        <span className="rounded-xl bg-white/12 px-2 py-1">
          {displayShortcutToken(token)}
        </span>
      </React.Fragment>
    ))}
    {shortcutTokens(shortcut).length === 0 ? (
      <span className="rounded-xl bg-white/12 px-2 py-1">Not set</span>
    ) : null}
  </div>
);

const SectionShell: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className = "" }) => (
  <div
    className={`relative h-full min-h-0 overflow-hidden rounded-[32px] bg-white/72 p-5 shadow-[0_28px_80px_-48px_rgb(15_23_42_/_0.45)] ${className}`}
  >
    {children}
  </div>
);

const BreezeTypeMark: React.FC<{ size?: number }> = ({ size = 58 }) => {
  const svgMarkup = useMemo(
    () =>
      breezeTraceSvg.replace(
        "<svg ",
        '<svg aria-hidden="true" focusable="false" ',
      ),
    [],
  );

  return (
    <span
      aria-hidden="true"
      className="inline-flex items-center justify-center text-zinc-950"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svgMarkup }}
    />
  );
};

const RecordingBubble: React.FC<{
  frame: number;
  visible: boolean;
  compact?: boolean;
}> = ({ frame, visible, compact = false }) => {
  const bars = compact ? 10 : 16;
  return (
    <div
      className="flex items-center justify-center rounded-full transition-all duration-500 ease-out"
      style={{
        width: visible ? (compact ? 78 : 96) : 32,
        height: compact ? 30 : 34,
        background: "#000000cc",
        opacity: visible ? 1 : 0,
        transform: `translateY(${visible ? 0 : 8}px) scale(${visible ? 1 : 0.92})`,
      }}
    >
      <div className="flex h-[22px] items-center justify-center gap-[2px] overflow-hidden">
        {Array.from({ length: bars }).map((_, index) => {
          const wave = Math.sin(frame / 5 + index * 0.74);
          const pulse = Math.sin(frame / 9 + index * 1.8);
          const height = 4 + Math.max(0, wave * 0.65 + pulse * 0.35) * 17;
          return (
            <span
              key={index}
              className="w-[5px] rounded-full bg-white transition-[height,opacity] duration-75 ease-out"
              style={{
                height,
                opacity: 0.58 + Math.max(0, wave) * 0.35,
              }}
            />
          );
        })}
      </div>
    </div>
  );
};

const ClassyConfetti: React.FC<{
  show: boolean;
  variant?: "small" | "wide";
}> = ({ show, variant = "small" }) => {
  if (!show) return null;
  const pieces = variant === "wide" ? 28 : 16;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <style>
        {`@keyframes tutorialConfettiFloat {
            0% { opacity: 0; transform: translate3d(0, 16px, 0) scale(.72) rotate(0deg); }
            16% { opacity: .9; }
            100% { opacity: 0; transform: translate3d(var(--x), var(--y), 0) scale(1) rotate(var(--r)); }
          }`}
      </style>
      {Array.from({ length: pieces }).map((_, index) => {
        const colors = ["#2563EB", "#16A34A", "#F97316", "#0EA5E9"];
        const left = variant === "wide" ? 16 + ((index * 11) % 68) : 42;
        const top = variant === "wide" ? 18 + ((index * 7) % 46) : 34;
        return (
          <span
            key={index}
            className="absolute h-1.5 w-5 rounded-full"
            style={
              {
                left: `${left}%`,
                top: `${top}%`,
                background: colors[index % colors.length],
                animation: `tutorialConfettiFloat ${900 + (index % 5) * 120}ms ease-out ${index * 24}ms both`,
                "--x": `${(index % 2 === 0 ? 1 : -1) * (38 + (index % 7) * 9)}px`,
                "--y": `${-60 - (index % 6) * 18}px`,
                "--r": `${(index % 2 === 0 ? 1 : -1) * (90 + index * 14)}deg`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </div>
  );
};

const DictationPractice: React.FC<{
  frame: number;
  shortcut: string;
  started: boolean;
  complete: boolean;
  transcript: string | null;
  onStart: () => void;
  onComplete: () => void;
}> = ({
  frame,
  shortcut,
  started,
  complete,
  transcript,
  onStart,
  onComplete,
}) => {
  const displayTranscript = transcript || DICTATION_PHRASE;

  return (
    <SectionShell>
      <ClassyConfetti show={complete} />
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              Dictation practice
            </div>
            <div className="mt-1 text-2xl font-semibold text-zinc-950">
              Try one phrase
            </div>
          </div>
          <ShortcutBadge shortcut={shortcut} />
        </div>

        <div className="mt-5 rounded-[26px] bg-[#f5f7fb] p-4">
          <div className="text-sm font-medium text-zinc-500">
            Read this out loud
          </div>
          <div className="mt-2 text-[24px] font-semibold leading-tight text-zinc-950">
            "{DICTATION_PHRASE}"
          </div>
        </div>

        <div className="mt-3 rounded-[24px] bg-white/70 shadow-[inset_0_0_0_1px_rgb(15_23_42_/_0.04),0_14px_34px_-30px_rgb(15_23_42_/_0.5)]">
          <FnKeyToggle descriptionMode="tooltip" grouped />
        </div>

        <div className="relative mt-4 min-h-[124px] flex-1 rounded-[28px] bg-white p-5 shadow-[inset_0_0_0_1px_rgb(15_23_42_/_0.04)]">
          <div className="text-sm font-semibold text-zinc-400">Notes</div>
          <div
            className="mt-3 min-h-[58px] text-[22px] font-medium leading-snug text-zinc-900 transition-all duration-500 ease-out"
            style={{
              opacity: complete ? 1 : 0,
              transform: `translateY(${complete ? 0 : 8}px)`,
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 3,
              overflow: "hidden",
            }}
          >
            {complete ? displayTranscript : null}
          </div>
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2">
            <RecordingBubble frame={frame} visible={started && !complete} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <InstructionPill>
            Press {formatShortcutText(shortcut)}, read the phrase, then release.
          </InstructionPill>
          {!started ? (
            <button
              type="button"
              className="rounded-full bg-zinc-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800"
              onClick={onStart}
            >
              Start practice
            </button>
          ) : !complete ? (
            <button
              type="button"
              className="rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500"
              onClick={onComplete}
            >
              I said it
            </button>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
              <Check className="h-4 w-4" />
              Nice, that is the whole loop.
            </div>
          )}
        </div>
      </div>
    </SectionShell>
  );
};

const ClipboardPractice: React.FC<{
  shortcut: string;
  copied: Record<ClipboardPhraseId, boolean>;
  pasted: Record<ClipboardPhraseId, boolean>;
  onCopy: (phraseId: ClipboardPhraseId) => void;
  onPaste: (phraseId: ClipboardPhraseId, value: string) => void;
}> = ({ shortcut, copied, pasted, onCopy, onPaste }) => {
  const allCopied = copied.first && copied.second;
  const allPasted = pasted.first && pasted.second;

  return (
    <SectionShell>
      <ClassyConfetti show={allPasted} />
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              Clipboard practice
            </div>
            <div className="mt-1 text-[22px] font-semibold text-zinc-950">
              Copy two useful snippets
            </div>
          </div>
          <ShortcutBadge shortcut={shortcut} />
        </div>

        <div className="relative mt-5 flex-1 overflow-hidden rounded-[28px] bg-[#f5f7fb] p-4">
          <div
            className={`absolute inset-4 grid content-start gap-3 transition-all duration-500 ease-out ${
              allCopied
                ? "pointer-events-none translate-y-2 opacity-0"
                : "opacity-100"
            }`}
          >
            {(Object.keys(CLIPBOARD_PHRASES) as ClipboardPhraseId[]).map(
              (phraseId, index) => (
                <div
                  key={phraseId}
                  className="flex min-h-[92px] items-center justify-between gap-4 rounded-[24px] bg-white px-4 py-3 shadow-[inset_0_0_0_1px_rgb(15_23_42_/_0.04)]"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-zinc-400">
                      Copy {index + 1}
                    </div>
                    <div className="mt-1.5 text-[17px] font-semibold leading-snug text-zinc-950">
                      {CLIPBOARD_PHRASES[phraseId]}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-2 rounded-full bg-zinc-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800"
                    onClick={() => onCopy(phraseId)}
                  >
                    {copied[phraseId] ? (
                      <ClipboardCheck className="h-4 w-4 text-blue-200" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                    {copied[phraseId] ? "Copied" : "Copy"}
                  </button>
                </div>
              ),
            )}
          </div>

          <div
            className={`absolute inset-4 rounded-[26px] bg-zinc-950 p-4 text-white transition-all duration-500 ease-out ${
              allCopied
                ? "translate-y-0 opacity-100"
                : "pointer-events-none translate-y-3 opacity-0"
            }`}
          >
            <div>
              <div className="text-sm font-semibold text-white/45">Notepad</div>
              <div className="mt-1 text-[22px] font-semibold">
                Paste each snippet here
              </div>
            </div>
            <div className="mt-4 grid gap-2.5">
              {(Object.keys(CLIPBOARD_PHRASES) as ClipboardPhraseId[]).map(
                (phraseId, index) => (
                  <label key={phraseId} className="block">
                    <span className="mb-1.5 block text-sm font-semibold text-white/45">
                      Paste {index + 1}
                    </span>
                    <textarea
                      className="h-[62px] w-full resize-none rounded-[20px] bg-white px-4 py-3 text-[15px] font-medium leading-6 text-zinc-900 outline-none transition focus:bg-blue-50"
                      placeholder={`Paste the ${index === 0 ? "first" : "second"} snippet`}
                      onPaste={(event) =>
                        onPaste(phraseId, event.clipboardData.getData("text"))
                      }
                      onChange={(event) =>
                        onPaste(phraseId, event.currentTarget.value)
                      }
                    />
                  </label>
                ),
              )}
            </div>
            {allPasted ? (
              <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-950">
                <Check className="h-4 w-4 text-blue-600" />
                That is clipboard history doing its job.
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-4">
          <InstructionPill icon={Clipboard}>
            Hold {formatShortcutText(shortcut)}, use Up / Down to move between
            clips, then release to paste.
          </InstructionPill>
        </div>
      </div>
    </SectionShell>
  );
};

const TasksPractice: React.FC<{
  shortcut: string;
  draft: string;
  created: boolean;
  onDraftChange: (value: string) => void;
  onCreate: () => void;
}> = ({ shortcut, draft, created, onDraftChange, onCreate }) => {
  const canCreate = draft.trim().length > 0;

  return (
    <SectionShell>
      <ClassyConfetti show={created} />
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              Quick task practice
            </div>
            <div className="mt-1 text-[22px] font-semibold text-zinc-950">
              Capture a next step
            </div>
          </div>
          <ShortcutBadge shortcut={shortcut} />
        </div>

        <div className="mt-5 rounded-[26px] bg-[#f5f7fb] p-4">
          <div className="text-sm font-semibold text-zinc-500">Try typing</div>
          <div className="mt-2 text-[22px] font-semibold leading-tight text-zinc-950">
            {TASK_EXAMPLE}
          </div>
        </div>

        <div className="mt-4 rounded-[30px] bg-zinc-950 p-4 text-white">
          <div>
            <div className="text-sm font-semibold text-white/45">
              Quick Task
            </div>
            <div className="mt-1 text-[22px] font-semibold">
              Add it without breaking flow
            </div>
          </div>
          <div className="mt-4 rounded-[24px] bg-white/8 p-3">
            <input
              className="w-full rounded-[18px] bg-white px-4 py-2.5 text-[16px] font-medium text-zinc-950 outline-none"
              value={draft}
              onChange={(event) => onDraftChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canCreate) {
                  event.preventDefault();
                  onCreate();
                }
              }}
              placeholder="Create task"
            />
            <div className="mt-3 flex items-center justify-between text-sm text-white/50">
              <span>tomorrow / LAUNCH / normal priority</span>
              <button
                type="button"
                disabled={!canCreate}
                className="rounded-full bg-white px-3.5 py-2 font-semibold text-zinc-950 transition hover:bg-blue-50 disabled:opacity-40"
                onClick={onCreate}
              >
                Create
              </button>
            </div>
          </div>

          <div className="mt-3">
            {created ? (
              <TaskRow
                title={draft.trim() || TASK_EXAMPLE}
                meta="Tomorrow / LAUNCH"
                checked
              />
            ) : (
              <TaskRow title="Review meeting transcript" meta="Tomorrow / P2" />
            )}
          </div>
        </div>
      </div>
    </SectionShell>
  );
};

const TaskRow: React.FC<{
  title: string;
  meta: string;
  checked?: boolean;
}> = ({ title, meta, checked = false }) => (
  <div className="flex items-center gap-3 rounded-[18px] bg-white px-3 py-2 text-zinc-950">
    <span
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${
        checked ? "bg-blue-600 text-white" : "bg-white text-transparent"
      }`}
      style={
        !checked
          ? { boxShadow: "inset 0 0 0 1px rgb(15 23 42 / 0.06)" }
          : undefined
      }
    >
      <Check className="h-3.5 w-3.5" />
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-semibold text-zinc-900">
        {title}
      </span>
      <span className="block truncate text-xs font-medium text-zinc-400">
        {meta}
      </span>
    </span>
  </div>
);

const MeetingPractice: React.FC<{ frame: number }> = ({ frame }) => {
  const transcriptIn = clamp(frame, [36, 94], [0, 1]);

  return (
    <SectionShell>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-start justify-between gap-5">
          <div>
            <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
              Meeting recordings
            </div>
            <div className="mt-1 text-[22px] font-semibold text-zinc-950">
              Record the call you are already in
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-full bg-red-500 px-4 py-2 text-sm font-semibold text-white"
          >
            Record
          </button>
        </div>

        <div className="mt-4 rounded-[26px] bg-[#f5f7fb] p-4 text-[16px] font-medium leading-6 text-zinc-700">
          Hit Record and BreezeType captures the meeting audio on your Mac, then
          transcribes it for review. No bot joins the call.
        </div>

        <div className="mt-4 rounded-[30px] bg-zinc-950 p-4 text-white">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-semibold text-white/45">
                Recording
              </div>
              <div className="mt-1 text-[24px] font-semibold">Design sync</div>
            </div>
            <div className="rounded-full bg-white/10 px-3 py-1.5 text-sm font-semibold text-white/65">
              12:48
            </div>
          </div>
          <div className="mt-4 flex items-center justify-center rounded-[26px] bg-white/8 py-5">
            <RecordingBubble frame={frame} visible compact={false} />
          </div>
          <div className="mt-3 grid gap-2">
            {[
              ["Nathan", "Let's capture next steps and owners."],
              ["Alex", "I will update the launch checklist."],
            ].map(([speaker, line], index) => {
              const rowIn = clamp(
                frame,
                [46 + index * 12, 76 + index * 12],
                [0, 1],
              );
              return (
                <div
                  key={speaker}
                  className="rounded-[18px] bg-white px-3 py-2 text-zinc-950"
                  style={{
                    opacity: transcriptIn * rowIn,
                    transform: `translateY(${interpolate(rowIn, [0, 1], [12, 0])}px)`,
                  }}
                >
                  <div className="text-[13px] font-semibold text-blue-600">
                    {speaker}
                  </div>
                  <div className="mt-0.5 text-[14px] font-medium text-zinc-700">
                    {line}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </SectionShell>
  );
};

const FinishScreen: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <SectionShell className="grid place-items-center">
    <ClassyConfetti show variant="wide" />
    <div className="relative z-10 max-w-xl text-center">
      <div className="mx-auto grid h-20 w-20 place-items-center rounded-[26px] bg-white/78 shadow-[0_18px_44px_-30px_rgb(15_23_42_/_0.55),inset_0_0_0_1px_rgb(15_23_42_/_0.05)]">
        <BreezeTypeMark size={58} />
      </div>
      <div className="mt-7 text-[54px] font-semibold leading-none tracking-normal text-zinc-950">
        You are ready.
      </div>
      <div className="mx-auto mt-5 max-w-md text-[18px] font-medium leading-7 text-zinc-500">
        Dictate anywhere, reuse clipboard history, capture tasks fast, and
        record meetings without adding a bot.
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-8 rounded-full bg-zinc-950 px-6 py-3 text-sm font-semibold text-white transition hover:bg-zinc-800"
      >
        Start using BreezeType
      </button>
    </div>
  </SectionShell>
);

const SceneMock: React.FC<{
  step: HelpTutorialStep;
  frame: number;
  shortcuts: HelpTutorialShortcuts;
  practiceState: PracticeState;
  onStartDictationPractice: () => void;
  onCompleteDictationPractice: (transcript?: string | null) => void;
  onCopyPhrase: (phraseId: ClipboardPhraseId) => void;
  onClipboardPaste: (phraseId: ClipboardPhraseId, value: string) => void;
  onTaskDraftChange: (value: string) => void;
  onCreateTask: () => void;
  onClose: () => void;
}> = ({
  step,
  frame,
  shortcuts,
  practiceState,
  onStartDictationPractice,
  onCompleteDictationPractice,
  onCopyPhrase,
  onClipboardPaste,
  onTaskDraftChange,
  onCreateTask,
  onClose,
}) => {
  switch (step.id) {
    case "dictation":
      return (
        <DictationPractice
          frame={frame}
          shortcut={shortcuts.dictation}
          started={practiceState.dictationStarted}
          complete={practiceState.dictationComplete}
          transcript={practiceState.dictationTranscript}
          onStart={onStartDictationPractice}
          onComplete={onCompleteDictationPractice}
        />
      );
    case "clipboard":
      return (
        <ClipboardPractice
          shortcut={shortcuts.clipboard}
          copied={practiceState.clipboardCopied}
          pasted={practiceState.clipboardPasted}
          onCopy={onCopyPhrase}
          onPaste={onClipboardPaste}
        />
      );
    case "tasks":
      return (
        <TasksPractice
          shortcut={shortcuts.quickTask}
          draft={practiceState.taskDraft}
          created={practiceState.taskCreated}
          onDraftChange={onTaskDraftChange}
          onCreate={onCreateTask}
        />
      );
    case "meetings":
      return <MeetingPractice frame={frame} />;
    case "finish":
      return <FinishScreen onClose={onClose} />;
  }
};

const TutorialScene: React.FC<{
  step: HelpTutorialStep;
  frame: number;
  stepStatusLabel: string;
  shortcuts: HelpTutorialShortcuts;
  practiceState: PracticeState;
  onStartDictationPractice: () => void;
  onCompleteDictationPractice: (transcript?: string | null) => void;
  onCopyPhrase: (phraseId: ClipboardPhraseId) => void;
  onClipboardPaste: (phraseId: ClipboardPhraseId, value: string) => void;
  onTaskDraftChange: (value: string) => void;
  onCreateTask: () => void;
  onClose: () => void;
}> = ({
  step,
  frame,
  stepStatusLabel,
  shortcuts,
  practiceState,
  onStartDictationPractice,
  onCompleteDictationPractice,
  onCopyPhrase,
  onClipboardPaste,
  onTaskDraftChange,
  onCreateTask,
  onClose,
}) => {
  const accent = stepAccentById[step.id];
  const Icon = stepIconById[step.id];
  const motion = clamp(frame, [0, 0.45 * TUTORIAL_FPS], [0, 1]);
  const mockShift = interpolate(motion, [0, 1], [18, 0]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        padding: "84px 40px 88px",
        display: "grid",
        gridTemplateColumns: "minmax(200px, 260px) minmax(0, 1fr)",
        gridTemplateRows: "minmax(0, 1fr)",
        gap: 22,
      }}
    >
      <div className="flex min-h-0 flex-col justify-center">
        <div className="inline-flex items-center gap-2 self-start rounded-full bg-white/72 px-3 py-2 text-sm font-semibold text-zinc-600 shadow-[0_10px_28px_-24px_rgb(15_23_42_/_0.45)]">
          <Icon className="h-4 w-4" style={{ color: accent }} />
          {step.eyebrow}
        </div>
        <div className="mt-6 text-[38px] font-semibold leading-none tracking-normal text-zinc-950">
          {step.title}
        </div>
        <div className="mt-4 text-[18px] font-medium leading-[1.32] text-zinc-500">
          {step.description}
        </div>
        <div className="mt-7 text-[15px] font-semibold text-zinc-400">
          {stepStatusLabel}
        </div>
      </div>

      <div
        style={{
          position: "relative",
          transform: `translateX(${mockShift}px) scale(${0.985 + motion * 0.015})`,
          height: "100%",
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <SceneMock
          step={step}
          frame={frame}
          shortcuts={shortcuts}
          practiceState={practiceState}
          onStartDictationPractice={onStartDictationPractice}
          onCompleteDictationPractice={onCompleteDictationPractice}
          onCopyPhrase={onCopyPhrase}
          onClipboardPaste={onClipboardPaste}
          onTaskDraftChange={onTaskDraftChange}
          onCreateTask={onCreateTask}
          onClose={onClose}
        />
      </div>
    </div>
  );
};

const TutorialComposition: React.FC<TutorialCompositionProps> = ({
  steps,
  stepIndex,
  frame,
  labels,
  shortcuts,
  practiceState,
  onStartDictationPractice,
  onCompleteDictationPractice,
  onCopyPhrase,
  onClipboardPaste,
  onTaskDraftChange,
  onCreateTask,
  onClose,
}) => {
  const currentStepIndex = Math.min(steps.length - 1, stepIndex);
  const currentStep = steps[currentStepIndex];
  const stepStatusLabel = labels.stepStatus(currentStepIndex + 1, steps.length);

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[#eef3f8]"
      style={{
        fontFamily:
          'system-ui, -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif',
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(15, 23, 42, 0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(15, 23, 42, 0.025) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />
      <div className="absolute -bottom-24 -right-20 rotate-[-12deg] opacity-[0.035]">
        <BreezeTypeHand width={320} height={344} />
      </div>
      <div className="absolute left-11 right-11 top-9 z-10 flex items-center justify-between">
        <BreezeTypeTextLogo width={210} />
        <div className="flex items-center gap-2">
          {steps.map((step, index) => {
            const Icon = stepIconById[step.id];
            const accent = stepAccentById[step.id];
            const active = index === currentStepIndex;
            return (
              <div
                key={step.id}
                className="grid h-10 w-10 place-items-center rounded-2xl bg-white/70 transition"
                style={{
                  color: active ? accent : "#94A3B8",
                  boxShadow: active
                    ? "0 14px 34px -28px rgb(15 23 42 / 0.6)"
                    : undefined,
                }}
              >
                <Icon size={18} />
              </div>
            );
          })}
        </div>
      </div>
      {currentStep ? (
        <TutorialScene
          step={currentStep}
          frame={frame}
          stepStatusLabel={stepStatusLabel}
          shortcuts={shortcuts}
          practiceState={practiceState}
          onStartDictationPractice={onStartDictationPractice}
          onCompleteDictationPractice={onCompleteDictationPractice}
          onCopyPhrase={onCopyPhrase}
          onClipboardPaste={onClipboardPaste}
          onTaskDraftChange={onTaskDraftChange}
          onCreateTask={onCreateTask}
          onClose={onClose}
        />
      ) : null}
    </div>
  );
};

const HelpTutorialPlayer: React.FC<HelpTutorialPlayerProps> = ({
  steps,
  labels,
  shortcuts,
  onClose,
}) => {
  const [stepIndex, setStepIndex] = useState(0);
  const [frame, setFrame] = useState(TUTORIAL_LOOP_START_FRAME);
  const [practiceState, setPracticeState] =
    useState<PracticeState>(initialPracticeState);
  const dictationShortcutHeldRef = useRef(false);
  const latestDictationHistoryIdRef = useRef<number | null>(null);
  const totalSteps = steps.length;
  const currentStep = steps[stepIndex];
  const currentAccent = stepAccentById[currentStep?.id ?? "dictation"];
  const canGoPrevious = stepIndex > 0;
  const canGoNext = stepIndex < totalSteps - 1;

  const goPrevious = useCallback(() => {
    setStepIndex((current) => Math.max(0, current - 1));
  }, []);

  const goNext = useCallback(() => {
    setStepIndex((current) => Math.min(totalSteps - 1, current + 1));
  }, [totalSteps]);

  const handleStartDictationPractice = useCallback(() => {
    setPracticeState((current) => ({
      ...current,
      dictationStarted: true,
      dictationComplete: false,
      dictationTranscript: null,
    }));
  }, []);

  const handleCompleteDictationPractice = useCallback(
    (transcript?: string | null) => {
      const normalizedTranscript = normalizeTranscriptText(transcript);
      setPracticeState((current) => ({
        ...current,
        dictationStarted: true,
        dictationComplete: true,
        dictationTranscript:
          normalizedTranscript || current.dictationTranscript || null,
      }));
    },
    [],
  );

  const readLatestDictationTranscript = useCallback(async () => {
    const result = await commands.getHistoryEntriesPageCompact(0, 1);
    if (result.status !== "ok") return null;

    const latest = result.data[0];
    if (!latest) return null;

    if (
      latestDictationHistoryIdRef.current !== null &&
      latest.id === latestDictationHistoryIdRef.current
    ) {
      return null;
    }

    latestDictationHistoryIdRef.current = latest.id;
    return normalizeTranscriptText(latest.text);
  }, []);

  const handleCopyPhrase = useCallback((phraseId: ClipboardPhraseId) => {
    void navigator.clipboard
      ?.writeText(CLIPBOARD_PHRASES[phraseId])
      .catch(() => undefined);
    setPracticeState((current) => ({
      ...current,
      clipboardCopied: {
        ...current.clipboardCopied,
        [phraseId]: true,
      },
    }));
  }, []);

  const handleClipboardPaste = useCallback(
    (phraseId: ClipboardPhraseId, value: string) => {
      const expected = CLIPBOARD_PHRASES[phraseId].toLowerCase();
      const pastedValue = value.toLowerCase();
      if (!pastedValue.includes(expected.slice(0, 24))) return;
      setPracticeState((current) => ({
        ...current,
        clipboardPasted: {
          ...current.clipboardPasted,
          [phraseId]: true,
        },
      }));
    },
    [],
  );

  const handleTaskDraftChange = useCallback((value: string) => {
    setPracticeState((current) => ({
      ...current,
      taskDraft: value,
      taskCreated: false,
    }));
  }, []);

  const handleCreateTask = useCallback(() => {
    setPracticeState((current) => ({
      ...current,
      taskDraft: current.taskDraft.trim() || TASK_EXAMPLE,
      taskCreated: true,
    }));
  }, []);

  useEffect(() => {
    setStepIndex((current) => Math.min(current, Math.max(0, totalSteps - 1)));
  }, [totalSteps]);

  useEffect(() => {
    if (totalSteps <= 0) return;

    const startedAt = performance.now();
    const loopFrames = Math.max(
      1,
      TUTORIAL_FRAMES_PER_STEP - TUTORIAL_LOOP_START_FRAME,
    );
    let animationFrame = 0;
    setFrame(TUTORIAL_LOOP_START_FRAME);

    const tick = (time: number) => {
      const elapsedFrames = Math.floor(
        ((time - startedAt) / 1000) * TUTORIAL_FPS,
      );
      setFrame(TUTORIAL_LOOP_START_FRAME + (elapsedFrames % loopFrames));
      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [stepIndex, totalSteps]);

  useEffect(() => {
    dictationShortcutHeldRef.current = false;
  }, [stepIndex]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (isTextEntryTarget(event.target) && event.key !== "Escape") return;

      if (
        currentStep?.id === "dictation" &&
        !practiceState.dictationComplete &&
        !event.repeat &&
        shortcutMatchesEvent(shortcuts.dictation, event)
      ) {
        event.preventDefault();
        dictationShortcutHeldRef.current = true;
        handleStartDictationPractice();
        return;
      }

      if (event.metaKey || event.ctrlKey) return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goPrevious();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (
        currentStep?.id !== "dictation" ||
        practiceState.dictationComplete ||
        !dictationShortcutHeldRef.current
      ) {
        return;
      }

      event.preventDefault();
      dictationShortcutHeldRef.current = false;
      handleCompleteDictationPractice();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [
    currentStep?.id,
    goNext,
    goPrevious,
    handleCompleteDictationPractice,
    handleStartDictationPractice,
    onClose,
    practiceState.dictationComplete,
    shortcuts.dictation,
  ]);

  useEffect(() => {
    if (currentStep?.id !== "dictation" || practiceState.dictationComplete) {
      return;
    }

    let disposed = false;
    let sawNativeDictation = false;
    let completeTimer: number | null = null;
    let unlistenHistory: (() => void) | null = null;

    void commands
      .getHistoryEntriesPageCompact(0, 1)
      .then((result) => {
        if (disposed || result.status !== "ok") return;
        latestDictationHistoryIdRef.current = result.data[0]?.id ?? null;
      })
      .catch(() => undefined);

    const clearCompleteTimer = () => {
      if (completeTimer === null) return;
      window.clearTimeout(completeTimer);
      completeTimer = null;
    };

    const completeWithLatestDictation = async () => {
      let transcript: string | null = null;
      try {
        transcript = await readLatestDictationTranscript();
      } catch {
        transcript = null;
      }

      if (disposed) return;
      handleCompleteDictationPractice(transcript);
    };

    const completeAfterNativeDictation = (
      delay = TUTORIAL_DICTATION_SETTLE_MS,
    ) => {
      if (completeTimer !== null) return;
      clearCompleteTimer();
      completeTimer = window.setTimeout(() => {
        if (disposed) return;
        void completeWithLatestDictation();
      }, delay);
    };

    const pollNativeDictation = async () => {
      try {
        const active = await commands.isVoiceActivityActive();
        if (disposed) return;

        if (active) {
          sawNativeDictation = true;
          clearCompleteTimer();
          handleStartDictationPractice();
          return;
        }

        if (sawNativeDictation) {
          completeAfterNativeDictation();
        }
      } catch {
        // Browser-only tests and preview builds may not expose the native command.
      }
    };

    const intervalId = window.setInterval(() => {
      void pollNativeDictation();
    }, 250);
    void pollNativeDictation();

    void listen("history-updated", () => {
      if (disposed) return;
      sawNativeDictation = true;
      handleStartDictationPractice();
      completeAfterNativeDictation(180);
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenHistory = unlisten;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      clearCompleteTimer();
      unlistenHistory?.();
    };
  }, [
    currentStep?.id,
    handleCompleteDictationPractice,
    handleStartDictationPractice,
    practiceState.dictationComplete,
    readLatestDictationTranscript,
  ]);

  if (totalSteps === 0) return null;

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[#eef3f8] text-zinc-950"
      role="dialog"
      aria-modal="true"
      aria-label={currentStep?.title}
    >
      <TutorialComposition
        steps={steps}
        stepIndex={stepIndex}
        frame={frame}
        labels={labels}
        shortcuts={shortcuts}
        practiceState={practiceState}
        onStartDictationPractice={handleStartDictationPractice}
        onCompleteDictationPractice={handleCompleteDictationPractice}
        onCopyPhrase={handleCopyPhrase}
        onClipboardPaste={handleClipboardPaste}
        onTaskDraftChange={handleTaskDraftChange}
        onCreateTask={handleCreateTask}
        onClose={onClose}
      />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 grid grid-cols-[1fr_auto_1fr] items-center gap-6 px-8 pb-6">
        <button
          type="button"
          onClick={onClose}
          className="pointer-events-auto justify-self-start rounded-full bg-white/75 px-5 py-2.5 text-sm font-semibold text-zinc-700 shadow-[0_14px_34px_-24px_rgb(15_23_42_/_0.7)] backdrop-blur-xl transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30"
        >
          {labels.skip}
        </button>

        <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-white/75 px-3 py-2 shadow-[0_14px_34px_-24px_rgb(15_23_42_/_0.7)] backdrop-blur-xl">
          {steps.map((step, index) => (
            <button
              key={step.id}
              type="button"
              onClick={() => setStepIndex(index)}
              className="h-2.5 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              style={{
                width: index === stepIndex ? 28 : 10,
                background:
                  index === stepIndex
                    ? currentAccent
                    : "rgba(100, 116, 139, 0.32)",
              }}
              aria-label={step.eyebrow}
            />
          ))}
        </div>

        <div className="pointer-events-auto flex justify-end gap-2">
          <button
            type="button"
            onClick={goPrevious}
            disabled={!canGoPrevious}
            className="grid h-11 w-11 place-items-center rounded-full bg-white/75 text-zinc-700 shadow-[0_14px_34px_-24px_rgb(15_23_42_/_0.7)] backdrop-blur-xl transition hover:bg-white disabled:pointer-events-none disabled:opacity-40 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            aria-label={labels.previous}
            title={labels.previous}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          {canGoNext ? (
            <button
              type="button"
              onClick={goNext}
              className="grid h-11 w-11 place-items-center rounded-full bg-white/85 text-zinc-800 shadow-[0_14px_34px_-24px_rgb(15_23_42_/_0.7)] backdrop-blur-xl transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              aria-label={labels.next}
              title={labels.next}
            >
              <ArrowRight className="h-5 w-5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="grid h-11 w-11 place-items-center rounded-full text-white shadow-[0_14px_34px_-24px_rgb(15_23_42_/_0.7)] transition hover:brightness-105 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              style={{ background: currentAccent }}
              aria-label={labels.next}
              title={labels.next}
            >
              <ArrowRight className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default HelpTutorialPlayer;
