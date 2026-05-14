import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
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
import {
  AlertCircle,
  CheckCircle2,
  Keyboard,
  Loader2,
  Mic,
  Monitor,
  Shield,
} from "lucide-react";
import BreezeTypeTextLogo from "../icons/BreezeTypeTextLogo";
import { Button } from "../ui/Button";
import { MODAL_TRANSITION_MS } from "../ui/Modal";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { trackAppEvent, trackAppEventOnce } from "@/lib/telemetry";

type PermissionId =
  | "accessibility"
  | "microphone"
  | "input_monitoring"
  | "screen_recording";

type PermissionState = "checking" | "granted" | "denied" | "error";

const REQUIRED_PERMISSIONS: PermissionId[] = ["microphone", "accessibility"];
const PERMISSIONS_GATE_TELEMETRY_SURFACE = "permissions_gate";

type PermissionActionMode = "request" | "open_settings";

const TitlebarDragRegion: React.FC = () => {
  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1) {
      return;
    }
    void getCurrentWindow().startDragging();
  };

  return (
    <div
      className="fixed top-0 left-0 right-0 h-[var(--titlebar-height)] z-[90] bg-transparent"
      data-tauri-drag-region
      onMouseDown={handleMouseDown}
    />
  );
};

const PermissionsGate: React.FC = () => {
  const { t } = useTranslation();
  const [osType, setOsType] = useState<string>("unknown");
  const [states, setStates] = useState<Record<PermissionId, PermissionState>>({
    accessibility: "checking",
    microphone: "checking",
    input_monitoring: "checking",
    screen_recording: "checking",
  });
  const [actionModes, setActionModes] = useState<
    Record<PermissionId, PermissionActionMode>
  >({
    microphone: "request",
    accessibility: "request",
    input_monitoring: "open_settings",
    screen_recording: "request",
  });
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const refreshInFlight = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const telemetrySnapshotRef = useRef<string | null>(null);

  const permissionItems = useMemo(
    () => [
      {
        id: "microphone" as const,
        required: true,
        icon: Mic,
        title: t("permissionsGate.items.microphone.title"),
        description: t("permissionsGate.items.microphone.description"),
        check: checkMicrophonePermission,
        request: requestMicrophonePermission,
      },
      {
        id: "accessibility" as const,
        required: true,
        icon: Shield,
        title: t("permissionsGate.items.accessibility.title"),
        description: t("permissionsGate.items.accessibility.description"),
        check: checkAccessibilityPermission,
        request: requestAccessibilityPermission,
      },
      {
        id: "input_monitoring" as const,
        required: false,
        icon: Keyboard,
        title: t("permissionsGate.items.inputMonitoring.title"),
        description: t("permissionsGate.items.inputMonitoring.description"),
        check: checkInputMonitoringPermission,
        request: requestInputMonitoringPermission,
      },
      {
        id: "screen_recording" as const,
        required: false,
        icon: Monitor,
        title: t("permissionsGate.items.screenRecording.title"),
        description: t("permissionsGate.items.screenRecording.description"),
        check: checkScreenRecordingPermission,
        request: requestScreenRecordingPermission,
      },
    ],
    [t],
  );

  useEffect(() => {
    if (isOpen) {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setMounted(true);
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }

    setVisible(false);
    if (!mounted) return;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = window.setTimeout(() => {
      setMounted(false);
      closeTimerRef.current = null;
    }, MODAL_TRANSITION_MS);
  }, [isOpen, mounted]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const allRequiredGranted = useMemo(
    () => REQUIRED_PERMISSIONS.every((id) => states[id] === "granted"),
    [states],
  );
  const allPermissionsResolved = useMemo(
    () => permissionItems.every((item) => states[item.id] !== "checking"),
    [permissionItems, states],
  );
  const requiredPermissionsResolved = useMemo(
    () => REQUIRED_PERMISSIONS.every((id) => states[id] !== "checking"),
    [states],
  );
  const permissionStatesMetadata = useCallback(
    (nextStates: Record<PermissionId, PermissionState>) =>
      permissionItems.reduce<Record<string, PermissionState>>((acc, item) => {
        acc[item.id] = nextStates[item.id];
        return acc;
      }, {}),
    [permissionItems],
  );
  const getPermissionTelemetryMetadata = useCallback(
    (
      id: PermissionId,
      currentStates: Record<PermissionId, PermissionState> = states,
      currentActionModes: Record<
        PermissionId,
        PermissionActionMode
      > = actionModes,
    ) => {
      const item = permissionItems.find((candidate) => candidate.id === id);
      const required = item?.required ?? REQUIRED_PERMISSIONS.includes(id);

      return {
        surface: PERMISSIONS_GATE_TELEMETRY_SURFACE,
        permission_id: id,
        state: currentStates[id],
        action_mode: currentActionModes[id],
        required,
        requirement: required ? "required" : "optional",
        permission_states: permissionStatesMetadata(currentStates),
      };
    },
    [actionModes, permissionItems, permissionStatesMetadata, states],
  );

  const refresh = useCallback(
    async (checkSource = "unknown") => {
      if (osType !== "macos") return;
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;

      setStates((prev) => {
        const next = { ...prev };
        (Object.keys(next) as PermissionId[]).forEach((key) => {
          next[key] = "checking";
        });
        return next;
      });

      try {
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
        const next = Object.fromEntries(results) as Record<
          PermissionId,
          PermissionState
        >;
        setStates(next);
        return next;
      } finally {
        refreshInFlight.current = false;
      }
    },
    [osType, permissionItems, permissionStatesMetadata],
  );

  useEffect(() => {
    let cancelled = false;
    const detectOs = async () => {
      try {
        const detected = await getOsType();
        if (!cancelled) setOsType(detected);
      } catch (error) {
        console.error("Failed to detect OS:", error);
        if (!cancelled) setOsType("unknown");
      }
    };
    void detectOs();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (osType === "macos") {
      void refresh("initial");
    } else if (osType !== "unknown") {
      setIsOpen(false);
    }
  }, [osType, refresh]);

  useEffect(() => {
    if (osType !== "macos") return;
    if (!requiredPermissionsResolved) return;
    setIsOpen(!allRequiredGranted);
  }, [osType, allRequiredGranted, requiredPermissionsResolved]);

  useEffect(() => {
    if (osType !== "macos") return;
    const handleFocus = () => {
      void refresh("focus");
    };
    const handleVisibility = () => {
      if (!document.hidden) {
        void refresh("visibility");
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [osType, refresh]);

  useEffect(() => {
    if (osType !== "macos") return;
    if (!allPermissionsResolved) return;

    if (mounted || isOpen) {
      permissionItems.forEach((item) => {
        trackAppEventOnce(
          "activation.permission_presented",
          getPermissionTelemetryMetadata(item.id),
          `${PERMISSIONS_GATE_TELEMETRY_SURFACE}:permission_present:${item.id}`,
        );
      });
    }

    const snapshotFingerprint = JSON.stringify({ states, actionModes });
    if (telemetrySnapshotRef.current === snapshotFingerprint) return;
    telemetrySnapshotRef.current = snapshotFingerprint;

    permissionItems.forEach((item) => {
      trackAppEvent(
        "activation.permission_snapshot",
        getPermissionTelemetryMetadata(item.id),
      );
    });
  }, [
    actionModes,
    allPermissionsResolved,
    getPermissionTelemetryMetadata,
    isOpen,
    mounted,
    osType,
    permissionItems,
    states,
  ]);

  const requestPermission = async (id: PermissionId) => {
    const item = permissionItems.find((candidate) => candidate.id === id);
    if (!item) return;
    const actionMode = actionModes[id];
    trackAppEvent(
      "activation.permission_click",
      getPermissionTelemetryMetadata(id),
    );

    setStates((prev) => ({ ...prev, [id]: "checking" }));
    try {
      await item.request();
    } catch (error) {
      console.error(`Failed to request ${id} permission:`, error);
    }

    // Some macOS permission prompts return immediately (before the user clicks Allow/Deny).
    // Refresh a few times so the UI reflects the user's choice without requiring manual refresh.
    const delaysMs = [200, 600, 1400];
    let granted = false;
    let finalState: PermissionState | null = null;
    let finalStates: Record<PermissionId, PermissionState> | null = null;
    for (const delayMs of delaysMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const next = await refresh("post_request_poll");
      finalState = next?.[id] ?? finalState;
      finalStates = next ?? finalStates;
      if (next?.[id] === "granted") {
        granted = true;
        break;
      }
    }

    finalStates = finalStates ?? {
      ...states,
      [id]: finalState || states[id],
    };
    const resultActionModes = granted
      ? actionModes
      : { ...actionModes, [id]: "open_settings" as const };

    if (!granted) {
      setActionModes(resultActionModes);
    }
    trackAppEvent("activation.permission_result", {
      ...getPermissionTelemetryMetadata(id, finalStates, {
        ...resultActionModes,
        [id]: actionMode,
      }),
      result_action_mode: resultActionModes[id],
      granted,
    });
  };

  const renderState = (state: PermissionState) => {
    switch (state) {
      case "granted":
        return (
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-full bg-blue-500/85" />
            {t("help.permissions.status.on")}
          </div>
        );
      case "denied":
        return (
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-full bg-zinc-400/85" />
            {t("help.permissions.status.off")}
          </div>
        );
      case "error":
        return (
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="h-2 w-2 rounded-full bg-zinc-500/85" />
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

  useEffect(() => {
    if (!isOpen) return;
    trackAppEvent("activation.permission_gate_opened", {
      all_required_granted: allRequiredGranted,
      states: permissionStatesMetadata(states),
    });
  }, [allRequiredGranted, isOpen, permissionStatesMetadata, states]);

  if (!mounted) {
    return null;
  }

  return (
    <div
      className={`fixed inset-0 z-[80] bg-black/35 transition-opacity duration-[320ms] ease-out ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <TitlebarDragRegion />
      <div className="absolute inset-0 preparing-glow pointer-events-none" />

      <div className="relative h-full w-full flex items-center justify-center px-5 pt-[var(--titlebar-height)] pb-8">
        <div
          className={`liquid-glass flex max-h-[calc(100vh-var(--titlebar-height)-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-[28px] transition-opacity duration-[320ms] ease-out will-change-[opacity] ${
            visible ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="liquid-separator border-b p-6">
            <BreezeTypeTextLogo width={188} />
            <h1 className="mt-4 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
              {t("permissionsGate.title")}
            </h1>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
              {t("permissionsGate.subtitle")}
            </p>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
            {permissionItems.map((item) => {
              const state = states[item.id];
              const Icon = item.icon;
              const isGranted = state === "granted";
              const badgeText = item.required
                ? t("permissionsGate.badges.required")
                : t("permissionsGate.badges.optional");

              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-3 rounded-2xl border border-black/5 bg-white/55 px-4 py-4 shadow-[0_6px_20px_-16px_rgb(0_0_0_/_0.3)] backdrop-blur-2xl sm:flex-row sm:items-center sm:justify-between dark:border-white/10 dark:bg-zinc-900/55"
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-xl border border-black/5 bg-white/60 dark:border-white/10 dark:bg-zinc-900/60">
                      <Icon className="h-4 w-4 text-zinc-700 dark:text-zinc-300" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          {item.title}
                        </span>
                        <span className="rounded-full border border-black/5 bg-white/60 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-400">
                          {badgeText}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                        {item.description}
                      </p>
                      <div className="mt-2">{renderState(state)}</div>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    {isGranted ? (
                      <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <CheckCircle2 className="h-4 w-4 text-blue-600 dark:text-blue-500" />
                        <span>{t("permissionsGate.actions.allowed")}</span>
                      </div>
                    ) : (
                      <Button
                        size="md"
                        variant={item.required ? "primary" : "secondary"}
                        onClick={() => void requestPermission(item.id)}
                      >
                        {actionModes[item.id] === "open_settings"
                          ? t("accessibility.openSettings")
                          : t("permissionsGate.actions.allow")}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}

            <div className="rounded-2xl border border-black/5 bg-white/55 px-4 py-3 dark:border-white/10 dark:bg-zinc-900/55">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-4 w-4 text-zinc-500 dark:text-zinc-400" />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t("permissionsGate.hint")}
                </p>
              </div>
            </div>
          </div>

          <div className="liquid-separator flex flex-col-reverse gap-3 border-t p-6 sm:flex-row sm:items-center sm:justify-between">
            <Button
              size="md"
              variant="secondary"
              onClick={() => void refresh("manual_refresh")}
            >
              {t("permissionsGate.actions.refresh")}
            </Button>

            <Button
              size="md"
              variant="primary"
              disabled={!requiredPermissionsResolved}
              onClick={() => {
                trackAppEvent("activation.permission_gate_continue_clicked", {
                  all_required_granted: allRequiredGranted,
                  states: permissionStatesMetadata(states),
                });
                setIsOpen(false);
              }}
            >
              {t("permissionsGate.actions.continue")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PermissionsGate;
