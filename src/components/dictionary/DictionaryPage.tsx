import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { Input } from "../ui/Input";
import { Textarea } from "../ui/Textarea";
import { useSettings } from "@/hooks/useSettings";
import type { DictionaryEntry } from "@/bindings";

const emptyEntry = (): DictionaryEntry => ({
  term: "",
  definition: "",
});

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

const fuzzyMatch = (text: string, query: string): boolean => {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return true;

  const normalizedText = text.toLowerCase();
  const words = tokenize(normalizedText);
  const tokens = tokenize(normalizedQuery);

  return tokens.every((token) => {
    if (token.length <= 2) {
      return words.some((word) => word.startsWith(token));
    }

    if (normalizedText.includes(token)) return true;

    const maxDistance = maxAllowedDistance(token.length);
    return words.some((word) => {
      if (Math.abs(word.length - token.length) > maxDistance) return false;
      return boundedLevenshtein(token, word, maxDistance) <= maxDistance;
    });
  });
};

const normalizeEntries = (entries: DictionaryEntry[]): DictionaryEntry[] =>
  entries
    .map((entry) => ({
      term: entry.term.trim(),
      definition: entry.definition.trim(),
    }))
    .filter((entry) => entry.term.length > 0);

interface DictionaryPageProps {
  embedded?: boolean;
}

