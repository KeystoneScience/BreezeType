import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands, type NoteEntry } from "@/bindings";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Textarea } from "../ui/Textarea";
import { Plus, Search, Trash2, X } from "lucide-react";
import { formatRelativeTime } from "@/utils/dateFormat";

const tokenize = (value: string): string[] =>
  value.split(/[^a-z0-9]+/).filter(Boolean);

const maxAllowedDistance = (length: number): number => {
  if (length <= 2) return 0;
  if (length <= 5) return 1;
  return 2;
};

const boundedLevenshtein = (
  a: string,
  b: string,
  maxDistance: number,
): number => {
  const lengthA = a.length;
  const lengthB = b.length;
  if (Math.abs(lengthA - lengthB) > maxDistance) return maxDistance + 1;
  if (lengthA === 0) return lengthB;
  if (lengthB === 0) return lengthA;

  const previous = new Array(lengthB + 1).fill(0);
  const current = new Array(lengthB + 1).fill(0);

  for (let j = 0; j <= lengthB; j += 1) {
    previous[j] = j;
  }

  for (let i = 1; i <= lengthA; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    const charA = a[i - 1];

    for (let j = 1; j <= lengthB; j += 1) {
      const cost = charA === b[j - 1] ? 0 : 1;
      const deletion = previous[j] + 1;
      const insertion = current[j - 1] + 1;
      const substitution = previous[j - 1] + cost;
      const value = Math.min(deletion, insertion, substitution);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > maxDistance) return maxDistance + 1;

    for (let j = 0; j <= lengthB; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[lengthB];
};

const scoreTextMatch = (text: string, query: string): number => {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return 0;

  const normalizedText = text.toLowerCase();
  const words = tokenize(normalizedText);
  const tokens = tokenize(normalizedQuery);
  if (tokens.length === 0) return 0;

  let score = 0;
  for (const token of tokens) {
    if (token.length <= 2) {
      const matched = words.some((word) => word.startsWith(token));
      if (!matched) return 0;
      score += 2;
      continue;
    }

    if (normalizedText.includes(token)) {
      score += 3;
      continue;
    }

    const maxDistance = maxAllowedDistance(token.length);
    const matched = words.some((word) => {
      if (Math.abs(word.length - token.length) > maxDistance) return false;
      return boundedLevenshtein(token, word, maxDistance) <= maxDistance;
    });

    if (!matched) return 0;
    score += 1;
  }

  return score;
};

const NotesPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [captureEnabled, setCaptureEnabled] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const activeIdRef = useRef<number | null>(null);

  const loadNotes = async (preferredId?: number | null) => {
    setLoading(true);
    try {
      const result = await commands.getNotes();
      if (result.status === "ok") {
        const sorted = result.data.sort((a, b) => b.updated_at - a.updated_at);
        setNotes(sorted);
        if (preferredId && sorted.some((note) => note.id === preferredId)) {
          setActiveId(preferredId);
        } else if (sorted.length > 0) {
          setActiveId(sorted[0].id);
        } else {
          setActiveId(null);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    const initialize = async () => {
      const activeResult = await commands.getActiveNote();
      const preferred =
        activeResult.status === "ok" ? activeResult.data : null;
      loadNotes(preferred ?? undefined);
    };

    initialize();
    const unlisten = listen("notes-updated", () => {
      loadNotes(activeIdRef.current);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const handleFocusChange = async () => {
      const unlisten = await getCurrentWindow().onFocusChanged(
        ({ payload }) => {
          if (!payload) {
            setCaptureEnabled(false);
          }
        },
      );
      return unlisten;
    };

    let cleanup: (() => void) | null = null;
    handleFocusChange().then((unlisten) => {
      cleanup = unlisten;
    });
    return () => {
      if (cleanup) cleanup();
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<number | { id: number }>("notes-focus", (event) => {
      const payload = event.payload;
      const nextId =
        typeof payload === "number" ? payload : payload?.id ?? null;
      if (nextId) {
        setActiveId(nextId);
        loadNotes(nextId);
        setCaptureEnabled(true);
        requestAnimationFrame(() => {
          bodyRef.current?.focus();
        });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();

    const handleClick = (event: MouseEvent) => {
      if (!searchContainerRef.current) return;
      if (searchContainerRef.current.contains(event.target as Node)) return;
      if (!searchQuery.trim()) {
        setSearchOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !searchQuery.trim()) {
        setSearchOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [searchOpen, searchQuery]);

  const mergedNotes = useMemo(() => {
    if (!activeId) return notes;
    return notes.map((note) =>
      note.id === activeId
        ? { ...note, title: draftTitle, body: draftBody }
        : note,
    );
  }, [notes, activeId, draftTitle, draftBody]);

  const activeSavedNote = useMemo(
    () => notes.find((note) => note.id === activeId) ?? null,
    [notes, activeId],
  );

  const scoredNotes = useMemo(() => {
    if (!searchQuery.trim()) {
      return mergedNotes.slice().sort((a, b) => b.updated_at - a.updated_at);
    }

    return mergedNotes
      .map((note) => {
        const titleScore = scoreTextMatch(note.title, searchQuery);
        const bodyScore = scoreTextMatch(note.body, searchQuery);
        if (titleScore === 0 && bodyScore === 0) {
          return null;
        }
        return { note, titleScore, bodyScore };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (!a || !b) return 0;
        if (b.titleScore !== a.titleScore) {
          return b.titleScore - a.titleScore;
        }
        if (b.bodyScore !== a.bodyScore) {
          return b.bodyScore - a.bodyScore;
        }
        return b.note.updated_at - a.note.updated_at;
      })
      .map((item) => (item ? item.note : null))
      .filter(Boolean) as NoteEntry[];
  }, [mergedNotes, searchQuery]);

  useEffect(() => {
    if (!activeId) return;
    setDraftTitle(activeSavedNote?.title ?? "");
    setDraftBody(activeSavedNote?.body ?? "");
  }, [activeId, activeSavedNote]);

  const activeNote = useMemo(
    () => mergedNotes.find((note) => note.id === activeId) ?? null,
    [mergedNotes, activeId],
  );

  useEffect(() => {
    if (captureEnabled && activeId) {
      void commands.setActiveNote(activeId);
    } else {
      void commands.setActiveNote(null);
    }
  }, [activeId, captureEnabled]);

  useEffect(() => {
    return () => {
      void commands.setActiveNote(null);
    };
  }, []);

  useEffect(() => {
    if (!activeSavedNote) return;
    if (
      draftTitle === activeSavedNote.title &&
      draftBody === activeSavedNote.body
    ) {
      return;
    }
    setIsSaving(true);
    const timeout = window.setTimeout(() => {
      void commands
        .updateNote(activeSavedNote.id, draftTitle, draftBody)
        .finally(() => {
          setIsSaving(false);
        });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [
    activeSavedNote?.id,
    activeSavedNote?.title,
    activeSavedNote?.body,
    draftTitle,
    draftBody,
  ]);

  const handleCreate = async () => {
    const result = await commands.createNote("", "");
    if (result.status === "ok") {
      setNotes((prev) => [result.data, ...prev]);
      setActiveId(result.data.id);
      requestAnimationFrame(() => {
        titleRef.current?.focus();
      });
    }
  };

  const handleDelete = async (id: number) => {
    const nextNotes = notes.filter((note) => note.id !== id);
    await commands.deleteNote(id);
    setNotes(nextNotes);
    if (activeId === id) {
      setActiveId(nextNotes[0]?.id ?? null);
    }
  };

  const listEmptyState = (
    <div className="rounded-xl border border-dashed border-border bg-surface/60 px-4 py-6 text-sm text-muted">
      <div className="font-medium text-text">{t("notesPage.empty")}</div>
      <div className="mt-1">{t("notesPage.emptyBody")}</div>
    </div>
  );

  return (
    <div className="max-w-6xl w-full mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text">
            {t("notesPage.title")}
          </h1>
          <p className="text-sm text-muted">{t("notesPage.subtitle")}</p>
        </div>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:text-text"
          onClick={handleCreate}
          aria-label={t("notesPage.newNote")}
          title={t("notesPage.newNote")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-text">
              {t("notesPage.title")}
            </div>
            <div
              ref={searchContainerRef}
              className={`relative flex h-7 items-center gap-2 rounded-full border border-transparent transition-all duration-200 ease-out ${
                searchOpen
                  ? "w-56 bg-border/60 border-border px-2"
                  : "w-7 bg-transparent px-1"
              }`}
            >
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center text-muted transition-colors hover:text-text"
                onClick={() => {
                  if (searchOpen) {
                    setSearchOpen(false);
                    setSearchQuery("");
                  } else {
                    setSearchOpen(true);
                  }
                }}
                aria-label={t("common.search")}
              >
                <Search className="h-3.5 w-3.5" />
              </button>
              {searchOpen && (
                <input
                  ref={searchInputRef}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t("notesPage.searchPlaceholder")}
                  className="flex-1 bg-transparent pr-6 text-xs text-text placeholder:text-muted focus:outline-none"
                />
              )}
              <button
                type="button"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                }}
                className={`absolute right-2 text-muted transition-opacity duration-150 hover:text-text ${
                  searchOpen ? "opacity-100 delay-150" : "opacity-0 pointer-events-none"
                }`}
                aria-label={t("common.close")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="mt-3 space-y-1">
            {loading && (
              <div className="text-xs text-muted">{t("common.loading")}</div>
            )}
            {!loading && scoredNotes.length === 0 && listEmptyState}
            {!loading &&
              scoredNotes.map((note) => {
                const isActive = note.id === activeId;
                const title = note.title.trim() || t("notesPage.untitled");
                const bodyPreview = note.body.trim().split("\n")[0];
                const relativeTime = formatRelativeTime(
                  String(note.updated_at),
                  i18n.language,
                );
                return (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => setActiveId(note.id)}
                    className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                      isActive
                        ? "border-accent/40 bg-accent/10 text-text"
                        : "border-border bg-background hover:border-accent/30 hover:bg-accent/5"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-text truncate">
                        {title}
                      </span>
                      <span className="text-[11px] text-muted">
                        {relativeTime}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted max-h-10 overflow-hidden">
                      {bodyPreview || t("notesPage.bodyPlaceholder")}
                    </div>
                  </button>
                );
              })}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          {!activeNote && (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              {t("notesPage.emptyBody")}
            </div>
          )}
          {activeNote && (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <Input
                  ref={titleRef}
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder={t("notesPage.titlePlaceholder")}
                  className="flex-1 text-base font-semibold"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(activeNote.id)}
                  className="text-muted hover:text-red-500"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <Textarea
                ref={bodyRef}
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
                placeholder={t("notesPage.bodyPlaceholder")}
                className="w-full min-h-[360px] leading-relaxed"
                onFocus={() => setCaptureEnabled(true)}
                onBlur={() => setCaptureEnabled(false)}
              />
              <div className="flex items-center justify-between text-xs text-muted">
                <span>
                  {isSaving ? t("notesPage.saving") : t("notesPage.saved")}
                </span>
                <span>
                  {activeNote.updated_at
                    ? formatRelativeTime(
                        String(activeNote.updated_at),
                        i18n.language,
                      )
                    : ""}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default NotesPage;
