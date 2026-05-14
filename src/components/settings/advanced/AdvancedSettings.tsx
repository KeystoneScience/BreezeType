import React from "react";
import { useTranslation } from "react-i18next";
import { ShowOverlay } from "../ShowOverlay";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { StartHidden } from "../StartHidden";
import { AutostartToggle } from "../AutostartToggle";
import { PasteMethodSetting } from "../PasteMethod";
import { LanguageSelector } from "../LanguageSelector";
import { MeetingDetectionToggle } from "../MeetingDetectionToggle";
import { MuteWhileRecording } from "../MuteWhileRecording";
import { RemoveFillerWords } from "../RemoveFillerWords";

export const AdvancedSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="w-full space-y-6">
      <SettingsGroup title={t("settings.advanced.title")}>
        <StartHidden descriptionMode="tooltip" grouped={true} />
        <AutostartToggle descriptionMode="tooltip" grouped={true} />
        <ShowOverlay descriptionMode="tooltip" grouped={true} />
        <MeetingDetectionToggle descriptionMode="tooltip" grouped={true} />
        <PasteMethodSetting descriptionMode="tooltip" grouped={true} />
        <MuteWhileRecording descriptionMode="tooltip" grouped={true} />
        <LanguageSelector descriptionMode="tooltip" grouped={true} />
        <RemoveFillerWords descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
    </div>
  );
};
