/* eslint-disable i18next/no-literal-string */
import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUp, CalendarDays, Check, Flag, Tags } from "lucide-react";
import {
  parseQuickTaskInput,
  type TaskItem,
  type TaskPriority,
  useTasksStore,
} from "@/stores/tasksStore";

const normalizeTagToken = (value: string): string | null => {
  const normalized = value.trim().replace(/^#/, "").trim();
  if (!normalized) return null;
  return normalized.toUpperCase();
};

const appendUniqueTags = (current: string[], incoming: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const tag of [...current, ...incoming]) {
    const normalized = normalizeTagToken(tag);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
};

const parseCommaSeparatedTags = (value: string): string[] => {
  const tokens = value.split(/[,\n\r\t]+/).map((token) => token.trim());
  const normalizedTokens = tokens
    .map((token) => normalizeTagToken(token))
    .filter((token): token is string => Boolean(token));
  return appendUniqueTags([], normalizedTokens);
};

const fromDateInput = (value: string): number | null => {
  if (!value) return null;
  const parsed = new Date(`${value}T18:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
};

const toDateInputValue = (date: Date): string => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const DAY_MS = 24 * 60 * 60 * 1000;

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

const isPendingTodayTask = (task: TaskItem): boolean => {
  if (task.completed || task.dueAt === null) return false;
  return task.dueAt <= endOfDay(Date.now());
};

const sortPendingTasks = (left: TaskItem, right: TaskItem): number => {
  const todayStart = startOfDay(Date.now());
  const leftOverdue = left.dueAt !== null && left.dueAt < todayStart;
  const rightOverdue = right.dueAt !== null && right.dueAt < todayStart;

  if (leftOverdue !== rightOverdue) {
    return leftOverdue ? -1 : 1;
  }

  if (
    left.dueAt !== null &&
    right.dueAt !== null &&
    left.dueAt !== right.dueAt
  ) {
    return left.dueAt - right.dueAt;
  }

  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  return right.updatedAt - left.updatedAt;
};

const formatPendingDueLabel = (dueAt: number | null): string => {
  if (dueAt === null) return "";

  const now = Date.now();
  const todayStart = startOfDay(now);
  if (dueAt < todayStart) {
    return "Overdue";
  }

  if (dueAt <= endOfDay(now)) {
    return "Today";
  }

  if (dueAt <= endOfDay(now + DAY_MS)) {
    return "Tomorrow";
  }

  return new Date(dueAt).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
};

const QuickTaskOverlay: React.FC = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [priorityOverride, setPriorityOverride] = useState<"" | TaskPriority>(
    "",
  );
  const [dueDateOverride, setDueDateOverride] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [tagPills, setTagPills] = useState<string[]>([]);
  const [activePicker, setActivePicker] = useState<
    "tags" | "priority" | "due" | null
  >(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const iconRowRef = useRef<HTMLDivElement | null>(null);
  const isVisibleRef = useRef(false);
  const lastShowAtRef = useRef(0);
  const tasks = useTasksStore((state) => state.tasks);
  const toggleTaskCompleted = useTasksStore(
    (state) => state.toggleTaskCompleted,
  );
  const pendingTodayTasks = tasks
    .filter(isPendingTodayTask)
    .sort(sortPendingTasks);

  const focusPrimaryInput = () => {
    const focus = () => {
      const inputElement = inputRef.current;
      if (!inputElement) return;
      inputElement.focus();
      const cursorPosition = inputElement.value.length;
      inputElement.setSelectionRange(cursorPosition, cursorPosition);
    };

    window.requestAnimationFrame(focus);
    window.setTimeout(focus, 80);
  };

  useEffect(() => {
    isVisibleRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== "breeze-tasks-v1") return;
      void useTasksStore.persist.rehydrate();
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const reset = () => {
    setInput("");
    setError(null);
    setPriorityOverride("");
    setDueDateOverride("");
    setTagDraft("");
    setTagPills([]);
    setActivePicker(null);
  };

  const closeOverlay = async () => {
    await invoke("hide_quick_task_overlay").catch(() => undefined);
  };

  const dismissOverlay = async () => {
    await invoke("dismiss_quick_task_overlay").catch(() => undefined);
  };

  const startWindowDrag = async () => {
    await getCurrentWindow()
      .startDragging()
      .catch(() => undefined);
  };

  const addTags = (incoming: string[]) => {
    if (!incoming.length) return;
    setTagPills((current) => appendUniqueTags(current, incoming));
  };

  const commitTagDraft = () => {
    const normalized = normalizeTagToken(tagDraft);
    if (!normalized) return false;
    addTags([normalized]);
    setTagDraft("");
    return true;
  };

  const removeTag = (tagToRemove: string) => {
    setTagPills((current) => current.filter((tag) => tag !== tagToRemove));
  };

  const handleTagPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text");
    if (!pasted || !/[,\n\r]/.test(pasted)) return;
    event.preventDefault();
    addTags(parseCommaSeparatedTags(pasted));
    setTagDraft("");
  };

  const submit = async () => {
    const parsedQuickTask = parseQuickTaskInput(input);
    if (!parsedQuickTask) {
      return;
    }

    const parsedTitleTags = parsedQuickTask.tags
      .map((tag) => normalizeTagToken(tag))
      .filter((tag): tag is string => Boolean(tag));
    const inlineTags = tagDraft.trim() ? parseCommaSeparatedTags(tagDraft) : [];
    const mergedTags = appendUniqueTags(
      appendUniqueTags(tagPills, inlineTags),
      parsedTitleTags,
    );

    setError(null);
    await invoke("submit_quick_task", {
      request: {
        title: parsedQuickTask.title,
        due_at: dueDateOverride
          ? fromDateInput(dueDateOverride)
          : parsedQuickTask.dueAt,
        priority:
          priorityOverride === "" ? parsedQuickTask.priority : priorityOverride,
        tags: mergedTags,
        notes: null,
        important: parsedQuickTask.important,
        urgent: parsedQuickTask.urgent,
        recurrence: parsedQuickTask.recurrence,
      },
    }).catch((invokeError) => {
      const message =
        invokeError instanceof Error
          ? invokeError.message
          : "Couldn't save task.";
      setError(message);
    });
  };

  useEffect(() => {
    let unlistenShow: (() => void) | null = null;
    let unlistenHide: (() => void) | null = null;
    let unlistenFocus: (() => void) | null = null;

    const setup = async () => {
      unlistenShow = await listen("quick-task-overlay-show", () => {
        const now = Date.now();
        const isDuplicateShow =
          isVisibleRef.current && now - lastShowAtRef.current < 500;
        lastShowAtRef.current = now;
        if (!isDuplicateShow) {
          reset();
        }
        isVisibleRef.current = true;
        setIsVisible(true);
        focusPrimaryInput();
      });

      unlistenHide = await listen("quick-task-overlay-hide", () => {
        isVisibleRef.current = false;
        setIsVisible(false);
      });

      unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload }) => {
        if (payload) {
          if (!isVisibleRef.current) {
            isVisibleRef.current = true;
            setIsVisible(true);
          }
          focusPrimaryInput();
          return;
        }
        if (isVisibleRef.current) {
          void dismissOverlay();
        }
      });
    };

    void setup();

    const handleWindowFocus = () => {
      if (!isVisibleRef.current) return;
      focusPrimaryInput();
    };
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      unlistenShow?.();
      unlistenHide?.();
      unlistenFocus?.();
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, []);

  useEffect(() => {
    if (activePicker !== "tags") return;
    window.requestAnimationFrame(() => {
      tagInputRef.current?.focus();
    });
  }, [activePicker]);

  useEffect(() => {
    if (!activePicker) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (iconRowRef.current?.contains(target)) return;
      setActivePicker(null);
    };

    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [activePicker]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        void closeOverlay();
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        if (event.target instanceof HTMLButtonElement) return;
        if (event.target instanceof HTMLSelectElement) return;
        if (
          event.target instanceof HTMLInputElement &&
          event.target !== inputRef.current
        ) {
          return;
        }
        if (event.target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        void submit();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const handlePendingTaskClick = (taskId: string) => {
    toggleTaskCompleted(taskId, true);
    focusPrimaryInput();
  };

  return (
    <div className="quick-task-overlay-root">
      <button
        type="button"
        className={`quick-task-backdrop ${isVisible ? "is-visible" : ""}`}
        onClick={() => void closeOverlay()}
        aria-label="Close quick task overlay"
      />
      <div className={`quick-task-panel ${isVisible ? "is-visible" : ""}`}>
        <div
          className="quick-task-drag-zone"
          onMouseDown={() => void startWindowDrag()}
          aria-hidden="true"
        />

        <div className="quick-task-pending-shell">
          <div className="quick-task-pending-header">
            <div className="quick-task-pending-heading">Pending today</div>
            <div className="quick-task-pending-subheading">
              {pendingTodayTasks.length === 0
                ? "Nothing due today."
                : pendingTodayTasks.length === 1
                  ? "1 task"
                  : `${pendingTodayTasks.length} tasks`}
            </div>
          </div>

          {pendingTodayTasks.length === 0 ? (
            <div className="quick-task-pending-empty-card">
              <div className="quick-task-pending-empty">
                Check back later or add something new below.
              </div>
            </div>
          ) : (
            <div
              className={`quick-task-pending-list ${
                pendingTodayTasks.length > 4 ? "has-overflow" : ""
              }`}
            >
              {pendingTodayTasks.map((task) => {
                const dueLabel = formatPendingDueLabel(task.dueAt);
                const isOverdue =
                  task.dueAt !== null && task.dueAt < startOfDay(Date.now());

                return (
                  <button
                    key={task.id}
                    type="button"
                    className="quick-task-pending-item"
                    onClick={() => handlePendingTaskClick(task.id)}
                    aria-label={`Complete ${task.title}`}
                  >
                    <span className="quick-task-pending-checkbox">
                      <Check size={13} />
                    </span>
                    <span className="quick-task-pending-content">
                      <span className="quick-task-pending-title">
                        {task.title}
                      </span>
                      <span className="quick-task-pending-meta">
                        {dueLabel ? (
                          <span
                            className={`quick-task-pending-chip ${
                              isOverdue ? "is-overdue" : ""
                            }`}
                          >
                            {dueLabel}
                          </span>
                        ) : null}
                        <span className="quick-task-pending-priority">
                          {`P${task.priority}`}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="quick-task-input-row">
          <input
            ref={inputRef}
            autoFocus
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Create task"
            className="quick-task-input"
          />
        </div>

        <div className="quick-task-actions-wrap">
          <div
            className={`quick-task-popover ${activePicker ? "is-open" : ""}`}
            ref={popoverRef}
            aria-hidden={activePicker ? "false" : "true"}
          >
            {activePicker === "tags" ? (
              <div className="quick-task-popover-section">
                <div className="quick-task-popover-title">Tags</div>
                {tagPills.length > 0 ? (
                  <div className="quick-task-tag-pills">
                    {tagPills.map((tag) => (
                      <span key={tag} className="quick-task-tag-pill">
                        {tag}
                        <button
                          type="button"
                          className="quick-task-tag-pill-remove"
                          onClick={() => removeTag(tag)}
                          aria-label={`Remove ${tag}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <label className="quick-task-popover-input">
                  <Tags size={13} />
                  <input
                    ref={tagInputRef}
                    type="text"
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    onPaste={handleTagPaste}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        commitTagDraft();
                      }
                    }}
                    placeholder="Type tag and press Enter"
                  />
                </label>
              </div>
            ) : null}
            {activePicker === "priority" ? (
              <div className="quick-task-popover-list">
                {[
                  { value: "", label: "Auto", description: "Use text intent" },
                  { value: "1", label: "P1", description: "Highest priority" },
                  { value: "2", label: "P2", description: "High priority" },
                  { value: "3", label: "P3", description: "Normal priority" },
                  { value: "4", label: "P4", description: "Low priority" },
                ].map((option) => {
                  const selected =
                    option.value === ""
                      ? priorityOverride === ""
                      : String(priorityOverride) === option.value;
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className="quick-task-popover-item"
                      onClick={() => {
                        setPriorityOverride(
                          option.value === ""
                            ? ""
                            : (Number(option.value) as TaskPriority),
                        );
                        setActivePicker(null);
                      }}
                    >
                      <span className="quick-task-popover-item-text">
                        <span className="quick-task-popover-item-label">
                          {option.label}
                        </span>
                        <span className="quick-task-popover-item-description">
                          {option.description}
                        </span>
                      </span>
                      {selected ? <Check size={14} /> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {activePicker === "due" ? (
              <div className="quick-task-popover-section">
                <div className="quick-task-popover-chip-row">
                  <button
                    type="button"
                    className="quick-task-popover-chip"
                    onClick={() =>
                      setDueDateOverride(toDateInputValue(new Date()))
                    }
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    className="quick-task-popover-chip"
                    onClick={() => {
                      const d = new Date();
                      d.setDate(d.getDate() + 1);
                      setDueDateOverride(toDateInputValue(d));
                    }}
                  >
                    Tomorrow
                  </button>
                  <button
                    type="button"
                    className="quick-task-popover-chip"
                    onClick={() => {
                      const d = new Date();
                      d.setDate(d.getDate() + 7);
                      setDueDateOverride(toDateInputValue(d));
                    }}
                  >
                    Next week
                  </button>
                  <button
                    type="button"
                    className="quick-task-popover-chip"
                    onClick={() => setDueDateOverride("")}
                  >
                    Clear
                  </button>
                </div>
                <label className="quick-task-popover-input">
                  <CalendarDays size={13} />
                  <input
                    type="date"
                    value={dueDateOverride}
                    onChange={(event) => setDueDateOverride(event.target.value)}
                  />
                </label>
              </div>
            ) : null}
          </div>

          <div className="quick-task-actions-row">
            <div className="quick-task-icon-row" ref={iconRowRef}>
              <button
                type="button"
                className={`quick-task-icon-button ${
                  activePicker === "tags" ? "is-active" : ""
                }`}
                onClick={() =>
                  setActivePicker((current) =>
                    current === "tags" ? null : "tags",
                  )
                }
                aria-label="Tags"
                title="Tags"
              >
                <Tags size={14} />
              </button>
              <button
                type="button"
                className={`quick-task-icon-button ${
                  activePicker === "priority" ? "is-active" : ""
                }`}
                onClick={() =>
                  setActivePicker((current) =>
                    current === "priority" ? null : "priority",
                  )
                }
                aria-label="Priority"
                title="Priority"
              >
                {priorityOverride === "" ? (
                  <Flag size={14} />
                ) : (
                  <span className="quick-task-priority-value">
                    {`P${priorityOverride}`}
                  </span>
                )}
              </button>
              <button
                type="button"
                className={`quick-task-icon-button ${
                  activePicker === "due" ? "is-active" : ""
                }`}
                onClick={() =>
                  setActivePicker((current) =>
                    current === "due" ? null : "due",
                  )
                }
                aria-label="Due date"
                title="Due date"
              >
                <CalendarDays size={14} />
              </button>
            </div>

            <button
              type="button"
              className="quick-task-push-button"
              onClick={() => void submit()}
              aria-label="Push task"
              title="Push task"
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
      </div>
      {error ? <div className="quick-task-error">{error}</div> : null}
    </div>
  );
};

export default QuickTaskOverlay;
