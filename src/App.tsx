import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands } from "@/bindings";
import { getServerUrl } from "@/lib/serverApi";
import {
  flushTelemetry,
  setTelemetryAuthToken,
  trackAppEvent,
  trackAppEventOnce,
} from "@/lib/telemetry";
import FirstRunFlow from "./components/onboarding/FirstRunFlow";
import { Sidebar, SidebarSection } from "./components/Sidebar";
import Home from "./components/home/Home";
import HistoryPage from "./components/history/HistoryPage";
import ClipboardHistoryPage from "./components/clipboard/ClipboardHistoryPage";
import TasksPage from "./components/tasks/TasksPage";
import HelpPage from "./components/help/HelpPage";
import { SettingsPage } from "./components/settings/SettingsPage";
import { SettingsErrorBoundary } from "./components/settings/SettingsErrorBoundary";
import UpdateChecker from "./components/update-checker";
import MeetingsPage, {
  type MeetingFocusRequest,
} from "./components/meetings/MeetingsPage";
import { useSettings } from "./hooks/useSettings";
import ProfileMenu from "./components/ProfileMenu";
import { useAuthStore } from "./stores/authStore";
import PermissionsGate from "./components/permissions/PermissionsGate";
import type { TaskFocusRequest } from "./components/tasks/TasksPage";
import { useTasksStore } from "./stores/tasksStore";

type QuickTaskCreateEvent = {
  title: string;
  due_at?: number | null;
  priority?: number | null;
  tags?: string[];
  notes?: string | null;
  important?: boolean | null;
  urgent?: boolean | null;
  recurrence?: "none" | "daily" | "weekly" | null;
};

const FIRST_RUN_TUTORIAL_COMPLETE_KEY =
  "breezetype-first-run-tutorial-complete-v1";

const REQUIRE_FIRST_RUN_AUTH =
  import.meta.env.VITE_BREEZE_REQUIRE_FIRST_RUN_AUTH === "true";

const getStoredFirstRunTutorialComplete = () => {
  if (typeof window === "undefined") return false;
  return (
    window.localStorage.getItem(FIRST_RUN_TUTORIAL_COMPLETE_KEY) === "true"
  );
};

const TitlebarDragRegion: React.FC = () => {
  const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1) {
      return;
    }
    void getCurrentWindow().startDragging();
  };

  return (
    <div
      className="fixed top-0 left-0 right-0 h-[var(--titlebar-height)] z-50 bg-transparent"
      data-tauri-drag-region
      onMouseDown={handleMouseDown}
    />
  );
};

