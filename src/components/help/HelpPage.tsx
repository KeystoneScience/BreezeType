import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCircle2,
  Image,
  Loader2,
  MessageCircleQuestion,
  Paperclip,
  PlayCircle,
  Send,
  Trash2,
} from "lucide-react";
import { useModelStatus } from "../../hooks/useModelStatus";
import { useSettings } from "../../hooks/useSettings";
import { getVersion } from "@tauri-apps/api/app";
import { type as getOsType } from "@tauri-apps/plugin-os";
import {
  checkAccessibilityPermission,
  checkInputMonitoringPermission,
  checkMicrophonePermission,
  checkScreenRecordingPermission,
  requestAccessibilityPermission,
  requestInputMonitoringPermission,
  requestMicrophonePermission,
  requestScreenRecordingPermission,
} from "tauri-plugin-macos-permissions-api";
import { Button } from "../ui/Button";
import { Modal, MODAL_TRANSITION_MS } from "../ui/Modal";
import { Textarea } from "../ui/Textarea";
import { toast } from "sonner";
import { submitSupportMessage, type SupportScreenshot } from "@/lib/supportApi";
import { useAuthStore } from "@/stores/authStore";
import UpdateChecker from "../update-checker";
import HelpTutorialPlayer, {
  type HelpTutorialLabels,
  type HelpTutorialShortcuts,
  type HelpTutorialStep,
} from "./TutorialPlayer";

const MAX_SCREENSHOTS = 3;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Unable to read image."));
      }
    };
    reader.onerror = () =>
      reject(reader.error || new Error("Unable to read image."));
    reader.readAsDataURL(file);
  });

const makeScreenshotId = (file: File) =>
  `${file.name}-${file.size}-${file.lastModified}-${Math.random()
    .toString(36)
    .slice(2)}`;

