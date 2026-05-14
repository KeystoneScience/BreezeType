import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AudioPlayer } from "../../ui/AudioPlayer";
import { Button } from "../../ui/Button";
import { Copy, Star, Check, Trash2, FolderOpen } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { commands, type HistoryEntry } from "@/bindings";
import { formatDateTime } from "@/utils/dateFormat";

interface OpenRecordingsButtonProps {
  onClick: () => void;
  label: string;
}

const OpenRecordingsButton: React.FC<OpenRecordingsButtonProps> = ({
  onClick,
  label,
}) => (
  <Button
    onClick={onClick}
    variant="secondary"
    size="sm"
    className="flex items-center gap-2"
    title={label}
  >
    <FolderOpen className="w-4 h-4" />
    <span>{label}</span>
  </Button>
);

export const HistorySettings: React.FC = () => {
  const { t } = useTranslation();
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const loadRequestId = useRef(0);
  const pageSize = 10;

  const loadInitialEntries = useCallback(async () => {
    const requestId = ++loadRequestId.current;
    setLoading(true);
    setLoadingMore(false);
    setHasMore(true);
    setHistoryEntries([]);
    try {
      const result = await commands.getHistoryEntriesPage(0, pageSize);
      if (requestId !== loadRequestId.current) return;
      if (result.status === "ok") {
        setHistoryEntries(result.data);
        setHasMore(result.data.length === pageSize);
      }
    } catch (error) {
      console.error("Failed to load history entries:", error);
    } finally {
      if (requestId === loadRequestId.current) {
        setLoading(false);
      }
    }
  }, [pageSize]);

  const loadMoreEntries = useCallback(async () => {
    if (loading || loadingMore || !hasMore) return;
    const requestId = ++loadRequestId.current;
    setLoadingMore(true);
    try {
      const result = await commands.getHistoryEntriesPage(
        historyEntries.length,
        pageSize,
      );
      if (requestId !== loadRequestId.current) return;
      if (result.status === "ok") {
        setHistoryEntries((prev) => [...prev, ...result.data]);
        setHasMore(result.data.length === pageSize);
      }
    } catch (error) {
      console.error("Failed to load more history entries:", error);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, historyEntries.length, loading, loadingMore, pageSize]);

  useEffect(() => {
    loadInitialEntries();

    // Listen for history update events
    const setupListener = async () => {
      const unlisten = await listen("history-updated", () => {
        console.log("History updated, reloading entries...");
        loadInitialEntries();
      });

      // Return cleanup function
      return unlisten;
    };

    let unlistenPromise = setupListener();

    return () => {
      unlistenPromise.then((unlisten) => {
        if (unlisten) {
          unlisten();
        }
      });
    };
  }, [loadInitialEntries]);

  useEffect(() => {
    if (!hasMore || loading) return;
    const root = document.querySelector<HTMLElement>("[data-scroll-container]");
    const target = loadMoreRef.current;
    if (!root || !target) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMoreEntries();
        }
      },
      {
        root,
        rootMargin: "800px 0px",
      },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMoreEntries, loading]);

  const toggleSaved = async (id: number) => {
    try {
      await commands.toggleHistoryEntrySaved(id);
      // No need to reload here - the event listener will handle it
    } catch (error) {
      console.error("Failed to toggle saved status:", error);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

  const getAudioUrl = async (fileName: string) => {
    try {
      const result = await commands.getAudioFilePath(fileName);
      if (result.status === "ok") {
        return convertFileSrc(`${result.data}`, "asset");
      }
      return null;
    } catch (error) {
      console.error("Failed to get audio file path:", error);
      return null;
    }
  };

  const deleteAudioEntry = async (id: number) => {
    try {
      await commands.deleteHistoryEntry(id);
    } catch (error) {
      console.error("Failed to delete audio entry:", error);
      throw error;
    }
  };

  const openRecordingsFolder = async () => {
    try {
      await commands.openRecordingsFolder();
    } catch (error) {
      console.error("Failed to open recordings folder:", error);
    }
  };

  const showLoading = loading && historyEntries.length === 0;
  const showEmpty = !loading && historyEntries.length === 0;

  return (
    <div className="w-full space-y-6">
      <div className="space-y-2">
        <div className="px-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-medium text-zinc-900 dark:text-zinc-100">
              {t("settings.history.title")}
            </h2>
          </div>
          <OpenRecordingsButton
            onClick={openRecordingsFolder}
            label={t("settings.history.openFolder")}
          />
        </div>
        <div className="liquid-glass overflow-visible rounded-3xl">
          {showLoading && (
            <div className="px-4 py-3 text-center text-zinc-500 dark:text-zinc-400">
              {t("settings.history.loading")}
            </div>
          )}
          {showEmpty && (
            <div className="px-4 py-3 text-center text-zinc-500 dark:text-zinc-400">
              {t("settings.history.empty")}
            </div>
          )}
          {!showLoading && !showEmpty && (
            <div className="divide-y divide-black/5 dark:divide-white/10">
              {historyEntries.map((entry) => (
                <HistoryEntryComponent
                  key={entry.id}
                  entry={entry}
                  onToggleSaved={() => toggleSaved(entry.id)}
                  onCopyText={() => copyToClipboard(entry.transcription_text)}
                  getAudioUrl={getAudioUrl}
                  deleteAudio={deleteAudioEntry}
                />
              ))}
              {loadingMore && (
                <div className="px-4 py-3 text-center text-zinc-500 dark:text-zinc-400">
                  {t("settings.history.loading")}
                </div>
              )}
            </div>
          )}
        </div>
        <div ref={loadMoreRef} className="h-px" />
      </div>
    </div>
  );
};

interface HistoryEntryProps {
  entry: HistoryEntry;
  onToggleSaved: () => void;
  onCopyText: () => void;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  deleteAudio: (id: number) => Promise<void>;
}

const HistoryEntryComponent: React.FC<HistoryEntryProps> = ({
  entry,
  onToggleSaved,
  onCopyText,
  getAudioUrl,
  deleteAudio,
}) => {
  const { t, i18n } = useTranslation();
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [showCopied, setShowCopied] = useState(false);
  const [iconSrc, setIconSrc] = useState<string | null>(null);

  useEffect(() => {
    const loadAudio = async () => {
      const url = await getAudioUrl(entry.file_name);
      setAudioUrl(url);
    };
    loadAudio();
  }, [entry.file_name, getAudioUrl]);

  useEffect(() => {
    let cancelled = false;
    const loadIcon = async () => {
      if (!entry.source_app_identifier) {
        setIconSrc(null);
        return;
      }
      const result = await commands.getAppIcon(entry.source_app_identifier);
      if (!cancelled && result.status === "ok") {
        setIconSrc(result.data ?? null);
      }
    };
    loadIcon();
    return () => {
      cancelled = true;
    };
  }, [entry.source_app_identifier]);

  const handleCopyText = () => {
    onCopyText();
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const handleDeleteEntry = async () => {
    try {
      await deleteAudio(entry.id);
    } catch (error) {
      console.error("Failed to delete entry:", error);
      alert("Failed to delete entry. Please try again.");
    }
  };

  const formattedDate = formatDateTime(String(entry.timestamp), i18n.language);
  const sourceLabelParts = [
    entry.source_app_name ?? entry.source_app_identifier,
    entry.source_window_title,
  ].filter(Boolean) as string[];
  const sourceLabel = sourceLabelParts.join(" — ");

  return (
    <div className="px-4 py-2 pb-5 flex flex-col gap-3">
      <div className="flex justify-between items-center">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
          {formattedDate}
        </p>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopyText}
            className="history-icon-button"
            title={t("settings.history.copyToClipboard")}
          >
            {showCopied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
          <button
            onClick={onToggleSaved}
            className={`history-icon-button ${
              entry.saved
                ? "text-blue-600 dark:text-blue-500"
                : ""
            }`}
            title={
              entry.saved
                ? t("settings.history.unsave")
                : t("settings.history.save")
            }
          >
            <Star
              className="h-4 w-4"
              fill={entry.saved ? "currentColor" : "none"}
            />
          </button>
          <button
            onClick={handleDeleteEntry}
            className="history-icon-button"
            title={t("settings.history.delete")}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      {sourceLabel && (
        <div className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          {iconSrc && (
            <img src={iconSrc} alt="" className="h-4 w-4 rounded-[4px]" />
          )}
          <span className="truncate">{sourceLabel}</span>
        </div>
      )}
      <p className="pb-2 text-sm italic text-zinc-700 dark:text-zinc-200">
        {entry.transcription_text}
      </p>
      {audioUrl && <AudioPlayer src={audioUrl} className="w-full" />}
    </div>
  );
};
