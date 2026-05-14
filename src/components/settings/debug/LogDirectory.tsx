import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { SettingContainer } from "../../ui/SettingContainer";
import { Button } from "../../ui/Button";

interface LogDirectoryProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

export const LogDirectory: React.FC<LogDirectoryProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const [logDir, setLogDir] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadLogDirectory = async () => {
      try {
        const result = await commands.getLogDirPath();
        if (result.status === "ok") {
          setLogDir(result.data);
        } else {
          setError(result.error);
        }
      } catch (err) {
        const errorMessage =
          err && typeof err === "object" && "message" in err
            ? String(err.message)
            : "Failed to load log directory";
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    loadLogDirectory();
  }, []);

  const handleOpen = async () => {
    if (!logDir) return;
    try {
      await commands.openLogDir();
    } catch (openError) {
      console.error("Failed to open log directory:", openError);
    }
  };

  return (
    <SettingContainer
      title={t("settings.debug.logDirectory.title")}
      description={t("settings.debug.logDirectory.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="stacked"
    >
      {loading ? (
        <div className="animate-pulse">
          <div className="h-8 rounded bg-black/10 dark:bg-white/15" />
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-black/5 bg-white/55 p-3 text-xs text-zinc-600 dark:border-white/10 dark:bg-zinc-900/55 dark:text-zinc-300">
          {t("errors.loadDirectory", { error })}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 rounded-2xl border border-black/5 bg-white/60 px-3 py-2 text-xs font-mono break-all text-zinc-700 dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-200">
            {logDir}
          </div>
          <Button
            onClick={handleOpen}
            variant="secondary"
            size="sm"
            disabled={!logDir}
            className="px-3 py-2"
          >
            {t("common.open")}
          </Button>
        </div>
      )}
    </SettingContainer>
  );
};
