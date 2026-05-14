import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface RemoveFillerWordsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const RemoveFillerWords: React.FC<RemoveFillerWordsProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const enabled = getSetting("post_process_remove_fillers") ?? true;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(checked) =>
          updateSetting("post_process_remove_fillers", checked)
        }
        isUpdating={isUpdating("post_process_remove_fillers")}
        label={t("settings.advanced.removeFillerWords.label")}
        description={t("settings.advanced.removeFillerWords.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);

RemoveFillerWords.displayName = "RemoveFillerWords";
