import React from "react";
import { useTranslation } from "react-i18next";
import { Tag, X } from "lucide-react";
import { type MeetingEntry } from "@/bindings";
import { formatDateTime, formatRelativeTime } from "@/utils/dateFormat";

const normalizeTag = (value: string) =>
  value.trim().replace(/\s+/g, " ").toUpperCase();

const formatDuration = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  const padded = (value: number) => value.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${padded(minutes)}:${padded(remaining)}`;
  }
  return `${minutes}:${padded(remaining)}`;
};

export interface MeetingListCardProps {
  meeting: MeetingEntry;
  isTagMenuOpen: boolean;
  tagQuery: string;
  tagSuggestions: string[];
  isFadingOut?: boolean;
  isLastRecorded?: boolean;
  tagMenuRef?: React.Ref<HTMLDivElement>;
  onOpenDetail: () => void;
  onToggleTagMenu: () => void;
  onCloseTagMenu: () => void;
  onTagQueryChange: (value: string) => void;
  onAddTag: (tag: string) => void | Promise<void>;
  onRemoveTag: (tag: string) => void | Promise<void>;
}

export const MeetingListCard: React.FC<MeetingListCardProps> = ({
  meeting,
  isTagMenuOpen,
  tagQuery,
  tagSuggestions,
  isFadingOut = false,
  isLastRecorded = false,
  tagMenuRef,
  onOpenDetail,
  onToggleTagMenu,
  onCloseTagMenu,
  onTagQueryChange,
  onAddTag,
  onRemoveTag,
}) => {
  const { t, i18n } = useTranslation();

  const endedRelative = formatRelativeTime(
    String(meeting.ended_at),
    i18n.language,
  );
  const endedAbsolute = formatDateTime(String(meeting.ended_at), i18n.language);
  const passiveTags = meeting.tags ?? [];
  const metadataButtonClass =
    "mt-0.5 flex w-full cursor-pointer flex-col items-start gap-0 px-1 text-left transition-opacity duration-200 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/25";
  const handleCardClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        "button,input,textarea,select,a,[data-meeting-card-ignore]",
      )
    ) {
      return;
    }

    onOpenDetail();
  };

  return (
    <article
      onClick={handleCardClick}
      className={`rounded-xl bg-background/40 px-4 py-4 transition-[max-height,opacity,transform,background-color] duration-300 ease-out ${
        isFadingOut
          ? "max-h-0 -translate-y-1 overflow-hidden py-0 opacity-0"
          : isLastRecorded
            ? "max-h-[480px] opacity-100 shadow-[0_0_0_1px_rgba(56,189,248,0.15)]"
            : "max-h-[480px] opacity-100"
      } ${isFadingOut ? "" : "hover:bg-background/60"} cursor-pointer`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 flex flex-col gap-1">
          <div className="flex h-7 w-full max-w-[38rem] items-center truncate px-1 text-sm font-semibold text-text">
            {meeting.name}
          </div>

          <button
            type="button"
            onClick={onOpenDetail}
            className={metadataButtonClass}
          >
            <div className="flex flex-wrap gap-2 text-xs text-muted">
              <span title={endedAbsolute}>
                {t("meetingsPage.ended", { time: endedRelative })}
              </span>
              <span className="before:content-['•']" aria-hidden />
              <span>
                {t("meetingsPage.durationLabel", {
                  time: formatDuration(meeting.duration_seconds),
                })}
              </span>
            </div>
            {passiveTags.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                {passiveTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted"
                  >
                    {normalizeTag(tag)}
                  </span>
                ))}
              </div>
            )}
          </button>

          <div
            className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted"
            data-meeting-card-ignore
          >
            <div
              className="relative"
              ref={isTagMenuOpen ? tagMenuRef : undefined}
            >
              <button
                type="button"
                onClick={onToggleTagMenu}
                className="flex h-6 w-6 cursor-pointer items-center justify-center text-muted transition-colors hover:text-text"
                title={t("meetingsPage.tagsLabel")}
                aria-label={t("meetingsPage.tagsLabel")}
              >
                <Tag className="h-3.5 w-3.5" />
              </button>
              <div
                className={`absolute left-0 z-50 mt-2 w-64 origin-top-left overflow-hidden rounded-xl border border-border bg-surface shadow-lg transition-[opacity,transform] duration-200 ease-out ${
                  isTagMenuOpen
                    ? "translate-y-0 scale-100 opacity-100"
                    : "pointer-events-none -translate-y-1 scale-[0.98] opacity-0"
                }`}
                aria-hidden={!isTagMenuOpen}
              >
                <div className="px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted">
                    {t("meetingsPage.tagsLabel")}
                  </div>
                  <input
                    value={tagQuery}
                    onChange={(event) => onTagQueryChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void onAddTag(tagQuery);
                      } else if (event.key === "Escape") {
                        onCloseTagMenu();
                      }
                    }}
                    placeholder={t("meetingsPage.tagsPlaceholder")}
                    tabIndex={isTagMenuOpen ? 0 : -1}
                    className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-text placeholder:text-muted focus:outline-none"
                  />
                </div>
                <div className="flex flex-wrap gap-2 px-3 pb-2">
                  {passiveTags.length === 0 && (
                    <span className="text-[11px] text-muted">
                      {t("meetingsPage.tagsEmpty")}
                    </span>
                  )}
                  {passiveTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => {
                        void onRemoveTag(tag);
                      }}
                      tabIndex={isTagMenuOpen ? 0 : -1}
                      className="flex cursor-pointer items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:text-text"
                    >
                      <span>{normalizeTag(tag)}</span>
                      <X className="h-3 w-3" />
                    </button>
                  ))}
                </div>
                <div className="max-h-40 overflow-y-auto border-t border-border">
                  {tagSuggestions.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted">
                      {t("common.noResults")}
                    </div>
                  ) : (
                    tagSuggestions.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          void onAddTag(tag);
                        }}
                        tabIndex={isTagMenuOpen ? 0 : -1}
                        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-text transition-colors hover:bg-accent/5"
                      >
                        <Tag className="h-3.5 w-3.5 text-muted" />
                        <span className="truncate">{normalizeTag(tag)}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
};

export default MeetingListCard;
