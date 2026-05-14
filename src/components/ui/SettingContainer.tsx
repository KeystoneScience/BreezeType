import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface SettingContainerProps {
  title: string;
  description: string;
  children: React.ReactNode;
  descriptionMode?: "inline" | "tooltip" | "none";
  grouped?: boolean;
  layout?: "horizontal" | "stacked";
  disabled?: boolean;
  tooltipPosition?: "top" | "bottom";
}

export const SettingContainer: React.FC<SettingContainerProps> = ({
  title,
  description,
  children,
  descriptionMode = "tooltip",
  grouped = false,
  layout = "horizontal",
  disabled = false,
  tooltipPosition = "top",
}) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPositionStyles, setTooltipPositionStyles] =
    useState<React.CSSProperties>({});
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        tooltipRef.current &&
        !tooltipRef.current.contains(target) &&
        !tooltipPanelRef.current?.contains(target)
      ) {
        setShowTooltip(false);
      }
    };

    if (showTooltip) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showTooltip]);

  useEffect(() => {
    if (!showTooltip || !tooltipRef.current) return;

    const updateTooltipPosition = () => {
      const rect = tooltipRef.current?.getBoundingClientRect();
      if (!rect) return;

      const tooltipWidth = Math.min(320, window.innerWidth - 32);
      const unclampedLeft = rect.left + rect.width / 2;
      const left = Math.min(
        window.innerWidth - 16 - tooltipWidth / 2,
        Math.max(16 + tooltipWidth / 2, unclampedLeft),
      );
      const top = tooltipPosition === "top" ? rect.top - 8 : rect.bottom + 8;

      setTooltipPositionStyles({
        left,
        top,
        width: tooltipWidth,
        transform:
          tooltipPosition === "top"
            ? "translate(-50%, -100%)"
            : "translate(-50%, 0)",
      });
    };

    updateTooltipPosition();
    window.addEventListener("resize", updateTooltipPosition);
    window.addEventListener("scroll", updateTooltipPosition, true);
    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
      window.removeEventListener("scroll", updateTooltipPosition, true);
    };
  }, [showTooltip, tooltipPosition]);

  const toggleTooltip = () => {
    setShowTooltip(!showTooltip);
  };

  const wrapperClasses = grouped
    ? "px-6 py-4"
    : "liquid-glass rounded-3xl px-6 py-5";

  const stateClasses = disabled ? "opacity-50" : "";

  const infoButton = (
    <div
      ref={tooltipRef}
      className="relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={toggleTooltip}
    >
      <button
        type="button"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-transparent text-zinc-500/80 transition-colors hover:bg-blue-500/10 hover:text-zinc-900 dark:text-zinc-400/80 dark:hover:text-zinc-100"
        aria-label="More information"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleTooltip();
          }
        }}
      >
        <svg
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.7}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </button>
      {showTooltip
        ? createPortal(
            <div
              ref={tooltipPanelRef}
              className="liquid-glass fixed z-[1000] min-w-[220px] max-w-xs whitespace-normal rounded-2xl px-3 py-2 text-sm text-zinc-600 dark:text-zinc-300"
              style={tooltipPositionStyles}
            >
              <p className="leading-snug">{description}</p>
            </div>,
            document.body,
          )
        : null}
    </div>
  );

  if (layout === "stacked") {
    return (
      <div className={`${wrapperClasses} ${stateClasses}`}>
        <div className="mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-medium leading-tight text-zinc-900 dark:text-zinc-100">
              {title}
            </h3>
            {descriptionMode === "tooltip" ? infoButton : null}
          </div>
          {descriptionMode === "inline" ? (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {description}
            </p>
          ) : null}
        </div>
        <div className="w-full">{children}</div>
      </div>
    );
  }

  return (
    <div
      className={`flex items-center justify-between gap-4 ${wrapperClasses} ${stateClasses}`}
    >
      <div className="max-w-[70%]">
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-medium leading-tight text-zinc-900 dark:text-zinc-100">
            {title}
          </h3>
          {descriptionMode === "tooltip" ? infoButton : null}
        </div>
        {descriptionMode === "inline" ? (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {description}
          </p>
        ) : null}
      </div>
      <div className="relative">{children}</div>
    </div>
  );
};
