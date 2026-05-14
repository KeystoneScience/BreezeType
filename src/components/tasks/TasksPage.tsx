/* eslint-disable i18next/no-literal-string */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  CalendarDays,
  Check,
  CheckSquare2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Ellipsis,
  FileText,
  Filter,
  MapPin,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Tag,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal, MODAL_TRANSITION_MS } from "../ui/Modal";
import { Textarea } from "../ui/Textarea";
import {
  getLocalDateKey,
  parseQuickTaskInput,
  type DueWindow,
  type FocusSession,
  type HabitItem,
  type SmartTaskFilter,
  type TaskItem,
  type TaskPriority,
  type TaskRecurrence,
  useTasksStore,
} from "@/stores/tasksStore";

type BaseView = "all" | "today" | "inbox" | "upcoming" | "completed";
type PlannerView = "agenda" | "week" | "month" | "year" | "kanban" | "matrix";
type ModalKey = null | "focus" | "planner" | "habits" | "filters";

export interface TaskFocusRequest {
  id: string;
  nonce: number;
}

interface TasksPageProps {
  focusRequest?: TaskFocusRequest | null;
}

type TaskSection = {
  id: string;
  title: string;
  helper?: string;
  tasks: TaskItem[];
  defaultOpen?: boolean;
};

type CompletionPhase = "checked" | "fading";

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPLETE_HOLD_MS = 260;
const COMPLETE_FADE_MS = 260;
const DETAILS_MODAL_FADE_MS = MODAL_TRANSITION_MS;

const startOfDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const endOfDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
};

const isSameDay = (left: number, right: number): boolean => {
  return startOfDay(left) === startOfDay(right);
};

const formatDueLabel = (dueAt: number | null): string | null => {
  if (!dueAt) return null;
  const now = Date.now();
  if (isSameDay(now, dueAt)) return "Today";
  if (isSameDay(now + DAY_MS, dueAt)) return "Tomorrow";
  return new Date(dueAt).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
};

