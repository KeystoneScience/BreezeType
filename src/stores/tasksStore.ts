import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TaskPriority = 1 | 2 | 3 | 4;
export type TaskRecurrence = "none" | "daily" | "weekly";

export interface TaskSubtask {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TaskLocationReminder {
  label: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  enabled: boolean;
  lastTriggeredAt?: number;
}

export interface TaskItem {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  dueAt: number | null;
  priority: TaskPriority;
  tags: string[];
  notes: string;
  subtasks: TaskSubtask[];
  important: boolean;
  urgent: boolean;
  recurrence: TaskRecurrence;
  pomodoroMinutes: number;
  pomodoroSessions: number;
  estimatePomodoros: number;
  locationReminder: TaskLocationReminder | null;
}

export interface HabitItem {
  id: string;
  title: string;
  icon: string;
  createdAt: number;
  targetPerWeek: number;
  checkins: string[];
}

export type DueWindow = "any" | "today" | "week" | "overdue";

export interface SmartTaskFilter {
  id: string;
  name: string;
  tag: string | null;
  minimumPriority: TaskPriority | null;
  dueWindow: DueWindow;
  includeCompleted: boolean;
}

export interface FocusSession {
  id: string;
  taskId: string | null;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  completed: boolean;
}

export interface CreateTaskInput {
  title: string;
  dueAt?: number | null;
  priority?: TaskPriority;
  tags?: string[];
  notes?: string;
  important?: boolean;
  urgent?: boolean;
  recurrence?: TaskRecurrence;
  pomodoroMinutes?: number;
  estimatePomodoros?: number;
}

export interface ParsedQuickTask {
  title: string;
  dueAt: number | null;
  priority: TaskPriority;
  tags: string[];
  important: boolean;
  urgent: boolean;
  recurrence: TaskRecurrence;
}

interface TasksStoreState {
  tasks: TaskItem[];
  habits: HabitItem[];
  smartFilters: SmartTaskFilter[];
  focusSessions: FocusSession[];

  addTask: (input: CreateTaskInput) => TaskItem;
  updateTask: (id: string, updates: Partial<TaskItem>) => void;
  deleteTask: (id: string) => void;
  toggleTaskCompleted: (id: string, completed?: boolean) => void;
  clearCompletedTasks: () => void;

  addSubtask: (taskId: string, title: string) => void;
  updateSubtask: (
    taskId: string,
    subtaskId: string,
    updates: Partial<TaskSubtask>,
  ) => void;
  toggleSubtask: (taskId: string, subtaskId: string) => void;
  deleteSubtask: (taskId: string, subtaskId: string) => void;

  addHabit: (title: string, icon?: string, targetPerWeek?: number) => HabitItem;
  updateHabit: (id: string, updates: Partial<HabitItem>) => void;
  deleteHabit: (id: string) => void;
  toggleHabitCheckin: (id: string, dayKey?: string) => void;

  addSmartFilter: (input: Omit<SmartTaskFilter, "id">) => SmartTaskFilter;
  deleteSmartFilter: (id: string) => void;

  addFocusSession: (session: Omit<FocusSession, "id">) => FocusSession;
  incrementPomodoroCount: (taskId: string) => void;

  setTaskLocationReminder: (
    taskId: string,
    reminder: TaskLocationReminder | null,
  ) => void;
  markLocationReminderTriggered: (taskId: string, timestamp: number) => void;
}

const DEFAULT_POMODORO_MINUTES = 25;
const DEFAULT_PRIORITY: TaskPriority = 3;
const DEFAULT_ESTIMATE = 1;
const DEFAULT_HABIT_ICON = "check";

const createId = (): string => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
};

