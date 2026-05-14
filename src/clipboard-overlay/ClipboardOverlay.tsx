import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  commands,
  type ClipboardHistoryEntry,
  type ClipboardHistoryEntryMedia,
} from "@/bindings";
import { syncLanguageFromSettings } from "@/i18n";
import {
  Image as ImageIcon,
  Keyboard,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";

const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();
const normalizeQuickPasteKey = (key: string): string | null => {
  if (key.length !== 1) return null;
  const trimmed = key.trim();
  if (trimmed.length !== 1) return null;
  return trimmed.toLowerCase();
};

const normalizeQuickPastes = (
  quickPastes: Partial<{ [key: string]: string }> | undefined,
): Record<string, string> => {
  if (!quickPastes) return {};
  const normalized: Record<string, string> = {};
  for (const [rawKey, text] of Object.entries(quickPastes)) {
    const key = normalizeQuickPasteKey(rawKey);
    if (!key || typeof text !== "string" || !text.trim()) continue;
    normalized[key] = text;
  }
  return normalized;
};

interface QuickPasteRow {
  id: number;
  key: string;
  text: string;
}

interface PendingQuickPaste {
  key: string;
  text: string;
}

const quickPasteMapToRows = (map: Record<string, string>): QuickPasteRow[] =>
  Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, text], index) => ({
      id: Date.now() + index,
      key,
      text,
    }));

const nextQuickPasteRowId = () =>
  Date.now() + Math.floor(Math.random() * 100_000);

const formatAppLabel = (entry?: ClipboardHistoryEntry) => {
  const name = entry?.source_app_name?.trim();
  if (name) return name;
  const identifier = entry?.source_app_identifier?.trim();
  if (!identifier) return "Clipboard";
  const lastSegment = identifier.split(/[/\\\\]/).pop() || identifier;
  return lastSegment.replace(/\.(app|exe)$/i, "");
};

const isImageEntry = (
  entry?: ClipboardHistoryEntry | null,
): entry is ClipboardHistoryEntry => entry?.content_kind === "image";

const formatImageLabel = (entry?: ClipboardHistoryEntry | null) => {
  if (entry?.media_width && entry.media_height) {
    return `${entry.media_width} x ${entry.media_height}`;
  }
  return entry?.text ?? "";
};

