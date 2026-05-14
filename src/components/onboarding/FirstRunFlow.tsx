/* eslint-disable i18next/no-literal-string */
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
  ArrowLeft,
  Check,
  Keyboard,
  LoaderCircle,
  Mail,
  Mic,
  Monitor,
  RefreshCcw,
  Shield,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import { useSettings } from "@/hooks/useSettings";
import { trackAppEvent, trackAppEventOnce } from "@/lib/telemetry";
import BreezeTypeTextLogo from "../icons/BreezeTypeTextLogo";
import HelpTutorialPlayer, {
  type HelpTutorialLabels,
  type HelpTutorialShortcuts,
  type HelpTutorialStep,
} from "../help/TutorialPlayer";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { MODAL_TRANSITION_MS } from "../ui/Modal";
import Onboarding from "./Onboarding";

type FirstRunStage =
  | "permissions"
  | "signin"
  | "setup"
  | "tutorial"
  | "checking"
  | "done";
type BrowserProvider = "apple" | "google";
type PermissionState = "checking" | "granted" | "denied" | "error";
type PermissionActionMode = "request" | "open_settings";
type PermissionId =
  | "microphone"
  | "accessibility"
  | "input_monitoring"
  | "screen_recording";

interface PermissionItem {
  id: PermissionId;
  icon: LucideIcon;
  title: string;
  description: string;
  check: () => Promise<boolean>;
  request: () => Promise<unknown>;
}

interface FirstRunFlowProps {
  authInitialized: boolean;
  signedIn: boolean;
  modelReady: boolean | null;
  tutorialComplete: boolean;
  onModelReady: () => void;
  onTutorialComplete: () => void;
  onComplete: () => void;
}

const PERMISSION_ITEMS: PermissionItem[] = [
  {
    id: "microphone",
    icon: Mic,
    title: "Microphone",
    description: "Dictation and meeting recordings need to hear you clearly.",
    check: checkMicrophonePermission,
    request: requestMicrophonePermission,
  },
  {
    id: "accessibility",
    icon: Shield,
    title: "Accessibility",
    description:
      "BreezeType needs this to place dictated text where you are working.",
    check: checkAccessibilityPermission,
    request: requestAccessibilityPermission,
  },
  {
    id: "input_monitoring",
    icon: Keyboard,
    title: "Input Monitoring",
    description:
      "Shortcuts and the clipboard popup stay responsive across apps.",
    check: checkInputMonitoringPermission,
    request: requestInputMonitoringPermission,
  },
  {
    id: "screen_recording",
    icon: Monitor,
    title: "Screen Recording",
    description: "Record system audio for meetings and enhanced dictation.",
    check: checkScreenRecordingPermission,
    request: requestScreenRecordingPermission,
  },
];

const emptyPermissionStates = (): Record<PermissionId, PermissionState> => ({
  microphone: "checking",
  accessibility: "checking",
  input_monitoring: "checking",
  screen_recording: "checking",
});

const permissionStatesMetadata = (
  states: Record<PermissionId, PermissionState>,
) =>
  PERMISSION_ITEMS.reduce<Record<string, PermissionState>>((acc, item) => {
    acc[item.id] = states[item.id];
    return acc;
  }, {});

const firstRunPermissionTelemetryMetadata = (
  id: PermissionId,
  states: Record<PermissionId, PermissionState>,
  actionModes: Record<PermissionId, PermissionActionMode>,
) => ({
  surface: "first_run",
  permission_id: id,
  state: states[id],
  action_mode: actionModes[id],
  required: true,
  requirement: "required",
  permission_states: permissionStatesMetadata(states),
});

const firstRunSurfaceClass =
  "relative h-full w-full overflow-hidden bg-[#eef3f8] text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50";

const panelClass =
  "mx-auto flex w-full max-w-[760px] flex-col rounded-[32px] bg-white/78 p-6 shadow-[0_28px_90px_-58px_rgb(15_23_42_/_0.55)] backdrop-blur-3xl dark:bg-zinc-900/80 dark:shadow-[0_28px_90px_-58px_rgb(0_0_0_/_0.75)]";

const optionButtonClass =
  "relative flex min-h-12 w-full items-center justify-center rounded-3xl bg-white/72 px-5 py-3 text-sm font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_rgb(15_23_42_/_0.04),0_12px_28px_-24px_rgb(15_23_42_/_0.55)] transition-all duration-200 ease-out hover:bg-blue-500/10 focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_rgba(59,130,246,0.5),0_0_0_5px_rgba(59,130,246,0.16)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-950/62 dark:text-zinc-50 dark:hover:bg-blue-500/10";