const DictionaryPage: React.FC<DictionaryPageProps> = ({
  embedded = false,
}) => {
  const { t } = useTranslation();
  const { settings, updateSetting, isUpdating } = useSettings();
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [editingEntryIndex, setEditingEntryIndex] = useState<number | null>(
    null,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [draftEntry, setDraftEntry] = useState<DictionaryEntry>(emptyEntry());
  const [isDirty, setIsDirty] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const addTermInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!settings) return;
    if (isDirty) return;
    setEntries(settings.custom_dictionary ?? []);
  }, [settings?.custom_dictionary, settings, isDirty]);

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

  const handleUpdateEntry = (
    index: number,
    patch: Partial<DictionaryEntry>,
  ) => {
    setEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );
    setIsDirty(true);
  };

  const handleRemoveEntry = (index: number) => {
    setEntries((prev) => prev.filter((_, i) => i !== index));
    setEditingEntryIndex((prev) => (prev === index ? null : prev));
    setIsDirty(true);
  };

  const handleOpenAddForm = () => {
    setDraftEntry(emptyEntry());
    setEditingEntryIndex(null);
    setSearchOpen(false);
    setShowAddForm(true);
  };

  const handleCreateEntry = () => {
    const trimmedTerm = draftEntry.term.trim();
    if (!trimmedTerm) return;
    const nextEntry: DictionaryEntry = {
      term: trimmedTerm,
      definition: draftEntry.definition.trim(),
    };
    setEntries((prev) => [...prev, nextEntry]);
    setIsDirty(true);
    setShowAddForm(false);
    setDraftEntry(emptyEntry());
  };

  const filteredEntries = useMemo(() => {
    if (!searchQuery.trim()) return entries;
    return entries.filter((entry) =>
      fuzzyMatch(`${entry.term} ${entry.definition}`, searchQuery),
    );
  }, [entries, searchQuery]);

  const saveAll = useCallback(
    async (nextEntries: DictionaryEntry[]) => {
      await updateSetting("custom_dictionary", nextEntries);
      setIsDirty(false);
    },
    [updateSetting],
  );

  useEffect(() => {
    if (!isDirty) return undefined;

    const normalized = normalizeEntries(entries);
    const hasInvalid = entries.some((entry) => !entry.term.trim());
    if (hasInvalid) return undefined;

    const timeout = window.setTimeout(() => {
      void saveAll(normalized);
    }, 600);

    return () => window.clearTimeout(timeout);
  }, [entries, isDirty, saveAll]);

  useEffect(() => {
    if (!showAddForm) return;
    const frame = window.requestAnimationFrame(() => {
      addTermInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showAddForm]);

  const isLoading = !settings;
  const isSaving = isUpdating("custom_dictionary");
  const content = (
    <div className="space-y-4">
      {!embedded && (
        <div className="flex items-start justify-between gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <div className="min-w-0">
            <div>
              <h2 className="text-lg font-semibold text-text">
                {t("dictionaryPage.title")}
              </h2>
              <p className="text-sm text-muted">
                {t("dictionaryPage.subtitle")}
              </p>
            </div>
          </div>
          <div className="min-h-5 shrink-0 text-xs text-muted">
            {isSaving ? t("dictionaryPage.saving") : ""}
          </div>
        </div>
      )}

      <div
        className={
          embedded
            ? "relative min-h-[280px] space-y-4"
            : "relative min-h-[280px] rounded-2xl border border-border bg-surface p-6 shadow-sm"
        }
      >
        {showAddForm ? (
          <div className="dictionary-view-panel mx-auto w-full max-w-2xl py-1 sm:py-2">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-text">
                  {t("dictionaryPage.entries.addTitle")}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="modal-close-button -mr-2 -mt-2"
                aria-label={t("common.close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-muted">
                  {t("dictionaryPage.entries.termLabel")}
                </span>
                <Input
                  ref={addTermInputRef}
                  type="text"
                  value={draftEntry.term}
                  onChange={(event) =>
                    setDraftEntry((prev) => ({
                      ...prev,
                      term: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleCreateEntry();
                    }
                  }}
                  placeholder={t("dictionaryPage.entries.termPlaceholder")}
                  variant="compact"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-muted">
                  {t("dictionaryPage.entries.definitionLabel")}
                </span>
                <Textarea
                  value={draftEntry.definition}
                  onChange={(event) =>
                    setDraftEntry((prev) => ({
                      ...prev,
                      definition: event.target.value,
                    }))
                  }
                  placeholder={t(
                    "dictionaryPage.entries.definitionPlaceholder",
                  )}
                  variant="compact"
                  className="min-h-[120px] resize-none"
                />
              </label>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="rounded-xl px-3 py-2 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-500/10 dark:text-blue-500"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={handleCreateEntry}
                disabled={!draftEntry.term.trim()}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-[0_8px_24px_-16px_rgb(37_99_235_/_0.75)] transition-colors hover:bg-blue-500 disabled:pointer-events-none disabled:opacity-45 dark:bg-blue-500 dark:hover:bg-blue-400"
              >
                {t("dictionaryPage.entries.confirm")}
              </button>
            </div>
          </div>
        ) : (
          <div className="dictionary-view-panel">
            <div className="flex items-center justify-end gap-2">
              {isSaving && (
                <div className="mr-1 min-h-5 text-xs text-muted">
                  {t("dictionaryPage.saving")}
                </div>
              )}
              <div
                ref={searchContainerRef}
                className={`relative flex h-9 items-center rounded-full border border-transparent transition-all duration-200 ease-out ${
                  searchOpen
                    ? "w-56 border-border bg-border/60 pr-2"
                    : "w-9 bg-transparent"
                }`}
              >
                <button
                  type="button"
                  className="history-icon-button"
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
                    placeholder={t("dictionaryPage.entries.searchPlaceholder")}
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
                    searchOpen
                      ? "opacity-100 delay-150"
                      : "pointer-events-none opacity-0"
                  }`}
                  aria-label={t("common.close")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <button
                type="button"
                className="history-icon-button !text-blue-600 dark:!text-blue-400"
                onClick={handleOpenAddForm}
                aria-label={t("dictionaryPage.entries.addTitle")}
                title={t("dictionaryPage.entries.addTitle")}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className={embedded ? "mt-3" : "mt-4"}>
              {isLoading && (
                <div className="py-8 text-center text-sm text-muted">
                  {t("common.loading")}
                </div>
              )}
              {!isLoading && filteredEntries.length === 0 && (
                <div className="py-10 text-center">
                  <div className="text-sm font-medium text-text">
                    {t("dictionaryPage.entries.empty")}
                  </div>
                </div>
              )}
              {!isLoading &&
                filteredEntries.map((entry, index) => {
                  const entryIndex = entries.indexOf(entry);
                  const notePreview = entry.definition.trim();
                  const isEditing = editingEntryIndex === entryIndex;

                  return (
                    <div
                      key={`${entry.term || "entry"}-${index}`}
                      className="py-3"
                    >
                      {isEditing ? (
                        <div className="space-y-3">
                          <div className="grid gap-3 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                            <label className="space-y-1">
                              <span className="text-xs font-semibold text-muted">
                                {t("dictionaryPage.entries.termLabel")}
                              </span>
                              <Input
                                type="text"
                                value={entry.term}
                                onChange={(event) =>
                                  handleUpdateEntry(entryIndex, {
                                    term: event.target.value,
                                  })
                                }
                                placeholder={t(
                                  "dictionaryPage.entries.termPlaceholder",
                                )}
                                variant="compact"
                              />
                            </label>

                            <label className="space-y-1">
                              <span className="text-xs font-semibold text-muted">
                                {t("dictionaryPage.entries.definitionLabel")}
                              </span>
                              <Textarea
                                value={entry.definition}
                                onChange={(event) =>
                                  handleUpdateEntry(entryIndex, {
                                    definition: event.target.value,
                                  })
                                }
                                placeholder={t(
                                  "dictionaryPage.entries.definitionPlaceholder",
                                )}
                                variant="compact"
                                className="min-h-[72px] resize-none"
                              />
                            </label>
                          </div>

                          <div className="flex items-center justify-between gap-3">
                            <button
                              type="button"
                              onClick={() => handleRemoveEntry(entryIndex)}
                              className="inline-flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {t("common.delete")}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingEntryIndex(null)}
                              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-500/10 dark:text-blue-500"
                            >
                              <Check className="h-3.5 w-3.5" />
                              {t("dictionaryPage.entries.hide")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="group flex min-h-11 items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-text">
                              {entry.term ||
                                t("dictionaryPage.entries.untitled")}
                            </div>
                            {notePreview ? (
                              <div className="mt-1 line-clamp-2 text-sm text-muted">
                                {notePreview}
                              </div>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setShowAddForm(false);
                              setEditingEntryIndex(entryIndex);
                            }}
                            className="history-mini-icon-button mt-0.5 opacity-70 group-hover:opacity-100"
                            aria-label={t("dictionaryPage.entries.edit")}
                            title={t("dictionaryPage.entries.edit")}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className={embedded ? "w-full" : "mx-auto w-full max-w-6xl space-y-6"}>
      {content}
    </div>
  );
};

export default DictionaryPage;