const formatTimestamp = (timestamp?: number | null) => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const dateLabel = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
  const timeLabel = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${dateLabel} at ${timeLabel}`;
};

const formatQuickPasteHotkeyToken = (token: string): string => {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return "";

  const tokenMap: Record<string, string> = {
    command: "⌘",
    cmd: "⌘",
    meta: "⌘",
    super: "⌘",
    commandorcontrol: "⌘/Ctrl",
    cmdorctrl: "⌘/Ctrl",
    ctrl: "⌃",
    control: "⌃",
    shift: "⇧",
    alt: "⌥",
    option: "⌥",
  };

  if (tokenMap[normalized]) {
    return tokenMap[normalized];
  }

  if (normalized.length === 1) {
    return normalized.toUpperCase();
  }

  return token.toUpperCase();
};

const MODIFIER_TOKENS = new Set([
  "command",
  "cmd",
  "meta",
  "super",
  "commandorcontrol",
  "cmdorctrl",
  "ctrl",
  "control",
  "shift",
  "alt",
  "option",
]);

const STICKY_SELECTION_TIMEOUT_MS = 3 * 60 * 1000;

const ClipboardOverlayImagePreview: React.FC<{
  media?: ClipboardHistoryEntryMedia | null;
  label: string;
}> = ({ media, label }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const width = media?.image_width ?? 0;
  const height = media?.image_height ?? 0;
  const imageDataBase64 = media?.image_data_base64;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageDataBase64 || width <= 0 || height <= 0) return;

    try {
      const binary = window.atob(imageDataBase64);
      const bytes = new Uint8ClampedArray(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      context.putImageData(new ImageData(bytes, width, height), 0, 0);
    } catch (error) {
      console.error("Failed to render clipboard image preview:", error);
    }
  }, [height, imageDataBase64, width]);

  if (!imageDataBase64 || width <= 0 || height <= 0) {
    return (
      <div className="clipboard-main-image-placeholder">
        <ImageIcon className="clipboard-main-image-placeholder-icon" />
        <span>{label}</span>
      </div>
    );
  }

  return (
    <div className="clipboard-main-image-frame">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="clipboard-main-image-canvas"
        aria-label={label}
      />
    </div>
  );
};

const ClipboardOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ClipboardHistoryEntry[]>([]);
  const [iconByIdentifier, setIconByIdentifier] = useState<
    Record<string, string>
  >({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [keyBindingsOpen, setKeyBindingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedEntryId, setSelectedEntryId] = useState<number | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [quickPasteRows, setQuickPasteRows] = useState<QuickPasteRow[]>([]);
  const [clipboardShortcut, setClipboardShortcut] = useState("");
  const [addQuickPasteOpen, setAddQuickPasteOpen] = useState(false);
  const [newQuickPasteKey, setNewQuickPasteKey] = useState("");
  const [newQuickPasteText, setNewQuickPasteText] = useState("");
  const [isSavingQuickPastes, setIsSavingQuickPastes] = useState(false);
  const [quickPasteStatus, setQuickPasteStatus] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [mediaByEntryId, setMediaByEntryId] = useState<
    Record<number, ClipboardHistoryEntryMedia | null>
  >({});
  const isVisibleRef = useRef(false);
  const searchOpenRef = useRef(false);
  const keyBindingsOpenRef = useRef(false);
  const entriesRef = useRef<ClipboardHistoryEntry[]>([]);
  const selectedEntryIdRef = useRef<number | null>(null);
  const releasePasteArmedRef = useRef(false);
  const deferredHotkeyReleaseRef = useRef(false);
  const modifiersActiveRef = useRef(false);
  const saveMoveTimeoutRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const addQuickPasteKeyInputRef = useRef<HTMLInputElement | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const hasStickySelectionRef = useRef(false);
  const selectionPinnedAtRef = useRef(0);
  const selectionPinnedNewestIdRef = useRef<number | null>(null);
  const quickPastesRef = useRef<Record<string, string>>({});
  const pendingQuickPasteRef = useRef<PendingQuickPaste | null>(null);
  const loadingMediaIdsRef = useRef<Set<number>>(new Set());
  const [pendingQuickPasteHint, setPendingQuickPasteHint] =
    useState<PendingQuickPaste | null>(null);

  const fetchEntries = useCallback(async () => {
    const result = await commands.getClipboardHistoryEntries();
    if (result.status === "ok") {
      setEntries(result.data);
      return result.data;
    } else {
      console.error("Failed to load clipboard history:", result.error);
    }
    return null;
  }, []);

  const clearPendingQuickPaste = useCallback(() => {
    pendingQuickPasteRef.current = null;
    setPendingQuickPasteHint(null);
  }, []);

  const hideOverlay = useCallback(() => {
    if (!isVisibleRef.current) return;
    isVisibleRef.current = false;
    releasePasteArmedRef.current = false;
    deferredHotkeyReleaseRef.current = false;
    modifiersActiveRef.current = false;
    clearPendingQuickPaste();
    setIsVisible(false);
    commands.hideClipboardOverlay().catch(async () => {
      await getCurrentWindow().hide();
    });
  }, [clearPendingQuickPaste]);

  const disarmReleasePaste = useCallback(() => {
    releasePasteArmedRef.current = false;
    deferredHotkeyReleaseRef.current = false;
    clearPendingQuickPaste();
  }, [clearPendingQuickPaste]);

  const handleHeaderPointerDown = useCallback(
    async (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("button, input, textarea, select")) return;
      disarmReleasePaste();
      try {
        await getCurrentWindow().startDragging();
      } catch (error) {
        console.error("Failed to start dragging clipboard overlay:", error);
      }
    },
    [disarmReleasePaste],
  );

  const filteredEntries = useMemo(() => {
    if (!query.trim()) return entries;
    const needle = query.toLowerCase();
    return entries.filter((entry) => entry.text.toLowerCase().includes(needle));
  }, [entries, query]);

  const activeEntries = searchOpen ? filteredEntries : entries;

  const activeIndex = useMemo(() => {
    if (!activeEntries.length) return -1;
    if (selectedEntryId === null) return 0;
    const index = activeEntries.findIndex(
      (entry) => entry.id === selectedEntryId,
    );
    return index >= 0 ? index : 0;
  }, [activeEntries, selectedEntryId]);

  const selectedEntry = useMemo(() => {
    if (!entries.length) return undefined;
    if (selectedEntryId === null) return entries[0];
    return entries.find((entry) => entry.id === selectedEntryId) ?? entries[0];
  }, [entries, selectedEntryId]);
  const selectedEntryText = selectedEntry?.text ?? "";

  const reservedKeys = useMemo(() => {
    const keys = clipboardShortcut
      .split("+")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length === 1);
    return new Set(keys);
  }, [clipboardShortcut]);

  const reservedKeysLabel = useMemo(() => {
    const keys = Array.from(reservedKeys).sort();
    return keys.join(", ");
  }, [reservedKeys]);

  const clipboardShortcutUsesModifiers = useMemo(
    () =>
      clipboardShortcut
        .split("+")
        .map((part) => part.trim().toLowerCase())
        .some((part) => MODIFIER_TOKENS.has(part)),
    [clipboardShortcut],
  );

  const rememberSelectionContext = useCallback(
    (candidateEntries: ClipboardHistoryEntry[]) => {
      hasStickySelectionRef.current = true;
      selectionPinnedAtRef.current = Date.now();
      selectionPinnedNewestIdRef.current = candidateEntries[0]?.id ?? null;
    },
    [],
  );

  const resolveSelectionOnShow = useCallback(
    (candidateEntries: ClipboardHistoryEntry[], currentId: number | null) => {
      if (!candidateEntries.length) {
        hasStickySelectionRef.current = false;
        selectionPinnedNewestIdRef.current = null;
        selectionPinnedAtRef.current = 0;
        return null;
      }

      const newestId = candidateEntries[0].id;
      const pinnedNewestId = selectionPinnedNewestIdRef.current;
      const hasNewClipboardItem =
        pinnedNewestId !== null && pinnedNewestId !== newestId;
      const timedOut =
        selectionPinnedAtRef.current > 0 &&
        Date.now() - selectionPinnedAtRef.current >=
          STICKY_SELECTION_TIMEOUT_MS;

      if (
        hasStickySelectionRef.current &&
        currentId !== null &&
        candidateEntries.some((entry) => entry.id === currentId) &&
        !hasNewClipboardItem &&
        !timedOut
      ) {
        return currentId;
      }

      hasStickySelectionRef.current = false;
      selectionPinnedNewestIdRef.current = newestId;
      selectionPinnedAtRef.current = Date.now();
      return newestId;
    },
    [],
  );

  useEffect(() => {
    const identifiers = Array.from(
      new Set(
        entries
          .map((entry) => entry.source_app_identifier)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const missing = identifiers.filter(
      (identifier) => !iconByIdentifier[identifier],
    );
    if (missing.length === 0) return;

    let cancelled = false;
    const loadIcons = async () => {
      const results = await Promise.all(
        missing.map(async (identifier) => {
          const result = await commands.getAppIcon(identifier);
          if (result.status !== "ok") return [identifier, null] as const;
          return [identifier, result.data] as const;
        }),
      );

      if (cancelled) return;
      setIconByIdentifier((prev) => {
        const next = { ...prev };
        results.forEach(([identifier, data]) => {
          if (data && !next[identifier]) {
            next[identifier] = data;
          }
        });
        return next;
      });
    };

    loadIcons();

    return () => {
      cancelled = true;
    };
  }, [entries, iconByIdentifier]);

  const ensureSelection = useCallback(
    (candidateId?: number | null) => {
      if (!entries.length) {
        selectedEntryIdRef.current = null;
        setSelectedEntryId(null);
        return;
      }
      if (candidateId !== undefined && candidateId !== null) {
        const exists = entries.some((entry) => entry.id === candidateId);
        if (exists) {
          selectedEntryIdRef.current = candidateId;
          setSelectedEntryId(candidateId);
          return;
        }
      }
      selectedEntryIdRef.current = entries[0].id;
      setSelectedEntryId(entries[0].id);
    },
    [entries],
  );

  const selectByIndex = useCallback(
    (nextIndex: number) => {
      if (!activeEntries.length) return;
      const maxIndex = activeEntries.length - 1;
      const clamped = Math.max(0, Math.min(nextIndex, maxIndex));
      const nextEntryId = activeEntries[clamped].id;
      rememberSelectionContext(entriesRef.current);
      selectedEntryIdRef.current = nextEntryId;
      setSelectedEntryId(nextEntryId);
    },
    [activeEntries, rememberSelectionContext],
  );

  const handlePaste = useCallback(
    async (entry: ClipboardHistoryEntry | undefined) => {
      if (!entry) return;
      const result = await commands
        .pasteClipboardHistoryEntry(entry.id)
        .catch((error) => {
          console.error("Failed to paste clipboard entry:", error);
          return null;
        });
      if (result?.status === "error") {
        console.error("Failed to paste clipboard entry:", result.error);
      }
    },
    [],
  );

  const handleQuickPaste = useCallback(async (text: string) => {
    const result = await commands
      .pasteClipboardQuickPasteText(text)
      .catch((error) => {
        console.error("Failed to paste quick clipboard text:", error);
        return null;
      });
    if (result?.status === "error") {
      console.error("Failed to paste quick clipboard text:", result.error);
    }
  }, []);

  const fetchQuickPastes = useCallback(async () => {
    const result = await commands.getAppSettings();
    if (result.status !== "ok") {
      console.error("Failed to load quick paste settings:", result.error);
      return quickPastesRef.current;
    }

    const normalized = normalizeQuickPastes(result.data.clipboard_quick_pastes);
    quickPastesRef.current = normalized;
    setQuickPasteRows(quickPasteMapToRows(normalized));
    setClipboardShortcut(
      result.data.bindings?.clipboard_history?.current_binding ?? "",
    );
    return normalized;
  }, []);

  const updateQuickPasteRow = useCallback(
    (id: number, patch: Partial<QuickPasteRow>) => {
      setQuickPasteRows((current) =>
        current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      );
      setQuickPasteStatus(null);
    },
    [],
  );

  const removeQuickPasteRow = useCallback((id: number) => {
    setQuickPasteRows((current) => current.filter((row) => row.id !== id));
    setQuickPasteStatus(null);
  }, []);

  const closeAddQuickPasteComposer = useCallback(() => {
    setAddQuickPasteOpen(false);
    setNewQuickPasteKey("");
    setNewQuickPasteText("");
  }, []);

  const openAddQuickPasteComposer = useCallback(() => {
    disarmReleasePaste();
    setQuickPasteStatus(null);
    setAddQuickPasteOpen(true);
    setNewQuickPasteKey("");
    setNewQuickPasteText("");
  }, [disarmReleasePaste]);

  const handleQuickPasteKeyCapture = useCallback(
    (id: number, event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Tab") return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Backspace" || event.key === "Delete") {
        updateQuickPasteRow(id, { key: "" });
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      const nextKey = normalizeQuickPasteKey(event.key);
      if (!nextKey) return;
      updateQuickPasteRow(id, { key: nextKey });
    },
    [updateQuickPasteRow],
  );

  const handleNewQuickPasteKeyCapture = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Tab") return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Backspace" || event.key === "Delete") {
        setNewQuickPasteKey("");
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      const nextKey = normalizeQuickPasteKey(event.key);
      if (!nextKey) return;
      setNewQuickPasteKey(nextKey);
    },
    [],
  );

  const validateQuickPasteRows = useCallback(
    (rows: QuickPasteRow[]) => {
      const nextMap: Partial<{ [key: string]: string }> = {};
      const seen = new Set<string>();

      for (const row of rows) {
        const key = row.key.trim().toLowerCase();
        const text = row.text;
        const trimmedText = text.trim();

        if (!key && !trimmedText) {
          continue;
        }

        if (key.length !== 1) {
          setQuickPasteStatus({
            tone: "error",
            message: t("settings.general.quickPastes.errors.invalidKey"),
          });
          return null;
        }

        if (reservedKeys.has(key)) {
          setQuickPasteStatus({
            tone: "error",
            message: t("settings.general.quickPastes.errors.reservedKey", {
              key,
              shortcut: clipboardShortcut,
            }),
          });
          return null;
        }

        if (seen.has(key)) {
          setQuickPasteStatus({
            tone: "error",
            message: t("settings.general.quickPastes.errors.duplicateKey", {
              key,
            }),
          });
          return null;
        }

        if (!trimmedText) {
          setQuickPasteStatus({
            tone: "error",
            message: t("settings.general.quickPastes.errors.emptyText", {
              key,
            }),
          });
          return null;
        }

        seen.add(key);
        nextMap[key] = text;
      }

      return nextMap;
    },
    [clipboardShortcut, reservedKeys, t],
  );

  const saveQuickPastes = useCallback(
    async (rowsToSave: QuickPasteRow[] = quickPasteRows) => {
      const nextMap = validateQuickPasteRows(rowsToSave);
      if (!nextMap) return false;
      setIsSavingQuickPastes(true);
      setQuickPasteStatus(null);

      try {
        await commands.changeClipboardQuickPastesSetting(nextMap);
        const normalized = normalizeQuickPastes(nextMap);
        quickPastesRef.current = normalized;
        setQuickPasteRows(quickPasteMapToRows(normalized));
        setQuickPasteStatus({
          tone: "success",
          message: t("settings.general.quickPastes.saved"),
        });
        return true;
      } catch (error) {
        console.error("Failed to save clipboard quick pastes:", error);
        setQuickPasteStatus({
          tone: "error",
          message: t("settings.general.quickPastes.errors.save"),
        });
        return false;
      } finally {
        setIsSavingQuickPastes(false);
      }
    },
    [quickPasteRows, t, validateQuickPasteRows],
  );

  const saveNewQuickPaste = useCallback(async () => {
    const key = newQuickPasteKey.trim().toLowerCase();
    const text = newQuickPasteText;
    const trimmedText = text.trim();

    if (key.length !== 1) {
      setQuickPasteStatus({
        tone: "error",
        message: t("settings.general.quickPastes.errors.invalidKey"),
      });
      return;
    }

    if (!trimmedText) {
      setQuickPasteStatus({
        tone: "error",
        message: t("settings.general.quickPastes.errors.emptyText", { key }),
      });
      return;
    }

    const nextRows = [
      ...quickPasteRows,
      { id: nextQuickPasteRowId(), key, text },
    ];
    const saved = await saveQuickPastes(nextRows);
    if (!saved) return;
    closeAddQuickPasteComposer();
  }, [
    closeAddQuickPasteComposer,
    newQuickPasteKey,
    newQuickPasteText,
    quickPasteRows,
    saveQuickPastes,
    t,
  ]);

  useEffect(() => {
    if (!addQuickPasteOpen) return;
    const timeoutId = window.setTimeout(() => {
      addQuickPasteKeyInputRef.current?.focus();
      addQuickPasteKeyInputRef.current?.select();
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [addQuickPasteOpen]);

  useEffect(() => {
    if (keyBindingsOpen) return;
    closeAddQuickPasteComposer();
  }, [closeAddQuickPasteComposer, keyBindingsOpen]);

  const stagePendingQuickPaste = useCallback((key: string, text: string) => {
    const pending = { key, text };
    pendingQuickPasteRef.current = pending;
    setPendingQuickPasteHint(pending);
  }, []);

  const flushPendingQuickPaste = useCallback(() => {
    const pending = pendingQuickPasteRef.current;
    if (!pending) return false;
    clearPendingQuickPaste();
    releasePasteArmedRef.current = false;
    deferredHotkeyReleaseRef.current = false;
    void handleQuickPaste(pending.text);
    return true;
  }, [clearPendingQuickPaste, handleQuickPaste]);

  const pasteCurrentSelection = useCallback(() => {
    releasePasteArmedRef.current = false;
    deferredHotkeyReleaseRef.current = false;
    const currentEntries = entriesRef.current;
    if (!currentEntries.length) {
      void hideOverlay();
      return;
    }
    const currentSelectionId = selectedEntryIdRef.current;
    const selected =
      currentSelectionId === null
        ? currentEntries[0]
        : (currentEntries.find((entry) => entry.id === currentSelectionId) ??
          currentEntries[0]);
    void handlePaste(selected);
  }, [handlePaste, hideOverlay]);

  useEffect(() => {
    searchOpenRef.current = searchOpen;
  }, [searchOpen]);

  useEffect(() => {
    keyBindingsOpenRef.current = keyBindingsOpen;
  }, [keyBindingsOpen]);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    setMediaByEntryId((previous) => {
      const entryIds = new Set(entries.map((entry) => entry.id));
      const next: Record<number, ClipboardHistoryEntryMedia | null> = {};
      let changed = false;

      Object.entries(previous).forEach(([id, media]) => {
        const numericId = Number(id);
        if (entryIds.has(numericId)) {
          next[numericId] = media;
        } else {
          changed = true;
        }
      });

      return changed ? next : previous;
    });
  }, [entries]);

  useEffect(() => {
    selectedEntryIdRef.current = selectedEntryId;
  }, [selectedEntryId]);

  useEffect(() => {
    void fetchEntries();
    void fetchQuickPastes();
  }, [fetchEntries, fetchQuickPastes]);

  const showOverlay = useCallback(async () => {
    isVisibleRef.current = true;
    releasePasteArmedRef.current = true;
    deferredHotkeyReleaseRef.current = false;
    modifiersActiveRef.current =
      !clipboardShortcut || clipboardShortcutUsesModifiers;
    clearPendingQuickPaste();
    setIsVisible(true);
    setKeyBindingsOpen(false);
    setQuickPasteStatus(null);
    void syncLanguageFromSettings();
    void fetchQuickPastes();
    setSelectedEntryId((currentId) => {
      const nextId = resolveSelectionOnShow(entriesRef.current, currentId);
      selectedEntryIdRef.current = nextId;
      return nextId;
    });
    const latestEntries = await fetchEntries();
    setSelectedEntryId((currentId) => {
      const nextId = resolveSelectionOnShow(
        latestEntries ?? entriesRef.current,
        currentId,
      );
      selectedEntryIdRef.current = nextId;
      return nextId;
    });
    if (searchOpenRef.current) {
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return;
    }

    setTimeout(() => {
      panelRef.current?.focus();
    }, 0);
  }, [
    clearPendingQuickPaste,
    clipboardShortcut,
    clipboardShortcutUsesModifiers,
    fetchEntries,
    fetchQuickPastes,
    resolveSelectionOnShow,
  ]);

  useEffect(() => {
    let mounted = true;
    let unlistenShow: (() => void) | null = null;
    let unlistenHide: (() => void) | null = null;
    let unlistenUpdate: (() => void) | null = null;
    let unlistenFocus: (() => void) | null = null;
    let unlistenHotkeyReleased: (() => void) | null = null;

    const setupListeners = async () => {
      unlistenShow = await listen("clipboard-overlay-show", () => {
        void showOverlay();
      });

      unlistenHide = await listen("clipboard-overlay-hide", () => {
        isVisibleRef.current = false;
        releasePasteArmedRef.current = false;
        clearPendingQuickPaste();
        setKeyBindingsOpen(false);
        setQuickPasteStatus(null);
        setIsVisible(false);
      });

      unlistenUpdate = await listen("clipboard-history-updated", () => {
        void fetchEntries();
      });

      unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload }) => {
        if (payload) {
          if (!isVisibleRef.current) {
            isVisibleRef.current = true;
            setIsVisible(true);
          }
          void fetchEntries();
          return;
        }

        if (isVisibleRef.current) {
          void hideOverlay();
        }
      });

      unlistenHotkeyReleased = await listen(
        "clipboard-overlay-hotkey-released",
        () => {
          if (!isVisibleRef.current) return;
          if (flushPendingQuickPaste()) {
            return;
          }
          if (!releasePasteArmedRef.current) return;
          // The base shortcut key is often released before a follow-up quick-paste
          // key can be pressed, so defer the default paste until modifiers are up.
          deferredHotkeyReleaseRef.current = true;
          if (!modifiersActiveRef.current) {
            pasteCurrentSelection();
          }
        },
      );

      if (!mounted) {
        unlistenShow?.();
        unlistenHide?.();
        unlistenUpdate?.();
        unlistenFocus?.();
        unlistenHotkeyReleased?.();
      }
    };

    void setupListeners();

    return () => {
      mounted = false;
      unlistenShow?.();
      unlistenHide?.();
      unlistenUpdate?.();
      unlistenFocus?.();
      unlistenHotkeyReleased?.();
    };
  }, [
    clearPendingQuickPaste,
    fetchEntries,
    flushPendingQuickPaste,
    hideOverlay,
    pasteCurrentSelection,
    showOverlay,
  ]);

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    let unlisten: (() => void) | null = null;

    const scheduleSavePosition = () => {
      if (saveMoveTimeoutRef.current !== null) {
        window.clearTimeout(saveMoveTimeoutRef.current);
      }
      saveMoveTimeoutRef.current = window.setTimeout(async () => {
        saveMoveTimeoutRef.current = null;
        try {
          const [position, scaleFactor] = await Promise.all([
            currentWindow.outerPosition(),
            currentWindow.scaleFactor(),
          ]);
          await commands.setClipboardOverlayPosition({
            x: position.x / scaleFactor,
            y: position.y / scaleFactor,
          });
        } catch (error) {
          console.error("Failed to persist clipboard overlay position:", error);
        }
      }, 180);
    };

    const setup = async () => {
      unlisten = await currentWindow.onMoved(() => {
        scheduleSavePosition();
      });
    };

    setup();

    return () => {
      if (unlisten) {
        unlisten();
      }
      if (saveMoveTimeoutRef.current !== null) {
        window.clearTimeout(saveMoveTimeoutRef.current);
        saveMoveTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!entries.length) {
      hasStickySelectionRef.current = false;
      selectionPinnedNewestIdRef.current = null;
      selectionPinnedAtRef.current = 0;
      selectedEntryIdRef.current = null;
      setSelectedEntryId(null);
      return;
    }
    if (selectedEntryId === null) {
      selectedEntryIdRef.current = entries[0].id;
      setSelectedEntryId(entries[0].id);
      return;
    }
    if (!entries.some((entry) => entry.id === selectedEntryId)) {
      const fallbackId = entries[0].id;
      selectedEntryIdRef.current = fallbackId;
      setSelectedEntryId(fallbackId);
    }
  }, [entries, selectedEntryId]);

  useEffect(() => {
    if (!searchOpen) return;
    if (!filteredEntries.length) return;
    const isInFiltered = filteredEntries.some(
      (entry) => entry.id === selectedEntryId,
    );
    if (!isInFiltered) {
      const nextFilteredId = filteredEntries[0].id;
      selectedEntryIdRef.current = nextFilteredId;
      setSelectedEntryId(nextFilteredId);
    }
  }, [filteredEntries, searchOpen, selectedEntryId]);

  useEffect(() => {
    if (!searchOpen && query.trim()) {
      setQuery("");
    }
  }, [query, searchOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      modifiersActiveRef.current =
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
      if (!isVisible) return;
      const target = event.target as HTMLElement | null;
      const isInput =
        target?.tagName === "INPUT" ||
        target?.getAttribute("role") === "textbox";

      if (keyBindingsOpenRef.current) {
        if (event.key === "Escape") {
          disarmReleasePaste();
          event.preventDefault();
          setKeyBindingsOpen(false);
          setQuickPasteStatus(null);
        }
        return;
      }

      if (!isInput) {
        const key = normalizeQuickPasteKey(event.key);
        if (key) {
          const quickPaste = quickPastesRef.current[key];
          if (quickPaste) {
            event.preventDefault();
            const modifiersActive =
              event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
            if (modifiersActive) {
              releasePasteArmedRef.current = true;
              stagePendingQuickPaste(key, quickPaste);
              return;
            }
            clearPendingQuickPaste();
            releasePasteArmedRef.current = false;
            void handleQuickPaste(quickPaste);
            return;
          }
        }
      }

      if (event.key === "ArrowDown" && searchOpen) {
        event.preventDefault();
        selectByIndex(activeIndex + 1);
      } else if (event.key === "ArrowUp" && searchOpen) {
        event.preventDefault();
        selectByIndex(activeIndex - 1);
      } else if (event.key === "ArrowLeft") {
        if (isInput && searchOpen) return;
        event.preventDefault();
        selectByIndex(activeIndex - 1);
      } else if (event.key === "ArrowRight") {
        if (isInput && searchOpen) return;
        event.preventDefault();
        selectByIndex(activeIndex + 1);
      } else if (event.key === "Enter") {
        disarmReleasePaste();
        event.preventDefault();
        handlePaste(searchOpen ? activeEntries[activeIndex] : selectedEntry);
      } else if (event.key === "Escape") {
        disarmReleasePaste();
        event.preventDefault();
        void hideOverlay();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      modifiersActiveRef.current =
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
      if (!isVisible) return;
      if (keyBindingsOpenRef.current) return;
      const releasedQuickPasteKey = normalizeQuickPasteKey(event.key);
      if (
        pendingQuickPasteRef.current &&
        releasedQuickPasteKey === pendingQuickPasteRef.current.key
      ) {
        event.preventDefault();
        void flushPendingQuickPaste();
        return;
      }
      const modifiersActive = modifiersActiveRef.current;
      if (modifiersActive) return;
      if (pendingQuickPasteRef.current) {
        event.preventDefault();
        void flushPendingQuickPaste();
        return;
      }
      if (deferredHotkeyReleaseRef.current && releasePasteArmedRef.current) {
        event.preventDefault();
        pasteCurrentSelection();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [
    activeEntries,
    activeIndex,
    handlePaste,
    handleQuickPaste,
    hideOverlay,
    isVisible,
    searchOpen,
    clearPendingQuickPaste,
    disarmReleasePaste,
    flushPendingQuickPaste,
    pasteCurrentSelection,
    selectByIndex,
    selectedEntry,
    stagePendingQuickPaste,
  ]);

  useEffect(() => {
    if (!searchOpen) return;
    const target = listRef.current?.querySelector(
      `[data-index="${activeIndex}"]`,
    );
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, filteredEntries, searchOpen]);

  const positionText = useMemo(() => {
    if (!entries.length || !selectedEntryId) return "0 out of 0";
    const index = entries.findIndex((entry) => entry.id === selectedEntryId);
    if (index < 0) return `0 out of ${entries.length}`;
    const positionFromNewest = index + 1;
    return `${positionFromNewest} out of ${entries.length}`;
  }, [entries, selectedEntryId]);

  const sourceLabel = useMemo(
    () => formatAppLabel(selectedEntry),
    [selectedEntry],
  );
  const sourceIdentifier = selectedEntry?.source_app_identifier ?? null;
  const sourceIcon = sourceIdentifier
    ? iconByIdentifier[sourceIdentifier]
    : null;
  const sourceInitial = sourceLabel.trim().slice(0, 1).toUpperCase();
  const timestampLabel = useMemo(
    () => formatTimestamp(selectedEntry?.timestamp),
    [selectedEntry],
  );
  const pendingQuickPasteVisible =
    Boolean(pendingQuickPasteHint) && !keyBindingsOpen;
  const pendingQuickPasteHotkeyText = useMemo(() => {
    if (!pendingQuickPasteHint) return "";

    const shortcutTokens = clipboardShortcut
      .split("+")
      .map((token) => formatQuickPasteHotkeyToken(token))
      .filter(Boolean);
    const quickKeyToken = pendingQuickPasteHint.key.toUpperCase();

    if (!shortcutTokens.length) {
      return quickKeyToken;
    }

    return `${shortcutTokens.join(" + ")} + ${quickKeyToken}`;
  }, [clipboardShortcut, pendingQuickPasteHint]);
  const pendingQuickPastePreviewText = useMemo(() => {
    if (!pendingQuickPasteHint) return "";
    return pendingQuickPasteHint.text;
  }, [pendingQuickPasteHint]);

  useEffect(() => {
    if (!isVisible || keyBindingsOpen || pendingQuickPasteVisible) return;
    if (!isImageEntry(selectedEntry)) return;
    if (
      Object.prototype.hasOwnProperty.call(mediaByEntryId, selectedEntry.id)
    ) {
      return;
    }
    if (loadingMediaIdsRef.current.has(selectedEntry.id)) return;

    const entryId = selectedEntry.id;
    let cancelled = false;
    loadingMediaIdsRef.current.add(entryId);

    const loadMedia = async () => {
      try {
        const result = await commands.getClipboardHistoryEntryMedia(entryId);
        if (cancelled) return;
        setMediaByEntryId((previous) => {
          if (Object.prototype.hasOwnProperty.call(previous, entryId)) {
            return previous;
          }
          return {
            ...previous,
            [entryId]: result.status === "ok" ? result.data : null,
          };
        });
      } finally {
        loadingMediaIdsRef.current.delete(entryId);
      }
    };

    void loadMedia();

    return () => {
      cancelled = true;
    };
  }, [
    isVisible,
    keyBindingsOpen,
    mediaByEntryId,
    pendingQuickPasteVisible,
    selectedEntry,
  ]);

  return (
    <div
      className="clipboard-overlay-root"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          void hideOverlay();
        }
      }}
    >
      <div
        ref={panelRef}
        className={`clipboard-panel ${isVisible ? "is-visible" : ""} ${
          pendingQuickPasteVisible ? "has-pending-quick-paste" : ""
        }`}
        tabIndex={-1}
        onMouseDown={(event) => {
          disarmReleasePaste();
          event.stopPropagation();
        }}
      >
        <div
          className="clipboard-header"
          onPointerDown={handleHeaderPointerDown}
        >
          {keyBindingsOpen ? (
            <div className="clipboard-mode-title">
              {t("settings.general.quickPastes.title")}
            </div>
          ) : (
            <div className="clipboard-source">
              <div className="clipboard-source-icon">
                {sourceIcon ? (
                  <img src={sourceIcon} alt="" />
                ) : (
                  <span>{sourceInitial}</span>
                )}
              </div>
              <div className="clipboard-source-name">{sourceLabel}</div>
            </div>
          )}
          <div className="clipboard-header-actions">
            <div
              ref={searchContainerRef}
              className={`clipboard-search-container ${
                searchOpen ? "open" : ""
              }`}
            >
              <button
                type="button"
                className="clipboard-search-button"
                onClick={() => {
                  disarmReleasePaste();
                  if (searchOpen) {
                    setSearchOpen(false);
                    setQuery("");
                    ensureSelection(selectedEntryId);
                  } else {
                    setKeyBindingsOpen(false);
                    setQuickPasteStatus(null);
                    setSearchOpen(true);
                    setTimeout(() => {
                      inputRef.current?.focus();
                      inputRef.current?.select();
                    }, 0);
                  }
                }}
                aria-label={t("common.search")}
              >
                <Search className="clipboard-search-icon" />
              </button>
              {searchOpen && (
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => {
                    disarmReleasePaste();
                    setQuery(event.target.value);
                  }}
                  onFocus={disarmReleasePaste}
                  placeholder={t("clipboardOverlay.searchPlaceholder")}
                  className="clipboard-search-input"
                />
              )}
              <button
                type="button"
                onClick={() => {
                  disarmReleasePaste();
                  setSearchOpen(false);
                  setQuery("");
                }}
                className="clipboard-search-close"
                aria-label={t("common.close")}
              >
                <X className="clipboard-search-close-icon" aria-hidden="true" />
              </button>
            </div>
            <button
              type="button"
              className={`clipboard-keybindings-button ${
                keyBindingsOpen ? "active" : ""
              }`}
              onClick={() => {
                disarmReleasePaste();
                if (keyBindingsOpen) {
                  setKeyBindingsOpen(false);
                  setQuickPasteStatus(null);
                  return;
                }
                setSearchOpen(false);
                setQuery("");
                setKeyBindingsOpen(true);
                setQuickPasteStatus(null);
                void fetchQuickPastes();
              }}
              aria-label={t("settings.general.quickPastes.title")}
              title={t("settings.general.quickPastes.title")}
            >
              <Keyboard className="clipboard-keybindings-icon" />
            </button>
          </div>
        </div>
        {keyBindingsOpen ? (
          <div className="clipboard-keybindings-panel">
            <div className="clipboard-keybindings-header">
              <button
                type="button"
                className="clipboard-keybindings-add-icon-button"
                onClick={openAddQuickPasteComposer}
                disabled={isSavingQuickPastes}
                aria-label={t("common.add")}
                title={t("common.add")}
              >
                <Plus className="clipboard-keybindings-add-icon" />
              </button>
            </div>
            {addQuickPasteOpen && (
              <div className="clipboard-keybindings-composer">
                <div className="clipboard-keybindings-composer-prompt">
                  {newQuickPasteKey
                    ? `${t("settings.general.quickPastes.keyPlaceholder")}: ${newQuickPasteKey.toUpperCase()}`
                    : t("settings.general.shortcut.pressKeys")}
                </div>
                <div className="clipboard-keybindings-composer-fields">
                  <input
                    ref={addQuickPasteKeyInputRef}
                    value={newQuickPasteKey}
                    onKeyDown={handleNewQuickPasteKeyCapture}
                    onFocus={disarmReleasePaste}
                    readOnly={true}
                    placeholder={t(
                      "settings.general.quickPastes.keyPlaceholder",
                    )}
                    className="clipboard-keybindings-key-input"
                    disabled={isSavingQuickPastes}
                  />
                  <input
                    value={newQuickPasteText}
                    onChange={(event) =>
                      setNewQuickPasteText(event.target.value)
                    }
                    onFocus={disarmReleasePaste}
                    placeholder={t(
                      "settings.general.quickPastes.textPlaceholder",
                    )}
                    className="clipboard-keybindings-text-input"
                    disabled={isSavingQuickPastes || !newQuickPasteKey}
                  />
                </div>
                <div className="clipboard-keybindings-composer-actions">
                  <button
                    type="button"
                    className="clipboard-keybindings-secondary"
                    onClick={closeAddQuickPasteComposer}
                    disabled={isSavingQuickPastes}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="clipboard-keybindings-save"
                    onClick={() => {
                      void saveNewQuickPaste();
                    }}
                    disabled={
                      isSavingQuickPastes ||
                      !newQuickPasteKey ||
                      !newQuickPasteText.trim()
                    }
                  >
                    {t("common.save")}
                  </button>
                </div>
              </div>
            )}
            <div className="clipboard-keybindings-list">
              {quickPasteRows.length === 0 ? (
                <div className="clipboard-keybindings-empty">
                  {t("settings.general.quickPastes.empty")}
                </div>
              ) : (
                quickPasteRows.map((row) => (
                  <div key={row.id} className="clipboard-keybindings-row">
                    <input
                      value={row.key}
                      onKeyDown={(event) =>
                        handleQuickPasteKeyCapture(row.id, event)
                      }
                      onFocus={disarmReleasePaste}
                      readOnly={true}
                      placeholder={t(
                        "settings.general.quickPastes.keyPlaceholder",
                      )}
                      className="clipboard-keybindings-key-input"
                      disabled={isSavingQuickPastes}
                      title={t("settings.general.shortcut.pressKeys")}
                    />
                    <input
                      value={row.text}
                      onChange={(event) =>
                        updateQuickPasteRow(row.id, {
                          text: event.target.value,
                        })
                      }
                      onFocus={disarmReleasePaste}
                      placeholder={t(
                        "settings.general.quickPastes.textPlaceholder",
                      )}
                      className="clipboard-keybindings-text-input"
                      disabled={isSavingQuickPastes}
                    />
                    <button
                      type="button"
                      className="clipboard-keybindings-row-delete"
                      onClick={() => removeQuickPasteRow(row.id)}
                      disabled={isSavingQuickPastes}
                      aria-label={t("common.remove")}
                      title={t("common.remove")}
                    >
                      <Trash2 className="clipboard-keybindings-row-delete-icon" />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="clipboard-keybindings-footer">
              <div className="clipboard-keybindings-reserved">
                {reservedKeysLabel
                  ? t("settings.general.quickPastes.reserved", {
                      keys: reservedKeysLabel,
                      shortcut: clipboardShortcut,
                    })
                  : t("settings.general.quickPastes.noReserved")}
              </div>
              <div className="clipboard-keybindings-actions">
                <button
                  type="button"
                  className="clipboard-keybindings-save"
                  onClick={() => {
                    void saveQuickPastes();
                  }}
                  disabled={isSavingQuickPastes}
                >
                  {t("common.save")}
                </button>
              </div>
            </div>
            {quickPasteStatus && (
              <div
                className={`clipboard-keybindings-status ${quickPasteStatus.tone}`}
              >
                {quickPasteStatus.message}
              </div>
            )}
          </div>
        ) : searchOpen ? (
          <div className="clipboard-list" ref={listRef}>
            {filteredEntries.length === 0 ? (
              <div className="clipboard-empty">
                {t("clipboardOverlay.empty")}
              </div>
            ) : (
              filteredEntries.map((entry, index) => {
                const preview = normalizeText(entry.text);
                return (
                  <button
                    type="button"
                    key={entry.id}
                    data-index={index}
                    className={`clipboard-item ${
                      entry.id === selectedEntryId ? "selected" : ""
                    }`}
                    onMouseEnter={() => {
                      disarmReleasePaste();
                      rememberSelectionContext(entriesRef.current);
                      selectedEntryIdRef.current = entry.id;
                      setSelectedEntryId(entry.id);
                    }}
                    onClick={() => {
                      disarmReleasePaste();
                      void handlePaste(entry);
                    }}
                  >
                    <span className="clipboard-item-text">{preview}</span>
                  </button>
                );
              })
            )}
          </div>
        ) : (
          <div className="clipboard-main">
            {selectedEntry || pendingQuickPasteVisible ? (
              pendingQuickPasteVisible ? (
                <div className="clipboard-main-text">
                  {pendingQuickPastePreviewText}
                </div>
              ) : isImageEntry(selectedEntry) ? (
                <ClipboardOverlayImagePreview
                  media={
                    selectedEntry ? mediaByEntryId[selectedEntry.id] : null
                  }
                  label={formatImageLabel(selectedEntry)}
                />
              ) : (
                <div className="clipboard-main-text">{selectedEntryText}</div>
              )
            ) : (
              <div className="clipboard-empty">
                {t("clipboardOverlay.empty")}
              </div>
            )}
          </div>
        )}
        {!keyBindingsOpen && (
          <div className="clipboard-footer">
            <div className="clipboard-footer-meta">{timestampLabel}</div>
            <div className="clipboard-footer-position">{positionText}</div>
          </div>
        )}
        {pendingQuickPasteVisible && (
          <div className="clipboard-pending-quick-paste" aria-live="polite">
            <div className="clipboard-pending-quick-paste-hotkey">
              {pendingQuickPasteHotkeyText}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ClipboardOverlay;