function App() {
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [firstRunTutorialComplete, setFirstRunTutorialComplete] = useState(
    getStoredFirstRunTutorialComplete,
  );
  const [firstRunFlowDismissed, setFirstRunFlowDismissed] = useState(false);
  const [currentSection, setCurrentSection] = useState<SidebarSection>("home");
  const [historyDictionaryOpenRequest, setHistoryDictionaryOpenRequest] =
    useState(0);
  const [meetingFocusRequest, setMeetingFocusRequest] =
    useState<MeetingFocusRequest | null>(null);
  const [taskFocusRequest, setTaskFocusRequest] =
    useState<TaskFocusRequest | null>(null);
  const { settings, updateSetting } = useSettings();
  const initializeAuth = useAuthStore((state) => state.initialize);
  const authToken = useAuthStore((state) => state.token);
  const authUserId = useAuthStore((state) => state.user?.user_id);

  const handleSectionChange = (section: SidebarSection) => {
    setCurrentSection(section);
    if (section !== "history") {
      setHistoryDictionaryOpenRequest(0);
    }
    if (section !== "meetings") {
      setMeetingFocusRequest(null);
    }
    if (section !== "tasks") {
      setTaskFocusRequest(null);
    }
  };

  const handleOpenDictionaryInHistory = () => {
    handleSectionChange("history");
    setHistoryDictionaryOpenRequest((current) => current + 1);
  };

  useEffect(() => {
    trackAppEvent("activation.app_launched");
    trackAppEventOnce("activation.app_first_launched");
    void flushTelemetry();
  }, []);

  useEffect(() => {
    setTelemetryAuthToken(authToken);
  }, [authToken]);

  useEffect(() => {
    void checkOnboardingStatus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      await initializeAuth();
      if (!cancelled) {
        setAuthInitialized(true);
      }
    };

    void initialize();
    return () => {
      cancelled = true;
    };
  }, [initializeAuth]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== "breeze-tasks-v1") return;
      void useTasksStore.persist.rehydrate();
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    let timeoutId: number | undefined;

    const syncTasksSnapshot = async () => {
      const { tasks, habits, smartFilters, focusSessions } =
        useTasksStore.getState();

      try {
        await invoke("sync_tasks_snapshot", {
          snapshot: JSON.stringify({
            schemaVersion: 1,
            updatedAt: Date.now(),
            tasks,
            habits,
            smartFilters,
            focusSessions,
          }),
        });
      } catch (error) {
        console.error("Failed to sync tasks snapshot:", error);
      }
    };

    const scheduleSync = () => {
      if (typeof timeoutId === "number") {
        window.clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(() => {
        void syncTasksSnapshot();
      }, 150);
    };

    scheduleSync();
    const unsubscribe = useTasksStore.subscribe(() => {
      scheduleSync();
    });

    return () => {
      if (typeof timeoutId === "number") {
        window.clearTimeout(timeoutId);
      }
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authToken || !authUserId) return;
    let cancelled = false;

    const syncNow = async () => {
      if (cancelled) return;
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        return;
      }
      try {
        const historyResult = await commands.syncWithServer(
          getServerUrl(),
          authToken,
          authUserId,
        );
        if (historyResult.status !== "ok") {
          console.warn("History sync failed:", historyResult.error);
          trackAppEventOnce("activation.first_sync_failed", {
            sync_scope: "history",
          });
          return;
        }

        await invoke("sync_meetings_with_server", {
          serverUrl: getServerUrl(),
          authToken,
          userId: authUserId,
        });
        trackAppEventOnce("activation.first_sync_succeeded");
      } catch (error) {
        console.warn("Sync error:", error);
        trackAppEventOnce("activation.first_sync_failed", {
          sync_scope: "sync",
        });
      }
    };

    void syncNow();
    const handleOnline = () => {
      void syncNow();
    };
    window.addEventListener("online", handleOnline);
    const intervalId = window.setInterval(syncNow, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.removeEventListener("online", handleOnline);
      window.clearInterval(intervalId);
    };
  }, [authToken, authUserId]);

  useEffect(() => {
    const unlisten = listen<string>("navigate-to", (event) => {
      const next = event.payload;
      if (!next) return;
      if (next === "dictionary") {
        handleOpenDictionaryInHistory();
        return;
      }
      const sections: SidebarSection[] = [
        "home",
        "history",
        "clipboard",
        "tasks",
        "meetings",
        "settings",
        "help",
      ];
      if (sections.includes(next as SidebarSection)) {
        handleSectionChange(next as SidebarSection);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<QuickTaskCreateEvent>(
      "quick-task-create",
      (event) => {
        const payload = event.payload;
        const title = payload?.title?.trim() ?? "";
        if (!title) return;

        useTasksStore.getState().addTask({
          title,
          dueAt:
            typeof payload?.due_at === "number" &&
            Number.isFinite(payload.due_at)
              ? payload.due_at
              : null,
          priority:
            payload?.priority === 1 ||
            payload?.priority === 2 ||
            payload?.priority === 3 ||
            payload?.priority === 4
              ? payload.priority
              : 3,
          tags: Array.isArray(payload?.tags) ? payload.tags : [],
          notes: payload?.notes?.trim() ?? "",
          important: Boolean(payload?.important),
          urgent: Boolean(payload?.urgent),
          recurrence:
            payload?.recurrence === "daily" || payload?.recurrence === "weekly"
              ? payload.recurrence
              : "none",
        });
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const historyUnlisten = listen("history-updated", () => {
      trackAppEventOnce("activation.first_dictation_created");
    });

    const meetingStartedUnlisten = listen("meeting-recording-started", () => {
      trackAppEventOnce("activation.first_meeting_started");
    });

    const meetingStoppedUnlisten = listen("meeting-recording-stopped", () => {
      trackAppEventOnce("activation.first_meeting_stopped");
    });

    return () => {
      historyUnlisten.then((fn) => fn());
      meetingStartedUnlisten.then((fn) => fn());
      meetingStoppedUnlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ message?: string }>(
      "meeting-permission-notice",
      (event) => {
        const message = event.payload?.message;
        if (!message) return;
        toast.error(message);
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const selectedTheme = settings?.app_theme ?? "system";

    const applyTheme = () => {
      const resolvedTheme =
        selectedTheme === "system"
          ? mediaQuery.matches
            ? "dark"
            : "light"
          : selectedTheme;
      document.documentElement.setAttribute("data-theme", resolvedTheme);
    };

    applyTheme();

    if (selectedTheme !== "system") {
      return;
    }

    const handleThemeChange = () => {
      applyTheme();
    };

    mediaQuery.addEventListener("change", handleThemeChange);
    return () => {
      mediaQuery.removeEventListener("change", handleThemeChange);
    };
  }, [settings?.app_theme]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isDebugShortcut =
        event.shiftKey &&
        event.key.toLowerCase() === "d" &&
        (event.ctrlKey || event.metaKey);

      if (isDebugShortcut) {
        event.preventDefault();
        const currentDebugMode = settings?.debug_mode ?? false;
        updateSetting("debug_mode", !currentDebugMode);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settings?.debug_mode, updateSetting]);

  const checkOnboardingStatus = async () => {
    try {
      const result = await commands.hasAnyModelsAvailable();
      if (result.status === "ok") {
        setModelReady(result.data);
      } else {
        setModelReady(false);
      }
    } catch (error) {
      console.error("Failed to check onboarding status:", error);
      setModelReady(false);
    }
  };

  const handleModelSelected = () => {
    setModelReady(true);
  };

  const handleFirstRunTutorialComplete = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(FIRST_RUN_TUTORIAL_COMPLETE_KEY, "true");
    }
    setFirstRunTutorialComplete(true);
  };

  const renderSection = () => {
    switch (currentSection) {
      case "home":
        return <Home onNavigate={handleSectionChange} />;
      case "history":
        return (
          <HistoryPage openDictionaryRequest={historyDictionaryOpenRequest} />
        );
      case "clipboard":
        return <ClipboardHistoryPage />;
      case "tasks":
        return <TasksPage focusRequest={taskFocusRequest} />;
      case "meetings":
        return <MeetingsPage focusRequest={meetingFocusRequest} />;
      case "settings":
        return (
          <SettingsErrorBoundary onExit={() => setCurrentSection("home")}>
            <SettingsPage />
          </SettingsErrorBoundary>
        );
      case "help":
        return <HelpPage />;
      default:
        return <Home onNavigate={handleSectionChange} />;
    }
  };

  const signedIn = Boolean(authToken);
  const firstRunAuthInitialized = REQUIRE_FIRST_RUN_AUTH
    ? authInitialized
    : true;
  const firstRunAuthReady = !REQUIRE_FIRST_RUN_AUTH || signedIn;
  const firstRunRequirementsMet =
    firstRunAuthInitialized &&
    firstRunAuthReady &&
    modelReady === true &&
    firstRunTutorialComplete;
  const shouldShowFirstRunFlow =
    !firstRunRequirementsMet || !firstRunFlowDismissed;

  useEffect(() => {
    if (!firstRunRequirementsMet) {
      setFirstRunFlowDismissed(false);
    }
  }, [firstRunRequirementsMet]);

  if (shouldShowFirstRunFlow) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-background text-text">
        <UpdateChecker showUi={false} autoInstallOnIdle={true} />
        <TitlebarDragRegion />
        <Toaster />
        <FirstRunFlow
          authInitialized={firstRunAuthInitialized}
          signedIn={firstRunAuthReady}
          modelReady={modelReady}
          tutorialComplete={firstRunTutorialComplete}
          onModelReady={handleModelSelected}
          onTutorialComplete={handleFirstRunTutorialComplete}
          onComplete={() => {
            trackAppEventOnce("activation.first_run_completed");
            setFirstRunFlowDismissed(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-background text-text">
      <TitlebarDragRegion />
      <Toaster />
      <ProfileMenu />
      <div className="flex h-full min-h-0 overflow-hidden">
        <Sidebar
          activeSection={currentSection}
          onSectionChange={handleSectionChange}
        />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden pt-[var(--titlebar-height)]">
          <div
            className="flex-1 overflow-y-auto overscroll-contain"
            data-scroll-container
          >
            <div className="flex flex-col items-center gap-8 px-6 pb-8 pt-4">
              {renderSection()}
            </div>
          </div>
        </div>
      </div>
      <PermissionsGate />
    </div>
  );
}

export default App;