const HelpPage: React.FC = () => {
  const { t } = useTranslation();
  const { status } = useModelStatus();
  const { getSetting } = useSettings();
  const authToken = useAuthStore((state) => state.token);
  const authUser = useAuthStore((state) => state.user);
  const [osType, setOsType] = useState<string>("unknown");
  const [permissionStates, setPermissionStates] = useState<
    Record<string, "checking" | "granted" | "denied" | "error">
  >({});
  const [supportOpen, setSupportOpen] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportScreenshots, setSupportScreenshots] = useState<
    SupportScreenshot[]
  >([]);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialMounted, setTutorialMounted] = useState(false);
  const [tutorialVisible, setTutorialVisible] = useState(false);
  const [tutorialReminderVisible, setTutorialReminderVisible] = useState(false);
  const [supportSubmitting, setSupportSubmitting] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const versionLabel = appVersion ? `v${appVersion}` : "...";
  const screenshotInputRef = useRef<HTMLInputElement | null>(null);
  const resetSupportOnExitRef = useRef(false);
  const tutorialCloseTimerRef = useRef<number | null>(null);
  const tutorialReminderTimerRef = useRef<number | null>(null);

  const statusIcon = (() => {
    switch (status) {
      case "ready":
        return (
          <CheckCircle2 className="h-4 w-4 text-blue-600 dark:text-blue-500" />
        );
      case "loading":
        return <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />;
      default:
        return <AlertCircle className="h-4 w-4 text-zinc-500" />;
    }
  })();

  const permissionItems = useMemo(
    () => [
      {
        id: "accessibility",
        label: t("help.permissions.items.accessibility"),
        check: checkAccessibilityPermission,
        request: requestAccessibilityPermission,
      },
      {
        id: "microphone",
        label: t("help.permissions.items.microphone"),
        check: checkMicrophonePermission,
        request: requestMicrophonePermission,
      },
      {
        id: "screen_recording",
        label: t("help.permissions.items.screenRecording"),
        check: checkScreenRecordingPermission,
        request: requestScreenRecordingPermission,
      },
      {
        id: "input_monitoring",
        label: t("help.permissions.items.inputMonitoring"),
        check: checkInputMonitoringPermission,
        request: requestInputMonitoringPermission,
      },
    ],
    [t],
  );

  const tutorialSteps = useMemo<HelpTutorialStep[]>(
    () => [
      {
        id: "dictation",
        eyebrow: t("help.tutorial.steps.dictation.eyebrow"),
        title: t("help.tutorial.steps.dictation.title"),
        description: t("help.tutorial.steps.dictation.description"),
        action: t("help.tutorial.steps.dictation.action"),
      },
      {
        id: "clipboard",
        eyebrow: t("help.tutorial.steps.clipboard.eyebrow"),
        title: t("help.tutorial.steps.clipboard.title"),
        description: t("help.tutorial.steps.clipboard.description"),
        action: t("help.tutorial.steps.clipboard.action"),
      },
      {
        id: "tasks",
        eyebrow: t("help.tutorial.steps.tasks.eyebrow"),
        title: t("help.tutorial.steps.tasks.title"),
        description: t("help.tutorial.steps.tasks.description"),
        action: t("help.tutorial.steps.tasks.action"),
      },
      {
        id: "meetings",
        eyebrow: t("help.tutorial.steps.meetings.eyebrow"),
        title: t("help.tutorial.steps.meetings.title"),
        description: t("help.tutorial.steps.meetings.description"),
        action: t("help.tutorial.steps.meetings.action"),
      },
      {
        id: "finish",
        eyebrow: t("help.tutorial.steps.finish.eyebrow"),
        title: t("help.tutorial.steps.finish.title"),
        description: t("help.tutorial.steps.finish.description"),
        action: t("help.tutorial.steps.finish.action"),
      },
    ],
    [t],
  );

  const shortcutBindings = getSetting("bindings") || {};
  const tutorialShortcuts = useMemo<HelpTutorialShortcuts>(
    () => ({
      dictation: shortcutBindings.transcribe?.current_binding || "cmd+shift+x",
      clipboard:
        shortcutBindings.clipboard_history?.current_binding || "cmd+shift+v",
      quickTask: shortcutBindings.quick_task?.current_binding || "cmd+shift+c",
    }),
    [shortcutBindings],
  );

  const tutorialLabels = useMemo<HelpTutorialLabels>(
    () => ({
      skip: t("help.tutorial.skip"),
      previous: t("help.tutorial.previous"),
      next: t("help.tutorial.next"),
      stepStatus: (current, total) =>
        t("help.tutorial.stepStatus", { current, total }),
    }),
    [t],
  );

  const refreshPermissions = useCallback(async () => {
    if (osType !== "macos") return;
    setPermissionStates((prev) => {
      const next = { ...prev };
      permissionItems.forEach((item) => {
        next[item.id] = "checking";
      });
      return next;
    });

    const results = await Promise.all(
      permissionItems.map(async (item) => {
        try {
          const allowed = await item.check();
          return [item.id, allowed ? "granted" : "denied"] as const;
        } catch (error) {
          console.error(`Failed to check ${item.id} permission:`, error);
          return [item.id, "error"] as const;
        }
      }),
    );

    setPermissionStates(Object.fromEntries(results));
  }, [osType, permissionItems]);

  useEffect(() => {
    const detectOs = async () => {
      try {
        const detected = await getOsType();
        setOsType(detected);
      } catch (error) {
        console.error("Failed to detect OS:", error);
        setOsType("unknown");
      }
    };
    void detectOs();
  }, []);

  useEffect(() => {
    const loadVersion = async () => {
      try {
        setAppVersion(await getVersion());
      } catch (error) {
        console.error("Failed to load app version:", error);
        setAppVersion("unknown");
      }
    };
    void loadVersion();
  }, []);

  useEffect(() => {
    if (osType === "macos") {
      void refreshPermissions();
    }
  }, [osType, refreshPermissions]);

  useEffect(
    () => () => {
      if (tutorialCloseTimerRef.current !== null) {
        window.clearTimeout(tutorialCloseTimerRef.current);
      }
      if (tutorialReminderTimerRef.current !== null) {
        window.clearTimeout(tutorialReminderTimerRef.current);
      }
    },
    [],
  );

  const showTutorialReminder = useCallback(() => {
    setTutorialReminderVisible(true);

    if (tutorialReminderTimerRef.current !== null) {
      window.clearTimeout(tutorialReminderTimerRef.current);
    }

    tutorialReminderTimerRef.current = window.setTimeout(() => {
      setTutorialReminderVisible(false);
      tutorialReminderTimerRef.current = null;
    }, 3200);
  }, []);

  useEffect(() => {
    if (tutorialOpen) {
      if (tutorialCloseTimerRef.current !== null) {
        window.clearTimeout(tutorialCloseTimerRef.current);
        tutorialCloseTimerRef.current = null;
      }
      setTutorialMounted(true);
      return;
    }

    setTutorialVisible(false);
    if (!tutorialMounted) return;

    if (tutorialCloseTimerRef.current !== null) {
      window.clearTimeout(tutorialCloseTimerRef.current);
    }

    tutorialCloseTimerRef.current = window.setTimeout(() => {
      setTutorialMounted(false);
      tutorialCloseTimerRef.current = null;
      showTutorialReminder();
    }, MODAL_TRANSITION_MS);
  }, [showTutorialReminder, tutorialMounted, tutorialOpen]);

  useEffect(() => {
    if (!tutorialMounted || !tutorialOpen) return;

    const frame = window.requestAnimationFrame(() => {
      setTutorialVisible(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tutorialMounted, tutorialOpen]);

  const handleOpenTutorial = useCallback(() => {
    if (tutorialReminderTimerRef.current !== null) {
      window.clearTimeout(tutorialReminderTimerRef.current);
      tutorialReminderTimerRef.current = null;
    }
    if (tutorialCloseTimerRef.current !== null) {
      window.clearTimeout(tutorialCloseTimerRef.current);
      tutorialCloseTimerRef.current = null;
    }
    setTutorialReminderVisible(false);
    setTutorialMounted(true);
    setTutorialOpen(true);
  }, []);

  const handleCloseTutorial = useCallback(() => {
    setTutorialOpen(false);
  }, []);

  const handleOpenSettings = async (item: (typeof permissionItems)[number]) => {
    setPermissionStates((prev) => ({ ...prev, [item.id]: "checking" }));
    try {
      await item.request();
    } catch (error) {
      console.error(`Failed to request ${item.id} permission:`, error);
    }
    await refreshPermissions();
  };

  const resetSupportForm = () => {
    setSupportMessage("");
    setSupportScreenshots([]);
  };

  const handleSupportExited = () => {
    if (!resetSupportOnExitRef.current) return;
    resetSupportOnExitRef.current = false;
    resetSupportForm();
    setSupportSubmitting(false);
  };

  const handleCloseSupport = () => {
    if (supportSubmitting) return;
    setSupportOpen(false);
  };

  const handleScreenshotFiles = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (files.length === 0) return;

    const remainingSlots = MAX_SCREENSHOTS - supportScreenshots.length;
    if (remainingSlots <= 0) {
      toast.error(t("help.support.errors.tooManyScreenshots"));
      return;
    }

    const acceptedFiles = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      toast.error(t("help.support.errors.tooManyScreenshots"));
    }

    const nextScreenshots: SupportScreenshot[] = [];
    for (const file of acceptedFiles) {
      if (!file.type.startsWith("image/")) {
        toast.error(t("help.support.errors.invalidScreenshot"));
        continue;
      }
      if (file.size > MAX_SCREENSHOT_BYTES) {
        toast.error(t("help.support.errors.screenshotTooLarge"));
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        nextScreenshots.push({
          id: makeScreenshotId(file),
          fileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          dataUrl,
        });
      } catch (error) {
        toast.error(t("help.support.errors.screenshotRead"));
      }
    }

    if (nextScreenshots.length > 0) {
      setSupportScreenshots((prev) => [...prev, ...nextScreenshots]);
    }
  };

  const handleSendSupport = async () => {
    const message = supportMessage.trim();
    if (!message) {
      toast.error(t("help.support.errors.messageRequired"));
      return;
    }
    if (!authToken) {
      toast.error(t("help.support.errors.signInRequired"));
      return;
    }

    setSupportSubmitting(true);
    let shouldResetAfterExit = false;
    try {
      await submitSupportMessage({
        authToken,
        message,
        appVersion: appVersion || "unknown",
        screenshots: supportScreenshots,
        metadata: {
          source: "help_page",
          osType,
          locale: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          userAgent: navigator.userAgent,
          screen: {
            width: window.screen.width,
            height: window.screen.height,
            pixelRatio: window.devicePixelRatio,
          },
          clientUser: {
            userId: authUser?.user_id || null,
            email: authUser?.email || null,
            name: authUser?.name || null,
          },
        },
      });
      toast.success(t("help.support.sent"));
      resetSupportOnExitRef.current = true;
      shouldResetAfterExit = true;
      setSupportOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("help.support.errors.send"),
      );
    } finally {
      if (!shouldResetAfterExit) {
        setSupportSubmitting(false);
      }
    }
  };

  const renderPermissionStatus = (
    state: "checking" | "granted" | "denied" | "error" | undefined,
  ) => {
    switch (state) {
      case "granted":
        return (
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-full bg-blue-500/80" />
            {t("help.permissions.status.on")}
          </div>
        );
      case "denied":
        return (
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-full bg-zinc-400/80" />
            {t("help.permissions.status.off")}
          </div>
        );
      case "error":
        return (
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-full bg-zinc-500/80" />
            {t("help.permissions.status.error")}
          </div>
        );
      default:
        return (
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("help.permissions.status.checking")}
          </div>
        );
    }
  };

  return (
    <div className="mx-auto w-full max-w-[980px]">
      <section className="w-full px-4 py-6">
        <div className="space-y-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="app-display">{t("help.title")}</h1>
              <p className="app-caption mt-2">{t("help.subtitle")}</p>
            </div>
            <div className="liquid-glass flex items-center gap-2 rounded-2xl px-4 py-2 text-sm text-zinc-600 dark:text-zinc-300">
              {statusIcon}
              <span>{t(`help.status.${status}`)}</span>
            </div>
          </div>

          {tutorialReminderVisible && (
            <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 px-4 py-3 text-sm font-semibold text-blue-700 shadow-[0_14px_34px_-28px_rgb(37_99_235_/_0.9)] dark:border-blue-400/20 dark:bg-blue-400/10 dark:text-blue-200">
              {t("help.tutorial.reminder")}
            </div>
          )}

          <div className="liquid-glass rounded-3xl p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400">
                  <PlayCircle className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h3 className="app-headline">
                    {t("help.tutorial.cardTitle")}
                  </h3>
                  <p className="app-caption mt-2">
                    {t("help.tutorial.cardSubtitle")}
                  </p>
                </div>
              </div>
              <Button type="button" size="sm" onClick={handleOpenTutorial}>
                <PlayCircle className="h-4 w-4" />
                {t("help.tutorial.open")}
              </Button>
            </div>
          </div>

          <div className="liquid-glass rounded-3xl p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="app-headline">
                  {t("settings.about.version.title")}
                </h3>
                <p className="app-caption mt-2">
                  {t("settings.about.version.description")}
                </p>
              </div>
              <div className="flex items-center gap-5 text-sm">
                <span className="font-mono text-zinc-700 dark:text-zinc-200">
                  {versionLabel}
                </span>
                <UpdateChecker
                  emphasized
                  autoCheckOnMount={false}
                  listenForExternalChecks={false}
                  promptOnAutoUpdate={false}
                />
              </div>
            </div>
          </div>

          <div className="liquid-glass rounded-3xl p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="app-headline">{t("help.permissions.title")}</h3>
                <p className="app-caption mt-2">
                  {t("help.permissions.subtitle")}
                </p>
              </div>
              {osType === "macos" && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void refreshPermissions()}
                >
                  {t("help.permissions.refresh")}
                </Button>
              )}
            </div>

            {osType !== "macos" ? (
              <div className="mt-4 rounded-2xl border border-black/5 bg-white/55 px-4 py-3 text-sm text-zinc-500 dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-400">
                {t("help.permissions.notSupported")}
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {permissionItems.map((item) => {
                  const state = permissionStates[item.id];
                  const isGranted = state === "granted";
                  return (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/5 bg-white/55 px-4 py-3 dark:border-white/10 dark:bg-zinc-900/60"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                          {item.label}
                        </span>
                        {renderPermissionStatus(state)}
                      </div>
                      {!isGranted && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void handleOpenSettings(item)}
                        >
                          {t("accessibility.openSettings")}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>

      <button
        type="button"
        onClick={() => setSupportOpen(true)}
        className="fixed bottom-6 right-6 z-40 inline-flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border border-white/25 bg-blue-600 text-white shadow-[0_14px_32px_-14px_rgb(37_99_235_/_0.85)] transition-all hover:bg-blue-500 hover:shadow-[0_18px_38px_-16px_rgb(37_99_235_/_0.95)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_rgb(59_130_246_/_0.7),0_0_0_5px_rgb(59_130_246_/_0.18),0_18px_38px_-16px_rgb(37_99_235_/_0.95)] active:scale-[0.98] dark:border-white/15 dark:bg-blue-500 dark:hover:bg-blue-400"
        aria-label={t("help.support.open")}
        title={t("help.support.open")}
      >
        <MessageCircleQuestion className="h-6 w-6" />
      </button>

      <Modal
        title={t("help.support.title")}
        subtitle={t("help.support.subtitle")}
        open={supportOpen}
        width="md"
        closeLabel={t("common.close")}
        onClose={handleCloseSupport}
        onExited={handleSupportExited}
      >
        <div className="space-y-5">
          {!authToken && (
            <div className="rounded-2xl border border-black/5 bg-white/55 px-4 py-3 text-sm text-zinc-500 dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-400">
              {t("help.support.signInRequired")}
            </div>
          )}

          <label className="block">
            <span className="mb-5 block text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              {t("help.support.messageLabel")}
            </span>
            <Textarea
              value={supportMessage}
              onChange={(event) => setSupportMessage(event.target.value)}
              placeholder={t("help.support.messagePlaceholder")}
              className="min-h-[150px] resize-none"
              disabled={supportSubmitting}
            />
          </label>

          <div className="space-y-3">
            <input
              ref={screenshotInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => void handleScreenshotFiles(event)}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => screenshotInputRef.current?.click()}
                disabled={
                  supportSubmitting ||
                  supportScreenshots.length >= MAX_SCREENSHOTS
                }
                className="inline-flex items-center gap-2 rounded-2xl border border-black/5 bg-white/55 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-50 dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-200 dark:hover:bg-zinc-900/75"
              >
                <Paperclip className="h-4 w-4" />
                {t("help.support.attach")}
              </button>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {t("help.support.attachmentLimit", {
                  count: supportScreenshots.length,
                  max: MAX_SCREENSHOTS,
                })}
              </span>
            </div>

            {supportScreenshots.length > 0 && (
              <div className="space-y-2">
                {supportScreenshots.map((screenshot) => (
                  <div
                    key={screenshot.id}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-black/5 bg-white/55 px-3 py-2 dark:border-white/10 dark:bg-zinc-900/60"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Image className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">
                          {screenshot.fileName}
                        </div>
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {Math.max(1, Math.round(screenshot.sizeBytes / 1024))}{" "}
                          KB
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="history-mini-icon-button"
                      onClick={() =>
                        setSupportScreenshots((prev) =>
                          prev.filter((item) => item.id !== screenshot.id),
                        )
                      }
                      aria-label={t("common.delete")}
                      title={t("common.delete")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleCloseSupport}
              disabled={supportSubmitting}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSendSupport()}
              disabled={
                supportSubmitting || !supportMessage.trim() || !authToken
              }
            >
              {supportSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {t("help.support.send")}
            </Button>
          </div>
        </div>
      </Modal>

      {tutorialMounted && (
        <div
          className={`fixed inset-0 z-[80] bg-[#eef3f8] transition-opacity ease-out will-change-[opacity] ${
            tutorialVisible
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0"
          }`}
          style={{ transitionDuration: `${MODAL_TRANSITION_MS}ms` }}
          aria-hidden={!tutorialOpen}
        >
          <HelpTutorialPlayer
            steps={tutorialSteps}
            labels={tutorialLabels}
            shortcuts={tutorialShortcuts}
            onClose={handleCloseTutorial}
          />
        </div>
      )}
    </div>
  );
};

export default HelpPage;
