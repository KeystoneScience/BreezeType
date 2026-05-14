import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface MeetingDetectionToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const MeetingDetectionToggle: React.FC<MeetingDetectionToggleProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("meeting_detection_enabled") ?? true;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(value) => updateSetting("meeting_detection_enabled", value)}
        isUpdating={isUpdating("meeting_detection_enabled")}
        label={t("settings.advanced.meetingDetection.label")}
        description={t("settings.advanced.meetingDetection.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
        tooltipPosition="bottom"
      />
    );
  },
);
