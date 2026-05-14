import React from "react";
import ResetIcon from "../icons/ResetIcon";

interface ResetButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  children?: React.ReactNode;
}

export const ResetButton: React.FC<ResetButtonProps> = React.memo(
  ({ onClick, disabled = false, className = "", ariaLabel, children }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-xl bg-transparent text-zinc-500/75 transition-all duration-150 ${
        disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer hover:bg-white/75 hover:text-zinc-900 hover:shadow-[0_8px_24px_-14px_rgb(0_0_0_/_0.25)] active:scale-[0.98] dark:hover:bg-zinc-900/75 dark:hover:text-zinc-100"
      } ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children ?? <ResetIcon />}
    </button>
  ),
);
