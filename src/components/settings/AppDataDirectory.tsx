import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { SettingContainer } from "../ui/SettingContainer";
import { Button } from "../ui/Button";

interface AppDataDirectoryProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

export const AppDataDirectory: React.FC<AppDataDirectoryProps> = ({
  descriptionMode = "inline",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const [appDirPath, setAppDirPath] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadAppDirectory = async () => {
      try {
        const result = await commands.getAppDirPath();
        if (result.status === "ok") {
          setAppDirPath(result.data);
        } else {
          setError(result.error);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load app directory",
        );
      } finally {
        setLoading(false);
      }
    };

    loadAppDirectory();
  }, []);

  const handleOpen = async () => {
    if (!appDirPath) return;
    try {
      await commands.openAppDataDir();
    } catch (openError) {
      console.error("Failed to open app data directory:", openError);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse">
        <div className="mb-2 h-4 w-1/3 rounded bg-black/10 dark:bg-white/15"></div>
        <div className="h-8 rounded bg-black/10 dark:bg-white/15"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-black/5 bg-white/55 p-4 text-sm text-zinc-600 dark:border-white/10 dark:bg-zinc-900/55 dark:text-zinc-300">
        <p>{t("errors.loadDirectory", { error })}</p>
      </div>
    );
  }

  return (
    <SettingContainer
      title={t("settings.about.appDataDirectory.title")}
      description={t("settings.about.appDataDirectory.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="stacked"
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 rounded-2xl border border-black/5 bg-white/60 px-3 py-2 text-xs font-mono break-all text-zinc-700 dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-200">
          {appDirPath}
        </div>
        <Button
          onClick={handleOpen}
          variant="secondary"
          size="sm"
          disabled={!appDirPath}
          className="px-3 py-2"
        >
          {t("common.open")}
        </Button>
      </div>
    </SettingContainer>
  );
};
