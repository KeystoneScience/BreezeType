import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type OpenCommand, type SnippetDefinition } from "@/bindings";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Textarea } from "../ui/Textarea";
import { AlertCircle, Plus, Search, X } from "lucide-react";

const emptyCommand = (): OpenCommand => ({ phrase: "", target: "" });
const emptySnippet = (): SnippetDefinition => ({
  id: "",
  triggers: [],
  kind: "text_expand",
  description: "",
  template: "",
  variables: [],
  enabled: false,
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

const CommandsPage: React.FC = () => {
  const { t } = useTranslation();
  const [openCommands, setOpenCommands] = useState<OpenCommand[]>([]);
  const [snippets, setSnippets] = useState<SnippetDefinition[]>([]);
  const [expandedSnippets, setExpandedSnippets] = useState<
    Record<number, boolean>
  >({});
  const [triggerInputs, setTriggerInputs] = useState<Record<number, string>>(
    {},
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [draftSnippet, setDraftSnippet] =
    useState<SnippetDefinition>(emptySnippet());
  const [draftTriggerInput, setDraftTriggerInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCommands = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [openResult, snippetResult] = await Promise.all([
        commands.getOpenCommands(),
        commands.getSnippets(),
      ]);
      if (openResult.status === "ok") {
        setOpenCommands(openResult.data);
      } else {
        setError(t("commandsPage.errors.load"));
      }
      if (snippetResult.status === "ok") {
        setSnippets(snippetResult.data);
      } else {
        setError(t("commandsPage.errors.load"));
      }
      setIsDirty(false);
    } catch (err) {
      console.error("Failed to load snippets", err);
      setError(t("commandsPage.errors.load"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCommands();
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

  const saveAll = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const [openResult, snippetResult] = await Promise.all([
        commands.setOpenCommands(openCommands),
        commands.setSnippets(snippets),
      ]);
      if (openResult.status === "ok" && snippetResult.status === "ok") {
        setIsDirty(false);
      } else {
        setError(t("commandsPage.errors.save"));
      }
    } catch (err) {
      console.error("Failed to save snippets", err);
      setError(t("commandsPage.errors.save"));
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    if (isLoading || !isDirty) return undefined;
    const timeout = window.setTimeout(() => {
      void saveAll();
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [isDirty, isLoading, openCommands, snippets]);

  const addTriggers = (index: number, raw: string) => {
    const tokens = raw
      .split(/[\\n\\t,;]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;

    setSnippets((prev) =>
      prev.map((snippet, i) => {
        if (i !== index) return snippet;
        const existing = new Set(
          snippet.triggers.map((trigger) => trigger.toLowerCase()),
        );
        const next = [...snippet.triggers];
        tokens.forEach((token) => {
          if (!existing.has(token.toLowerCase())) {
            next.push(token);
            existing.add(token.toLowerCase());
          }
        });
        return { ...snippet, triggers: next };
      }),
    );
    setTriggerInputs((prev) => ({ ...prev, [index]: "" }));
    setIsDirty(true);
  };

  const removeTrigger = (index: number, trigger: string) => {
    setSnippets((prev) =>
      prev.map((snippet, i) =>
        i === index
          ? {
              ...snippet,
              triggers: snippet.triggers.filter(
                (item) => item.toLowerCase() !== trigger.toLowerCase(),
              ),
            }
          : snippet,
      ),
    );
    setIsDirty(true);
  };

  const toggleSnippetExpanded = (index: number) => {
    setExpandedSnippets((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const updateSnippet = (index: number, patch: Partial<SnippetDefinition>) => {
    setSnippets((prev) =>
      prev.map((snippet, i) =>
        i === index ? { ...snippet, ...patch } : snippet,
      ),
    );
    setIsDirty(true);
  };

  const handleRemoveSnippet = (index: number) => {
    setSnippets((prev) => prev.filter((_, i) => i !== index));
    setIsDirty(true);
  };

  const handleAddOpenCommand = () => {
    setOpenCommands((prev) => [...prev, emptyCommand()]);
    setIsDirty(true);
  };

  const handleRemoveOpenCommand = (index: number) => {
    setOpenCommands((prev) => prev.filter((_, i) => i !== index));
    setIsDirty(true);
  };

  const handleOpenCommandChange = (
    index: number,
    field: keyof OpenCommand,
    value: string,
  ) => {
    setOpenCommands((prev) =>
      prev.map((command, i) =>
        i === index ? { ...command, [field]: value } : command,
      ),
    );
    setIsDirty(true);
  };

  const addDraftTriggers = (raw: string) => {
    const tokens = raw
      .split(/[\\n\\t,;]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;

    setDraftSnippet((prev) => {
      const existing = new Set(prev.triggers.map((t) => t.toLowerCase()));
      const next = [...prev.triggers];
      tokens.forEach((token) => {
        if (!existing.has(token.toLowerCase())) {
          next.push(token);
          existing.add(token.toLowerCase());
        }
      });
      return { ...prev, triggers: next };
    });
    setDraftTriggerInput("");
  };

  const removeDraftTrigger = (trigger: string) => {
    setDraftSnippet((prev) => ({
      ...prev,
      triggers: prev.triggers.filter(
        (item) => item.toLowerCase() !== trigger.toLowerCase(),
      ),
    }));
  };

  const filteredSnippets = useMemo(() => {
    if (!searchQuery.trim()) return snippets;
    return snippets.filter((snippet) => {
      const combined = [
        snippet.id,
        snippet.description,
        snippet.template,
        ...snippet.triggers,
      ]
        .filter(Boolean)
        .join(" ");
      return fuzzyMatch(combined, searchQuery);
    });
  }, [snippets, searchQuery]);

  const handleOpenAddModal = () => {
    setDraftSnippet(emptySnippet());
    setDraftTriggerInput("");
    setShowAddModal(true);
  };

  const handleCreateSnippet = () => {
    if (!draftSnippet.id.trim()) return;
    if (!draftSnippet.template.trim()) return;
    if (draftSnippet.triggers.length === 0) return;

    setSnippets((prev) => [...prev, { ...draftSnippet }]);
    setExpandedSnippets((prev) => ({ ...prev, [snippets.length]: false }));
    setIsDirty(true);
    setShowAddModal(false);
  };

  return (
    <div className="mx-auto w-full max-w-[980px] space-y-8">
      <div className="liquid-glass rounded-3xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="app-display">{t("commandsPage.title")}</h2>
            <p className="app-caption mt-2">{t("commandsPage.subtitle")}</p>
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {isSaving ? t("commandsPage.saving") : ""}
          </div>
        </div>
        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-2xl border border-black/5 bg-white/55 px-3 py-2 text-sm text-zinc-600 dark:border-white/10 dark:bg-zinc-900/55 dark:text-zinc-300">
            <AlertCircle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="liquid-glass relative rounded-3xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-text">
              {t("commandsPage.snippets.title")}
            </h3>
            <p className="text-sm text-muted">
              {t("commandsPage.snippets.description")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div
              ref={searchContainerRef}
              className={`relative flex h-7 items-center gap-2 overflow-hidden rounded-full border border-transparent transition-[width,padding,background-color,border-color] duration-200 ease-out ${
                searchOpen
                  ? "w-52 bg-border/60 border-border px-2"
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
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("commandsPage.snippets.searchPlaceholder")}
                className={`min-w-0 flex-1 bg-transparent pr-6 text-xs text-text transition-opacity duration-150 placeholder:text-muted focus:outline-none ${
                  searchOpen ? "opacity-100" : "pointer-events-none opacity-0"
                }`}
                tabIndex={searchOpen ? 0 : -1}
                aria-hidden={!searchOpen}
              />
              <button
                type="button"
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                }}
                className={`absolute right-2 text-muted transition-opacity duration-150 hover:text-text ${
                  searchOpen
                    ? "opacity-100 delay-150"
                    : "opacity-0 pointer-events-none"
                }`}
                aria-label={t("common.close")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:text-text"
              onClick={handleOpenAddModal}
              aria-label={t("commandsPage.snippets.addTitle")}
              title={t("commandsPage.snippets.addTitle")}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          {isLoading && (
            <div className="text-sm text-muted">{t("common.loading")}</div>
          )}
          {!isLoading && filteredSnippets.length === 0 && (
            <div className="text-sm text-muted">
              {t("commandsPage.snippets.empty")}
            </div>
          )}
          {!isLoading &&
            filteredSnippets.map((snippet, index) => {
              const previewLine = snippet.template
                .split("\n")
                .map((line) => line.trim())
                .find(Boolean);
              const snippetIndex = snippets.indexOf(snippet);

              return (
                <div
                  key={`${snippet.id || "snippet"}-${index}`}
                  className="rounded-2xl border border-border bg-background p-4 space-y-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-text">
                        {snippet.id || t("commandsPage.snippets.untitled")}
                      </div>
                      <div className="text-xs text-muted">
                        {snippet.description ||
                          t("commandsPage.snippets.helper")}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleSnippetExpanded(snippetIndex)}
                        className="text-xs font-semibold text-muted hover:text-text"
                      >
                        {expandedSnippets[snippetIndex]
                          ? t("commandsPage.snippets.hide")
                          : t("commandsPage.snippets.edit")}
                      </button>
                      <label className="inline-flex cursor-pointer select-none items-center gap-2 text-xs text-muted">
                        {snippet.enabled
                          ? t("commandsPage.snippets.enabled")
                          : t("commandsPage.snippets.disabled")}
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={snippet.enabled}
                          onChange={(event) =>
                            updateSnippet(snippetIndex, {
                              enabled: event.target.checked,
                            })
                          }
                        />
                        <div className="relative h-[20px] w-[40px] rounded-full bg-border peer-checked:bg-accent after:absolute after:left-[2px] after:top-[2px] after:h-[16px] after:w-[16px] after:rounded-full after:border after:border-border after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-[20px]" />
                      </label>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-muted">
                      {t("commandsPage.snippets.triggersLabel")}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {snippet.triggers.map((trigger) => (
                        <button
                          key={trigger}
                          type="button"
                          className="inline-flex items-center gap-1 rounded-full border border-black/5 bg-white/55 px-2 py-1 text-xs text-zinc-700 transition-colors hover:bg-blue-500/10 dark:border-white/10 dark:bg-zinc-900/55 dark:text-zinc-200"
                          onClick={() => removeTrigger(snippetIndex, trigger)}
                          title={t("commandsPage.snippets.removeTrigger")}
                        >
                          <span>{trigger}</span>
                          <span className="text-muted">×</span>
                        </button>
                      ))}
                      <Input
                        type="text"
                        value={triggerInputs[snippetIndex] ?? ""}
                        onChange={(event) =>
                          setTriggerInputs((prev) => ({
                            ...prev,
                            [snippetIndex]: event.target.value,
                          }))
                        }
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" ||
                            event.key === "," ||
                            event.key === "Tab"
                          ) {
                            event.preventDefault();
                            addTriggers(
                              snippetIndex,
                              triggerInputs[snippetIndex] ?? "",
                            );
                          }
                        }}
                        onBlur={() =>
                          addTriggers(
                            snippetIndex,
                            triggerInputs[snippetIndex] ?? "",
                          )
                        }
                        placeholder={t("commandsPage.snippets.addTrigger")}
                        className="min-w-[140px] flex-1"
                      />
                    </div>
                  </div>

                  {!expandedSnippets[snippetIndex] && previewLine && (
                    <div className="text-xs text-muted">{previewLine}</div>
                  )}

                  {expandedSnippets[snippetIndex] && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr]">
                        <div className="space-y-1">
                          <label className="text-xs font-semibold text-muted">
                            {t("commandsPage.snippets.idLabel")}
                          </label>
                          <Input
                            type="text"
                            value={snippet.id}
                            onChange={(event) =>
                              updateSnippet(snippetIndex, {
                                id: event.target.value,
                              })
                            }
                            placeholder={t(
                              "commandsPage.snippets.idPlaceholder",
                            )}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-semibold text-muted">
                            {t("commandsPage.snippets.descriptionLabel")}
                          </label>
                          <Input
                            type="text"
                            value={snippet.description}
                            onChange={(event) =>
                              updateSnippet(snippetIndex, {
                                description: event.target.value,
                              })
                            }
                            placeholder={t(
                              "commandsPage.snippets.descriptionPlaceholder",
                            )}
                          />
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-semibold text-muted">
                          {t("commandsPage.snippets.templateLabel")}
                        </label>
                        <Textarea
                          value={snippet.template}
                          onChange={(event) =>
                            updateSnippet(snippetIndex, {
                              template: event.target.value,
                            })
                          }
                          placeholder={t(
                            "commandsPage.snippets.templatePlaceholder",
                          )}
                          variant="compact"
                        />
                      </div>

                      {snippet.variables.length > 0 && (
                        <p className="text-xs text-muted">
                          {t("commandsPage.snippets.variablesLabel", {
                            variables: snippet.variables.join(", "),
                          })}
                        </p>
                      )}

                      <div className="flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveSnippet(snippetIndex)}
                        >
                          {t("common.delete")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
        </div>

        <Modal
          title={t("commandsPage.snippets.addTitle")}
          subtitle={t("commandsPage.snippets.addSubtitle")}
          open={showAddModal}
          width="md"
          closeLabel={t("common.close")}
          onClose={() => setShowAddModal(false)}
        >
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr]">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">
                  {t("commandsPage.snippets.idLabel")}
                </label>
                <Input
                  type="text"
                  value={draftSnippet.id}
                  onChange={(event) =>
                    setDraftSnippet((prev) => ({
                      ...prev,
                      id: event.target.value,
                    }))
                  }
                  placeholder={t("commandsPage.snippets.idPlaceholder")}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-muted">
                  {t("commandsPage.snippets.descriptionLabel")}
                </label>
                <Input
                  type="text"
                  value={draftSnippet.description}
                  onChange={(event) =>
                    setDraftSnippet((prev) => ({
                      ...prev,
                      description: event.target.value,
                    }))
                  }
                  placeholder={t(
                    "commandsPage.snippets.descriptionPlaceholder",
                  )}
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-xs font-semibold text-muted">
                {t("commandsPage.snippets.triggersLabel")}
              </div>
              <div className="flex flex-wrap gap-2">
                {draftSnippet.triggers.map((trigger) => (
                  <button
                    key={trigger}
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border border-black/5 bg-white/55 px-2 py-1 text-xs text-zinc-700 transition-colors hover:bg-blue-500/10 dark:border-white/10 dark:bg-zinc-900/55 dark:text-zinc-200"
                    onClick={() => removeDraftTrigger(trigger)}
                    title={t("commandsPage.snippets.removeTrigger")}
                  >
                    <span>{trigger}</span>
                    <span className="text-muted">×</span>
                  </button>
                ))}
                <Input
                  type="text"
                  value={draftTriggerInput}
                  onChange={(event) => setDraftTriggerInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" ||
                      event.key === "," ||
                      event.key === "Tab"
                    ) {
                      event.preventDefault();
                      addDraftTriggers(draftTriggerInput);
                    }
                  }}
                  onBlur={() => addDraftTriggers(draftTriggerInput)}
                  placeholder={t("commandsPage.snippets.addTrigger")}
                  className="min-w-[140px] flex-1"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted">
                {t("commandsPage.snippets.templateLabel")}
              </label>
              <Textarea
                value={draftSnippet.template}
                onChange={(event) =>
                  setDraftSnippet((prev) => ({
                    ...prev,
                    template: event.target.value,
                  }))
                }
                placeholder={t("commandsPage.snippets.templatePlaceholder")}
                variant="compact"
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              <label className="inline-flex cursor-pointer select-none items-center gap-2 text-xs text-muted">
                {draftSnippet.enabled
                  ? t("commandsPage.snippets.enabled")
                  : t("commandsPage.snippets.disabled")}
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={draftSnippet.enabled}
                  onChange={(event) =>
                    setDraftSnippet((prev) => ({
                      ...prev,
                      enabled: event.target.checked,
                    }))
                  }
                />
                <div className="relative h-[20px] w-[40px] rounded-full bg-border peer-checked:bg-accent after:absolute after:left-[2px] after:top-[2px] after:h-[16px] after:w-[16px] after:rounded-full after:border after:border-border after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-[20px]" />
              </label>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowAddModal(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleCreateSnippet}
                  disabled={
                    !draftSnippet.id.trim() ||
                    !draftSnippet.template.trim() ||
                    draftSnippet.triggers.length === 0
                  }
                >
                  {t("commandsPage.snippets.create")}
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      </div>

      <div className="liquid-glass rounded-3xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-text">
              {t("commandsPage.open.title")}
            </h3>
            <p className="text-sm text-muted">
              {t("commandsPage.open.description")}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={handleAddOpenCommand}>
            {t("common.add")}
          </Button>
        </div>

        <div className="mt-4 space-y-3">
          {isLoading && (
            <div className="text-sm text-muted">{t("common.loading")}</div>
          )}
          {!isLoading && openCommands.length === 0 && (
            <div className="text-sm text-muted">
              {t("commandsPage.open.empty")}
            </div>
          )}
          {!isLoading &&
            openCommands.map((command, index) => (
              <div
                key={`${command.phrase}-${index}`}
                className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto] md:items-center"
              >
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-muted">
                    {t("commandsPage.open.phraseLabel")}
                  </label>
                  <Input
                    type="text"
                    value={command.phrase}
                    onChange={(event) =>
                      handleOpenCommandChange(
                        index,
                        "phrase",
                        event.target.value,
                      )
                    }
                    placeholder={t("commandsPage.open.phrasePlaceholder")}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-muted">
                    {t("commandsPage.open.targetLabel")}
                  </label>
                  <Input
                    type="text"
                    value={command.target}
                    onChange={(event) =>
                      handleOpenCommandChange(
                        index,
                        "target",
                        event.target.value,
                      )
                    }
                    placeholder={t("commandsPage.open.targetPlaceholder")}
                  />
                </div>
                <div className="flex md:justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveOpenCommand(index)}
                  >
                    {t("common.remove")}
                  </Button>
                </div>
              </div>
            ))}
        </div>
      </div>

      <div className="liquid-glass rounded-3xl p-6">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-text">
            {t("commandsPage.takeNote.title")}
          </h3>
          <p className="text-sm text-muted">
            {t("commandsPage.takeNote.description")}
          </p>
          <div className="text-xs text-muted">
            {t("commandsPage.takeNote.examplesLabel")}
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted">
              {t("commandsPage.takeNote.example1")}
            </span>
            <span className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted">
              {t("commandsPage.takeNote.example2")}
            </span>
            <span className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted">
              {t("commandsPage.takeNote.example3")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CommandsPage;
