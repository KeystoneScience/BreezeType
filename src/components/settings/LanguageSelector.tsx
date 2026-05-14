import React, { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { SettingContainer } from "../ui/SettingContainer";
import { ResetButton } from "../ui/ResetButton";
import { useSettings } from "../../hooks/useSettings";
import { useModels } from "../../hooks/useModels";
import { LANGUAGES } from "../../lib/constants/languages";

interface LanguageSelectorProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

const unsupportedModels = ["parakeet-tdt-0.6b-v3"];

export const LanguageSelector: React.FC<LanguageSelectorProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, resetSetting, isUpdating } = useSettings();
  const { currentModel, loadCurrentModel } = useModels();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selectedLanguage = getSetting("selected_language") || "auto";
  const isUnsupported = unsupportedModels.includes(currentModel);

  useEffect(() => {
    if (isUnsupported) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSearchQuery("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Listen for model state changes to update UI reactively
  useEffect(() => {
    if (isUnsupported) return;
    const modelStateUnlisten = listen("model-state-changed", () => {
      loadCurrentModel();
    });

    return () => {
      modelStateUnlisten.then((fn) => fn());
    };
  }, [loadCurrentModel]);

  useEffect(() => {
    if (isUnsupported) return;
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen, isUnsupported]);

  const filteredLanguages = useMemo(
    () =>
      LANGUAGES.filter((language) =>
        language.label.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    [searchQuery],
  );

  const selectedLanguageName =
    LANGUAGES.find((lang) => lang.value === selectedLanguage)?.label ||
    t("settings.general.language.auto");

  const handleLanguageSelect = async (languageCode: string) => {
    await updateSetting("selected_language", languageCode);
    setIsOpen(false);
    setSearchQuery("");
  };

  const handleReset = async () => {
    await resetSetting("selected_language");
  };

  const handleToggle = () => {
    if (isUpdating("selected_language")) return;
    setIsOpen(!isOpen);
  };

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && filteredLanguages.length > 0) {
      // Select first filtered language on Enter
      handleLanguageSelect(filteredLanguages[0].value);
    } else if (event.key === "Escape") {
      setIsOpen(false);
      setSearchQuery("");
    }
  };

  if (isUnsupported) {
    return null;
  }

  return (
    <SettingContainer
      title={t("settings.general.language.title")}
      description={t("settings.general.language.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    >
      <div className="flex items-center space-x-1">
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            className={`flex min-h-11 min-w-[200px] items-center justify-between rounded-2xl border border-black/5 bg-white/70 px-4 py-2 text-left text-sm shadow-[0_6px_20px_-14px_rgb(0_0_0_/_0.28)] backdrop-blur-3xl transition-all duration-150 dark:border-white/10 dark:bg-zinc-900/70 ${
              isUpdating("selected_language")
                ? "opacity-50 cursor-not-allowed"
                : "cursor-pointer hover:bg-white/88 dark:hover:bg-zinc-900/88"
            }`}
            onClick={handleToggle}
            disabled={isUpdating("selected_language")}
          >
            <span className="truncate">{selectedLanguageName}</span>
            <svg
              className={`w-4 h-4 ml-2 transition-transform duration-200 ${
                isOpen ? "transform rotate-180" : ""
              }`}
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

          {isOpen && !isUpdating("selected_language") && (
            <div className="liquid-glass absolute left-0 right-0 top-full z-50 mt-2 max-h-60 overflow-hidden rounded-2xl">
              {/* Search input */}
              <div className="border-b border-black/5 p-2 dark:border-white/10">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={handleSearchChange}
                  onKeyDown={handleKeyDown}
                  placeholder={t("settings.general.language.searchPlaceholder")}
                  className="w-full rounded-xl border border-black/5 bg-white/70 px-3 py-2 text-sm text-zinc-800 shadow-[0_6px_18px_-14px_rgb(0_0_0_/_0.3)] backdrop-blur-2xl focus:outline-none focus:shadow-[0_0_0_1px_rgba(59,130,246,0.42),0_12px_28px_-18px_rgba(37,99,235,0.55)] dark:border-white/10 dark:bg-zinc-900/70 dark:text-zinc-100"
                />
              </div>

              <div className="max-h-48 overflow-y-auto">
                {filteredLanguages.length === 0 ? (
                  <div className="px-2 py-2 text-center text-sm text-zinc-500 dark:text-zinc-400">
                    {t("settings.general.language.noResults")}
                  </div>
                ) : (
                  filteredLanguages.map((language) => (
                    <button
                      key={language.value}
                      type="button"
                      className={`w-full px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-blue-500/10 ${
                        selectedLanguage === language.value
                          ? "bg-blue-500/10 font-semibold text-blue-600 dark:text-blue-500"
                          : ""
                      }`}
                      onClick={() => handleLanguageSelect(language.value)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate">{language.label}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <ResetButton
          onClick={handleReset}
          disabled={isUpdating("selected_language") || isUnsupported}
        />
      </div>
      {isUpdating("selected_language") && (
        <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-white/35 backdrop-blur-sm dark:bg-black/35">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500/70 border-t-transparent"></div>
        </div>
      )}
    </SettingContainer>
  );
};