const toDateInput = (timestamp: number | null): string => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const fromDateInput = (value: string): number | null => {
  if (!value) return null;
  const parsed = new Date(`${value}T18:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
};

const taskSort = (left: TaskItem, right: TaskItem): number => {
  if (left.completed !== right.completed) return left.completed ? 1 : -1;
  if (left.dueAt !== null || right.dueAt !== null) {
    if (left.dueAt === null) return 1;
    if (right.dueAt === null) return -1;
    if (left.dueAt !== right.dueAt) return left.dueAt - right.dueAt;
  }
  if (left.priority !== right.priority) return left.priority - right.priority;
  return right.updatedAt - left.updatedAt;
};

const taskMatchesDueWindow = (
  task: TaskItem,
  dueWindow: DueWindow,
): boolean => {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  switch (dueWindow) {
    case "today":
      return (
        task.dueAt !== null &&
        task.dueAt >= todayStart &&
        task.dueAt <= todayEnd
      );
    case "week":
      return (
        task.dueAt !== null &&
        task.dueAt >= todayStart &&
        task.dueAt <= todayStart + 7 * DAY_MS
      );
    case "overdue":
      return task.dueAt !== null && task.dueAt < todayStart && !task.completed;
    case "any":
    default:
      return true;
  }
};

const getWeekStart = (source: Date): Date => {
  const date = new Date(source.getTime());
  const day = date.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + offset);
  date.setHours(0, 0, 0, 0);
  return date;
};

const getWeekDates = (source: Date): Date[] => {
  const start = getWeekStart(source);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start.getTime());
    date.setDate(start.getDate() + index);
    return date;
  });
};

const getMonthGrid = (source: Date): Date[] => {
  const year = source.getFullYear();
  const month = source.getMonth();
  const first = new Date(year, month, 1);
  const start = getWeekStart(first);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getTime());
    date.setDate(start.getDate() + index);
    return date;
  });
};

const getRecentDayKeys = (days: number): string[] => {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - index);
    return getLocalDateKey(date.getTime());
  }).reverse();
};

const habitStreak = (habit: HabitItem): number => {
  const checkins = new Set(habit.checkins);
  const cursor = new Date();
  let streak = 0;

  while (true) {
    const key = getLocalDateKey(cursor.getTime());
    if (!checkins.has(key)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
};

const haversineMeters = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number => {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earth = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return earth * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

const getCurrentPosition = (): Promise<GeolocationPosition> => {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation unavailable"));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 10_000,
      maximumAge: 90_000,
    });
  });
};

const priorityLabel = (priority: TaskPriority): string => `P${priority}`;

const priorityTone = (priority: TaskPriority): string => {
  if (priority === 1)
    return "border-black/5 bg-blue-500/12 text-blue-700 dark:border-white/10 dark:text-blue-400";
  if (priority === 2)
    return "border-black/5 bg-blue-500/10 text-blue-600 dark:border-white/10 dark:text-blue-500";
  if (priority === 3)
    return "border-black/5 bg-white/55 text-zinc-700 dark:border-white/10 dark:bg-zinc-900/55 dark:text-zinc-300";
  return "border-black/5 bg-white/45 text-zinc-500 dark:border-white/10 dark:bg-zinc-900/45 dark:text-zinc-400";
};

const recurrenceLabel = (recurrence: TaskRecurrence): string => {
  if (recurrence === "daily") return "Daily";
  if (recurrence === "weekly") return "Weekly";
  return "No repeat";
};

const tagTone = (index: number): string => {
  const tones = [
    "border-black/5 bg-white/60 text-zinc-700 dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-300",
    "border-black/5 bg-white/55 text-zinc-700 dark:border-white/10 dark:bg-zinc-900/55 dark:text-zinc-300",
    "border-black/5 bg-white/50 text-zinc-700 dark:border-white/10 dark:bg-zinc-900/50 dark:text-zinc-300",
    "border-black/5 bg-white/45 text-zinc-700 dark:border-white/10 dark:bg-zinc-900/45 dark:text-zinc-300",
  ];
  return tones[index % tones.length];
};

const normalizeTaskTag = (value: string): string => {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
};

const scoreTaskTagMatch = (tag: string, query: string): number => {
  const normalizedTag = normalizeTaskTag(tag);
  const normalizedQuery = normalizeTaskTag(query);
  if (!normalizedQuery) return 0;

  if (normalizedTag === normalizedQuery) return 4;
  if (normalizedTag.startsWith(normalizedQuery)) return 3;
  if (normalizedTag.includes(normalizedQuery)) return 2;

  const queryParts = normalizedQuery.split(/\s+/).filter(Boolean);
  if (
    queryParts.length > 0 &&
    queryParts.every((part) => normalizedTag.includes(part))
  ) {
    return 1;
  }

  return 0;
};

const TasksPage: React.FC<TasksPageProps> = ({ focusRequest = null }) => {
  const { t } = useTranslation();

  const tasks = useTasksStore((state) => state.tasks);
  const habits = useTasksStore((state) => state.habits);
  const smartFilters = useTasksStore((state) => state.smartFilters);
  const focusSessions = useTasksStore((state) => state.focusSessions);

  const addTask = useTasksStore((state) => state.addTask);
  const updateTask = useTasksStore((state) => state.updateTask);
  const deleteTask = useTasksStore((state) => state.deleteTask);
  const toggleTaskCompleted = useTasksStore(
    (state) => state.toggleTaskCompleted,
  );
  const clearCompletedTasks = useTasksStore(
    (state) => state.clearCompletedTasks,
  );

  const addSubtask = useTasksStore((state) => state.addSubtask);
  const updateSubtask = useTasksStore((state) => state.updateSubtask);
  const toggleSubtask = useTasksStore((state) => state.toggleSubtask);
  const deleteSubtask = useTasksStore((state) => state.deleteSubtask);

  const addHabit = useTasksStore((state) => state.addHabit);
  const updateHabit = useTasksStore((state) => state.updateHabit);
  const deleteHabit = useTasksStore((state) => state.deleteHabit);
  const toggleHabitCheckin = useTasksStore((state) => state.toggleHabitCheckin);

  const addSmartFilter = useTasksStore((state) => state.addSmartFilter);
  const deleteSmartFilter = useTasksStore((state) => state.deleteSmartFilter);

  const addFocusSession = useTasksStore((state) => state.addFocusSession);
  const incrementPomodoroCount = useTasksStore(
    (state) => state.incrementPomodoroCount,
  );

  const setTaskLocationReminder = useTasksStore(
    (state) => state.setTaskLocationReminder,
  );
  const markLocationReminderTriggered = useTasksStore(
    (state) => state.markLocationReminderTriggered,
  );

  const [view, setView] = useState<BaseView>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickInput, setQuickInput] = useState("");

  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [newSubtask, setNewSubtask] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [locationPanelOpen, setLocationPanelOpen] = useState(false);

  const [activeFilterId, setActiveFilterId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKey>(null);

  const [showFilterBuilder, setShowFilterBuilder] = useState(false);
  const [filterName, setFilterName] = useState("");
  const [filterTag, setFilterTag] = useState("");
  const [filterPriority, setFilterPriority] = useState<"" | TaskPriority>("");
  const [filterDueWindow, setFilterDueWindow] = useState<DueWindow>("any");
  const [filterIncludeCompleted, setFilterIncludeCompleted] = useState(false);

  const [newHabitTitle, setNewHabitTitle] = useState("");
  const [newHabitTarget, setNewHabitTarget] = useState("5");

  const [plannerView, setPlannerView] = useState<PlannerView>("agenda");
  const [calendarCursor, setCalendarCursor] = useState(new Date());

  const [timerTaskId, setTimerTaskId] = useState<string | null>(null);
  const [sessionMinutes, setSessionMinutes] = useState(25);
  const [secondsRemaining, setSecondsRemaining] = useState(25 * 60);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [noiseMode, setNoiseMode] = useState<"off" | "white">("off");

  const [locationBusy, setLocationBusy] = useState(false);
  const [locationLabelDraft, setLocationLabelDraft] = useState("");
  const [locationRadiusDraft, setLocationRadiusDraft] = useState("250");

  const [toolsOpen, setToolsOpen] = useState(false);
  const [taskMenuOpenId, setTaskMenuOpenId] = useState<string | null>(null);
  const [priorityMenuOpenId, setPriorityMenuOpenId] = useState<string | null>(
    null,
  );
  const [editingTaskTitleId, setEditingTaskTitleId] = useState<string | null>(
    null,
  );
  const [editingTaskTitleDraft, setEditingTaskTitleDraft] = useState("");
  const [editingExpandedTitle, setEditingExpandedTitle] = useState(false);
  const [editingExpandedTitleDraft, setEditingExpandedTitleDraft] =
    useState("");
  const [detailsModalVisible, setDetailsModalVisible] = useState(false);
  const [completionPhaseByTask, setCompletionPhaseByTask] = useState<
    Record<string, CompletionPhase>
  >({});
  const [subtasksJumpTaskId, setSubtasksJumpTaskId] = useState<string | null>(
    null,
  );
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const taskRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const taskTitleInputRefs = useRef<Record<string, HTMLInputElement | null>>(
    {},
  );
  const taskMenuRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const priorityMenuRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const detailsModalCloseTimerRef = useRef<number | null>(null);
  const completionTimersRef = useRef<
    Record<string, { fadeTimer: number; commitTimer: number }>
  >({});
  const subtasksSectionRef = useRef<HTMLDivElement | null>(null);
  const tagEditorRef = useRef<HTMLDivElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const expandedTitleInputRef = useRef<HTMLInputElement | null>(null);

  const whiteNoiseRef = useRef<{
    ctx: AudioContext;
    source: AudioBufferSourceNode;
    gain: GainNode;
  } | null>(null);

  const activeFilter = useMemo<SmartTaskFilter | null>(() => {
    return smartFilters.find((filter) => filter.id === activeFilterId) ?? null;
  }, [smartFilters, activeFilterId]);

  const quickPreview = useMemo(
    () => parseQuickTaskInput(quickInput),
    [quickInput],
  );

  const openTaskCount = useMemo(
    () => tasks.filter((task) => !task.completed).length,
    [tasks],
  );

  const dueTodayCount = useMemo(() => {
    const now = Date.now();
    return tasks.filter(
      (task) =>
        !task.completed && task.dueAt !== null && isSameDay(task.dueAt, now),
    ).length;
  }, [tasks]);

  const focusMinutesToday = useMemo(() => {
    const today = getLocalDateKey(Date.now());
    const totalSeconds = focusSessions
      .filter((session) => getLocalDateKey(session.startedAt) === today)
      .reduce((sum, session) => sum + session.durationSeconds, 0);
    return Math.round(totalSeconds / 60);
  }, [focusSessions]);

  const expandedTask = useMemo(
    () => tasks.find((task) => task.id === expandedTaskId) ?? null,
    [tasks, expandedTaskId],
  );
  const taskTagOptions = useMemo(() => {
    const unique = new Set<string>();
    tasks.forEach((task) => {
      task.tags.forEach((tag) => {
        const normalized = normalizeTaskTag(tag);
        if (!normalized) return;
        unique.add(normalized);
      });
    });
    return Array.from(unique).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    );
  }, [tasks]);
  const tagSuggestions = useMemo(() => {
    if (!expandedTask) return [];
    const existing = new Set(expandedTask.tags.map(normalizeTaskTag));
    const available = taskTagOptions.filter((tag) => !existing.has(tag));
    const query = tagDraft.trim();

    if (!query) return available;

    return available
      .map((tag) => ({
        tag,
        score: scoreTaskTagMatch(tag, query),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) =>
        right.score !== left.score
          ? right.score - left.score
          : left.tag.localeCompare(right.tag, undefined, {
              sensitivity: "base",
            }),
      )
      .map((entry) => entry.tag);
  }, [expandedTask, taskTagOptions, tagDraft]);

  useEffect(() => {
    if (!expandedTask) {
      setLocationLabelDraft("");
      setLocationRadiusDraft("250");
      setEditingExpandedTitleDraft("");
      setTagDraft("");
      setTagEditorOpen(false);
      setNotesOpen(false);
      setLocationPanelOpen(false);
      return;
    }
    setLocationLabelDraft(expandedTask.locationReminder?.label ?? "");
    setLocationRadiusDraft(
      `${expandedTask.locationReminder?.radiusMeters ?? 250}`,
    );
    setEditingExpandedTitleDraft(expandedTask.title);
    setTagDraft("");
    setTagEditorOpen(false);
    setNotesOpen(false);
    setLocationPanelOpen(false);
  }, [expandedTask?.id]);

  const closeExpandedTask = useCallback(() => {
    setExpandedTaskId(null);
    setEditingExpandedTitle(false);
    setEditingExpandedTitleDraft("");
    setTaskMenuOpenId(null);
    setPriorityMenuOpenId(null);
    setSubtasksJumpTaskId(null);
    setNewSubtask("");
    setTagEditorOpen(false);
    setNotesOpen(false);
    setLocationPanelOpen(false);
  }, []);

  const clearDetailsModalCloseTimer = useCallback(() => {
    if (detailsModalCloseTimerRef.current === null) return;
    window.clearTimeout(detailsModalCloseTimerRef.current);
    detailsModalCloseTimerRef.current = null;
  }, []);

  const requestCloseExpandedTask = useCallback(() => {
    if (!expandedTaskId) return;
    setDetailsModalVisible(false);
    clearDetailsModalCloseTimer();
    detailsModalCloseTimerRef.current = window.setTimeout(() => {
      closeExpandedTask();
      detailsModalCloseTimerRef.current = null;
    }, DETAILS_MODAL_FADE_MS);
  }, [expandedTaskId, clearDetailsModalCloseTimer, closeExpandedTask]);

  const clearCompletionTimers = useCallback((taskId: string) => {
    const timers = completionTimersRef.current[taskId];
    if (!timers) return;
    window.clearTimeout(timers.fadeTimer);
    window.clearTimeout(timers.commitTimer);
    delete completionTimersRef.current[taskId];
  }, []);

  const clearCompletionPhase = useCallback((taskId: string) => {
    setCompletionPhaseByTask((current) => {
      if (!(taskId in current)) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  }, []);

  const undoTaskCompletion = useCallback(
    (taskId: string) => {
      clearCompletionTimers(taskId);
      clearCompletionPhase(taskId);

      const latestTask = useTasksStore
        .getState()
        .tasks.find((entry) => entry.id === taskId);
      if (latestTask?.completed) {
        toggleTaskCompleted(taskId, false);
      }
    },
    [clearCompletionPhase, clearCompletionTimers, toggleTaskCompleted],
  );

  const startTaskCompletion = useCallback(
    (taskId: string) => {
      clearCompletionTimers(taskId);
      setCompletionPhaseByTask((current) => ({
        ...current,
        [taskId]: "checked",
      }));

      const fadeTimer = window.setTimeout(() => {
        setCompletionPhaseByTask((current) => {
          if (!(taskId in current)) return current;
          return { ...current, [taskId]: "fading" };
        });
      }, COMPLETE_HOLD_MS);

      const commitTimer = window.setTimeout(() => {
        toggleTaskCompleted(taskId, true);
        clearCompletionPhase(taskId);
        clearCompletionTimers(taskId);
      }, COMPLETE_HOLD_MS + COMPLETE_FADE_MS);

      completionTimersRef.current[taskId] = {
        fadeTimer,
        commitTimer,
      };

      toast("Task marked as complete", {
        duration: 5000,
        action: {
          label: "Undo",
          onClick: () => undoTaskCompletion(taskId),
        },
      });
    },
    [
      clearCompletionPhase,
      clearCompletionTimers,
      toggleTaskCompleted,
      undoTaskCompletion,
    ],
  );

  const handleTaskCompletionToggle = useCallback(
    (task: TaskItem) => {
      const phase = completionPhaseByTask[task.id];
      if (phase) {
        undoTaskCompletion(task.id);
        return;
      }

      if (task.completed) {
        toggleTaskCompleted(task.id, false);
        return;
      }

      startTaskCompletion(task.id);
    },
    [
      completionPhaseByTask,
      startTaskCompletion,
      toggleTaskCompleted,
      undoTaskCompletion,
    ],
  );

  const commitTaskTitleDraft = useCallback(
    (taskId: string, draft: string) => {
      updateTask(taskId, { title: draft });
    },
    [updateTask],
  );

  useEffect(() => {
    if (!expandedTaskId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (tagEditorOpen) {
        setTagEditorOpen(false);
        setTagDraft("");
        return;
      }
      requestCloseExpandedTask();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [expandedTaskId, requestCloseExpandedTask, tagEditorOpen]);

  useEffect(() => {
    if (!expandedTaskId) {
      setDetailsModalVisible(false);
      clearDetailsModalCloseTimer();
      return;
    }

    clearDetailsModalCloseTimer();
    setDetailsModalVisible(false);
    const frame = window.requestAnimationFrame(() => {
      setDetailsModalVisible(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expandedTaskId, clearDetailsModalCloseTimer]);

  useEffect(() => {
    return () => {
      clearDetailsModalCloseTimer();
    };
  }, [clearDetailsModalCloseTimer]);

  useEffect(() => {
    if (!expandedTaskId || !subtasksJumpTaskId) return;
    if (expandedTaskId !== subtasksJumpTaskId) return;

    requestAnimationFrame(() => {
      subtasksSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      setSubtasksJumpTaskId(null);
    });
  }, [expandedTaskId, subtasksJumpTaskId]);

  useEffect(() => {
    return () => {
      Object.keys(completionTimersRef.current).forEach((taskId) => {
        clearCompletionTimers(taskId);
      });
    };
  }, [clearCompletionTimers]);

  useEffect(() => {
    const overlayOpen = expandedTaskId !== null || modal !== null;
    if (!overlayOpen) return;

    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousHtmlOverscroll =
      document.documentElement.style.overscrollBehavior;

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "contain";
    document.documentElement.style.overscrollBehavior = "contain";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.documentElement.style.overscrollBehavior =
        previousHtmlOverscroll;
    };
  }, [expandedTaskId, modal]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    if (!tagEditorOpen) return;
    tagInputRef.current?.focus();
  }, [tagEditorOpen]);

  useEffect(() => {
    if (!searchOpen) return;

    const handleClickOutsideSearch = (event: MouseEvent) => {
      if (!searchContainerRef.current) return;
      if (searchContainerRef.current.contains(event.target as Node)) return;
      if (!searchQuery.trim()) {
        setSearchOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !searchQuery.trim()) {
        setSearchOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutsideSearch);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutsideSearch);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    if (!editingTaskTitleId) return;

    const frame = window.requestAnimationFrame(() => {
      const input = taskTitleInputRefs.current[editingTaskTitleId];
      if (!input) return;
      input.focus();
      input.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [editingTaskTitleId]);

  useEffect(() => {
    if (!editingTaskTitleId) return;
    const stillExists = tasks.some((task) => task.id === editingTaskTitleId);
    if (!stillExists) {
      setEditingTaskTitleId(null);
      setEditingTaskTitleDraft("");
    }
  }, [editingTaskTitleId, tasks]);

  useEffect(() => {
    if (!editingExpandedTitle) return;

    const frame = window.requestAnimationFrame(() => {
      expandedTitleInputRef.current?.focus();
      expandedTitleInputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [editingExpandedTitle]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!toolsRef.current) return;
      if (toolsRef.current.contains(event.target as Node)) return;
      setToolsOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!tagEditorOpen) return;

    const handleClickOutsideTagEditor = (event: MouseEvent) => {
      if (!tagEditorRef.current) return;
      if (tagEditorRef.current.contains(event.target as Node)) return;
      setTagEditorOpen(false);
      setTagDraft("");
    };

    document.addEventListener("mousedown", handleClickOutsideTagEditor);
    return () =>
      document.removeEventListener("mousedown", handleClickOutsideTagEditor);
  }, [tagEditorOpen]);

  useEffect(() => {
    const handleClickOutsideTaskMenu = (event: MouseEvent) => {
      if (!taskMenuOpenId) return;
      const menuRef = taskMenuRefs.current[taskMenuOpenId];
      if (!menuRef) {
        setTaskMenuOpenId(null);
        return;
      }
      if (menuRef.contains(event.target as Node)) return;
      setTaskMenuOpenId(null);
    };

    document.addEventListener("mousedown", handleClickOutsideTaskMenu);
    return () =>
      document.removeEventListener("mousedown", handleClickOutsideTaskMenu);
  }, [taskMenuOpenId]);

  useEffect(() => {
    const handleClickOutsidePriorityMenu = (event: MouseEvent) => {
      if (!priorityMenuOpenId) return;
      const menuRef = priorityMenuRefs.current[priorityMenuOpenId];
      if (!menuRef) {
        setPriorityMenuOpenId(null);
        return;
      }
      if (menuRef.contains(event.target as Node)) return;
      setPriorityMenuOpenId(null);
    };

    document.addEventListener("mousedown", handleClickOutsidePriorityMenu);
    return () =>
      document.removeEventListener("mousedown", handleClickOutsidePriorityMenu);
  }, [priorityMenuOpenId]);

  const visibleTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return tasks
      .filter((task) => {
        if (!activeFilter) return true;
        if (!activeFilter.includeCompleted && task.completed) return false;
        if (activeFilter.tag && !task.tags.includes(activeFilter.tag))
          return false;
        if (
          activeFilter.minimumPriority !== null &&
          task.priority > activeFilter.minimumPriority
        ) {
          return false;
        }
        if (!taskMatchesDueWindow(task, activeFilter.dueWindow)) return false;
        return true;
      })
      .filter((task) => {
        if (!query) return true;
        if (task.title.toLowerCase().includes(query)) return true;
        if (task.notes.toLowerCase().includes(query)) return true;
        if (task.tags.some((tag) => tag.includes(query))) return true;
        return false;
      })
      .sort(taskSort);
  }, [tasks, activeFilter, searchQuery]);

  const sections = useMemo<TaskSection[]>(() => {
    const now = Date.now();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const weekEnd = todayStart + 7 * DAY_MS;

    const open = visibleTasks.filter((task) => !task.completed);
    const completed = visibleTasks.filter((task) => task.completed);

    if (view === "completed") {
      return [
        {
          id: "completed",
          title: "Completed",
          helper: completed.length > 0 ? "" : "Nothing completed yet.",
          defaultOpen: true,
          tasks: completed
            .slice()
            .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
        },
      ];
    }

    if (view === "inbox") {
      const inbox = open.filter((task) => task.dueAt === null);
      return [
        {
          id: "inbox",
          title: "Inbox",
          helper: inbox.length > 0 ? "" : "No tasks waiting in your inbox.",
          defaultOpen: true,
          tasks: inbox,
        },
      ];
    }

    if (view === "today") {
      const overdue = open.filter(
        (task) => task.dueAt !== null && task.dueAt < todayStart,
      );
      const dueToday = open.filter(
        (task) =>
          task.dueAt !== null &&
          task.dueAt >= todayStart &&
          task.dueAt <= todayEnd,
      );
      return [
        { id: "overdue", title: "Overdue", defaultOpen: true, tasks: overdue },
        { id: "today", title: "Today", defaultOpen: true, tasks: dueToday },
        {
          id: "inbox",
          title: "Inbox",
          helper: "",
          defaultOpen: false,
          tasks: open.filter((task) => task.dueAt === null).slice(0, 6),
        },
      ].filter((section) => section.tasks.length > 0);
    }

    if (view === "upcoming") {
      const thisWeek = open.filter(
        (task) =>
          task.dueAt !== null && task.dueAt > todayEnd && task.dueAt <= weekEnd,
      );
      const later = open.filter(
        (task) => task.dueAt !== null && task.dueAt > weekEnd,
      );

      return [
        {
          id: "week",
          title: "Next 7 days",
          helper: thisWeek.length > 0 ? "" : "No tasks due this week.",
          defaultOpen: true,
          tasks: thisWeek,
        },
        {
          id: "later",
          title: "Later",
          helper: later.length > 0 ? "" : "No later tasks.",
          defaultOpen: false,
          tasks: later,
        },
      ];
    }

    const overdue = open.filter(
      (task) => task.dueAt !== null && task.dueAt < todayStart,
    );
    const dueToday = open.filter(
      (task) =>
        task.dueAt !== null &&
        task.dueAt >= todayStart &&
        task.dueAt <= todayEnd,
    );
    const upcoming = open.filter(
      (task) =>
        task.dueAt !== null && task.dueAt > todayEnd && task.dueAt <= weekEnd,
    );
    const later = open.filter(
      (task) => task.dueAt !== null && task.dueAt > weekEnd,
    );
    const inbox = open.filter((task) => task.dueAt === null);

    return [
      { id: "overdue", title: "Overdue", defaultOpen: true, tasks: overdue },
      { id: "today", title: "Today", defaultOpen: true, tasks: dueToday },
      {
        id: "upcoming",
        title: "Next 7 days",
        defaultOpen: true,
        tasks: upcoming,
      },
      { id: "inbox", title: "No date", defaultOpen: true, tasks: inbox },
      { id: "later", title: "Later", defaultOpen: false, tasks: later },
      {
        id: "completed-preview",
        title: "Completed",
        helper: completed.length > 0 ? "" : "",
        defaultOpen: false,
        tasks: completed
          .slice()
          .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
          .slice(0, 3),
      },
    ].filter((section) => section.tasks.length > 0);
  }, [visibleTasks, view]);

  const sectionsKey = useMemo(
    () => sections.map((section) => section.id).join("|"),
    [sections],
  );

  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setOpenSections((previous) => {
      const next = new Set<string>();
      const previousHasEntries = previous.size > 0;

      for (const section of sections) {
        if (previousHasEntries && previous.has(section.id)) {
          next.add(section.id);
          continue;
        }
        if (section.defaultOpen) {
          next.add(section.id);
        }
      }

      return next;
    });
  }, [sectionsKey]);

  useEffect(() => {
    if (!focusRequest) return;
    const task = tasks.find((entry) => entry.id === focusRequest.id);
    if (!task) return;

    setModal(null);
    setView("all");
    setActiveFilterId(null);
    setExpandedTaskId(task.id);
    setTaskMenuOpenId(null);
    setNewSubtask("");
    setTagEditorOpen(false);
    setNotesOpen(false);
    setLocationPanelOpen(false);

    const scrollTarget = taskRowRefs.current[task.id];
    if (!scrollTarget) return;

    window.setTimeout(() => {
      scrollTarget.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  }, [focusRequest?.nonce, focusRequest?.id, tasks]);

  const handleAddQuickTask = useCallback(() => {
    const parsed = parseQuickTaskInput(quickInput);
    if (!parsed) {
      toast.error("Enter a task title.");
      return;
    }

    addTask({
      title: parsed.title,
      dueAt: parsed.dueAt,
      priority: parsed.priority,
      tags: parsed.tags,
      important: parsed.important,
      urgent: parsed.urgent,
      recurrence: parsed.recurrence,
    });

    setQuickInput("");
    setView("all");
  }, [quickInput, addTask]);

  const duplicateTaskItem = useCallback(
    (task: TaskItem) => {
      const created = addTask({
        title: task.title,
        dueAt: task.dueAt,
        priority: task.priority,
        tags: task.tags,
        notes: task.notes,
        important: task.important,
        urgent: task.urgent,
        recurrence: task.recurrence,
        pomodoroMinutes: task.pomodoroMinutes,
        estimatePomodoros: task.estimatePomodoros,
      });

      if (task.locationReminder) {
        setTaskLocationReminder(created.id, {
          ...task.locationReminder,
          lastTriggeredAt: undefined,
        });
      }

      for (const subtask of task.subtasks) {
        addSubtask(created.id, subtask.title);
      }

      toast.success("Task duplicated.");
    },
    [addTask, addSubtask, setTaskLocationReminder],
  );

  const stopWhiteNoise = useCallback(() => {
    const current = whiteNoiseRef.current;
    if (!current) return;

    try {
      current.source.stop();
    } catch (_error) {
      // noop
    }

    void current.ctx.close();
    whiteNoiseRef.current = null;
  }, []);

  const startWhiteNoise = useCallback(async () => {
    if (whiteNoiseRef.current) return;
    if (typeof window === "undefined") return;

    const AudioContextClass =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;

    if (!AudioContextClass) return;

    const ctx = new AudioContextClass();
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const channel = buffer.getChannelData(0);

    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = Math.random() * 2 - 1;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = 0.015;

    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();

    whiteNoiseRef.current = { ctx, source, gain };
  }, []);

  const logFocusSession = useCallback(
    (payload: Omit<FocusSession, "id">) => {
      addFocusSession(payload);
      if (payload.completed && payload.taskId) {
        incrementPomodoroCount(payload.taskId);
      }
    },
    [addFocusSession, incrementPomodoroCount],
  );

  const completePomodoro = useCallback(() => {
    const endedAt = Date.now();
    const startedAt = sessionStartedAt ?? endedAt - sessionMinutes * 60_000;

    logFocusSession({
      taskId: timerTaskId,
      startedAt,
      endedAt,
      durationSeconds: Math.max(1, Math.round((endedAt - startedAt) / 1000)),
      completed: true,
    });

    setSessionStartedAt(null);
    setIsTimerRunning(false);
    setSecondsRemaining(sessionMinutes * 60);
    toast.success("Focus session complete");
  }, [sessionStartedAt, sessionMinutes, timerTaskId, logFocusSession]);

  useEffect(() => {
    if (!isTimerRunning) {
      setSessionStartedAt(null);
      setSecondsRemaining(sessionMinutes * 60);
      return;
    }

    const interval = window.setInterval(() => {
      setSecondsRemaining((previous) => {
        if (previous <= 1) {
          window.setTimeout(() => {
            completePomodoro();
          }, 0);
          return 0;
        }
        return previous - 1;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [isTimerRunning, sessionMinutes, completePomodoro]);

  useEffect(() => {
    if (isTimerRunning && noiseMode === "white") {
      void startWhiteNoise();
      return;
    }
    stopWhiteNoise();
  }, [isTimerRunning, noiseMode, startWhiteNoise, stopWhiteNoise]);

  useEffect(() => {
    return () => {
      stopWhiteNoise();
    };
  }, [stopWhiteNoise]);

  const startPauseTimer = () => {
    if (!isTimerRunning) {
      if (!sessionStartedAt) setSessionStartedAt(Date.now());
      setIsTimerRunning(true);
      return;
    }

    if (sessionStartedAt) {
      const endedAt = Date.now();
      logFocusSession({
        taskId: timerTaskId,
        startedAt: sessionStartedAt,
        endedAt,
        durationSeconds: Math.max(
          1,
          Math.round((endedAt - sessionStartedAt) / 1000),
        ),
        completed: false,
      });
    }

    setIsTimerRunning(false);
    setSessionStartedAt(null);
  };

  const resetTimer = () => {
    setIsTimerRunning(false);
    setSessionStartedAt(null);
    setSecondsRemaining(sessionMinutes * 60);
  };

  const startTimerForTask = (task: TaskItem) => {
    const minutes = task.pomodoroMinutes;
    setTimerTaskId(task.id);
    setSessionMinutes(minutes);
    setSecondsRemaining(minutes * 60);
    setSessionStartedAt(Date.now());
    setIsTimerRunning(true);
    setModal("focus");
  };

  const checkLocationReminders = useCallback(
    async (manual: boolean) => {
      const candidates = tasks.filter(
        (task) =>
          !task.completed &&
          task.locationReminder &&
          task.locationReminder.enabled,
      );

      if (manual && candidates.length === 0) {
        toast.message("No active location reminders.");
        return;
      }

      if (candidates.length === 0) return;

      if (manual) setLocationBusy(true);

      try {
        const position = await getCurrentPosition();
        const now = Date.now();
        let hitCount = 0;

        for (const task of candidates) {
          if (!task.locationReminder) continue;

          const distance = haversineMeters(
            position.coords.latitude,
            position.coords.longitude,
            task.locationReminder.latitude,
            task.locationReminder.longitude,
          );

          const cooldownPassed =
            !task.locationReminder.lastTriggeredAt ||
            now - task.locationReminder.lastTriggeredAt > 30 * 60 * 1000;

          if (
            distance <= task.locationReminder.radiusMeters &&
            cooldownPassed
          ) {
            hitCount += 1;
            markLocationReminderTriggered(task.id, now);
            toast.info(`Near ${task.locationReminder.label}: ${task.title}`);
          }
        }

        if (manual && hitCount === 0) {
          toast.message("No reminders triggered at this location.");
        }
      } catch (error) {
        if (manual) {
          const message =
            error instanceof Error ? error.message : "Location check failed.";
          toast.error(message);
        }
      } finally {
        if (manual) setLocationBusy(false);
      }
    },
    [tasks, markLocationReminderTriggered],
  );

  useEffect(() => {
    const hasActiveLocationTasks = tasks.some(
      (task) =>
        !task.completed &&
        task.locationReminder &&
        task.locationReminder.enabled,
    );

    if (!hasActiveLocationTasks) return;

    const interval = window.setInterval(() => {
      void checkLocationReminders(false);
    }, 120_000);

    return () => window.clearInterval(interval);
  }, [tasks, checkLocationReminders]);

  const saveLocationReminderForExpandedTask = async (
    enabledOverride?: boolean,
  ) => {
    if (!expandedTask) return;

    setLocationBusy(true);
    try {
      const position = await getCurrentPosition();
      const radius = Math.max(50, Number(locationRadiusDraft) || 250);
      const enabled =
        enabledOverride ?? expandedTask.locationReminder?.enabled ?? false;

      setTaskLocationReminder(expandedTask.id, {
        label: locationLabelDraft.trim() || "Task location",
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        radiusMeters: radius,
        enabled,
        lastTriggeredAt: expandedTask.locationReminder?.lastTriggeredAt,
      });

      toast.success(enabled ? "Location reminder saved." : "Location saved.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not save location reminder.";
      toast.error(message);
    } finally {
      setLocationBusy(false);
    }
  };

  const movePlannerCursor = (direction: -1 | 1) => {
    setCalendarCursor((current) => {
      const next = new Date(current.getTime());
      if (plannerView === "week") {
        next.setDate(next.getDate() + direction * 7);
      } else if (plannerView === "year") {
        next.setFullYear(next.getFullYear() + direction);
      } else {
        next.setMonth(next.getMonth() + direction);
      }
      return next;
    });
  };

  const renderTaskRow = (task: TaskItem) => {
    const dueLabel = formatDueLabel(task.dueAt);
    const expanded = expandedTaskId === task.id;
    const completedSubtasks = task.subtasks.filter(
      (sub) => sub.completed,
    ).length;
    const completionPhase = completionPhaseByTask[task.id] ?? null;
    const rowFadingOut = completionPhase === "fading";
    const displayCompleted = task.completed || completionPhase !== null;
    const taskMenuOpen = taskMenuOpenId === task.id;
    const priorityMenuOpen = priorityMenuOpenId === task.id;
    const rowActionsVisible = expanded || taskMenuOpen;
    const isOverdue =
      task.dueAt !== null && task.dueAt < startOfDay(Date.now());

    const openTaskDetails = () => {
      clearDetailsModalCloseTimer();
      setEditingTaskTitleId(null);
      setEditingTaskTitleDraft("");
      setEditingExpandedTitle(false);
      setEditingExpandedTitleDraft("");
      setExpandedTaskId(task.id);
      setTaskMenuOpenId(null);
      setPriorityMenuOpenId(null);
      setNewSubtask("");
      setTagEditorOpen(false);
      setNotesOpen(false);
      setLocationPanelOpen(false);
    };

    const toggleTaskDetails = () => {
      if (expanded) {
        requestCloseExpandedTask();
        return;
      }
      openTaskDetails();
    };

    const handleTaskRowClick = (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-prevent-row-open='true']")) return;
      if (editingTaskTitleId === task.id) return;
      if (
        target.closest("button,input,textarea,select,a,label,[role='button']")
      )
        return;
      openTaskDetails();
    };

    const commitInlineTitleEdit = () => {
      commitTaskTitleDraft(task.id, editingTaskTitleDraft);
      setEditingTaskTitleId(null);
    };

    return (
      <div
        key={task.id}
        className={`rounded-2xl transition-[max-height,opacity,transform] duration-300 ease-out ${
          priorityMenuOpen || taskMenuOpen ? "relative z-20" : ""
        } ${
          rowFadingOut
            ? "max-h-0 -translate-y-1 overflow-hidden opacity-0"
            : "max-h-[500px] overflow-visible opacity-100"
        }`}
        ref={(node) => {
          taskRowRefs.current[task.id] = node;
        }}
      >
        <div
          className={`group/taskrow flex cursor-pointer items-start gap-3 rounded-2xl px-3 py-2 transition-colors ${
            expanded ? "bg-accent/10" : "hover:bg-accent/5"
          }`}
          onClick={handleTaskRowClick}
        >
          <button
            type="button"
            onClick={() => handleTaskCompletionToggle(task)}
            className={`mt-[2px] flex h-5 w-5 items-center justify-center rounded-full border-2 ${
              displayCompleted
                ? "border-accent bg-accent text-white"
                : "border-border bg-background text-transparent hover:border-accent/40"
            }`}
            aria-label="Toggle complete"
          >
            <Check className="h-3.5 w-3.5" />
          </button>

          <div className="flex-1 text-left">
            <div className="flex items-center gap-3">
              {editingTaskTitleId === task.id ? (
                <input
                  ref={(node) => {
                    taskTitleInputRefs.current[task.id] = node;
                  }}
                  value={editingTaskTitleDraft}
                  onChange={(event) =>
                    setEditingTaskTitleDraft(event.target.value)
                  }
                  onBlur={commitInlineTitleEdit}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "Escape") {
                      event.preventDefault();
                      commitInlineTitleEdit();
                      event.currentTarget.blur();
                    }
                  }}
                  className={`min-w-0 flex-1 appearance-none [-webkit-appearance:none] rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium outline-none transition ${
                    displayCompleted ? "text-muted line-through" : "text-text"
                  } focus:border-accent/40 focus:bg-background/70`}
                  aria-label="Task title"
                />
              ) : (
                <button
                  type="button"
                  data-prevent-row-open="true"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setTaskMenuOpenId(null);
                    setPriorityMenuOpenId(null);
                    setEditingTaskTitleDraft(task.title);
                    setEditingTaskTitleId(task.id);
                  }}
                  className={`min-w-0 flex-1 rounded-md px-1 py-0.5 text-left text-sm font-medium transition ${
                    displayCompleted ? "text-muted line-through" : "text-text"
                  }`}
                  aria-label="Edit task title"
                >
                  <span className="block truncate">{task.title}</span>
                </button>
              )}

              {dueLabel && (
                <div
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${
                    isOverdue
                      ? "border-red-500/30 bg-red-500/10 text-red-600"
                      : "border-border bg-background text-muted"
                  }`}
                >
                  {dueLabel}
                </div>
              )}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <div
                className="relative"
                data-prevent-row-open="true"
                ref={(node) => {
                  priorityMenuRefs.current[task.id] = node;
                }}
              >
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setTaskMenuOpenId(null);
                    setPriorityMenuOpenId((current) =>
                      current === task.id ? null : task.id,
                    );
                  }}
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 font-semibold ${priorityTone(task.priority)}`}
                  aria-label="Set priority"
                  title="Set priority"
                >
                  {priorityLabel(task.priority)}
                </button>

                {priorityMenuOpen && (
                  <div className="absolute left-0 top-full z-30 mt-1 w-28 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
                    {([1, 2, 3, 4] as TaskPriority[]).map((priority) => (
                      <button
                        key={priority}
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          updateTask(task.id, { priority });
                          setPriorityMenuOpenId(null);
                        }}
                        className={`flex w-full items-center px-3 py-1.5 text-left text-xs ${
                          task.priority === priority
                            ? "text-accent"
                            : "text-text opacity-80 hover:opacity-100"
                        }`}
                      >
                        {priorityLabel(priority)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {task.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-border px-2 py-0.5"
                >
                  #{tag}
                </span>
              ))}
              {task.recurrence !== "none" && (
                <span className="rounded-full border border-border px-2 py-0.5">
                  {recurrenceLabel(task.recurrence)}
                </span>
              )}
              {task.subtasks.length > 0 && (
                <button
                  type="button"
                  data-prevent-row-open="true"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSubtasksJumpTaskId(task.id);
                    openTaskDetails();
                  }}
                  className="rounded-full border border-border px-2 py-0.5 text-muted opacity-80 transition-opacity hover:opacity-100"
                  aria-label="Open subtasks"
                  title="Open subtasks"
                >
                  {completedSubtasks}/{task.subtasks.length}
                </button>
              )}
            </div>
          </div>

          <div
            className="mt-[2px] flex items-center gap-0.5 self-start"
            data-prevent-row-open="true"
          >
            <button
              type="button"
              onClick={() => startTimerForTask(task)}
              className="flex h-7 w-7 items-center justify-center text-muted opacity-0 hover:opacity-100 group-hover/taskrow:opacity-75 group-focus-within/taskrow:opacity-100 focus-visible:opacity-100"
              title="Start focus"
              aria-label="Start focus"
            >
              <Play className="h-4 w-4" />
            </button>

            <div
              className="relative flex h-7 w-7 items-center justify-center"
              data-prevent-row-open="true"
              ref={(node) => {
                taskMenuRefs.current[task.id] = node;
              }}
            >
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setPriorityMenuOpenId(null);
                  setTaskMenuOpenId((current) =>
                    current === task.id ? null : task.id,
                  );
                }}
                className={`flex h-7 w-7 items-center justify-center text-muted hover:opacity-100 ${
                  rowActionsVisible
                    ? "opacity-75"
                    : "opacity-0 group-hover/taskrow:opacity-75 group-focus-within/taskrow:opacity-100 focus-visible:opacity-100"
                }`}
                aria-label="Task actions"
              >
                <Ellipsis className="h-4 w-4" />
              </button>

              {taskMenuOpen && (
                <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
                  <button
                    type="button"
                    onClick={toggleTaskDetails}
                    className="flex w-full items-center px-3 py-2 text-left text-sm text-text opacity-80 transition-opacity hover:opacity-100"
                  >
                    {expanded ? "Close details" : "Open details"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      duplicateTaskItem(task);
                      setTaskMenuOpenId(null);
                    }}
                    className="flex w-full items-center px-3 py-2 text-left text-sm text-text opacity-80 transition-opacity hover:opacity-100"
                  >
                    Duplicate task
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      deleteTask(task.id);
                      setTaskMenuOpenId(null);
                      if (expandedTaskId === task.id) {
                        closeExpandedTask();
                      }
                    }}
                    className="flex w-full items-center px-3 py-2 text-left text-sm text-red-600 opacity-80 transition-opacity hover:opacity-100"
                  >
                    Delete task
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderTaskDetailsModal = () => {
    if (!expandedTask) return null;

    const task = expandedTask;
    const isOverdue =
      task.dueAt !== null && task.dueAt < startOfDay(Date.now());
    const completedSubtasks = task.subtasks.filter(
      (sub) => sub.completed,
    ).length;

    const addSubtaskToTask = () => {
      const title = newSubtask.trim();
      if (!title) return;
      addSubtask(task.id, title);
      setNewSubtask("");
    };

    const addTagToTask = (rawTag: string = tagDraft) => {
      const normalized = normalizeTaskTag(rawTag);
      if (!normalized) return;
      const existing = new Set(task.tags.map(normalizeTaskTag));
      if (existing.has(normalized)) {
        setTagDraft("");
        return;
      }
      const canonical =
        taskTagOptions.find((tagOption) => tagOption === normalized) ??
        normalized;
      updateTask(task.id, { tags: [...task.tags, canonical] });
      setTagDraft("");
      setTagEditorOpen(false);
    };

    const commitExpandedTitleEdit = () => {
      commitTaskTitleDraft(task.id, editingExpandedTitleDraft);
      setEditingExpandedTitle(false);
    };

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <button
          type="button"
          className={`absolute inset-0 bg-black/35 transition-opacity duration-[320ms] ease-out ${
            detailsModalVisible ? "opacity-100" : "opacity-0"
          }`}
          onClick={requestCloseExpandedTask}
          aria-label="Close details"
        />
        <div
          className={`relative w-full max-w-6xl max-h-[88vh] overflow-y-auto overscroll-contain rounded-3xl border border-border bg-background shadow-xl transition-opacity duration-[320ms] ease-out will-change-[opacity] ${
            detailsModalVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="border-b border-border px-4 py-3 sm:px-6">
            {editingExpandedTitle ? (
              <input
                ref={expandedTitleInputRef}
                value={editingExpandedTitleDraft}
                onChange={(event) =>
                  setEditingExpandedTitleDraft(event.target.value)
                }
                onBlur={commitExpandedTitleEdit}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === "Escape") {
                    event.preventDefault();
                    commitExpandedTitleEdit();
                    event.currentTarget.blur();
                  }
                }}
                className="w-full appearance-none [-webkit-appearance:none] rounded-md border border-transparent bg-transparent px-1 py-0.5 text-2xl font-semibold text-text outline-none focus:border-accent/40 focus:bg-background/70"
                aria-label="Task title"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditingExpandedTitleDraft(task.title);
                  setEditingExpandedTitle(true);
                }}
                className="w-full rounded-md px-1 py-0.5 text-left text-2xl font-semibold text-text"
                aria-label="Edit task title"
              >
                <span className="block truncate">{task.title}</span>
              </button>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${priorityTone(
                  task.priority,
                )}`}
              >
                <span className="text-sm font-semibold">
                  {priorityLabel(task.priority)}
                </span>
                <select
                  value={task.priority}
                  onChange={(event) =>
                    updateTask(task.id, {
                      priority: Number(event.target.value) as TaskPriority,
                    })
                  }
                  className="bg-transparent text-sm font-medium text-text focus:outline-none"
                >
                  <option value={1}>P1</option>
                  <option value={2}>P2</option>
                  <option value={3}>P3</option>
                  <option value={4}>P4</option>
                </select>
              </label>

              <label
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                  isOverdue
                    ? "border-red-500/30 bg-red-500/10 text-red-600"
                    : "border-border bg-background text-muted"
                }`}
              >
                <CalendarDays className="h-4 w-4" />
                <input
                  type="date"
                  value={toDateInput(task.dueAt)}
                  onChange={(event) =>
                    updateTask(task.id, {
                      dueAt: fromDateInput(event.target.value),
                    })
                  }
                  className="w-[122px] border-0 bg-transparent p-0 text-sm text-text focus:outline-none"
                />
              </label>

              <label className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-sm text-muted">
                <RotateCcw className="h-4 w-4" />
                <select
                  value={task.recurrence}
                  onChange={(event) =>
                    updateTask(task.id, {
                      recurrence: event.target.value as TaskRecurrence,
                    })
                  }
                  className="bg-transparent text-sm text-text focus:outline-none"
                >
                  <option value="none">None</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
            </div>
          </div>

          <div className="px-4 py-5 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                {task.tags.map((tag, index) => (
                  <span
                    key={tag}
                    className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm ${tagTone(index)}`}
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() =>
                        updateTask(task.id, {
                          tags: task.tags.filter((entry) => entry !== tag),
                        })
                      }
                      className="rounded-full p-0.5 text-current/70 opacity-75 transition-opacity hover:opacity-100"
                      aria-label={`Remove ${tag} tag`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setNotesOpen((current) => !current)}
                  className={`p-1.5 transition-opacity ${
                    notesOpen
                      ? "text-accent opacity-100"
                      : "text-muted opacity-70 hover:opacity-100"
                  }`}
                  aria-label="Toggle notes"
                  title="Toggle notes"
                >
                  <FileText className="h-4 w-4" />
                </button>
                <div
                  className="relative"
                  ref={tagEditorRef}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (tagEditorOpen) {
                        setTagEditorOpen(false);
                        setTagDraft("");
                        return;
                      }
                      setTagEditorOpen(true);
                    }}
                    className={`p-1.5 transition-opacity ${
                      tagEditorOpen
                        ? "text-accent opacity-100"
                        : "text-muted opacity-70 hover:opacity-100"
                    }`}
                    aria-label="Add tag"
                    title="Add tag"
                  >
                    <Tag className="h-4 w-4" />
                  </button>
                  {tagEditorOpen && (
                    <div className="absolute right-0 top-full z-30 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
                      <div className="px-3 py-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted">
                          Tags
                        </div>
                        <input
                          ref={tagInputRef}
                          value={tagDraft}
                          onChange={(event) => setTagDraft(event.target.value)}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                              event.preventDefault();
                              addTagToTask();
                            } else if (event.key === "Escape") {
                              setTagEditorOpen(false);
                              setTagDraft("");
                            }
                          }}
                          placeholder="Add or search tag"
                          className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-text placeholder:text-muted focus:outline-none"
                        />
                      </div>
                      <div className="max-h-40 overflow-y-auto border-t border-border">
                        {tagSuggestions.length === 0 ? (
                          <div className="px-3 py-2 text-xs text-muted">
                            {taskTagOptions.length === 0
                              ? "No saved tags yet."
                              : tagDraft.trim()
                                ? "No matching tags."
                                : "All saved tags are already on this task."}
                          </div>
                        ) : (
                          tagSuggestions.map((suggestion) => (
                            <button
                              key={suggestion}
                              type="button"
                              onClick={() => addTagToTask(suggestion)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text transition-colors hover:bg-accent/5"
                            >
                              <Tag className="h-3.5 w-3.5 text-muted" />
                              <span className="truncate">#{suggestion}</span>
                            </button>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setLocationPanelOpen((current) => !current)}
                  className={`p-1.5 transition-opacity ${
                    locationPanelOpen || task.locationReminder
                      ? "text-accent opacity-100"
                      : "text-muted opacity-70 hover:opacity-100"
                  }`}
                  aria-label="Toggle location"
                  title="Location"
                >
                  <MapPin className="h-4 w-4" />
                </button>
              </div>
            </div>

            {notesOpen && (
              <div className="mt-4 w-full rounded-2xl border border-border bg-surface/60 p-3">
                <h3 className="text-lg font-semibold text-text">Notes</h3>
                <Textarea
                  value={task.notes}
                  onChange={(event) =>
                    updateTask(task.id, { notes: event.target.value })
                  }
                  className="mt-3 min-h-[170px] w-full rounded-2xl bg-background px-4 py-3 text-sm leading-6"
                  placeholder="Context, links, details..."
                />
              </div>
            )}

            {locationPanelOpen && (
              <div className="mt-4 w-full rounded-2xl border border-border bg-surface/60 p-3">
                <h3 className="text-lg font-semibold text-text">Location</h3>
                <div className="mt-3 grid grid-cols-[minmax(0,1fr)_82px] gap-2">
                  <Input
                    value={locationLabelDraft}
                    onChange={(event) =>
                      setLocationLabelDraft(event.target.value)
                    }
                    placeholder="Place label"
                    className="rounded-xl bg-background text-sm"
                  />
                  <Input
                    type="number"
                    min={50}
                    value={locationRadiusDraft}
                    onChange={(event) =>
                      setLocationRadiusDraft(event.target.value)
                    }
                    placeholder="250"
                    className="rounded-xl bg-background text-center text-sm"
                  />
                </div>

                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      void saveLocationReminderForExpandedTask();
                    }}
                    disabled={locationBusy}
                    className="px-2 py-1 text-sm font-semibold text-blue-500 transition hover:text-blue-600 focus:outline-none focus:underline disabled:cursor-not-allowed disabled:text-muted"
                  >
                    {locationBusy
                      ? "Saving..."
                      : task.locationReminder
                        ? "Update location"
                        : "Set location"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!task.locationReminder) {
                        void saveLocationReminderForExpandedTask(true);
                        return;
                      }
                      setTaskLocationReminder(task.id, {
                        ...task.locationReminder,
                        enabled: !task.locationReminder.enabled,
                      });
                    }}
                    disabled={locationBusy}
                    className="px-2 py-1 text-sm font-semibold text-blue-500 transition hover:text-blue-600 focus:outline-none focus:underline disabled:cursor-not-allowed disabled:text-muted"
                  >
                    {task.locationReminder?.enabled
                      ? "Disable reminder"
                      : "Enable reminder"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTaskLocationReminder(task.id, null)}
                    disabled={!task.locationReminder}
                    className="px-2 py-1 text-sm font-semibold text-blue-500 transition hover:text-blue-600 focus:outline-none focus:underline disabled:cursor-not-allowed disabled:text-muted"
                  >
                    Clear
                  </button>
                </div>

                {task.locationReminder && (
                  <div className="mt-2 text-sm text-muted">
                    {task.locationReminder.label} •{" "}
                    {Math.round(task.locationReminder.radiusMeters)}m •{" "}
                    {task.locationReminder.enabled
                      ? "Reminder on"
                      : "Saved only"}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-6 px-4 pb-5 sm:px-6">
              <div ref={subtasksSectionRef}>
                <div className="mb-3 flex items-center gap-2">
                  <h3 className="text-xl font-semibold text-text">Subtasks</h3>
                  <span className="text-base text-muted">
                    • {completedSubtasks}/{task.subtasks.length}
                  </span>
                </div>

                <div className="space-y-1">
                  {task.subtasks.map((subtask) => (
                    <div
                      key={subtask.id}
                      className="group/subtask flex items-center gap-3 rounded-lg px-1 py-1.5"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSubtask(task.id, subtask.id)}
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
                          subtask.completed
                            ? "border-accent bg-accent text-white"
                            : "border-border bg-background text-transparent hover:border-accent/40"
                        }`}
                        aria-label="Toggle subtask"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <input
                        value={subtask.title}
                        onChange={(event) =>
                          updateSubtask(task.id, subtask.id, {
                            title: event.target.value,
                          })
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        className={`min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-1 text-sm outline-none transition focus:border-accent/40 focus:bg-background/70 ${
                          subtask.completed
                            ? "text-muted line-through"
                            : "text-text"
                        }`}
                        aria-label="Subtask title"
                      />
                      <button
                        type="button"
                        onClick={() => deleteSubtask(task.id, subtask.id)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center text-muted opacity-0 hover:text-red-500 group-hover/subtask:opacity-75 group-focus-within/subtask:opacity-100 focus-visible:opacity-100"
                        aria-label="Delete subtask"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}

                  {task.subtasks.length === 0 && (
                    <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-sm text-muted">
                      No subtasks yet.
                    </div>
                  )}
                </div>

                <div className="mt-3 flex items-center gap-2 rounded-2xl border border-border bg-background p-2">
                  <Input
                    value={newSubtask}
                    onChange={(event) => setNewSubtask(event.target.value)}
                    placeholder="Add subtask"
                    variant="compact"
                    className="flex-1 border-transparent bg-transparent text-sm"
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addSubtaskToTask();
                    }}
                  />
                  <button
                    type="button"
                    onClick={addSubtaskToTask}
                    className="px-2 py-1 text-sm font-semibold text-blue-500 transition hover:text-blue-600 focus:outline-none focus:underline"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>

            <aside className="border-t border-border bg-surface/30 px-4 py-5 sm:px-6 xl:border-l xl:border-t-0">
              <div className="text-2xl font-semibold text-text">Details</div>

              <div className="mt-5 space-y-6 border-t border-border pt-5">
                <section>
                  <div className="flex items-center justify-between">
                    <div className="text-lg font-medium text-text">
                      Planning
                    </div>
                    <ChevronDown className="h-5 w-5 text-muted" />
                  </div>

                  <div className="mt-3 space-y-2 text-sm text-text">
                    <label className="flex items-center justify-between gap-3">
                      <span>Pomodoro length:</span>
                      <span className="inline-flex items-center gap-2">
                        <input
                          type="number"
                          min={5}
                          max={90}
                          value={task.pomodoroMinutes}
                          onChange={(event) => {
                            const next = Math.max(
                              5,
                              Number(event.target.value) || 25,
                            );
                            updateTask(task.id, { pomodoroMinutes: next });
                          }}
                          className="w-16 rounded-lg border border-border bg-background px-2 py-1 text-right text-base text-text focus:outline-none focus:ring-2 focus:ring-accent/20"
                        />
                        <span>min 🍅</span>
                      </span>
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span>Estimated sessions:</span>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={task.estimatePomodoros}
                        onChange={(event) => {
                          const next = Math.max(
                            1,
                            Number(event.target.value) || 1,
                          );
                          updateTask(task.id, { estimatePomodoros: next });
                        }}
                        className="w-16 rounded-lg border border-border bg-background px-2 py-1 text-right text-base text-text focus:outline-none focus:ring-2 focus:ring-accent/20"
                      />
                    </label>
                  </div>
                </section>

                <section>
                  <div className="text-lg font-medium text-text">
                    Prioritization
                  </div>
                  <div className="mt-3 flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() =>
                        updateTask(task.id, { important: !task.important })
                      }
                      className={`text-sm font-semibold transition ${
                        task.important
                          ? "text-blue-600"
                          : "text-muted hover:text-blue-600"
                      }`}
                    >
                      Important
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateTask(task.id, { urgent: !task.urgent })
                      }
                      className={`text-sm font-semibold transition ${
                        task.urgent
                          ? "text-blue-600"
                          : "text-muted hover:text-blue-600"
                      }`}
                    >
                      Urgent
                    </button>
                  </div>
                </section>
              </div>
            </aside>
          </div>
        </div>
      </div>
    );
  };

  const renderPlannerPill = (task: TaskItem) => {
    return (
      <button
        key={task.id}
        type="button"
        onClick={() => {
          setModal(null);
          setExpandedTaskId(task.id);
        }}
        className={`w-full rounded-lg border px-2 py-1 text-left text-xs transition-colors ${
          task.completed
            ? "border-border bg-border/40 text-muted line-through"
            : "border-border bg-surface text-text hover:border-accent/40"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate">{task.title}</span>
          <span className="text-[10px] text-muted">
            {priorityLabel(task.priority)}
          </span>
        </div>
      </button>
    );
  };

  const renderPlanner = () => {
    const now = Date.now();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);

    const move = (direction: -1 | 1) => {
      movePlannerCursor(direction);
    };

    const renderAgenda = () => {
      const dueTasks = tasks
        .filter((task) => task.dueAt !== null)
        .sort(taskSort);
      const grouped = new Map<string, TaskItem[]>();
      for (const task of dueTasks) {
        if (!task.dueAt) continue;
        const key = getLocalDateKey(task.dueAt);
        grouped.set(key, [...(grouped.get(key) ?? []), task]);
      }

      const rows = [...grouped.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (rows.length === 0) {
        return (
          <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted">
            No due dates yet.
          </div>
        );
      }

      return (
        <div className="space-y-3">
          {rows.map(([day, dayTasks]) => (
            <div
              key={day}
              className="rounded-2xl border border-border bg-background p-4"
            >
              <div className="text-sm font-semibold text-text">
                {new Date(`${day}T12:00:00`).toLocaleDateString([], {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })}
              </div>
              <div className="mt-2 space-y-2">
                {dayTasks.map(renderPlannerPill)}
              </div>
            </div>
          ))}
        </div>
      );
    };

    const renderWeek = () => {
      const days = getWeekDates(calendarCursor);
      return (
        <div className="rounded-2xl border border-border bg-background p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-7">
            {days.map((day) => {
              const dayTasks = tasks
                .filter(
                  (task) =>
                    task.dueAt !== null && isSameDay(task.dueAt, day.getTime()),
                )
                .sort(taskSort);
              return (
                <div
                  key={day.toISOString()}
                  className="min-h-[140px] rounded-xl border border-border/70 bg-surface p-2"
                >
                  <div className="text-xs font-semibold text-text">
                    {day.toLocaleDateString([], {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </div>
                  <div className="mt-2 space-y-1">
                    {dayTasks.map(renderPlannerPill)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    };

    const renderMonth = () => {
      const days = getMonthGrid(calendarCursor);
      const month = calendarCursor.getMonth();
      return (
        <div className="rounded-2xl border border-border bg-background p-4">
          <div className="grid grid-cols-7 gap-2 text-center text-xs font-semibold text-muted">
            {"Mon Tue Wed Thu Fri Sat Sun".split(" ").map((label) => (
              <div key={label}>{label}</div>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-7 gap-2">
            {days.map((day) => {
              const inMonth = day.getMonth() === month;
              const dayTasks = tasks
                .filter(
                  (task) =>
                    task.dueAt !== null && isSameDay(task.dueAt, day.getTime()),
                )
                .sort(taskSort);
              const isToday = isSameDay(day.getTime(), now);

              return (
                <div
                  key={day.toISOString()}
                  className={`min-h-[88px] rounded-lg border p-2 ${
                    inMonth
                      ? "border-border bg-surface"
                      : "border-border/50 bg-border/10 text-muted"
                  } ${isToday ? "ring-1 ring-accent/40" : ""}`}
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <span>{day.getDate()}</span>
                    {dayTasks.length > 0 && (
                      <span className="text-muted">{dayTasks.length}</span>
                    )}
                  </div>
                  <div className="mt-1 space-y-1">
                    {dayTasks.slice(0, 2).map((task) => (
                      <div
                        key={task.id}
                        className="truncate rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-text"
                      >
                        {task.title}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    };

    const renderYear = () => {
      const year = calendarCursor.getFullYear();
      const months = Array.from({ length: 12 }, (_, monthIndex) => {
        const count = tasks.filter((task) => {
          if (!task.dueAt) return false;
          const due = new Date(task.dueAt);
          return due.getFullYear() === year && due.getMonth() === monthIndex;
        }).length;
        return { monthIndex, count };
      });

      return (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {months.map(({ monthIndex, count }) => (
            <div
              key={monthIndex}
              className="rounded-2xl border border-border bg-background p-4"
            >
              <div className="text-sm font-semibold text-text">
                {new Date(year, monthIndex, 1).toLocaleDateString([], {
                  month: "long",
                })}
              </div>
              <div className="mt-1 text-sm text-muted">{count} due</div>
            </div>
          ))}
        </div>
      );
    };

    const renderKanban = () => {
      const columns = [
        {
          id: "overdue",
          label: "Overdue",
          items: tasks
            .filter(
              (task) =>
                !task.completed &&
                task.dueAt !== null &&
                task.dueAt < todayStart,
            )
            .sort(taskSort),
        },
        {
          id: "today",
          label: "Today",
          items: tasks
            .filter(
              (task) =>
                !task.completed &&
                task.dueAt !== null &&
                task.dueAt >= todayStart &&
                task.dueAt <= todayEnd,
            )
            .sort(taskSort),
        },
        {
          id: "upcoming",
          label: "Upcoming",
          items: tasks
            .filter(
              (task) =>
                !task.completed && task.dueAt !== null && task.dueAt > todayEnd,
            )
            .sort(taskSort),
        },
        {
          id: "done",
          label: "Done",
          items: tasks.filter((task) => task.completed).sort(taskSort),
        },
      ];

      return (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
          {columns.map((column) => (
            <div
              key={column.id}
              className="rounded-2xl border border-border bg-background p-3"
            >
              <div className="text-sm font-semibold text-text">
                {column.label}{" "}
                <span className="text-muted">({column.items.length})</span>
              </div>
              <div className="mt-2 space-y-2">
                {column.items.map(renderPlannerPill)}
                {column.items.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border px-2 py-2 text-xs text-muted">
                    No tasks
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      );
    };

    const renderMatrix = () => {
      const open = tasks.filter((task) => !task.completed);
      const quadrants = [
        {
          id: "do",
          title: "Do first",
          items: open.filter((task) => task.important && task.urgent),
        },
        {
          id: "schedule",
          title: "Schedule",
          items: open.filter((task) => task.important && !task.urgent),
        },
        {
          id: "delegate",
          title: "Delegate",
          items: open.filter((task) => !task.important && task.urgent),
        },
        {
          id: "reduce",
          title: "Reduce",
          items: open.filter((task) => !task.important && !task.urgent),
        },
      ];

      return (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {quadrants.map((quad) => (
            <div
              key={quad.id}
              className="rounded-2xl border border-border bg-background p-4"
            >
              <div className="text-sm font-semibold text-text">
                {quad.title}
              </div>
              <div className="mt-2 space-y-2">
                {quad.items.map(renderPlannerPill)}
                {quad.items.length === 0 && (
                  <div className="text-xs text-muted">No tasks</div>
                )}
              </div>
            </div>
          ))}
        </div>
      );
    };

    const plannerChoices: { id: PlannerView; label: string }[] = [
      { id: "agenda", label: "Agenda" },
      { id: "week", label: "Week" },
      { id: "month", label: "Month" },
      { id: "year", label: "Year" },
      { id: "kanban", label: "Kanban" },
      { id: "matrix", label: "Matrix" },
    ];

    return (
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {plannerChoices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                onClick={() => setPlannerView(choice.id)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  plannerView === choice.id
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-border bg-surface text-muted hover:border-accent/40"
                }`}
              >
                {choice.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => move(-1)}
              className="rounded-lg border border-border bg-surface p-1 text-muted hover:border-accent/40 hover:text-text"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="min-w-[170px] text-center text-xs font-medium text-text">
              {plannerView === "year"
                ? calendarCursor.getFullYear()
                : calendarCursor.toLocaleDateString([], {
                    month: "long",
                    year: "numeric",
                  })}
            </div>
            <button
              type="button"
              onClick={() => move(1)}
              className="rounded-lg border border-border bg-surface p-1 text-muted hover:border-accent/40 hover:text-text"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {plannerView === "agenda" && renderAgenda()}
        {plannerView === "week" && renderWeek()}
        {plannerView === "month" && renderMonth()}
        {plannerView === "year" && renderYear()}
        {plannerView === "kanban" && renderKanban()}
        {plannerView === "matrix" && renderMatrix()}
      </div>
    );
  };

  const renderHabits = () => {
    const recentDays = getRecentDayKeys(7);

    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-background p-4">
          <div className="text-sm font-semibold text-text">New habit</div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Input
              value={newHabitTitle}
              onChange={(event) => setNewHabitTitle(event.target.value)}
              placeholder="Habit name"
              className="flex-1"
            />
            <Input
              type="number"
              min={1}
              max={7}
              value={newHabitTarget}
              onChange={(event) => setNewHabitTarget(event.target.value)}
              className="w-full sm:w-24"
            />
            <Button
              onClick={() => {
                const title = newHabitTitle.trim();
                if (!title) return;
                addHabit(title, "check", Number(newHabitTarget) || 5);
                setNewHabitTitle("");
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              Add
            </Button>
          </div>
        </div>

        <div className="space-y-3">
          {habits.map((habit) => {
            const streak = habitStreak(habit);
            const weekHits = recentDays.filter((day) =>
              habit.checkins.includes(day),
            ).length;

            return (
              <div
                key={habit.id}
                className="rounded-2xl border border-border bg-background p-4"
              >
                <div className="flex items-center gap-2">
                  <Input
                    value={habit.title}
                    onChange={(event) =>
                      updateHabit(habit.id, { title: event.target.value })
                    }
                    className="flex-1 text-sm font-semibold"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted hover:text-red-500"
                    onClick={() => deleteHabit(habit.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="mt-2 text-xs text-muted">
                  Streak {streak}d • {weekHits}/{habit.targetPerWeek} this week
                </div>

                <div className="mt-3 grid grid-cols-7 gap-2">
                  {recentDays.map((day) => {
                    const checked = habit.checkins.includes(day);
                    const date = new Date(`${day}T12:00:00`);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleHabitCheckin(habit.id, day)}
                        className={`rounded-lg border px-1 py-2 text-center text-xs ${
                          checked
                            ? "border-accent/60 bg-accent/10 text-accent"
                            : "border-border bg-surface text-muted hover:border-accent/40"
                        }`}
                      >
                        <div className="text-[10px] uppercase">
                          {date.toLocaleDateString([], { weekday: "short" })}
                        </div>
                        <div>{date.getDate()}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {habits.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted">
              No habits yet.
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderFilters = () => {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => {
              setActiveFilterId(null);
              setModal(null);
            }}
            className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${
              activeFilterId === null
                ? "border-accent/50 bg-accent/10 text-accent"
                : "border-border bg-background text-text hover:border-accent/40"
            }`}
          >
            No filter
          </button>

          {smartFilters.map((filter) => (
            <div key={filter.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setActiveFilterId(filter.id);
                  setModal(null);
                }}
                className={`flex-1 rounded-xl border px-3 py-2 text-left text-sm ${
                  activeFilterId === filter.id
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-border bg-background text-text hover:border-accent/40"
                }`}
              >
                <div className="font-medium">{filter.name}</div>
                <div className="mt-1 text-xs text-muted">
                  {filter.tag ? `#${filter.tag}` : "Any tag"} •{" "}
                  {filter.minimumPriority
                    ? `P${filter.minimumPriority}+`
                    : "Any priority"}{" "}
                  • {filter.dueWindow === "any" ? "Any due" : filter.dueWindow}
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (activeFilterId === filter.id) setActiveFilterId(null);
                  deleteSmartFilter(filter.id);
                }}
                className="rounded-lg border border-border bg-background p-2 text-muted hover:border-red-500/40 hover:text-red-500"
                aria-label="Delete filter"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-border bg-background p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-text">Create filter</div>
            <button
              type="button"
              onClick={() => setShowFilterBuilder((value) => !value)}
              className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-muted hover:border-accent/40 hover:text-text"
            >
              {showFilterBuilder ? "Hide" : "Show"}
            </button>
          </div>

          {showFilterBuilder && (
            <div className="mt-3 space-y-2">
              <Input
                value={filterName}
                onChange={(event) => setFilterName(event.target.value)}
                placeholder="Filter name"
              />
              <Input
                value={filterTag}
                onChange={(event) => setFilterTag(event.target.value)}
                placeholder="Tag (optional)"
              />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <select
                  value={filterPriority}
                  onChange={(event) => {
                    setFilterPriority(
                      event.target.value
                        ? (Number(event.target.value) as TaskPriority)
                        : "",
                    );
                  }}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
                >
                  <option value="">Any priority</option>
                  <option value={1}>P1 and up</option>
                  <option value={2}>P2 and up</option>
                  <option value={3}>P3 and up</option>
                  <option value={4}>P4 and up</option>
                </select>
                <select
                  value={filterDueWindow}
                  onChange={(event) =>
                    setFilterDueWindow(event.target.value as DueWindow)
                  }
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
                >
                  <option value="any">Any due</option>
                  <option value="today">Due today</option>
                  <option value="week">Due this week</option>
                  <option value="overdue">Overdue</option>
                </select>
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-muted">
                <button
                  type="button"
                  onClick={() =>
                    setFilterIncludeCompleted((current) => !current)
                  }
                  className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                    filterIncludeCompleted
                      ? "border-accent bg-accent text-white"
                      : "border-border bg-background text-transparent hover:border-accent/40"
                  }`}
                  aria-label="Include completed"
                >
                  <Check className="h-3 w-3" />
                </button>
                Include completed
              </label>
              <Button
                variant="secondary"
                onClick={() => {
                  const name = filterName.trim();
                  if (!name) return;

                  addSmartFilter({
                    name,
                    tag: filterTag.trim() || null,
                    minimumPriority: filterPriority || null,
                    dueWindow: filterDueWindow,
                    includeCompleted: filterIncludeCompleted,
                  });

                  setFilterName("");
                  setFilterTag("");
                  setFilterPriority("");
                  setFilterDueWindow("any");
                  setFilterIncludeCompleted(false);
                  setShowFilterBuilder(false);
                }}
              >
                Save filter
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const recentSessions = useMemo(
    () => focusSessions.slice(0, 6),
    [focusSessions],
  );

  const renderFocus = () => {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-background p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-text">Pomodoro</div>
              <div className="mt-0.5 text-xs text-muted">
                Attach to a task if you want stats.
              </div>
            </div>
            <div className="text-xs text-muted">
              {Math.round(secondsRemaining / 60)}m
            </div>
          </div>

          <div className="mt-5 text-center">
            <div className="text-5xl font-semibold tabular-nums text-text">
              {`${Math.floor(secondsRemaining / 60)
                .toString()
                .padStart(
                  2,
                  "0",
                )}:${(secondsRemaining % 60).toString().padStart(2, "0")}`}
            </div>
            <div className="mt-2 text-sm text-muted">
              {timerTaskId
                ? (tasks.find((task) => task.id === timerTaskId)?.title ??
                  "Task removed")
                : "No task"}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2">
            {[15, 25, 50].map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => setSessionMinutes(minutes)}
                className={`rounded-lg border px-2 py-1.5 text-xs ${
                  sessionMinutes === minutes
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-border text-muted hover:border-accent/40"
                }`}
              >
                {minutes}m
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button className="flex-1 justify-center" onClick={startPauseTimer}>
              {isTimerRunning ? (
                <>
                  <Pause className="mr-1 h-4 w-4" />
                  Pause
                </>
              ) : (
                <>
                  <Play className="mr-1 h-4 w-4" />
                  Start
                </>
              )}
            </Button>
            <Button variant="secondary" onClick={resetTimer}>
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-muted">
              Task
              <select
                value={timerTaskId ?? ""}
                onChange={(event) => setTimerTaskId(event.target.value || null)}
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
              >
                <option value="">None</option>
                {tasks
                  .filter((task) => !task.completed)
                  .sort(taskSort)
                  .map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
              </select>
            </label>

            <label className="text-xs text-muted">
              Sound
              <select
                value={noiseMode}
                onChange={(event) =>
                  setNoiseMode(event.target.value as "off" | "white")
                }
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text"
              >
                <option value="off">Off</option>
                <option value="white">White noise</option>
              </select>
            </label>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-background p-4">
          <div className="text-sm font-semibold text-text">Recent sessions</div>
          <div className="mt-2 space-y-2">
            {recentSessions.map((session) => (
              <div
                key={session.id}
                className="rounded-xl border border-border bg-surface px-3 py-2 text-xs"
              >
                <div className="font-medium text-text">
                  {session.taskId
                    ? (tasks.find((task) => task.id === session.taskId)
                        ?.title ?? "Task removed")
                    : "No task"}
                </div>
                <div className="mt-0.5 text-muted">
                  {Math.round(session.durationSeconds / 60)} min •{" "}
                  {session.completed ? "completed" : "paused"}
                </div>
              </div>
            ))}
            {recentSessions.length === 0 && (
              <div className="text-xs text-muted">No sessions yet.</div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const viewChoices: { id: BaseView; label: string }[] = [
    { id: "all", label: "All" },
    { id: "today", label: "Today" },
    { id: "inbox", label: "Inbox" },
    { id: "upcoming", label: "Upcoming" },
    { id: "completed", label: "Done" },
  ];

  return (
    <div className="mx-auto w-full max-w-[980px]">
      <section className="w-full px-4 py-6">
        <div>
          <h1 className="app-display">
            {t("tasksPage.title", { defaultValue: "Tasks" })}
          </h1>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Open {openTaskCount} | Today {dueTodayCount} | Focus{" "}
            {focusMinutesToday}m
          </p>
        </div>
        <div className="liquid-glass liquid-separator mt-6 rounded-3xl border px-5 pb-5 pt-4">
          <div className="mt-1 flex flex-col gap-2 sm:flex-row">
            <Input
              value={quickInput}
              onChange={(event) => setQuickInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                handleAddQuickTask();
              }}
              placeholder="Add a task..."
              className="flex-1"
            />
            <button
              type="button"
              onClick={handleAddQuickTask}
              aria-label="Add task"
              className="tasks-icon-button h-11 w-11"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            {quickPreview ? (
              <span>
                {quickPreview.dueAt
                  ? `${formatDueLabel(quickPreview.dueAt) ?? ""} | `
                  : ""}
                {priorityLabel(quickPreview.priority)}
                {quickPreview.tags.length > 0
                  ? ` | ${quickPreview.tags.map((tag) => `#${tag}`).join(" ")}`
                  : ""}
                {quickPreview.recurrence !== "none"
                  ? ` | ${quickPreview.recurrence}`
                  : ""}
              </span>
            ) : null}
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {viewChoices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  onClick={() => setView(choice.id)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                    view === choice.id
                      ? "border-accent/50 bg-accent/10 text-accent"
                      : "border-border bg-background text-muted hover:border-accent/40 hover:text-text"
                  }`}
                >
                  {choice.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 self-end sm:self-auto">
              <div className="relative" ref={toolsRef}>
                <button
                  type="button"
                  onClick={() => setToolsOpen((value) => !value)}
                  className={`tasks-icon-button h-9 w-9 transition-opacity ${
                    toolsOpen ? "opacity-100" : "opacity-75"
                  }`}
                  aria-label="Tools"
                  title="Tools"
                >
                  <Wrench className="h-3.5 w-3.5" />
                </button>

                {toolsOpen && (
                  <div className="liquid-glass absolute right-0 top-full z-40 mt-2 w-56 overflow-hidden rounded-2xl">
                    <button
                      type="button"
                      onClick={() => {
                        setModal("focus");
                        setToolsOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text opacity-80 transition-opacity hover:opacity-100"
                    >
                      <Clock3 className="h-4 w-4 text-muted" />
                      Focus timer
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setModal("planner");
                        setToolsOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text opacity-80 transition-opacity hover:opacity-100"
                    >
                      <CalendarDays className="h-4 w-4 text-muted" />
                      Planner
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setModal("habits");
                        setToolsOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text opacity-80 transition-opacity hover:opacity-100"
                    >
                      <CheckSquare2 className="h-4 w-4 text-muted" />
                      Habits
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setModal("filters");
                        setToolsOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text opacity-80 transition-opacity hover:opacity-100"
                    >
                      <Filter className="h-4 w-4 text-muted" />
                      Smart filters
                    </button>

                    <div className="h-px bg-border" />

                    <button
                      type="button"
                      onClick={() => {
                        void checkLocationReminders(true);
                        setToolsOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text opacity-80 transition-opacity hover:opacity-100"
                      disabled={locationBusy}
                    >
                      <MapPin className="h-4 w-4 text-muted" />
                      {locationBusy
                        ? "Checking location..."
                        : "Check location reminders"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        clearCompletedTasks();
                        setToolsOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text opacity-80 transition-opacity hover:opacity-100"
                    >
                      <Trash2 className="h-4 w-4 text-muted" />
                      Clear completed
                    </button>
                  </div>
                )}
              </div>

              <div
                ref={searchContainerRef}
                className={`relative flex h-7 items-center gap-2 rounded-full border border-transparent transition-[width,padding,background-color,border-color] duration-200 ease-out motion-reduce:transition-none ${
                  searchOpen
                    ? "w-56 border-border bg-border/60 px-2"
                    : "w-7 bg-transparent px-1"
                }`}
              >
                <button
                  type="button"
                  className="tasks-mini-icon-button"
                  onClick={() => {
                    if (searchOpen) {
                      setSearchOpen(false);
                      setSearchQuery("");
                    } else {
                      setSearchOpen(true);
                    }
                  }}
                  aria-label="Search tasks"
                  title="Search tasks"
                >
                  <Search className="h-3.5 w-3.5" />
                </button>

                {searchOpen && (
                  <input
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search tasks"
                    className="flex-1 bg-transparent pr-6 text-xs text-text placeholder:text-muted focus:outline-none"
                  />
                )}

                {searchOpen && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchOpen(false);
                      setSearchQuery("");
                    }}
                    className="tasks-mini-icon-button absolute right-2"
                    aria-label="Close search"
                    title="Close search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="px-2 py-3">
          {sections.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border bg-background px-4 py-12 text-center text-sm text-muted">
              No tasks yet. Add one above.
            </div>
          )}

          <div className="space-y-2">
            {sections.map((section) => (
              <details
                key={section.id}
                open={openSections.has(section.id)}
                onToggle={(event) => {
                  const element = event.currentTarget;
                  setOpenSections((previous) => {
                    const next = new Set(previous);
                    if (element.open) {
                      next.add(section.id);
                    } else {
                      next.delete(section.id);
                    }
                    return next;
                  });
                }}
                className="group rounded-2xl"
              >
                <summary className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted hover:bg-accent/5 [&::-webkit-details-marker]:hidden">
                  <span className="inline-flex items-center gap-2">
                    <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                    {section.title}
                  </span>
                  <span className="text-xs text-muted">
                    {section.tasks.length}
                  </span>
                </summary>

                <div className="mt-1 space-y-1 px-1 pb-2">
                  {section.tasks.map(renderTaskRow)}

                  {section.helper && section.tasks.length === 0 && (
                    <div className="px-3 py-6 text-sm text-muted">
                      {section.helper}
                    </div>
                  )}

                  {section.id === "completed-preview" && (
                    <div className="px-3 pt-2">
                      <button
                        type="button"
                        onClick={() => setView("completed")}
                        className="text-xs font-semibold text-accent hover:underline"
                      >
                        View all completed
                      </button>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {renderTaskDetailsModal()}

      <Modal
        title="Focus"
        open={modal === "focus"}
        width="sm"
        onClose={() => setModal(null)}
      >
        {renderFocus()}
      </Modal>

      <Modal
        title="Planner"
        open={modal === "planner"}
        width="lg"
        onClose={() => setModal(null)}
      >
        {renderPlanner()}
      </Modal>

      <Modal
        title="Habits"
        open={modal === "habits"}
        width="lg"
        onClose={() => setModal(null)}
      >
        {renderHabits()}
      </Modal>

      <Modal
        title="Smart Filters"
        open={modal === "filters"}
        width="md"
        onClose={() => setModal(null)}
      >
        {renderFilters()}
      </Modal>
    </div>
  );
};

export default TasksPage;
