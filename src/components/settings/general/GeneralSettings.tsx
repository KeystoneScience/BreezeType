import React from "react";
import { useTranslation } from "react-i18next";
import { MicrophoneSelector } from "../MicrophoneSelector";
import { BreezeTypeShortcut } from "../BreezeTypeShortcut";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { PushToTalk } from "../PushToTalk";
import { AudioFeedback } from "../AudioFeedback";
import { FnKeyToggle } from "../FnKeyToggle";
import { AppThemeSelector } from "../AppThemeSelector";

export const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="w-full space-y-6">
      <SettingsGroup title={t("settings.general.title")}>
        <AppThemeSelector descriptionMode="tooltip" grouped={true} />
        <BreezeTypeShortcut shortcutId="transcribe" grouped={true} />
        <BreezeTypeShortcut shortcutId="clipboard_history" grouped={true} />
        <BreezeTypeShortcut shortcutId="quick_task" grouped={true} />
        <PushToTalk descriptionMode="tooltip" grouped={true} />
        <FnKeyToggle grouped={true} />
      </SettingsGroup>
      <SettingsGroup title={t("settings.sound.title")}>
        <MicrophoneSelector descriptionMode="tooltip" grouped={true} />
        <AudioFeedback descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
    </div>
  );
};
