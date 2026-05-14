import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  BrushCleaning,
  ClipboardList,
  Copy,
  Filter,
  Image as ImageIcon,
  Keyboard,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  commands,
  type ClipboardHistoryClearRange,
  type ClipboardHistoryEntry,
  type ClipboardHistoryEntryMedia,
  type ClipboardHistoryEntrySummary,
  type HistoryAppFilterOption,
} from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { ClipboardQuickPastes } from "../settings/ClipboardQuickPastes";
import { BreezeTypeShortcut } from "../settings/BreezeTypeShortcut";
import { AppFilterMenu } from "../shared/AppFilterMenu";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

const PAGE_SIZE = 30;
const ICON_LOAD_BATCH_SIZE = 6;
const CLIPBOARD_CACHE_TTL_MS = 15_000;
const APP_OPTIONS_CACHE_TTL_MS = 60_000;

type ClipboardPageCache = {
  history: {
    entries: ClipboardHistoryEntrySummary[];
    hasMore: boolean;
    updatedAt: number;
  };
  apps: {
    options: HistoryAppFilterOption[];
    updatedAt: number;
  };
  icons: Record<string, string>;
};

const clipboardPageCache: ClipboardPageCache = {
  history: {
    entries: [],
    hasMore: true,
    updatedAt: 0,
  },
  apps: {
    options: [],
    updatedAt: 0,
  },
  icons: {},
};

const scheduleClipboardBackgroundTask = (callback: () => void) => {
  const id = window.setTimeout(callback, 80);
  return () => window.clearTimeout(id);
};

const formatShortcut = (binding: string): string => {
  const tokenMap: Record<string, string> = {
    cmd: "Cmd",
    command: "Cmd",
    meta: "Cmd",
    super: "Super",
    ctrl: "Ctrl",
    control: "Ctrl",
    shift: "Shift",
    alt: "Alt",
    option: "Option",
  };

  return binding
    .split("+")
    .map((token) => {
      const normalized = token.trim().toLowerCase();
      if (!normalized) return "";
      if (tokenMap[normalized]) return tokenMap[normalized];
      return normalized.length === 1
        ? normalized.toUpperCase()
        : normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .filter(Boolean)
    .join(" + ");
};

const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    return date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
};

const formatFullTimestamp = (timestamp: number): string =>
  new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));

const getSourceLabel = (entry: ClipboardHistoryEntrySummary): string => {
  const name = entry.source_app_name?.trim();
  if (name) return name;
  const identifier = entry.source_app_identifier?.trim();
  if (!identifier) return "Clipboard";
  const lastSegment = identifier.split(/[/\\]/).pop() || identifier;
  return lastSegment.replace(/\.(app|exe)$/i, "");
};

const mergeClipboardEntries = (
  current: ClipboardHistoryEntrySummary[],
  incoming: ClipboardHistoryEntrySummary[],
): ClipboardHistoryEntrySummary[] => {
  if (incoming.length === 0) return current;
  const seen = new Set(current.map((entry) => entry.id));
  const next = [...current];
  incoming.forEach((entry) => {
    if (!seen.has(entry.id)) {
      next.push(entry);
      seen.add(entry.id);
    }
  });
  return next;
};

const toClipboardEntrySummary = (
  entry: ClipboardHistoryEntry | ClipboardHistoryEntrySummary,
): ClipboardHistoryEntrySummary => ({
  id: entry.id,
  content_hash: entry.content_hash ?? "",
  content_kind: entry.content_kind ?? "text",
  text: entry.text,
  timestamp: entry.timestamp,
  source_app_name: entry.source_app_name,
  source_app_identifier: entry.source_app_identifier,
  media_width: entry.media_width ?? null,
  media_height: entry.media_height ?? null,
  media_byte_len: entry.media_byte_len ?? null,
});

const CLEAR_RANGE_OPTIONS: Array<{
  range: ClipboardHistoryClearRange;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    range: "past_day",
    labelKey: "clipboardHistoryPage.clearPastDay",
    descriptionKey: "clipboardHistoryPage.clearPastDayDescription",
  },
  {
    range: "past_week",
    labelKey: "clipboardHistoryPage.clearPastWeek",
    descriptionKey: "clipboardHistoryPage.clearPastWeekDescription",
  },
  {
    range: "all",
    labelKey: "clipboardHistoryPage.clearAll",
    descriptionKey: "clipboardHistoryPage.clearAllDescription",
  },
];

