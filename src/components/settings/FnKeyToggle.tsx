import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type } from "@tauri-apps/plugin-os";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

type OSType = "macos" | "windows" | "linux" | "unknown";

interface FnKeyToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const FnKeyToggle: React.FC<FnKeyToggleProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const [osType, setOsType] = useState<OSType>("unknown");

    useEffect(() => {
      let isMounted = true;
      const detectOsType = async () => {
        try {
          const detected = await type();
          if (isMounted) {
            setOsType(detected as OSType);
          }
        } catch (error) {
          console.error("Error detecting OS type:", error);
          if (isMounted) {
            setOsType("unknown");
          }
        }
      };

      detectOsType();
      return () => {
        isMounted = false;
      };
    }, []);

    if (osType !== "macos") {
      return null;
    }

    const pttEnabled = getSetting("push_to_talk") || false;
    const fnEnabled = getSetting("fn_key_ptt_enabled") || false;

    return (
      <ToggleSwitch
        checked={fnEnabled}
        onChange={(enabled) => updateSetting("fn_key_ptt_enabled", enabled)}
        isUpdating={isUpdating("fn_key_ptt_enabled")}
        disabled={!pttEnabled}
        label={t("settings.general.fnKey.label")}
        description={
          pttEnabled
            ? t("settings.general.fnKey.description")
            : t("settings.general.fnKey.requiresPushToTalk")
        }
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);