const optionIconClass =
  "absolute left-4 flex h-6 w-6 items-center justify-center text-zinc-500 dark:text-zinc-400";

const validateEmail = (value: string) =>
  String(value)
    .toLowerCase()
    .match(
      /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
    );

const validatePassword = (value: string) => {
  if (!value.trim()) {
    return "Password cannot be empty.";
  }

  if (value.length > 128) {
    return "Password must be 128 characters or fewer.";
  }

  return null;
};

const AppleIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
    <path d="M15.11 3.17c0 1.14-.42 2.18-1.12 2.96-.77.87-2.02 1.53-3.1 1.44-.14-1.11.44-2.28 1.12-3.03.76-.83 2.08-1.48 3.1-1.37ZM19.17 17.06c-.43.99-.63 1.43-1.18 2.27-.77 1.17-1.87 2.63-3.24 2.64-1.21.01-1.52-.79-3.16-.78-1.64.01-1.98.79-3.19.78-1.37-.01-2.41-1.33-3.19-2.5-2.18-3.28-2.41-7.13-1.07-9.19.95-1.46 2.46-2.32 3.88-2.32 1.45 0 2.36.79 3.55.79 1.16 0 1.86-.8 3.54-.8 1.27 0 2.62.69 3.57 1.89-3.14 1.72-2.63 6.16.49 7.22Z" />
  </svg>
);

const GoogleIcon: React.FC = () => (
  <svg
    viewBox="-2 -2 28 28"
    aria-hidden="true"
    className="block h-[18px] w-[18px] shrink-0 overflow-visible"
  >
    <path
      fill="#4285F4"
      d="M23.49 12.27c0-.79-.07-1.55-.21-2.27H12v4.3h6.44a5.5 5.5 0 0 1-2.39 3.61v2.99h3.87c2.27-2.09 3.57-5.18 3.57-8.63Z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.87-2.99c-1.07.72-2.44 1.15-4.08 1.15-3.14 0-5.8-2.12-6.75-4.96H1.25v3.08A12 12 0 0 0 12 24Z"
    />
    <path
      fill="#FBBC05"
      d="M5.25 14.3A7.2 7.2 0 0 1 4.88 12c0-.8.14-1.57.37-2.3V6.62H1.25A12 12 0 0 0 0 12c0 1.94.46 3.78 1.25 5.38l4-3.08Z"
    />
    <path
      fill="#EA4335"
      d="M12 4.77c1.76 0 3.35.61 4.6 1.82l3.45-3.45C17.95 1.15 15.24 0 12 0A12 12 0 0 0 1.25 6.62l4 3.08C6.2 6.89 8.86 4.77 12 4.77Z"
    />
  </svg>
);

const FlowShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className={firstRunSurfaceClass}>
    <div className="pointer-events-none absolute inset-0 preparing-glow opacity-70" />
    <div className="relative flex h-full min-h-0 flex-col px-6 pb-8 pt-[calc(var(--titlebar-height)+2rem)]">
      {children}
    </div>
  </div>
);

const AuthOptionButton: React.FC<{
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}> = ({ label, icon, disabled, onClick }) => (
  <button
    type="button"
    className={optionButtonClass}
    disabled={disabled}
    onClick={onClick}
  >
    <span className={optionIconClass}>{icon}</span>
    <span>{label}</span>
  </button>
);

