import React, { useEffect, useMemo, useRef, useState } from "react";
import { Filter, Search } from "lucide-react";
import type { HistoryAppFilterOption } from "@/bindings";

type AppFilterMenuProps = {
  options: HistoryAppFilterOption[];
  selectedOption: HistoryAppFilterOption | null;
  iconByIdentifier: Record<string, string>;
  title: string;
  allLabel: string;
  emptyLabel: string;
  noResultsLabel: string;
  searchPlaceholder: string;
  onClear: () => void;
  onSelect: (option: HistoryAppFilterOption) => void;
  onClose: () => void;
};

const tokenize = (value: string): string[] =>
  value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

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
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = new Array(b.length + 1).fill(0);
  const current = new Array(b.length + 1).fill(0);

  for (let index = 0; index <= b.length; index += 1) {
    previous[index] = index;
  }

  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    let rowMin = current[0];
    const char = a[row - 1];

    for (let column = 1; column <= b.length; column += 1) {
      const cost = char === b[column - 1] ? 0 : 1;
      const value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
      );
      current[column] = value;
      rowMin = Math.min(rowMin, value);
    }

    if (rowMin > maxDistance) return maxDistance + 1;

    for (let index = 0; index <= b.length; index += 1) {
      previous[index] = current[index];
    }
  }

  return previous[b.length];
};

const isSubsequence = (needle: string, haystack: string): boolean => {
  let needleIndex = 0;
  for (let index = 0; index < haystack.length; index += 1) {
    if (haystack[index] === needle[needleIndex]) {
      needleIndex += 1;
      if (needleIndex === needle.length) return true;
    }
  }
  return needle.length === 0;
};

const optionMatchesQuery = (
  option: HistoryAppFilterOption,
  query: string,
): boolean => {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return true;

  const words = tokenize(
    `${option.label} ${option.value} ${option.icon_identifier ?? ""}`,
  );
  const haystack = words.join(" ");
  const acronym = words.map((word) => word[0]).join("");

  return queryTokens.every((token) => {
    if (haystack.includes(token) || acronym.startsWith(token)) return true;
    if (isSubsequence(token, acronym)) return true;
    if (token.length <= 2) {
      return words.some((word) => word.startsWith(token));
    }

    const maxDistance = maxAllowedDistance(token.length);
    return words.some((word) => {
      if (word.includes(token) || word.startsWith(token)) return true;
      if (Math.abs(word.length - token.length) > maxDistance) return false;
      return boundedLevenshtein(token, word, maxDistance) <= maxDistance;
    });
  });
};

export const AppFilterMenu: React.FC<AppFilterMenuProps> = ({
  options,
  selectedOption,
  iconByIdentifier,
  title,
  allLabel,
  emptyLabel,
  noResultsLabel,
  searchPlaceholder,
  onClear,
  onSelect,
  onClose,
}) => {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filteredOptions = useMemo(
    () => options.filter((option) => optionMatchesQuery(option, query)),
    [options, query],
  );

  const isSearching = query.trim().length > 0;
  const showNoResults = options.length > 0 && filteredOptions.length === 0;

  return (
    <div className="app-filter-menu liquid-glass absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-2xl">
      <div className="space-y-2 border-b border-black/5 px-3 py-2 dark:border-white/10">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {title}
        </div>
        <div className="flex h-8 items-center gap-2 rounded-xl border border-black/5 bg-white/60 px-2 text-xs text-zinc-700 shadow-[0_6px_18px_-14px_rgb(0_0_0_/_0.3)] backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-200">
          <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
              if (event.key === "Enter" && filteredOptions.length === 1) {
                event.preventDefault();
                onSelect(filteredOptions[0]);
              }
            }}
            placeholder={searchPlaceholder}
            className="min-w-0 flex-1 bg-transparent text-xs text-text placeholder:text-muted focus:outline-none"
          />
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {!isSearching && (
          <button
            type="button"
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-blue-500/10 ${
              !selectedOption
                ? "text-blue-600 dark:text-blue-500"
                : "text-zinc-800 dark:text-zinc-200"
            }`}
            onClick={onClear}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-black/10 text-[10px] text-zinc-500 dark:bg-white/15 dark:text-zinc-400">
              <Filter className="h-3 w-3" />
            </span>
            <span>{allLabel}</span>
          </button>
        )}
        {options.length === 0 && (
          <div className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
            {emptyLabel}
          </div>
        )}
        {showNoResults && (
          <div className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
            {noResultsLabel}
          </div>
        )}
        {filteredOptions.map((option) => {
          const iconSrc =
            option.icon_identifier && iconByIdentifier[option.icon_identifier];
          const isActive =
            selectedOption?.filter_type === option.filter_type &&
            selectedOption.value === option.value;
          const fallbackLetter =
            option.label?.trim().charAt(0).toUpperCase() || "?";
          return (
            <button
              key={`${option.filter_type}:${option.value}`}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-blue-500/10 ${
                isActive
                  ? "text-blue-600 dark:text-blue-500"
                  : "text-zinc-800 dark:text-zinc-200"
              }`}
              onClick={() => onSelect(option)}
            >
              {iconSrc ? (
                <img src={iconSrc} alt="" className="h-5 w-5 rounded-[5px]" />
              ) : (
                <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-black/10 text-[10px] text-zinc-500 dark:bg-white/15 dark:text-zinc-400">
                  {fallbackLetter}
                </span>
              )}
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
