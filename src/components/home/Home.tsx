import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ArrowRight,
  ClipboardList,
  HelpCircle,
  History as HistoryIcon,
  ListChecks,
  Settings,
  Video,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import {
  commands,
  type HistoryEntrySummary,
  type HistoryStats,
} from "@/bindings";
import { useTasksStore } from "@/stores/tasksStore";
import type { SidebarSection } from "../Sidebar";

interface HomeProps {
  onNavigate: (section: SidebarSection) => void;
}

interface QuickSectionCard {
  id: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  stat?: string;
}

type HomeOverviewCache = {
  stats: HistoryStats | null;
  meetingsCount: number;
  recentEntries: HistoryEntrySummary[];
  icons: Record<string, string>;
  updatedAt: number;
};

const RECENT_ENTRY_LIMIT = 3;
const OVERVIEW_CACHE_TTL_MS = 20_000;
const ICON_LOAD_BATCH_SIZE = 6;

const homeOverviewCache: HomeOverviewCache = {
  stats: null,
  meetingsCount: 0,
  recentEntries: [],
  icons: {},
  updatedAt: 0,
};

const formatRecentEntryTime = (timestamp: number): string => {
  const entryDate = new Date(timestamp * 1000);
  const now = new Date();

  const isToday =
    entryDate.getFullYear() === now.getFullYear() &&
    entryDate.getMonth() === now.getMonth() &&
    entryDate.getDate() === now.getDate();

  if (isToday) {
    return entryDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return entryDate.toLocaleDateString([], { month: "short", day: "numeric" });
};

const Home: React.FC<HomeProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const [stats, setStats] = useState<HistoryStats | null>(
    homeOverviewCache.stats,
  );
  const [meetingsCount, setMeetingsCount] = useState(
    homeOverviewCache.meetingsCount,
  );
  const [recentEntries, setRecentEntries] = useState<HistoryEntrySummary[]>(
    homeOverviewCache.recentEntries,
  );
  const [iconByIdentifier, setIconByIdentifier] = useState<
    Record<string, string>
  >(homeOverviewCache.icons);
  const [loading, setLoading] = useState(homeOverviewCache.updatedAt === 0);
  const openTaskCount = useTasksStore(
    (state) => state.tasks.filter((task) => !task.completed).length,
  );
  const requestIdRef = useRef(0);

  const loadOverview = useCallback(async ({ background = false } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!background) {
      setLoading(true);
    }

    try {
      const [statsResult, meetingsResult, recentResult] = await Promise.all([
        commands.getHistoryStats(),
        commands.getMeetings(),
        commands.getHistoryEntriesPageCompact(0, RECENT_ENTRY_LIMIT),
      ]);

      if (requestId !== requestIdRef.current) return;

      const nextStats = statsResult.status === "ok" ? statsResult.data : null;
      const nextMeetingsCount =
        meetingsResult.status === "ok" ? meetingsResult.data.length : 0;
      const nextRecentEntries =
        recentResult.status === "ok" ? recentResult.data : [];

      setStats(nextStats);
      setMeetingsCount(nextMeetingsCount);
      setRecentEntries(nextRecentEntries);

      homeOverviewCache.stats = nextStats;
      homeOverviewCache.meetingsCount = nextMeetingsCount;
      homeOverviewCache.recentEntries = nextRecentEntries;
      homeOverviewCache.updatedAt = Date.now();
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const hasCache = homeOverviewCache.updatedAt > 0;
    const isStale =
      Date.now() - homeOverviewCache.updatedAt > OVERVIEW_CACHE_TTL_MS;

    if (!hasCache || isStale) {
      loadOverview({ background: hasCache });
    }

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const setupListeners = async () => {
      const historyUnlisten = await listen("history-updated", () => {
        loadOverview({ background: true });
      });
      if (disposed) {
        historyUnlisten();
        return;
      }
      unlisteners.push(historyUnlisten);
    };

    void setupListeners();

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [loadOverview]);

  useEffect(() => {
    let cancelled = false;
    const missing = Array.from(
      new Set(
        recentEntries
          .map((entry) => entry.source_app_identifier)
          .filter((identifier): identifier is string => {
            if (!identifier) return false;
            return !iconByIdentifier[identifier];
          }),
      ),
    );
    if (missing.length === 0) {
      return () => {
        cancelled = true;
      };
    }

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
        homeOverviewCache.icons = next;
        return next;
      });
    };

    void loadIcons();

    return () => {
      cancelled = true;
    };
  }, [iconByIdentifier, recentEntries]);

  const copyRecentEntryToClipboard = useCallback(
    async (entry: HistoryEntrySummary) => {
      try {
        let textToCopy = entry.text;
        const fullTextResult = await commands.getHistoryEntryText(entry.id);
        if (fullTextResult.status === "ok" && fullTextResult.data) {
          textToCopy = fullTextResult.data;
        }
        await navigator.clipboard.writeText(textToCopy);
        toast.success(t("historyPage.copied"));
      } catch (error) {
        console.error("Failed to copy history entry:", error);
      }
    },
    [t],
  );

  const totalSessions = stats?.entry_count ?? 0;

  const cards: QuickSectionCard[] = useMemo(
    () => [
      {
        id: "history",
        title: t("historyPage.voiceHistory"),
        description: t("home.cards.history"),
        icon: HistoryIcon,
        onClick: () => onNavigate("history"),
        stat: `${totalSessions}`,
      },
      {
        id: "clipboard",
        title: t("nav.clipboardHistory"),
        description: t("home.cards.clipboardHistory"),
        icon: ClipboardList,
        onClick: () => onNavigate("clipboard"),
      },
      {
        id: "tasks",
        title: t("nav.tasks"),
        description: t("home.cards.tasks"),
        icon: ListChecks,
        onClick: () => onNavigate("tasks"),
        stat: `${openTaskCount}`,
      },
      {
        id: "meetings",
        title: t("nav.meetings"),
        description: t("home.cards.meetings"),
        icon: Video,
        onClick: () => onNavigate("meetings"),
        stat: `${meetingsCount}`,
      },
      {
        id: "settings",
        title: t("nav.settings"),
        description: t("home.cards.settings"),
        icon: Settings,
        onClick: () => onNavigate("settings"),
      },
      {
        id: "help",
        title: t("nav.help"),
        description: t("home.cards.help"),
        icon: HelpCircle,
        onClick: () => onNavigate("help"),
      },
    ],
    [meetingsCount, onNavigate, openTaskCount, t, totalSessions],
  );

  return (
    <div className="mx-auto w-full max-w-[980px]">
      <section className="w-full px-4 py-6">
        <div className="space-y-10">
          <div>
            <h1 className="app-display">{t("home.title")}</h1>
          </div>

          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="app-title">{t("home.cards.title")}</h2>
              {loading && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t("common.loading")}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {cards.map((card) => {
                const Icon = card.icon;
                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={card.onClick}
                    className="liquid-glass group rounded-3xl p-5 text-left transition-all hover:-translate-y-0.5 hover:bg-white/85 dark:hover:bg-zinc-900/85"
                  >
                    <div className="flex items-center justify-between">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-500">
                        <Icon className="h-4 w-4" />
                      </span>
                      {card.stat && (
                        <span className="rounded-full border border-black/5 px-2 py-0.5 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
                          {card.stat}
                        </span>
                      )}
                    </div>
                    <div className="mt-3 space-y-1">
                      <p className="text-xl font-medium text-zinc-900 dark:text-zinc-100">
                        {card.title}
                      </p>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">
                        {card.description}
                      </p>
                    </div>
                    <div className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-blue-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-blue-500">
                      {t("home.cards.open")}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="liquid-glass rounded-3xl p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="app-title">{t("home.recent.title")}</h2>
              <button
                type="button"
                onClick={() => onNavigate("history")}
                className="text-sm font-medium text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-500 dark:hover:text-blue-400"
              >
                {t("home.recent.openHistory")}
              </button>
            </div>

            {recentEntries.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
                {t("home.recent.empty")}
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {recentEntries.map((entry) => {
                  const text = entry.text;
                  const sourceLabelParts = [
                    entry.source_app_name ?? entry.source_app_identifier,
                    entry.source_window_title,
                  ].filter(Boolean) as string[];
                  const sourceLabel = sourceLabelParts.join(" — ");
                  const iconSrc = entry.source_app_identifier
                    ? iconByIdentifier[entry.source_app_identifier]
                    : undefined;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => {
                        void copyRecentEntryToClipboard(entry);
                      }}
                      title={t("historyPage.copy")}
                      aria-label={t("historyPage.copy")}
                      className="flex w-full items-start gap-3 rounded-2xl border border-black/5 bg-white/55 px-3 py-2 text-left shadow-[0_6px_20px_-16px_rgb(0_0_0_/_0.3)] backdrop-blur-2xl transition-colors hover:bg-blue-500/10 dark:border-white/10 dark:bg-zinc-900/55"
                    >
                      <div className="w-24 shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                        <div>{formatRecentEntryTime(entry.timestamp)}</div>
                        {sourceLabel && (
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
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
                      <span className="min-w-0 flex-1 line-clamp-2 text-sm text-zinc-800 dark:text-zinc-200">
                        {text}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
};

export default Home;
