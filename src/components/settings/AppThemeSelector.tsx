import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import type { AppThemePreference } from "@/bindings";

interface AppThemeSelectorProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const AppThemeSelector: React.FC<AppThemeSelectorProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const selectedTheme = (getSetting("app_theme") ||
      "system") as AppThemePreference;

    const options = [
      {
        value: "system",
        label: t("settings.general.theme.options.system"),
      },
      {
        value: "light",
        label: t("settings.general.theme.options.light"),
      },
      {
        value: "dark",
        label: t("settings.general.theme.options.dark"),
      },
    ];

    return (
      <SettingContainer
        title={t("settings.general.theme.title")}
        description={t("settings.general.theme.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
        tooltipPosition="bottom"
      >
        <Dropdown
          options={options}
          selectedValue={selectedTheme}
          onSelect={(value) =>
            updateSetting("app_theme", value as AppThemePreference)
          }
          disabled={isUpdating("app_theme")}
        />
      </SettingContainer>
    );
  },
);

