import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { ProgressBar } from "../shared";
import { useSettings } from "../../hooks/useSettings";
import { commands } from "../../bindings";

const AUTO_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const AUTO_UPDATE_IDLE_RETRY_MS = 60 * 1000;
const AUTO_UPDATE_IDLE_STABILITY_MS = 30 * 1000;
const UP_TO_DATE_MESSAGE_MS = 3000;

interface UpdateCheckerProps {
  className?: string;
  emphasized?: boolean;
  autoCheckOnMount?: boolean;
  listenForExternalChecks?: boolean;
  promptOnAutoUpdate?: boolean;
  autoInstallOnIdle?: boolean;
  showWhenUpdateAvailableOnly?: boolean;
  variant?: "inline" | "sidebar";
  showUi?: boolean;
}

const UpdateChecker: React.FC<UpdateCheckerProps> = ({
  className = "",
  emphasized = false,
  autoCheckOnMount = true,
  listenForExternalChecks = true,
  promptOnAutoUpdate = false,
  autoInstallOnIdle = false,
  showWhenUpdateAvailableOnly = false,
  variant = "inline",
  showUi = true,
}) => {
  const { t } = useTranslation();
  const [isChecking, setIsChecking] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [showUpToDate, setShowUpToDate] = useState(false);
  const [pendingUpdateReady, setPendingUpdateReady] = useState(false);

  const { settings, isLoading } = useSettings();
  const settingsLoaded = !isLoading && settings !== null;
  const updateChecksEnabled = settings?.update_checks_enabled ?? false;

  const upToDateTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const idleInstallTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const downloadedBytesRef = useRef(0);
  const contentLengthRef = useRef(0);
  const promptedVersionRef = useRef<string | null>(null);
  const pendingUpdateRef = useRef<Update | null>(null);
  const pendingUpdateVersionRef = useRef<string | null>(null);
  const pendingUpdateDownloadedRef = useRef(false);
  const checkingRef = useRef(false);
  const downloadInProgressRef = useRef(false);
  const installInProgressRef = useRef(false);
  const lastUnsafeForInstallAtRef = useRef(Date.now());

  const closeUpdateQuietly = (update: Update | null) => {
    if (!update) return;
    void update.close().catch((error) => {
      console.warn("Failed to close updater resource:", error);
    });
  };

  const clearPendingUpdate = (updateState = true) => {
    closeUpdateQuietly(pendingUpdateRef.current);
    pendingUpdateRef.current = null;
    pendingUpdateVersionRef.current = null;
    pendingUpdateDownloadedRef.current = false;
    if (updateState) {
      setPendingUpdateReady(false);
    }
  };

  const handleDownloadEvent = (event: DownloadEvent) => {
    switch (event.event) {
      case "Started":
        downloadedBytesRef.current = 0;
        contentLengthRef.current = event.data.contentLength ?? 0;
        break;
      case "Progress": {
        downloadedBytesRef.current += event.data.chunkLength;
        const progress =
          contentLengthRef.current > 0
            ? Math.round(
                (downloadedBytesRef.current / contentLengthRef.current) * 100,
              )
            : 0;
        setDownloadProgress(Math.min(progress, 100));
        break;
      }
      case "Finished":
        setDownloadProgress(100);
        break;
    }
  };

  const resetDownloadProgress = () => {
    setDownloadProgress(0);
    downloadedBytesRef.current = 0;
    contentLengthRef.current = 0;
  };

  const hasBeenIdleForUpdateInstall = async () => {
    try {
      const [
        voiceActivityActive,
        meetingRecordingResult,
        clipboardRecentlyActive,
      ] = await Promise.all([
        invoke<boolean>("is_voice_activity_active"),
        commands.isMeetingRecording(),
        invoke<boolean>("is_clipboard_recently_active", {
          idleMs: AUTO_UPDATE_IDLE_STABILITY_MS,
        }),
      ]);
      const meetingRecording =
        meetingRecordingResult.status === "ok"
          ? meetingRecordingResult.data
          : true;
      const unsafe =
        voiceActivityActive || meetingRecording || clipboardRecentlyActive;

      if (unsafe) {
        lastUnsafeForInstallAtRef.current = Date.now();
        return false;
      }

      return (
        Date.now() - lastUnsafeForInstallAtRef.current >=
        AUTO_UPDATE_IDLE_STABILITY_MS
      );
    } catch (error) {
      lastUnsafeForInstallAtRef.current = Date.now();
      console.error("Failed to determine update install safety:", error);
      return false;
    }
  };

  const scheduleIdleInstallAttempt = (
    delayMs: number = AUTO_UPDATE_IDLE_RETRY_MS,
  ) => {
    if (!autoInstallOnIdle || idleInstallTimeoutRef.current) return;
    idleInstallTimeoutRef.current = setTimeout(() => {
      idleInstallTimeoutRef.current = undefined;
      void installPendingUpdateWhenIdle();
    }, delayMs);
  };

  const installPendingUpdateWhenIdle = async () => {
    if (
      !autoInstallOnIdle ||
      !pendingUpdateRef.current ||
      !pendingUpdateDownloadedRef.current ||
      downloadInProgressRef.current ||
      installInProgressRef.current
    ) {
      return;
    }

    const safeToInstall = await hasBeenIdleForUpdateInstall();
    if (!safeToInstall) {
      scheduleIdleInstallAttempt();
      return;
    }

    const update = pendingUpdateRef.current;

    try {
      installInProgressRef.current = true;
      setIsInstalling(true);
      setDownloadProgress(100);
      await update.install();
      pendingUpdateRef.current = null;
      pendingUpdateVersionRef.current = null;
      pendingUpdateDownloadedRef.current = false;
      setPendingUpdateReady(false);
      await relaunch();
    } catch (error) {
      console.error("Failed to install downloaded update:", error);
      scheduleIdleInstallAttempt();
    } finally {
      installInProgressRef.current = false;
      setIsInstalling(false);
      resetDownloadProgress();
    }
  };

  const downloadUpdateForAutomaticInstall = async (update: Update) => {
    if (!autoInstallOnIdle) return;

    if (pendingUpdateVersionRef.current === update.version) {
      closeUpdateQuietly(update);
      if (pendingUpdateDownloadedRef.current) {
        setPendingUpdateReady(true);
        scheduleIdleInstallAttempt(0);
      }
      return;
    }

    clearPendingUpdate();
    pendingUpdateRef.current = update;
    pendingUpdateVersionRef.current = update.version;
    pendingUpdateDownloadedRef.current = false;
    setPendingUpdateReady(false);

    try {
      downloadInProgressRef.current = true;
      setIsInstalling(true);
      setUpdateAvailable(true);
      resetDownloadProgress();
      await update.download(handleDownloadEvent);
      pendingUpdateDownloadedRef.current = true;
      setPendingUpdateReady(true);
      scheduleIdleInstallAttempt(0);
    } catch (error) {
      console.error("Failed to download update:", error);
      clearPendingUpdate();
      setUpdateAvailable(false);
    } finally {
      downloadInProgressRef.current = false;
      setIsInstalling(false);
      resetDownloadProgress();
    }
  };

  const installUpdate = async (precheckedUpdate?: Update) => {
    if (!updateChecksEnabled) return;
    try {
      installInProgressRef.current = true;
      setIsInstalling(true);
      resetDownloadProgress();
      const update =
        precheckedUpdate ?? pendingUpdateRef.current ?? (await check());

      if (!update) {
        console.log("No update available during install attempt");
        return;
      }

      if (
        update === pendingUpdateRef.current &&
        pendingUpdateDownloadedRef.current
      ) {
        await update.install();
      } else {
        await update.downloadAndInstall(handleDownloadEvent);
      }

      if (update === pendingUpdateRef.current) {
        pendingUpdateRef.current = null;
        pendingUpdateVersionRef.current = null;
        pendingUpdateDownloadedRef.current = false;
        setPendingUpdateReady(false);
      }
      await relaunch();
    } catch (error) {
      console.error("Failed to install update:", error);
    } finally {
      installInProgressRef.current = false;
      setIsInstalling(false);
      resetDownloadProgress();
    }
  };

  const checkForUpdates = async ({
    manual = false,
    promptOnAvailable = false,
  }: {
    manual?: boolean;
    promptOnAvailable?: boolean;
  } = {}) => {
    if (
      !updateChecksEnabled ||
      checkingRef.current ||
      downloadInProgressRef.current ||
      installInProgressRef.current
    ) {
      return;
    }

    try {
      checkingRef.current = true;
      setIsChecking(true);
      const update = await check();

      if (update) {
        setUpdateAvailable(true);
        setShowUpToDate(false);

        if (autoInstallOnIdle && !manual) {
          await downloadUpdateForAutomaticInstall(update);
          return;
        }

        if (promptOnAvailable) {
          const version = update.version;
          if (promptedVersionRef.current !== version) {
            promptedVersionRef.current = version;
            const shouldInstall = window.confirm(
              t("footer.updatePrompt", { version }),
            );
            if (shouldInstall) {
              await installUpdate(update);
              return;
            }
          }
        }

        closeUpdateQuietly(update);
      } else {
        setUpdateAvailable(false);
        setPendingUpdateReady(false);

        if (manual) {
          setShowUpToDate(true);
          if (upToDateTimeoutRef.current) {
            clearTimeout(upToDateTimeoutRef.current);
          }
          upToDateTimeoutRef.current = setTimeout(() => {
            setShowUpToDate(false);
          }, UP_TO_DATE_MESSAGE_MS);
        }
      }
    } catch (error) {
      console.error("Failed to check for updates:", error);
    } finally {
      checkingRef.current = false;
      setIsChecking(false);
    }
  };

  const handleManualUpdateCheck = () => {
    if (!updateChecksEnabled) return;
    void checkForUpdates({ manual: true });
  };

  const handleInstallUpdate = () => {
    void installUpdate();
  };

  useEffect(() => {
    if (!settingsLoaded) return;

    if (!updateChecksEnabled) {
      if (upToDateTimeoutRef.current) {
        clearTimeout(upToDateTimeoutRef.current);
      }
      if (idleInstallTimeoutRef.current) {
        clearTimeout(idleInstallTimeoutRef.current);
        idleInstallTimeoutRef.current = undefined;
      }
      clearPendingUpdate();
      setIsChecking(false);
      setUpdateAvailable(false);
      setShowUpToDate(false);
      promptedVersionRef.current = null;
      return;
    }

    if (autoCheckOnMount) {
      void checkForUpdates({ promptOnAvailable: promptOnAutoUpdate });
    }

    let periodicCheckInterval: ReturnType<typeof setInterval> | null = null;
    if (autoInstallOnIdle) {
      periodicCheckInterval = setInterval(() => {
        void checkForUpdates();
      }, AUTO_UPDATE_CHECK_INTERVAL_MS);
    }

    let updateUnlisten: Promise<() => void> | null = null;
    if (listenForExternalChecks) {
      updateUnlisten = listen("check-for-updates", () => {
        void checkForUpdates({ manual: true, promptOnAvailable: true });
      });
    }

    return () => {
      if (upToDateTimeoutRef.current) {
        clearTimeout(upToDateTimeoutRef.current);
      }
      if (idleInstallTimeoutRef.current) {
        clearTimeout(idleInstallTimeoutRef.current);
        idleInstallTimeoutRef.current = undefined;
      }
      if (periodicCheckInterval) {
        clearInterval(periodicCheckInterval);
      }
      clearPendingUpdate(false);
      if (updateUnlisten) {
        updateUnlisten.then((fn) => fn());
      }
    };
  }, [
    autoCheckOnMount,
    autoInstallOnIdle,
    listenForExternalChecks,
    promptOnAutoUpdate,
    settingsLoaded,
    updateChecksEnabled,
  ]);

  const getUpdateStatusText = () => {
    if (!updateChecksEnabled) {
      return t("footer.updateCheckingDisabled");
    }
    if (isInstalling) {
      return downloadProgress > 0 && downloadProgress < 100
        ? t("footer.downloading", {
            progress: downloadProgress.toString().padStart(3),
          })
        : downloadProgress === 100
          ? t("footer.installing")
          : t("footer.preparing");
    }
    if (isChecking) return t("footer.checkingUpdates");
    if (showUpToDate) return t("footer.upToDate");
    if (pendingUpdateReady) return t("footer.updateNow");
    if (updateAvailable) return t("footer.updateAvailableShort");
    return t("footer.checkForUpdates");
  };

  const getUpdateStatusAction = () => {
    if (!updateChecksEnabled) return undefined;
    if (updateAvailable && !isInstalling) return handleInstallUpdate;
    if (!isChecking && !isInstalling && !updateAvailable)
      return handleManualUpdateCheck;
    return undefined;
  };

  const isUpdateDisabled = !updateChecksEnabled || isChecking || isInstalling;
  const isUpdateClickable =
    !isUpdateDisabled && (updateAvailable || (!isChecking && !showUpToDate));
  const isSidebarVariant = variant === "sidebar";
  const clickableClassName = isSidebarVariant
    ? "flex min-h-[34px] w-full items-center justify-center rounded-xl bg-blue-600 px-3 py-2 text-[13px] font-semibold leading-4 text-white transition-colors hover:bg-blue-500 disabled:cursor-default disabled:bg-blue-600/70"
    : emphasized || updateAvailable
      ? "font-medium text-blue-600 hover:text-blue-500 dark:text-blue-500 dark:hover:text-blue-400"
      : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200";
  const staticClassName = isSidebarVariant
    ? "flex min-h-[34px] w-full items-center justify-center rounded-xl bg-blue-600/80 px-3 py-2 text-[13px] font-semibold leading-4 text-white"
    : "tabular-nums text-zinc-500 dark:text-zinc-400";

  if (!showUi) return null;
  if (showWhenUpdateAvailableOnly && !updateAvailable && !isInstalling) {
    return null;
  }

  return (
    <div
      className={`flex items-center gap-3 ${isSidebarVariant ? "w-full" : ""} ${className}`}
    >
      {isUpdateClickable ? (
        <button
          type="button"
          onClick={getUpdateStatusAction()}
          disabled={isUpdateDisabled}
          className={`cursor-pointer tabular-nums transition-opacity transition-colors disabled:cursor-default disabled:opacity-50 ${clickableClassName}`}
        >
          {getUpdateStatusText()}
        </button>
      ) : (
        <span className={staticClassName}>{getUpdateStatusText()}</span>
      )}

      {!isSidebarVariant &&
        isInstalling &&
        downloadProgress > 0 &&
        downloadProgress < 100 && (
          <ProgressBar
            progress={[
              {
                id: "update",
                percentage: downloadProgress,
              },
            ]}
            size="large"
          />
        )}
    </div>
  );
};

export default UpdateChecker;