const useMacPermissions = () => {
  const [osType, setOsType] = useState<string>("unknown");
  const [states, setStates] = useState<Record<PermissionId, PermissionState>>(
    emptyPermissionStates,
  );
  const [actionModes, setActionModes] = useState<
    Record<PermissionId, PermissionActionMode>
  >({
    microphone: "request",
    accessibility: "request",
    input_monitoring: "open_settings",
    screen_recording: "request",
  });
  const refreshInFlight = useRef(false);
  const previousSnapshotRef = useRef<string | null>(null);

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

  const refresh = useCallback(
    async (checkSource = "unknown") => {
      if (osType === "unknown") return null;
      if (osType !== "macos") return emptyPermissionStates();
      if (refreshInFlight.current) return null;
      refreshInFlight.current = true;

      setStates((current) => {
        const next = { ...current };
        PERMISSION_ITEMS.forEach((item) => {
          next[item.id] = "checking";
        });
        return next;
      });

      try {
        const results = await Promise.all(
          PERMISSION_ITEMS.map(async (item) => {
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
    [osType],
  );

  useEffect(() => {
    if (osType !== "unknown") {
      void refresh("initial");
    }
  }, [osType, refresh]);

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
    if (PERMISSION_ITEMS.some((item) => states[item.id] === "checking")) {
      return;
    }

    const snapshot = JSON.stringify({ states, actionModes });
    if (previousSnapshotRef.current === snapshot) return;
    previousSnapshotRef.current = snapshot;

    PERMISSION_ITEMS.forEach((item) => {
      trackAppEvent(
        "activation.permission_snapshot",
        firstRunPermissionTelemetryMetadata(item.id, states, actionModes),
      );
    });
  }, [actionModes, osType, states]);

  const requestPermission = useCallback(
    async (id: PermissionId) => {
      const item = PERMISSION_ITEMS.find((candidate) => candidate.id === id);
      if (!item) return;

      const actionMode = actionModes[id];
      trackAppEvent(
        "activation.permission_click",
        firstRunPermissionTelemetryMetadata(id, states, actionModes),
      );

      setStates((current) => ({ ...current, [id]: "checking" }));
      try {
        await item.request();
      } catch (error) {
        console.error(`Failed to request ${id} permission:`, error);
      }

      const delaysMs = [240, 700, 1500];
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
        ...firstRunPermissionTelemetryMetadata(id, finalStates, {
          ...resultActionModes,
          [id]: actionMode,
        }),
        result_action_mode: resultActionModes[id],
        granted,
      });
    },
    [actionModes, refresh, states],
  );

  const resolved =
    osType !== "unknown" &&
    (osType !== "macos" ||
      PERMISSION_ITEMS.every((item) => states[item.id] !== "checking"));
  const allGranted =
    osType !== "unknown" &&
    (osType !== "macos" ||
      PERMISSION_ITEMS.every((item) => states[item.id] === "granted"));

  return {
    states,
    actionModes,
    resolved,
    allGranted,
    refresh,
    requestPermission,
  };
};

const PermissionStatus: React.FC<{ state: PermissionState }> = ({ state }) => {
  if (state === "checking") {
    return (
      <span className="inline-flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        Checking
      </span>
    );
  }

  if (state === "granted") {
    return (
      <span className="inline-flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-blue-600 text-white dark:bg-blue-500">
          <Check className="h-3 w-3" />
        </span>
        Allowed
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
      <span className="h-2 w-2 rounded-full bg-zinc-400" />
      Needs access
    </span>
  );
};

const PermissionsStep: React.FC<{
  states: Record<PermissionId, PermissionState>;
  actionModes: Record<PermissionId, PermissionActionMode>;
  resolved: boolean;
  onRefresh: () => void;
  onRequest: (id: PermissionId) => void;
}> = ({ states, actionModes, resolved, onRefresh, onRequest }) => {
  useEffect(() => {
    if (!resolved) return;

    PERMISSION_ITEMS.forEach((item) => {
      trackAppEventOnce(
        "activation.permission_presented",
        firstRunPermissionTelemetryMetadata(item.id, states, actionModes),
        `first_run:permission_present:${item.id}`,
      );
    });
  }, [actionModes, resolved, states]);

  return (
    <FlowShell>
      <div className="shrink-0">
        <BreezeTypeTextLogo width={214} className="opacity-95" />
      </div>

      <div className="flex min-h-0 flex-1 items-center">
        <div className={panelClass}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[13px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                First setup
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
                Give BreezeType access.
              </h1>
              <p className="mt-2 max-w-[36rem] text-[15px] leading-6 text-zinc-500 dark:text-zinc-400">
                These macOS permissions let the app listen, type, use shortcuts,
                and record meetings without adding a bot to your calls.
              </p>
            </div>
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-zinc-950 px-4 text-sm font-semibold text-white transition-all duration-200 ease-out hover:bg-zinc-800 active:scale-[0.98] dark:bg-white dark:text-zinc-950"
            >
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </button>
          </div>

          <div className="mt-6 grid gap-3">
            {PERMISSION_ITEMS.map((item) => {
              const Icon = item.icon;
              const state = states[item.id];
              const granted = state === "granted";
              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-4 rounded-[24px] bg-zinc-50/82 px-4 py-4 shadow-[inset_0_0_0_1px_rgb(15_23_42_/_0.04)] sm:flex-row sm:items-center sm:justify-between dark:bg-zinc-950/54"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white text-zinc-700 shadow-[inset_0_0_0_1px_rgb(15_23_42_/_0.04)] dark:bg-zinc-900 dark:text-zinc-200">
                      <Icon className="h-4.5 w-4.5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
                          {item.title}
                        </h2>
                        <PermissionStatus state={state} />
                      </div>
                      <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
                        {item.description}
                      </p>
                    </div>
                  </div>

                  {granted ? null : (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="shrink-0 rounded-2xl bg-white/72 px-4 py-2 dark:bg-zinc-900/72"
                      disabled={!resolved && state === "checking"}
                      onClick={() => onRequest(item.id)}
                    >
                      {actionModes[item.id] === "open_settings"
                        ? "Open Settings"
                        : "Allow"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </FlowShell>
  );
};

const SignInStep: React.FC = () => {
  const {
    login,
    loginWithBrowser,
    cancelBrowserLogin,
    isLoading,
    browserAuthProvider,
    error,
    clearError,
  } = useAuthStore();
  const [screen, setScreen] = useState<"options" | "email">("options");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const activeError = localError || error;

  useEffect(() => {
    clearError();
    return () => {
      clearError();
    };
  }, [clearError]);

  const handleBrowserSignIn = async (provider: BrowserProvider) => {
    setLocalError(null);
    clearError();
    await loginWithBrowser(provider);
  };

  const handleEmailLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);

    if (!validateEmail(email.trim())) {
      setLocalError("Enter a valid email address.");
      return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      setLocalError(passwordError);
      return;
    }

    const result = await login(email.trim(), password);
    if (result.ok) {
      setPassword("");
    }
  };

  return (
    <FlowShell>
      <div className="shrink-0">
        <BreezeTypeTextLogo width={214} className="opacity-95" />
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="w-full max-w-[460px] rounded-[32px] bg-white/78 p-6 shadow-[0_28px_90px_-58px_rgb(15_23_42_/_0.55)] backdrop-blur-3xl dark:bg-zinc-900/80">
          {screen === "email" ? (
            <form onSubmit={handleEmailLogin} className="space-y-5">
              <button
                type="button"
                onClick={() => {
                  setLocalError(null);
                  clearError();
                  setScreen("options");
                }}
                disabled={isLoading}
                className="inline-flex min-h-10 items-center gap-2 rounded-2xl px-2 text-sm font-semibold text-blue-600 transition-colors hover:bg-blue-500/10 focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_rgba(59,130,246,0.5),0_0_0_4px_rgba(59,130,246,0.16)] dark:text-blue-500"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
              <div>
                <p className="text-[13px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                  Sign in
                </p>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
                  Continue with email.
                </h1>
                <p className="mt-2 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
                  Use the same BreezeType account you use on the web.
                </p>
              </div>

              <div className="space-y-2.5">
                <Input
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={isLoading}
                />
                <Input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={isLoading}
                />
              </div>

              <div className="min-h-[1.25rem] text-sm text-red-500">
                {activeError || null}
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                {isLoading ? "Signing in..." : "Continue"}
              </Button>
            </form>
          ) : (
            <div className="space-y-5">
              <div className="text-center">
                <h1 className="text-2xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
                  Sign in
                </h1>
              </div>

              <div className="space-y-2.5">
                <AuthOptionButton
                  label="Apple"
                  icon={<AppleIcon />}
                  disabled={isLoading}
                  onClick={() => void handleBrowserSignIn("apple")}
                />
                <AuthOptionButton
                  label="Google"
                  icon={<GoogleIcon />}
                  disabled={isLoading}
                  onClick={() => void handleBrowserSignIn("google")}
                />
                <AuthOptionButton
                  label="Email"
                  icon={<Mail className="h-5 w-5" />}
                  disabled={isLoading}
                  onClick={() => {
                    setLocalError(null);
                    clearError();
                    setScreen("email");
                  }}
                />
              </div>

              <div className="min-h-[1.25rem] text-center text-sm text-red-500">
                {activeError || null}
              </div>

              {browserAuthProvider ? (
                <div className="space-y-2 text-center">
                  <div className="flex items-center justify-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    Finish sign-in in the BreezeType window.
                  </div>
                  <button
                    type="button"
                    className="text-xs font-semibold text-zinc-500 transition-opacity hover:opacity-70 dark:text-zinc-400"
                    onClick={() => {
                      void cancelBrowserLogin();
                    }}
                  >
                    Cancel sign-in
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </FlowShell>
  );
};

const CheckingStep: React.FC = () => (
  <FlowShell>
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-3 rounded-3xl bg-white/78 px-5 py-4 text-sm font-semibold text-zinc-500 shadow-[0_18px_60px_-46px_rgb(15_23_42_/_0.65)] backdrop-blur-3xl dark:bg-zinc-900/80 dark:text-zinc-400">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        Checking BreezeType setup
      </div>
    </div>
  </FlowShell>
);

const FirstRunFlow: React.FC<FirstRunFlowProps> = ({
  authInitialized,
  signedIn,
  modelReady,
  tutorialComplete,
  onModelReady,
  onTutorialComplete,
  onComplete,
}) => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const permissions = useMacPermissions();
  const [renderedStage, setRenderedStage] = useState<FirstRunStage>("checking");
  const [visible, setVisible] = useState(false);
  const transitionTimerRef = useRef<number | null>(null);
  const completeTimerRef = useRef<number | null>(null);

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

  const activeStage: FirstRunStage = (() => {
    if (!permissions.allGranted) return "permissions";
    if (!authInitialized) return "checking";
    if (!signedIn) return "signin";
    if (modelReady === false) return "setup";
    if (modelReady === null) return "checking";
    if (!tutorialComplete) return "tutorial";
    return "done";
  })();

  useEffect(() => {
    return () => {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
      }
      if (completeTimerRef.current !== null) {
        window.clearTimeout(completeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (activeStage === "done") {
      setVisible(false);
      if (completeTimerRef.current !== null) {
        window.clearTimeout(completeTimerRef.current);
      }
      completeTimerRef.current = window.setTimeout(
        onComplete,
        MODAL_TRANSITION_MS,
      );
      return;
    }

    if (completeTimerRef.current !== null) {
      window.clearTimeout(completeTimerRef.current);
      completeTimerRef.current = null;
    }

    if (renderedStage === activeStage) {
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }

    setVisible(false);
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
    transitionTimerRef.current = window.setTimeout(() => {
      setRenderedStage(activeStage);
      window.requestAnimationFrame(() => setVisible(true));
    }, MODAL_TRANSITION_MS);
  }, [activeStage, onComplete, renderedStage]);

  useEffect(() => {
    if (!visible) return;

    trackAppEventOnce(
      "activation.first_run_stage_viewed",
      {
        surface: "first_run",
        stage: renderedStage,
        permission_states: permissionStatesMetadata(permissions.states),
      },
      `first_run:stage_viewed:${renderedStage}`,
    );
  }, [permissions.states, renderedStage, visible]);

  const handleTutorialClose = () => {
    trackAppEvent("activation.first_run_tutorial_completed");
    onTutorialComplete();
  };

  const content = (() => {
    if (renderedStage === "permissions") {
      return (
        <PermissionsStep
          states={permissions.states}
          actionModes={permissions.actionModes}
          resolved={permissions.resolved}
          onRefresh={() => void permissions.refresh("manual_refresh")}
          onRequest={(id) => void permissions.requestPermission(id)}
        />
      );
    }

    if (renderedStage === "signin") {
      return <SignInStep />;
    }

    if (renderedStage === "setup") {
      return (
        <FlowShell>
          <Onboarding onModelSelected={onModelReady} />
        </FlowShell>
      );
    }

    if (renderedStage === "tutorial") {
      return (
        <div className={firstRunSurfaceClass}>
          <HelpTutorialPlayer
            steps={tutorialSteps}
            labels={tutorialLabels}
            shortcuts={tutorialShortcuts}
            onClose={handleTutorialClose}
          />
        </div>
      );
    }

    return <CheckingStep />;
  })();

  return (
    <div
      className={`h-full w-full transition-[opacity,transform,filter] ease-out will-change-[opacity,transform,filter] motion-reduce:transition-none ${
        visible
          ? "pointer-events-auto translate-y-0 scale-100 opacity-100 blur-0"
          : "pointer-events-none translate-y-1 scale-[0.992] opacity-0 blur-[2px]"
      }`}
      style={{ transitionDuration: `${MODAL_TRANSITION_MS}ms` }}
    >
      {content}
    </div>
  );
};

export default FirstRunFlow;
