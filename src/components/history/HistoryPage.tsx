import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import {
  commands,
  type HistoryAppFilterOption,
  type HistoryEntrySummary,
  type HistoryStats,
} from "@/bindings";
import {
  Book,
  Copy,
  Filter,
  MessageSquareText,
  Search,
  Trash2,
  Zap,
  X,
} from "lucide-react";
import DictionaryPage from "../dictionary/DictionaryPage";
import { AppFilterMenu } from "../shared/AppFilterMenu";
import { Modal } from "../ui/Modal";

const formatCompactNumber = (value: number): string => {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${value}`;
};

const tokenize = (value: string): string[] =>
  value.split(/[^a-z0-9]+/).filter(Boolean);

const maxAllowedDistance = (length: number): number => {
  if (length <= 2) return 0;
  if (length <= 5) return 1;
  return 2;
};

const boundedLevenshtein = (
  a: string,
  b: string,
  maxDistance: number,
): number => {
  const lengthA = a.length;
  const lengthB = b.length;
  if (Math.abs(lengthA - lengthB) > maxDistance) return maxDistance + 1;
  if (lengthA === 0) return lengthB;
  if (lengthB === 0) return lengthA;

  const previous = new Array(lengthB + 1).fill(0);
  const current = new Array(lengthB + 1).fill(0);

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

const StatPill: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
}> = ({ icon, label, value }) => (
  <div className="liquid-glass flex items-center gap-2 rounded-full px-3 py-1 text-xs text-zinc-500 dark:text-zinc-400">
    <span className="text-blue-600 dark:text-blue-500">{icon}</span>
    <span className="font-medium text-zinc-900 dark:text-zinc-100">
      {value}
    </span>
    <span>{label}</span>
  </div>
);

type HistoryToolbarButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> & {
  active?: boolean;
};

const HistoryToolbarButton: React.FC<HistoryToolbarButtonProps> = ({
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

const historySkeletonRows = [
  {
    timeWidth: 46,
    sourceWidth: 78,
    lineWidths: ["92%", "64%"],
  },
  {
    timeWidth: 54,
    sourceWidth: 62,
    lineWidths: ["84%", "74%", "38%"],
  },
  {
    timeWidth: 42,
    sourceWidth: 86,
    lineWidths: ["96%", "58%"],
  },
  {
    timeWidth: 50,
    sourceWidth: 70,
    lineWidths: ["88%", "78%", "46%"],
  },
];

const HistorySkeletonRows: React.FC = () => (
  <>
    {historySkeletonRows.map((row, rowIndex) => (
      <div
        key={rowIndex}
        className="flex items-start gap-4 py-3 text-sm"
        aria-hidden="true"
      >
        <div className="w-28 space-y-2">
          <div
            className="history-skeleton-shimmer h-3 rounded-full"
            style={{ width: row.timeWidth }}
          />
          <div className="flex items-center gap-1">
            <div className="history-skeleton-shimmer h-4 w-4 rounded-[4px]" />
            <div
              className="history-skeleton-shimmer h-2.5 rounded-full"
              style={{ width: row.sourceWidth }}
            />
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {row.lineWidths.map((width, lineIndex) => (
            <div
              key={`${rowIndex}:${lineIndex}`}
              className="history-skeleton-shimmer h-3 rounded-full"
              style={{ width }}
            />
          ))}
        </div>
        <div className="history-skeleton-shimmer h-6 w-6 rounded-md opacity-70" />
      </div>
    ))}
  </>
);

const PAGE_SIZE = 20;
const ICON_LOAD_BATCH_SIZE = 6;
const HISTORY_TEXT_PREVIEW_CHARS = 600;
const HISTORY_CACHE_TTL_MS = 30_000;
const METRICS_CACHE_TTL_MS = 60_000;
const APP_OPTIONS_CACHE_TTL_MS = 60_000;

type HistoryPageCache = {
  history: {
    entries: HistoryEntrySummary[];
    hasMore: boolean;
    updatedAt: number;
  };
  metrics: {
    stats: HistoryStats | null;
    updatedAt: number;
  };
  apps: {
    options: HistoryAppFilterOption[];
    updatedAt: number;
  };
  icons: Record<string, string>;
};

const historyPageCache: HistoryPageCache = {
  history: {
    entries: [],
    hasMore: true,
    updatedAt: 0,
  },
  metrics: {
    stats: null,
    updatedAt: 0,
  },
  apps: {
    options: [],
    updatedAt: 0,
  },
  icons: {},
};

const mergeHistoryEntries = (
  current: HistoryEntrySummary[],
  incoming: HistoryEntrySummary[],
): HistoryEntrySummary[] => {
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

interface HistoryPageProps {
  openDictionaryRequest?: number;
}

const HistoryPage: React.FC<HistoryPageProps> = ({
  openDictionaryRequest = 0,
}) => {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<HistoryEntrySummary[]>(
    historyPageCache.history.entries,
  );
  const [stats, setStats] = useState<HistoryStats | null>(
    historyPageCache.metrics.stats,
  );
  const [loading, setLoading] = useState(
    historyPageCache.history.entries.length === 0,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(historyPageCache.history.hasMore);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [appOptions, setAppOptions] = useState<HistoryAppFilterOption[]>(
    historyPageCache.apps.options,
  );
  const [selectedAppFilter, setSelectedAppFilter] =
    useState<HistoryAppFilterOption | null>(null);
  const [iconByIdentifier, setIconByIdentifier] = useState<
    Record<string, string>
  >(historyPageCache.icons);
  const historySentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const historyRequestIdRef = useRef(0);
  const metricsRequestIdRef = useRef(0);
  const appOptionsRequestIdRef = useRef(0);

  const loadHistoryPage = useCallback(
    (offset: number, limit: number) => {
      if (!selectedAppFilter) {
        return commands.getHistoryEntriesPageCompact(offset, limit);
      }
      return commands.getHistoryEntriesPageCompactForApp(
        offset,
        limit,
        selectedAppFilter.filter_type,
        selectedAppFilter.value,
      );
    },
    [selectedAppFilter],
  );

  const loadInitialHistory = useCallback(
    async ({ background = false } = {}) => {
      const requestId = ++historyRequestIdRef.current;
      if (!background) {
        setLoading(true);
        if (selectedAppFilter) {
          setEntries([]);
        }
      }
      setLoadingMore(false);
      try {
        const historyResult = await loadHistoryPage(0, PAGE_SIZE);
        if (requestId !== historyRequestIdRef.current) return;
        if (historyResult.status === "ok") {
          const nextEntries = historyResult.data;
          const nextHasMore = historyResult.data.length === PAGE_SIZE;
          setEntries(nextEntries);
          setHasMore(nextHasMore);
          if (!selectedAppFilter) {
            historyPageCache.history.entries = nextEntries;
            historyPageCache.history.hasMore = nextHasMore;
            historyPageCache.history.updatedAt = Date.now();
          }
        }
      } finally {
        if (requestId === historyRequestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [loadHistoryPage, selectedAppFilter],
  );

  const loadMoreHistory = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;
    const requestId = ++historyRequestIdRef.current;
    setLoadingMore(true);
    try {
      const historyResult = await loadHistoryPage(entries.length, PAGE_SIZE);
      if (requestId !== historyRequestIdRef.current) return;
      if (historyResult.status === "ok") {
        const nextHasMore = historyResult.data.length === PAGE_SIZE;
        setHasMore(nextHasMore);
        setEntries((current) => {
          const merged = mergeHistoryEntries(current, historyResult.data);
          if (!selectedAppFilter) {
            historyPageCache.history.entries = merged;
            historyPageCache.history.hasMore = nextHasMore;
            historyPageCache.history.updatedAt = Date.now();
          }
          return merged;
        });
      }
    } finally {
      if (requestId === historyRequestIdRef.current) {
        setLoadingMore(false);
      }
    }
  }, [
    entries.length,
    hasMore,
    loadHistoryPage,
    loading,
    loadingMore,
    selectedAppFilter,
  ]);

  const loadMetrics = useCallback(async () => {
    const requestId = ++metricsRequestIdRef.current;
    const statsResult = await commands.getHistoryStats();
    if (requestId !== metricsRequestIdRef.current) return;

    if (statsResult.status === "ok") {
      setStats(statsResult.data);
      historyPageCache.metrics.stats = statsResult.data;
      historyPageCache.metrics.updatedAt = Date.now();
    }
  }, []);

  const loadAppOptions = useCallback(async () => {
    const requestId = ++appOptionsRequestIdRef.current;
    const appOptionsResult = await commands.getHistoryAppFilterOptions();
    if (requestId !== appOptionsRequestIdRef.current) return;

    if (appOptionsResult.status === "ok") {
      setAppOptions(appOptionsResult.data);
      historyPageCache.apps.options = appOptionsResult.data;
      historyPageCache.apps.updatedAt = Date.now();
    }
  }, []);

  useEffect(() => {
    const now = Date.now();
    const hasCachedHistory = historyPageCache.history.entries.length > 0;
    const hasCachedMetrics = historyPageCache.metrics.updatedAt > 0;
    const hasCachedAppOptions = historyPageCache.apps.updatedAt > 0;

    if (!selectedAppFilter && hasCachedHistory) {
      setEntries(historyPageCache.history.entries);
      setHasMore(historyPageCache.history.hasMore);
      setLoading(false);
    }

    if (hasCachedMetrics) {
      setStats(historyPageCache.metrics.stats);
    }

    if (hasCachedAppOptions) {
      setAppOptions(historyPageCache.apps.options);
    }

    if (Object.keys(historyPageCache.icons).length > 0) {
      setIconByIdentifier(historyPageCache.icons);
    }

    const historyStale =
      now - historyPageCache.history.updatedAt > HISTORY_CACHE_TTL_MS;
    const metricsStale =
      now - historyPageCache.metrics.updatedAt > METRICS_CACHE_TTL_MS;
    const appOptionsStale =
      now - historyPageCache.apps.updatedAt > APP_OPTIONS_CACHE_TTL_MS;

    if (selectedAppFilter || !hasCachedHistory || historyStale) {
      loadInitialHistory({
        background: !selectedAppFilter && hasCachedHistory,
      });
    }

    if (!hasCachedMetrics || metricsStale) {
      loadMetrics();
    }

    if (!hasCachedAppOptions || appOptionsStale) {
      loadAppOptions();
    }

    const unlisten = listen("history-updated", () => {
      loadInitialHistory({ background: true });
      loadMetrics();
      loadAppOptions();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadAppOptions, loadInitialHistory, loadMetrics, selectedAppFilter]);

  const historyEntries = useMemo(() => entries, [entries]);

  const filteredEntries = useMemo(() => {
    const scopedEntries = historyEntries;

    if (!searchQuery.trim()) return scopedEntries;
    return scopedEntries.filter((entry) => {
      const text = entry.text ?? "";
      const combined = `${entry.title ?? ""} ${text} ${entry.source_app_name ?? ""} ${entry.source_app_identifier ?? ""} ${entry.source_window_title ?? ""}`;
      return fuzzyMatch(combined, searchQuery);
    });
  }, [historyEntries, searchQuery]);

  useEffect(() => {
    if (!historySentinelRef.current) return;
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
        loadMoreHistory();
      },
      {
        root: scrollContainerRef.current,
        rootMargin: "0px 0px 400px 0px",
        threshold: 0.1,
      },
    );

    observer.observe(historySentinelRef.current);

    return () => observer.disconnect();
  }, [hasMore, loadMoreHistory]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    if (openDictionaryRequest <= 0) return;
    setDictionaryOpen(true);
  }, [openDictionaryRequest]);

  useEffect(() => {
    if (!dictionaryOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDictionaryOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dictionaryOpen]);

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
        appOptions
          .map((option) => option.icon_identifier)
          .filter((value): value is string => Boolean(value)),
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
      setIconByIdentifier((prev) => {
        const next = { ...prev };
        results.forEach(([identifier, data]) => {
          if (data && !next[identifier]) {
            next[identifier] = data;
          }
        });
        historyPageCache.icons = next;
        return next;
      });
    };

    loadIcons();

    return () => {
      cancelled = true;
    };
  }, [appOptions, iconByIdentifier]);

  const copyEntryToClipboard = useCallback(
    async (entry: HistoryEntrySummary) => {
      try {
        let textToCopy = entry.text;
        const fullTextResult = await commands.getHistoryEntryText(entry.id);
        if (fullTextResult.status === "ok" && fullTextResult.data) {
          textToCopy = fullTextResult.data;
        }
        try {
          await writeClipboardText(textToCopy);
        } catch {
          await navigator.clipboard.writeText(textToCopy);
        }
        toast.success(t("historyPage.copied"), {
          position: "bottom-right",
        });
      } catch (error) {
        console.error("Failed to copy history entry:", error);
        toast.error("Couldn't copy to clipboard.", {
          position: "bottom-right",
        });
      }
    },
    [t],
  );

  const removeHistoryEntryLocally = useCallback((entryId: number) => {
    setEntries((current) => current.filter((entry) => entry.id !== entryId));
    historyPageCache.history.entries = historyPageCache.history.entries.filter(
      (entry) => entry.id !== entryId,
    );
    historyPageCache.history.updatedAt = Date.now();
  }, []);

  const deleteHistoryEntry = useCallback(
    async (entry: HistoryEntrySummary) => {
      try {
        const result = await commands.deleteHistoryEntry(entry.id);
        if (result.status !== "ok") {
          throw new Error(result.error);
        }
        removeHistoryEntryLocally(entry.id);
        void loadMetrics();
        void loadAppOptions();
      } catch (error) {
        console.error("Failed to delete history entry:", error);
        toast.error(t("historyPage.deleteError"), {
          position: "bottom-right",
        });
      }
    },
    [loadAppOptions, loadMetrics, removeHistoryEntryLocally, t],
  );

  const totalWordsValue = stats ? formatCompactNumber(stats.total_words) : "—";
  const wpmWords = stats?.total_words_with_duration ?? 0;
  const totalMinutes = stats?.total_audio_seconds
    ? stats.total_audio_seconds / 60
    : 0;
  const avgWpm =
    stats && totalMinutes > 0 ? Math.round(wpmWords / totalMinutes) : null;
  const showInitialSkeleton = loading && entries.length === 0;

  return (
    <div className="mx-auto w-full max-w-[980px]">
      <section className="w-full px-4 py-6">
        <div className="space-y-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="app-display">{t("historyPage.title")}</h1>
              <p className="app-caption mt-2">{t("historyPage.subtitle")}</p>
            </div>
            <div className="flex items-center gap-2">
              <StatPill
                icon={<MessageSquareText className="h-3.5 w-3.5" />}
                value={totalWordsValue}
                label={t("historyPage.stats.words")}
              />
              <StatPill
                icon={<Zap className="h-3.5 w-3.5" />}
                value={avgWpm ? `${avgWpm}` : "—"}
                label={t("historyPage.stats.wpm")}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4">
            <div className="history-panel-surface rounded-3xl px-6 py-3">
              <div className="history-toolbar flex items-center justify-end">
                <div className="flex items-center gap-2">
                  <div
                    ref={searchContainerRef}
                    className={`relative flex h-9 items-center rounded-full border border-transparent transition-[width,padding,background-color,border-color] duration-200 ease-out motion-reduce:transition-none ${
                      searchOpen
                        ? "w-56 bg-border/60 border-border pr-2"
                        : "w-9 bg-transparent"
                    }`}
                  >
                    <HistoryToolbarButton
                      onClick={() => {
                        if (searchOpen) {
                          setSearchOpen(false);
                          setSearchQuery("");
                        } else {
                          setSearchOpen(true);
                        }
                      }}
                      aria-label={t("common.search")}
                    >
                      <Search className="h-3.5 w-3.5" />
                    </HistoryToolbarButton>
                    {searchOpen && (
                      <>
                        <input
                          ref={searchInputRef}
                          value={searchQuery}
                          onChange={(event) =>
                            setSearchQuery(event.target.value)
                          }
                          placeholder={t("common.searchHistory")}
                          className="flex-1 bg-transparent pr-6 text-xs text-text placeholder:text-muted focus:outline-none"
                        />
                      </>
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
                    <HistoryToolbarButton
                      active={Boolean(selectedAppFilter)}
                      onClick={() => setFilterOpen((current) => !current)}
                      aria-label={t("historyPage.filter")}
                      title={t("historyPage.filter")}
                    >
                      <Filter className="h-3.5 w-3.5" />
                    </HistoryToolbarButton>
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
                  <HistoryToolbarButton
                    active={dictionaryOpen}
                    onClick={() => setDictionaryOpen(true)}
                    aria-label={t("nav.dictionary")}
                    title={t("nav.dictionary")}
                  >
                    <Book className="h-3.5 w-3.5" />
                  </HistoryToolbarButton>
                </div>
              </div>
              <div
                className="mt-3 divide-y divide-black/5 dark:divide-white/10"
                aria-busy={showInitialSkeleton}
              >
                {showInitialSkeleton && <HistorySkeletonRows />}
                {filteredEntries.length === 0 && !loading && (
                  <div className="py-3 text-sm text-zinc-500 dark:text-zinc-400">
                    {searchQuery.trim()
                      ? t("common.noResults")
                      : t("historyPage.empty")}
                  </div>
                )}
                {filteredEntries.map((entry) => {
                  const entryDate = new Date(entry.timestamp * 1000);
                  const isToday = (() => {
                    const now = new Date();
                    return (
                      entryDate.getFullYear() === now.getFullYear() &&
                      entryDate.getMonth() === now.getMonth() &&
                      entryDate.getDate() === now.getDate()
                    );
                  })();
                  const time = isToday
                    ? entryDate.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : entryDate.toLocaleDateString([], {
                        month: "short",
                        day: "numeric",
                      });
                  const entryText =
                    entry.text.length >= HISTORY_TEXT_PREVIEW_CHARS
                      ? `${entry.text}…`
                      : entry.text;
                  const sourceLabelParts = [
                    entry.source_app_name ?? entry.source_app_identifier,
                    entry.source_window_title,
                  ].filter(Boolean) as string[];
                  const sourceLabel = sourceLabelParts.join(" — ");
                  const iconSrc = entry.source_app_identifier
                    ? iconByIdentifier[entry.source_app_identifier]
                    : undefined;
                  return (
                    <div
                      key={entry.id}
                      className="group flex items-start gap-4 py-3 text-sm"
                    >
                      <div className="w-28 tabular-nums text-zinc-500 dark:text-zinc-400">
                        <div>{time}</div>
                        {sourceLabel && (
                          <div className="mt-1 flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                            {iconSrc && (
                              <img
                                src={iconSrc}
                                alt=""
                                className="h-4 w-4 rounded-[4px]"
                              />
                            )}
                            <span className="truncate">{sourceLabel}</span>
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="text-zinc-800 dark:text-zinc-200">
                          {entryText}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100">
                        <button
                          type="button"
                          className="history-mini-icon-button text-zinc-500 dark:text-zinc-400"
                          onClick={() => {
                            void copyEntryToClipboard(entry);
                          }}
                          title={t("historyPage.copy")}
                          aria-label={t("historyPage.copy")}
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="history-mini-icon-button text-zinc-500 hover:text-red-500 dark:text-zinc-400 dark:hover:text-red-400"
                          onClick={() => {
                            void deleteHistoryEntry(entry);
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
                {hasMore && <div ref={historySentinelRef} className="py-2" />}
                {loadingMore && (
                  <div className="py-2 text-xs text-muted">
                    {t("common.loading")}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
      <Modal
        title={t("nav.dictionary")}
        subtitle={t("dictionaryPage.subtitle")}
        open={dictionaryOpen}
        width="md"
        closeLabel={t("common.close")}
        onClose={() => setDictionaryOpen(false)}
      >
        <DictionaryPage embedded />
      </Modal>
    </div>
  );
};

export default HistoryPage;