const isImageEntry = (entry: ClipboardHistoryEntrySummary) =>
  entry.content_kind === "image";

type ToolbarButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> & {
  active?: boolean;
};

const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  active = false,
  className = "",
  children,
  ...props
}) => (
  <button
    {...props}
    type="button"
    className={[
      "history-icon-button",
      active ? "text-zinc-900 dark:text-zinc-100" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ")}
  >
    {children}
  </button>
);

const ClipboardSkeletonRows: React.FC = () => (
  <>
    {[76, 58, 88, 64].map((sourceWidth, index) => (
      <div
        key={sourceWidth}
        className="flex items-start gap-4 py-3 text-sm"
        aria-hidden="true"
      >
        <div className="w-28 space-y-2">
          <div className="history-skeleton-shimmer h-3 w-12 rounded-full" />
          <div className="flex items-center gap-1">
            <div className="history-skeleton-shimmer h-4 w-4 rounded-[4px]" />
            <div
              className="history-skeleton-shimmer h-2.5 rounded-full"
              style={{ width: sourceWidth }}
            />
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div
            className="history-skeleton-shimmer h-3 rounded-full"
            style={{ width: `${88 - index * 7}%` }}
          />
          <div
            className="history-skeleton-shimmer h-3 rounded-full"
            style={{ width: `${58 + index * 5}%` }}
          />
        </div>
        <div className="history-skeleton-shimmer h-6 w-6 rounded-md opacity-70" />
      </div>
    ))}
  </>
);

const ClipboardImagePreview: React.FC<{
  media?: ClipboardHistoryEntryMedia | null;
  label: string;
  onVisible?: () => void;
}> = ({ media, label, onVisible }) => {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const width = media?.image_width ?? 0;
  const height = media?.image_height ?? 0;
  const imageDataBase64 = media?.image_data_base64;

  useEffect(() => {
    if (imageDataBase64 || !onVisible) return;
    const frame = frameRef.current;
    if (!frame) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        onVisible();
        observer.disconnect();
      },
      { rootMargin: "180px 0px" },
    );
    observer.observe(frame);

    return () => observer.disconnect();
  }, [imageDataBase64, onVisible]);

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
      <div
        ref={frameRef}
        className="flex h-28 w-full max-w-[360px] items-center justify-center gap-2 rounded-2xl border border-black/5 bg-white/35 text-xs text-zinc-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400"
      >
        <ImageIcon className="h-4 w-4" />
        <span>{label}</span>
      </div>
    );
  }

  return (
    <div
      ref={frameRef}
      className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-black/5 bg-white/40 dark:border-white/10 dark:bg-white/[0.04]"
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="block h-auto max-h-56 w-full object-contain"
        style={{ aspectRatio: `${width} / ${height}` }}
        aria-label={label}
      />
    </div>
  );
};