const normalizeStoredTag = (value: string): string => {
  return value
    .trim()
    .replace(/^#+/, "")
    .replace(/^[.,!?;:()[\]{}-]+|[.,!?;:()[\]{}-]+$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
};

const dedupeStrings = (value: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of value) {
    const normalized = normalizeStoredTag(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }

  return output;
};

const TASK_HASHTAG_PATTERN =
  /(^|[\s([{,;:-]+)#([a-z0-9][a-z0-9_-]*)(?:[.,!?;:)\]}]+)?(?=$|[\s)\]},.!?;:-])/gi;

const cleanParsedTaskTitle = (value: string): string => {
  return value
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/(^|[\s([{])[,;:]+(?=\s|$)/g, "$1")
    .replace(/^[,;:-]+\s*/g, "")
    .replace(/\s*[,;:-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

export const extractTaskTitleTags = (
  input: string,
): { title: string; tags: string[] } => {
  const tags: string[] = [];
  const titleWithTagsRemoved = input.replace(
    TASK_HASHTAG_PATTERN,
    (_match, prefix: string, tag: string) => {
      tags.push(tag);
      return prefix && /\s/.test(prefix) ? " " : "";
    },
  );

  return {
    title:
      tags.length > 0
        ? cleanParsedTaskTitle(titleWithTagsRemoved)
        : input.trim(),
    tags: dedupeStrings(tags),
  };
};

const localDateKeyFromDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const getLocalDateKey = (timestamp: number): string => {
  return localDateKeyFromDate(new Date(timestamp));
};

const nextDueAtForRecurrence = (
  recurrence: TaskRecurrence,
  sourceDueAt: number | null,
): number => {
  const source = sourceDueAt ? new Date(sourceDueAt) : new Date();
  const next = new Date(source.getTime());
  if (recurrence === "daily") {
    next.setDate(next.getDate() + 1);
  } else if (recurrence === "weekly") {
    next.setDate(next.getDate() + 7);
  }
  return next.getTime();
};

const createTask = (input: CreateTaskInput): TaskItem => {
  const now = Date.now();
  const parsedTitle = extractTaskTitleTags(input.title);
  const title = parsedTitle.title || input.title.trim();
  return {
    id: createId(),
    title,
    completed: false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    dueAt: input.dueAt ?? null,
    priority: input.priority ?? DEFAULT_PRIORITY,
    tags: dedupeStrings([...(input.tags ?? []), ...parsedTitle.tags]),
    notes: input.notes?.trim() ?? "",
    subtasks: [],
    important: Boolean(input.important),
    urgent: Boolean(input.urgent),
    recurrence: input.recurrence ?? "none",
    pomodoroMinutes: Math.max(
      5,
      input.pomodoroMinutes ?? DEFAULT_POMODORO_MINUTES,
    ),
    pomodoroSessions: 0,
    estimatePomodoros: Math.max(1, input.estimatePomodoros ?? DEFAULT_ESTIMATE),
    locationReminder: null,
  };
};

const stripToken = (value: string, token: RegExp): string => {
  return value.replace(token, " ");
};

const endOfLocalDay = (date: Date): number => {
  const next = new Date(date.getTime());
  next.setHours(23, 59, 59, 999);
  return next.getTime();
};

const parsePriority = (text: string): TaskPriority | null => {
  const explicit = text.match(/(?:^|\s)p([1-4])(?=\s|$)/i);
  if (explicit) {
    return Number(explicit[1]) as TaskPriority;
  }

  const bang = text.match(/(?:^|\s)!{1,4}(?=\s|$)/);
  if (!bang) return null;

  const count = bang[0].trim().length;
  if (count >= 4) return 1;
  if (count === 3) return 2;
  if (count === 2) return 3;
  return 4;
};

const parseRecurrence = (text: string): TaskRecurrence => {
  const normalized = text.toLowerCase();
  if (/\bevery\s+day\b|\bdaily\b/.test(normalized)) return "daily";
  if (/\bevery\s+week\b|\bweekly\b/.test(normalized)) return "weekly";
  return "none";
};

const parseDueDate = (text: string): number | null => {
  const normalized = text.toLowerCase();
  const now = new Date();
  let date: Date | null = null;

  if (/\btoday\b/.test(normalized)) {
    date = new Date(now.getTime());
  } else if (/\btomorrow\b/.test(normalized)) {
    date = new Date(now.getTime());
    date.setDate(date.getDate() + 1);
  } else if (/\bnext\s+week\b/.test(normalized)) {
    date = new Date(now.getTime());
    date.setDate(date.getDate() + 7);
  } else {
    const iso = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (iso) {
      const parsed = new Date(`${iso[1]}T18:00:00`);
      if (!Number.isNaN(parsed.getTime())) {
        date = parsed;
      }
    }
  }

  if (!date) {
    return null;
  }

  const timeMatch = normalized.match(
    /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/,
  );
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] ?? "0");
    const meridiem = timeMatch[3]?.toLowerCase();

    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      date.setHours(hour, minute, 0, 0);
      return date.getTime();
    }
  }

  return endOfLocalDay(date);
};

export const parseQuickTaskInput = (input: string): ParsedQuickTask | null => {
  const raw = input.trim();
  if (!raw) return null;

  const parsedTitle = extractTaskTitleTags(raw);
  const priority = parsePriority(raw) ?? DEFAULT_PRIORITY;
  const recurrence = parseRecurrence(raw);
  const dueAt = parseDueDate(raw);
  const important = /!important|!i\b/i.test(raw);
  const urgent = /!urgent|!u\b/i.test(raw);

  let title = parsedTitle.title;
  title = stripToken(title, /(?:^|\s)p([1-4])(?=\s|$)/gi);
  title = stripToken(title, /(?:^|\s)!{1,4}(?=\s|$)/g);
  title = stripToken(title, /\btoday\b/gi);
  title = stripToken(title, /\btomorrow\b/gi);
  title = stripToken(title, /\bnext\s+week\b/gi);
  title = stripToken(title, /\b(20\d{2}-\d{2}-\d{2})\b/g);
  title = stripToken(title, /\bat\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi);
  title = stripToken(title, /!important|!urgent|!i\b|!u\b/gi);
  title = stripToken(
    title,
    /\bevery\s+day\b|\bdaily\b|\bevery\s+week\b|\bweekly\b/gi,
  );
  title = cleanParsedTaskTitle(title);

  if (!title) return null;

  return {
    title,
    dueAt,
    priority,
    tags: parsedTitle.tags,
    important,
    urgent,
    recurrence,
  };
};

export const useTasksStore = create<TasksStoreState>()(
  persist(
    (set, get) => ({
      tasks: [],
      habits: [],
      smartFilters: [],
      focusSessions: [],

      addTask: (input) => {
        const created = createTask(input);
        set((state) => ({
          tasks: [created, ...state.tasks],
        }));
        return created;
      },

      updateTask: (id, updates) => {
        set((state) => ({
          tasks: state.tasks.map((task) => {
            if (task.id !== id) return task;
            const parsedTitle =
              updates.title !== undefined
                ? extractTaskTitleTags(updates.title)
                : null;
            const baseTags =
              updates.tags !== undefined ? updates.tags : task.tags;
            return {
              ...task,
              ...updates,
              title: parsedTitle ? parsedTitle.title || task.title : task.title,
              tags: dedupeStrings([...baseTags, ...(parsedTitle?.tags ?? [])]),
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      deleteTask: (id) => {
        set((state) => ({
          tasks: state.tasks.filter((task) => task.id !== id),
          focusSessions: state.focusSessions.filter(
            (session) => session.taskId !== id,
          ),
        }));
      },

      toggleTaskCompleted: (id, completed) => {
        const now = Date.now();
        const current = get().tasks.find((task) => task.id === id);
        if (!current) return;

        const nextCompleted =
          typeof completed === "boolean" ? completed : !current.completed;

        const nextTasks = get().tasks.map((task) => {
          if (task.id !== id) return task;
          return {
            ...task,
            completed: nextCompleted,
            completedAt: nextCompleted ? now : null,
            updatedAt: now,
          };
        });

        if (nextCompleted && current.recurrence !== "none") {
          const followUp: TaskItem = {
            ...current,
            id: createId(),
            completed: false,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
            dueAt: nextDueAtForRecurrence(current.recurrence, current.dueAt),
            pomodoroSessions: 0,
            subtasks: current.subtasks.map((subtask) => ({
              ...subtask,
              id: createId(),
              completed: false,
              createdAt: now,
              updatedAt: now,
            })),
            locationReminder: current.locationReminder
              ? {
                  ...current.locationReminder,
                  lastTriggeredAt: undefined,
                }
              : null,
          };
          nextTasks.unshift(followUp);
        }

        set({ tasks: nextTasks });
      },

      clearCompletedTasks: () => {
        set((state) => ({
          tasks: state.tasks.filter((task) => !task.completed),
        }));
      },

      addSubtask: (taskId, title) => {
        const trimmed = title.trim();
        if (!trimmed) return;
        const now = Date.now();
        const created: TaskSubtask = {
          id: createId(),
          title: trimmed,
          completed: false,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  subtasks: [...task.subtasks, created],
                  updatedAt: now,
                }
              : task,
          ),
        }));
      },

      updateSubtask: (taskId, subtaskId, updates) => {
        const now = Date.now();
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  subtasks: task.subtasks.map((subtask) =>
                    subtask.id === subtaskId
                      ? {
                          ...subtask,
                          ...updates,
                          title: updates.title ?? subtask.title,
                          updatedAt: now,
                        }
                      : subtask,
                  ),
                  updatedAt: now,
                }
              : task,
          ),
        }));
      },

      toggleSubtask: (taskId, subtaskId) => {
        const now = Date.now();
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  subtasks: task.subtasks.map((subtask) =>
                    subtask.id === subtaskId
                      ? {
                          ...subtask,
                          completed: !subtask.completed,
                          updatedAt: now,
                        }
                      : subtask,
                  ),
                  updatedAt: now,
                }
              : task,
          ),
        }));
      },

      deleteSubtask: (taskId, subtaskId) => {
        const now = Date.now();
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  subtasks: task.subtasks.filter(
                    (subtask) => subtask.id !== subtaskId,
                  ),
                  updatedAt: now,
                }
              : task,
          ),
        }));
      },

      addHabit: (title, icon = DEFAULT_HABIT_ICON, targetPerWeek = 5) => {
        const now = Date.now();
        const created: HabitItem = {
          id: createId(),
          title: title.trim(),
          icon,
          createdAt: now,
          targetPerWeek: Math.max(1, targetPerWeek),
          checkins: [],
        };
        set((state) => ({
          habits: [created, ...state.habits],
        }));
        return created;
      },

      updateHabit: (id, updates) => {
        set((state) => ({
          habits: state.habits.map((habit) =>
            habit.id === id
              ? {
                  ...habit,
                  ...updates,
                  title: updates.title ? updates.title.trim() : habit.title,
                  targetPerWeek: updates.targetPerWeek
                    ? Math.max(1, updates.targetPerWeek)
                    : habit.targetPerWeek,
                }
              : habit,
          ),
        }));
      },

      deleteHabit: (id) => {
        set((state) => ({
          habits: state.habits.filter((habit) => habit.id !== id),
        }));
      },

      toggleHabitCheckin: (id, dayKey) => {
        const checkinDay = dayKey ?? localDateKeyFromDate(new Date());
        set((state) => ({
          habits: state.habits.map((habit) => {
            if (habit.id !== id) return habit;
            const hasDay = habit.checkins.includes(checkinDay);
            const nextCheckins = hasDay
              ? habit.checkins.filter((value) => value !== checkinDay)
              : [...habit.checkins, checkinDay];
            return {
              ...habit,
              checkins: nextCheckins.sort(),
            };
          }),
        }));
      },

      addSmartFilter: (input) => {
        const created: SmartTaskFilter = {
          ...input,
          id: createId(),
          name: input.name.trim(),
          tag: input.tag?.trim().toLowerCase() || null,
        };
        set((state) => ({
          smartFilters: [created, ...state.smartFilters],
        }));
        return created;
      },

      deleteSmartFilter: (id) => {
        set((state) => ({
          smartFilters: state.smartFilters.filter((filter) => filter.id !== id),
        }));
      },

      addFocusSession: (session) => {
        const created: FocusSession = { ...session, id: createId() };
        set((state) => ({
          focusSessions: [created, ...state.focusSessions].slice(0, 500),
        }));
        return created;
      },

      incrementPomodoroCount: (taskId) => {
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  pomodoroSessions: task.pomodoroSessions + 1,
                  updatedAt: Date.now(),
                }
              : task,
          ),
        }));
      },

      setTaskLocationReminder: (taskId, reminder) => {
        set((state) => ({
          tasks: state.tasks.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  locationReminder: reminder,
                  updatedAt: Date.now(),
                }
              : task,
          ),
        }));
      },

      markLocationReminderTriggered: (taskId, timestamp) => {
        set((state) => ({
          tasks: state.tasks.map((task) => {
            if (task.id !== taskId || !task.locationReminder) return task;
            return {
              ...task,
              locationReminder: {
                ...task.locationReminder,
                lastTriggeredAt: timestamp,
              },
              updatedAt: timestamp,
            };
          }),
        }));
      },
    }),
    {
      name: "breeze-tasks-v1",
      version: 1,
    },
  ),
);
