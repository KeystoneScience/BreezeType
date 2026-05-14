import React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { Slider } from "../ui/Slider";

interface MuteWhileRecordingToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const MuteWhileRecording: React.FC<MuteWhileRecordingToggleProps> =
  React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting } = useSettings();
    const level = getSetting("recording_duck_level") ?? 0.09;

    return (
      <Slider
        value={level}
        onChange={(value: number) => updateSetting("recording_duck_level", value)}
        min={0}
        max={1}
        step={0.01}
        label={t("settings.advanced.audioWhileSpeaking.label")}
        description={t("settings.advanced.audioWhileSpeaking.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
        formatValue={(value) => `${Math.round(value * 100)}%`}
      />
    );
  });
