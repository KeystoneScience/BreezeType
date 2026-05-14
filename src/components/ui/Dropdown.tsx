import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface DropdownProps {
  options: DropdownOption[];
  className?: string;
  selectedValue: string | null;
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onRefresh?: () => void;
}

export const Dropdown: React.FC<DropdownProps> = ({
  options,
  selectedValue,
  onSelect,
  className = "",
  placeholder = "Select an option...",
  disabled = false,
  onRefresh,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedOption = options.find(
    (option) => option.value === selectedValue,
  );

  const handleSelect = (value: string) => {
    onSelect(value);
    setIsOpen(false);
  };

  const handleToggle = () => {
    if (disabled) return;
    if (!isOpen && onRefresh) onRefresh();
    setIsOpen(!isOpen);
  };

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      <button
        type="button"
        className={`flex min-h-11 min-w-[200px] items-center justify-between gap-2 rounded-2xl border border-black/5 bg-white/70 px-4 py-2 text-left text-sm text-zinc-900 shadow-[0_6px_20px_-14px_rgb(0_0_0_/_0.28)] backdrop-blur-3xl transition-[background-color,border-color,box-shadow,color,opacity] duration-150 dark:border-white/10 dark:bg-zinc-900/70 dark:text-zinc-100 ${
          disabled
            ? "cursor-not-allowed opacity-50"
            : "cursor-pointer hover:bg-white/88 focus:outline-none focus:bg-white/90 focus:shadow-[0_0_0_1px_rgba(59,130,246,0.45),0_12px_28px_-18px_rgba(37,99,235,0.55)] dark:hover:bg-zinc-900/88 dark:focus:bg-zinc-900/90"
        }`}
        onClick={handleToggle}
        disabled={disabled}
      >
        <span className="truncate">{selectedOption?.label || placeholder}</span>
        <svg
          className={`h-4 w-4 text-zinc-500 transition-transform duration-200 dark:text-zinc-400 ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>
      {isOpen && !disabled && (
        <div className="liquid-glass absolute left-0 right-0 top-full z-50 mt-2 max-h-60 overflow-y-auto rounded-2xl p-1">
          {options.length === 0 ? (
            <div className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
              {t("common.noOptionsFound")}
            </div>
          ) : (
            options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`w-full rounded-xl px-3 py-2 text-left text-sm transition-colors duration-150 ${
                  selectedValue === option.value
                    ? "bg-blue-500/10 font-medium text-blue-600 dark:text-blue-500"
                    : "text-zinc-700 hover:bg-blue-500/10 dark:text-zinc-200"
                } ${option.disabled ? "cursor-not-allowed opacity-50" : ""}`}
                onClick={() => handleSelect(option.value)}
                disabled={option.disabled}
              >
                <span className="truncate">{option.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