const ClipboardHistoryPage: React.FC = () => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [entries, setEntries] = useState<ClipboardHistoryEntrySummary[]>(
    clipboardPageCache.history.entries,
  );
  const [loading, setLoading] = useState(
    clipboardPageCache.history.entries.length === 0,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(clipboardPageCache.history.hasMore);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clearRangeOpen, setClearRangeOpen] = useState(false);
  const [clearConfirmRange, setClearConfirmRange] =
    useState<ClipboardHistoryClearRange | null>(null);
  const [clearInProgress, setClearInProgress] = useState(false);
  const [mediaByEntryId, setMediaByEntryId] = useState<
    Record<number, ClipboardHistoryEntryMedia | null>
  >({});
  const [appOptions, setAppOptions] = useState<HistoryAppFilterOption[]>(
    clipboardPageCache.apps.options,
  );
  const [selectedAppFilter, setSelectedAppFilter] =
    useState<HistoryAppFilterOption | null>(null);
  const [iconByIdentifier, setIconByIdentifier] = useState<
    Record<string, string>
  >(clipboardPageCache.icons);
  const clipboardSentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const clipboardRequestIdRef = useRef(0);
  const appOptionsRequestIdRef = useRef(0);
  const loadingMediaIdsRef = useRef<Set<number>>(new Set());

  const clipboardShortcut =
    settings?.bindings?.clipboard_history?.current_binding ?? "";
  const shortcutLabel = clipboardShortcut
    ? formatShortcut(clipboardShortcut)
    : t("clipboardHistoryPage.shortcutUnset");
  const selectedClearOption = CLEAR_RANGE_OPTIONS.find(
    (option) => option.range === clearConfirmRange,
  );

  const loadClipboardPage = useCallback(
    async (offset: number, limit: number) => {
      const loadFallbackPage = async () => {
        const fallbackResult = !selectedAppFilter
          ? await commands.getClipboardHistoryEntriesPage(offset, limit)
          : await commands.getClipboardHistoryEntriesPageForApp(
              offset,
              limit,
              selectedAppFilter.filter_type,
              selectedAppFilter.value,
            );

        if (fallbackResult.status !== "ok") {
          return fallbackResult;
        }

        return {
          status: "ok" as const,
          data: fallbackResult.data.map(toClipboardEntrySummary),
        };
      };

      try {
        const summaryResult = !selectedAppFilter
          ? await commands.getClipboardHistoryEntriesPageSummary(offset, limit)
          : await commands.getClipboardHistoryEntriesPageSummaryForApp(
              offset,
              limit,
              selectedAppFilter.filter_type,
              selectedAppFilter.value,
            );

        if (summaryResult.status === "ok") {
          if (offset === 0 && summaryResult.data.length < limit) {
            const fallbackResult = await loadFallbackPage();
            if (
              fallbackResult.status === "ok" &&
              fallbackResult.data.length > summaryResult.data.length
            ) {
              return fallbackResult;
            }
          }

          return summaryResult;
        }
      } catch (error) {
        console.warn(
          "Clipboard summary history command unavailable, falling back to full entries.",
          error,
        );
      }

      return loadFallbackPage();
    },
    [selectedAppFilter],
  );

  const loadInitialEntries = useCallback(
    async ({ background = false } = {}) => {
      const requestId = ++clipboardRequestIdRef.current;
      if (!background) {
        setLoading(true);
        if (selectedAppFilter) {
          setEntries([]);
        }
      }
      setLoadingMore(false);

      try {
        const result = await loadClipboardPage(0, PAGE_SIZE);
        if (requestId !== clipboardRequestIdRef.current) return;
        if (result.status === "ok") {
          const nextEntries = result.data;
          const nextHasMore = result.data.length === PAGE_SIZE;
          setEntries(nextEntries);
          setHasMore(nextHasMore);
          if (!selectedAppFilter) {
            clipboardPageCache.history.entries = nextEntries;
            clipboardPageCache.history.hasMore = nextHasMore;
            clipboardPageCache.history.updatedAt = Date.now();
          }
        } else {
          console.error("Failed to load clipboard history:", result.error);
        }
      } finally {
        if (requestId === clipboardRequestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [loadClipboardPage, selectedAppFilter],
  );

  const loadMoreEntries = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;
    const requestId = ++clipboardRequestIdRef.current;
    setLoadingMore(true);

    try {
      const result = await loadClipboardPage(entries.length, PAGE_SIZE);
      if (requestId !== clipboardRequestIdRef.current) return;
      if (result.status === "ok") {
        const nextHasMore = result.data.length === PAGE_SIZE;
        setHasMore(nextHasMore);
        setEntries((current) => {
          const merged = mergeClipboardEntries(current, result.data);
          if (!selectedAppFilter) {
            clipboardPageCache.history.entries = merged;
            clipboardPageCache.history.hasMore = nextHasMore;
            clipboardPageCache.history.updatedAt = Date.now();
          }
          return merged;
        });
      } else {
        console.error("Failed to load more clipboard history:", result.error);
      }
    } finally {
      if (requestId === clipboardRequestIdRef.current) {
        setLoadingMore(false);
      }
    }
  }, [
    entries.length,
    hasMore,
    loadClipboardPage,
    loading,
    loadingMore,
    selectedAppFilter,
  ]);

  const loadAppOptions = useCallback(async () => {
    const requestId = ++appOptionsRequestIdRef.current;
    const result = await commands.getClipboardHistoryAppFilterOptions();
    if (requestId !== appOptionsRequestIdRef.current) return;

    if (result.status === "ok") {
      setAppOptions(result.data);
      clipboardPageCache.apps.options = result.data;
      clipboardPageCache.apps.updatedAt = Date.now();
    } else {
      console.error(
        "Failed to load clipboard app filter options:",
        result.error,
      );
    }
  }, []);

  useEffect(() => {
    const now = Date.now();
    const hasCachedEntries = clipboardPageCache.history.entries.length > 0;
    const hasCachedAppOptions = clipboardPageCache.apps.updatedAt > 0;
    const cacheStale =
      now - clipboardPageCache.history.updatedAt > CLIPBOARD_CACHE_TTL_MS;
    const appOptionsStale =
      now - clipboardPageCache.apps.updatedAt > APP_OPTIONS_CACHE_TTL_MS;

    if (!selectedAppFilter && hasCachedEntries) {
      setEntries(clipboardPageCache.history.entries);
      setHasMore(clipboardPageCache.history.hasMore);
      setIconByIdentifier(clipboardPageCache.icons);
      setLoading(false);
    }

    if (hasCachedAppOptions) {
      setAppOptions(clipboardPageCache.apps.options);
    }

    if (selectedAppFilter || !hasCachedEntries || cacheStale) {
      void loadInitialEntries({
        background: !selectedAppFilter && hasCachedEntries,
      });
    }

    let cancelInitialAppOptionsLoad: (() => void) | undefined;
    if (!hasCachedAppOptions || appOptionsStale) {
      cancelInitialAppOptionsLoad = scheduleClipboardBackgroundTask(() => {
        void loadAppOptions();
      });
    }

    let cancelEventAppOptionsLoad: (() => void) | undefined;
    const unlisten = listen("clipboard-history-updated", () => {
      void loadInitialEntries({ background: true });
      cancelEventAppOptionsLoad?.();
      cancelEventAppOptionsLoad = scheduleClipboardBackgroundTask(() => {
        void loadAppOptions();
      });
    });

    return () => {
      cancelInitialAppOptionsLoad?.();
      cancelEventAppOptionsLoad?.();
      unlisten.then((fn) => fn());
    };
  }, [loadAppOptions, loadInitialEntries, selectedAppFilter]);

  useEffect(() => {
    if (!clipboardSentinelRef.current) return;
    if (!scrollContainerRef.current) {
      scrollContainerRef.current = document.querySelector<HTMLElement>(
        "[data-scroll-container]",
      );
    }
    if (!scrollContainerRef.current) return;
    if (!hasMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        void loadMoreEntries();
      },
      {
        root: scrollContainerRef.current,
        rootMargin: "0px 0px 400px 0px",
        threshold: 0.1,
      },
    );

    observer.observe(clipboardSentinelRef.current);

    return () => observer.disconnect();
  }, [hasMore, loadMoreEntries]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!searchContainerRef.current) return;
      if (searchContainerRef.current.contains(event.target as Node)) return;
      if (!searchQuery.trim()) {
        setSearchOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !searchQuery.trim()) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    if (!selectedAppFilter) return;
    const stillExists = appOptions.some(
      (option) =>
        option.filter_type === selectedAppFilter.filter_type &&
        option.value === selectedAppFilter.value,
    );
    if (!stillExists) {
      setSelectedAppFilter(null);
    }
  }, [appOptions, selectedAppFilter]);

  useEffect(() => {
    if (!filterOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!filterMenuRef.current) return;
      if (!filterMenuRef.current.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [filterOpen]);

  useEffect(() => {
    const identifiers = Array.from(
      new Set(
        [
          ...entries.map((entry) => entry.source_app_identifier),
          ...appOptions.map((option) => option.icon_identifier),
        ].filter((value): value is string => Boolean(value)),
      ),
    );
    const missing = identifiers.filter(
      (identifier) => !iconByIdentifier[identifier],
    );
    if (missing.length === 0) return;

    let cancelled = false;
    const loadIcons = async () => {
      const results: Array<readonly [string, string | null]> = [];
      for (let i = 0; i < missing.length; i += ICON_LOAD_BATCH_SIZE) {
        if (cancelled) return;
        const batch = missing.slice(i, i + ICON_LOAD_BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (identifier) => {
            const result = await commands.getAppIcon(identifier);
            if (result.status !== "ok") return [identifier, null] as const;
            return [identifier, result.data] as const;
          }),
        );
        results.push(...batchResults);
      }

      if (cancelled) return;
      setIconByIdentifier((previous) => {
        const next = { ...previous };
        results.forEach(([identifier, data]) => {
          if (data && !next[identifier]) {
            next[identifier] = data;
          }
        });
        clipboardPageCache.icons = next;
        return next;
      });
    };

    const cancelIconLoad = scheduleClipboardBackgroundTask(() => {
      void loadIcons();
    });

    return () => {
      cancelled = true;
      cancelIconLoad();
    };
  }, [appOptions, entries, iconByIdentifier]);

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

  const loadEntryMedia = useCallback(
    async (entryId: number) => {
      if (Object.prototype.hasOwnProperty.call(mediaByEntryId, entryId)) {
        return;
      }
      if (loadingMediaIdsRef.current.has(entryId)) {
        return;
      }

      loadingMediaIdsRef.current.add(entryId);
      try {
        const result = await commands.getClipboardHistoryEntryMedia(entryId);
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
    },
    [mediaByEntryId],
  );

  const filteredEntries = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return entries;

    return entries.filter((entry) => {
      const haystack = [
        entry.text,
        entry.content_kind,
        entry.source_app_name,
        entry.source_app_identifier,
        entry.media_width && entry.media_height
          ? `${entry.media_width} ${entry.media_height}`
          : null,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [entries, searchQuery]);

  const copyEntryToClipboard = useCallback(
    async (entry: ClipboardHistoryEntrySummary) => {
      try {
        try {
          const copyResult = await commands.copyClipboardHistoryEntry(entry.id);
          if (copyResult.status === "ok") {
            toast.success(t("clipboardHistoryPage.copied"), {
              position: "bottom-right",
            });
            return;
          }
          if (isImageEntry(entry)) {
            throw new Error(copyResult.error);
          }
        } catch (error) {
          if (isImageEntry(entry)) {
            throw error;
          }
          console.warn(
            "Clipboard history copy command unavailable, falling back to web clipboard.",
            error,
          );
        }

        let textToCopy = entry.text;
        try {
          const fullTextResult = await commands.getClipboardHistoryEntryText(
            entry.id,
          );
          if (
            fullTextResult.status === "ok" &&
            typeof fullTextResult.data === "string"
          ) {
            textToCopy = fullTextResult.data;
          }
        } catch (error) {
          console.warn(
            "Clipboard entry text command unavailable, copying loaded text.",
            error,
          );
        }

        try {
          await writeClipboardText(textToCopy);
        } catch {
          await navigator.clipboard.writeText(textToCopy);
        }
        toast.success(t("clipboardHistoryPage.copied"), {
          position: "bottom-right",
        });
      } catch (error) {
        console.error("Failed to copy clipboard history entry:", error);
        toast.error(t("clipboardHistoryPage.copyError"), {
          position: "bottom-right",
        });
      }
    },
    [t],
  );

  const removeClipboardEntryLocally = useCallback((entryId: number) => {
    setEntries((current) => current.filter((entry) => entry.id !== entryId));
    clipboardPageCache.history.entries =
      clipboardPageCache.history.entries.filter(
        (entry) => entry.id !== entryId,
      );
    clipboardPageCache.history.updatedAt = Date.now();
    setMediaByEntryId((previous) => {
      if (!Object.prototype.hasOwnProperty.call(previous, entryId)) {
        return previous;
      }
      const next = { ...previous };
      delete next[entryId];
      return next;
    });
  }, []);

  const deleteClipboardEntry = useCallback(
    async (entry: ClipboardHistoryEntrySummary) => {
      try {
        const result = await commands.deleteClipboardHistoryEntry(entry.id);
        if (result.status !== "ok") {
          throw new Error(result.error);
        }
        removeClipboardEntryLocally(entry.id);
        void loadAppOptions();
      } catch (error) {
        console.error("Failed to delete clipboard history entry:", error);
        toast.error(t("clipboardHistoryPage.deleteError"), {
          position: "bottom-right",
        });
      }
    },
    [loadAppOptions, removeClipboardEntryLocally, t],
  );

  const clearClipboardHistory = useCallback(async () => {
    if (!clearConfirmRange) return;

    setClearInProgress(true);
    try {
      const result =
        await commands.clearClipboardHistoryRange(clearConfirmRange);
      if (result.status !== "ok") {
        throw new Error(result.error);
      }

      clipboardPageCache.history.entries = [];
      clipboardPageCache.history.hasMore = true;
      clipboardPageCache.history.updatedAt = 0;
      clipboardPageCache.apps.options = [];
      clipboardPageCache.apps.updatedAt = 0;
      setMediaByEntryId({});
      setClearConfirmRange(null);
      setClearRangeOpen(false);
      await loadInitialEntries({ background: false });
      await loadAppOptions();
      toast.success(t("clipboardHistoryPage.clearSuccess"), {
        position: "bottom-right",
      });
    } catch (error) {
      console.error("Failed to clear clipboard history:", error);
      toast.error(t("clipboardHistoryPage.clearError"), {
        position: "bottom-right",
      });
    } finally {
      setClearInProgress(false);
    }
  }, [clearConfirmRange, loadAppOptions, loadInitialEntries, t]);

  const showInitialSkeleton = loading && entries.length === 0;
  const totalItemsLabel = t("clipboardHistoryPage.itemCount", {
    count: entries.length,
  });

  return (
    <div className="mx-auto w-full max-w-[980px]">
      <section className="w-full px-4 py-6">
        <div className="space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="app-display">{t("clipboardHistoryPage.title")}</h1>
              <p className="app-caption mt-2">
                {t("clipboardHistoryPage.subtitle")}
              </p>
            </div>
            <div className="liquid-glass flex items-center gap-2 rounded-full px-3 py-1 text-xs text-zinc-500 dark:text-zinc-400">
              <ClipboardList className="h-3.5 w-3.5 text-blue-600 dark:text-blue-500" />
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {entries.length}
              </span>
              <span>{t("clipboardHistoryPage.items")}</span>
            </div>
          </div>

          <div className="liquid-glass flex flex-col gap-3 rounded-[28px] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-500">
                <Keyboard className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {t("clipboardHistoryPage.openPickerTitle")}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                  <span>{t("clipboardHistoryPage.openPickerPrefix")}</span>
                  <kbd className="rounded-lg border border-black/5 bg-white/65 px-2 py-1 text-xs font-semibold text-zinc-800 shadow-[0_6px_18px_-16px_rgb(0_0_0_/_0.35)] dark:border-white/10 dark:bg-zinc-900/65 dark:text-zinc-100">
                    {shortcutLabel}
                  </kbd>
                  <span>{t("clipboardHistoryPage.openPickerSuffix")}</span>
                </div>
              </div>
            </div>
            <button
              type="button"
              className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-2xl border border-black/5 bg-white/30 px-4 py-2 text-sm font-medium text-blue-600 shadow-[0_6px_18px_-14px_rgb(0_0_0_/_0.25)] backdrop-blur-3xl transition-colors hover:bg-blue-500/10 dark:border-white/10 dark:bg-zinc-900/30 dark:text-blue-500"
              onClick={() => setSettingsOpen(true)}
            >
              <Keyboard className="h-4 w-4" />
              {t("clipboardHistoryPage.editShortcut")}
            </button>
          </div>

          <div className="history-panel-surface rounded-3xl px-6 py-3">
            <div className="history-toolbar flex items-center justify-between">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {totalItemsLabel}
              </div>
              <div className="flex items-center gap-2">
                <div
                  ref={searchContainerRef}
                  className={`relative flex h-9 items-center rounded-full border border-transparent transition-[width,padding,background-color,border-color] duration-200 ease-out motion-reduce:transition-none ${
                    searchOpen
                      ? "w-64 border-border bg-border/60 pr-2"
                      : "w-9 bg-transparent"
                  }`}
                >
                  <ToolbarButton
                    onClick={() => {
                      if (searchOpen) {
                        setSearchOpen(false);
                        setSearchQuery("");
                      } else {
                        setSearchOpen(true);
                      }
                    }}
                    active={searchOpen}
                    aria-label={t("common.search")}
                    title={t("common.search")}
                  >
                    <Search className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {searchOpen && (
                    <input
                      ref={searchInputRef}
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder={t("clipboardHistoryPage.searchPlaceholder")}
                      className="flex-1 bg-transparent pr-6 text-xs text-text placeholder:text-muted focus:outline-none"
                    />
                  )}
                  {searchOpen && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchOpen(false);
                        setSearchQuery("");
                      }}
                      className="history-mini-icon-button absolute right-2"
                      aria-label={t("common.close")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="relative h-9 w-9" ref={filterMenuRef}>
                  <ToolbarButton
                    active={Boolean(selectedAppFilter)}
                    onClick={() => setFilterOpen((current) => !current)}
                    aria-label={t("historyPage.filter")}
                    title={t("historyPage.filter")}
                  >
                    <Filter className="h-3.5 w-3.5" />
                  </ToolbarButton>
                  {filterOpen && (
                    <AppFilterMenu
                      options={appOptions}
                      selectedOption={selectedAppFilter}
                      iconByIdentifier={iconByIdentifier}
                      title={t("historyPage.filterTitle")}
                      allLabel={t("historyPage.filterAll")}
                      emptyLabel={t("historyPage.filterEmpty")}
                      noResultsLabel={t("common.noResults")}
                      searchPlaceholder={t("historyPage.filterSearch")}
                      onClear={() => {
                        setSelectedAppFilter(null);
                        setFilterOpen(false);
                      }}
                      onSelect={(option) => {
                        setSelectedAppFilter(option);
                        setFilterOpen(false);
                      }}
                      onClose={() => setFilterOpen(false)}
                    />
                  )}
                </div>
                <ToolbarButton
                  active={clearRangeOpen || clearConfirmRange !== null}
                  disabled={entries.length === 0 && !loading}
                  onClick={() => setClearRangeOpen(true)}
                  aria-label={t("common.clear")}
                  title={t("common.clear")}
                >
                  <BrushCleaning className="h-3.5 w-3.5" />
                </ToolbarButton>
                <ToolbarButton
                  active={settingsOpen}
                  onClick={() => setSettingsOpen(true)}
                  aria-label={t("clipboardHistoryPage.editShortcut")}
                  title={t("clipboardHistoryPage.editShortcut")}
                >
                  <Keyboard className="h-3.5 w-3.5" />
                </ToolbarButton>
              </div>
            </div>

            <div
              className="mt-3 divide-y divide-black/5 dark:divide-white/10"
              aria-busy={showInitialSkeleton}
            >
              {showInitialSkeleton && <ClipboardSkeletonRows />}
              {filteredEntries.length === 0 && !loading && (
                <div className="py-3 text-sm text-zinc-500 dark:text-zinc-400">
                  {searchQuery.trim() || selectedAppFilter
                    ? t("common.noResults")
                    : t("clipboardHistoryPage.empty")}
                </div>
              )}
              {filteredEntries.map((entry) => {
                const sourceLabel = getSourceLabel(entry);
                const iconSrc = entry.source_app_identifier
                  ? iconByIdentifier[entry.source_app_identifier]
                  : undefined;
                const fallbackLetter =
                  sourceLabel.trim().charAt(0).toUpperCase() || "?";
                const imageLabel =
                  entry.media_width && entry.media_height
                    ? t("clipboardHistoryPage.mediaImageDimensions", {
                        width: entry.media_width,
                        height: entry.media_height,
                      })
                    : t("clipboardHistoryPage.mediaImage");

                return (
                  <div
                    key={entry.id}
                    className="group flex items-start gap-4 py-3 text-sm"
                  >
                    <div className="w-28 tabular-nums text-zinc-500 dark:text-zinc-400">
                      <div title={formatFullTimestamp(entry.timestamp)}>
                        {formatTimestamp(entry.timestamp)}
                      </div>
                      <div className="mt-1 flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {iconSrc ? (
                          <img
                            src={iconSrc}
                            alt=""
                            className="h-4 w-4 rounded-[4px]"
                          />
                        ) : (
                          <span className="flex h-4 w-4 items-center justify-center rounded-[4px] bg-black/10 text-[9px] text-zinc-500 dark:bg-white/15 dark:text-zinc-400">
                            {fallbackLetter}
                          </span>
                        )}
                        <span className="truncate">{sourceLabel}</span>
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      {isImageEntry(entry) ? (
                        <div className="space-y-2">
                          <ClipboardImagePreview
                            media={mediaByEntryId[entry.id]}
                            label={imageLabel}
                            onVisible={() => {
                              void loadEntryMedia(entry.id);
                            }}
                          />
                          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                            <ImageIcon className="h-3.5 w-3.5" />
                            <span>{imageLabel}</span>
                          </div>
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap break-words text-zinc-800 dark:text-zinc-200">
                          {entry.text}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100">
                      <button
                        type="button"
                        className="history-mini-icon-button text-zinc-500 dark:text-zinc-400"
                        onClick={() => {
                          void copyEntryToClipboard(entry);
                        }}
                        title={t("clipboardHistoryPage.copy")}
                        aria-label={t("clipboardHistoryPage.copy")}
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="history-mini-icon-button text-zinc-500 hover:text-red-500 dark:text-zinc-400 dark:hover:text-red-400"
                        onClick={() => {
                          void deleteClipboardEntry(entry);
                        }}
                        title={t("common.delete")}
                        aria-label={t("common.delete")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {hasMore && <div ref={clipboardSentinelRef} className="py-2" />}
              {loadingMore && (
                <div className="py-2 text-xs text-muted">
                  {t("common.loading")}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <Modal
        title={t("clipboardHistoryPage.clearRangeTitle")}
        subtitle={t("clipboardHistoryPage.clearRangeSubtitle")}
        open={clearRangeOpen}
        width="sm"
        bodyClassName="px-5 py-5"
        closeLabel={t("common.close")}
        onClose={() => setClearRangeOpen(false)}
      >
        <div className="space-y-2">
          {CLEAR_RANGE_OPTIONS.map((option) => (
            <button
              key={option.range}
              type="button"
              className="flex w-full cursor-pointer items-start gap-3 rounded-2xl border border-black/5 bg-white/25 px-4 py-3 text-left transition-colors duration-150 ease-out hover:bg-blue-500/10 focus-visible:bg-blue-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-blue-500/10 dark:focus-visible:bg-blue-500/10"
              onClick={() => {
                setClearRangeOpen(false);
                setClearConfirmRange(option.range);
              }}
            >
              <BrushCleaning className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {t(option.labelKey)}
                </span>
                <span className="mt-1 block text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                  {t(option.descriptionKey)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        title={t("clipboardHistoryPage.clearConfirmTitle")}
        subtitle={
          selectedClearOption
            ? t("clipboardHistoryPage.clearConfirmSubtitle", {
                range: t(selectedClearOption.labelKey),
              })
            : undefined
        }
        open={clearConfirmRange !== null}
        width="sm"
        bodyClassName="px-5 py-5"
        closeLabel={t("common.close")}
        onClose={() => {
          if (!clearInProgress) {
            setClearConfirmRange(null);
          }
        }}
      >
        <div className="space-y-5">
          <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
            {t("clipboardHistoryPage.clearConfirmBody")}
          </p>
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="min-w-[84px] active:!scale-100"
              disabled={clearInProgress}
              onClick={() => setClearConfirmRange(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              className="min-w-[112px] active:!scale-100"
              disabled={clearInProgress}
              onClick={() => {
                void clearClipboardHistory();
              }}
            >
              {clearInProgress
                ? t("clipboardHistoryPage.clearing")
                : t("clipboardHistoryPage.clearConfirmAction")}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        title={t("clipboardHistoryPage.shortcutModalTitle")}
        subtitle={t("clipboardHistoryPage.shortcutModalSubtitle")}
        open={settingsOpen}
        width="md"
        bodyClassName="px-6 pt-0 pb-6"
        closeLabel={t("common.close")}
        onClose={() => setSettingsOpen(false)}
      >
        <div className="space-y-6">
          <div className="divide-y divide-black/5 dark:divide-white/10">
            <BreezeTypeShortcut
              shortcutId="clipboard_history"
              descriptionMode="none"
              grouped
            />
            <ClipboardQuickPastes descriptionMode="inline" grouped />
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default ClipboardHistoryPage;
