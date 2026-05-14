import React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { GeneralSettings } from "./general/GeneralSettings";
import { AdvancedSettings } from "./advanced/AdvancedSettings";
import { DebugSettings } from "./debug/DebugSettings";
import { AboutSettings } from "./about/AboutSettings";

export const SettingsPage: React.FC = () => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  return (
    <div className="mx-auto w-full max-w-[980px]">
      <section className="w-full px-4 py-6">
        <div className="flex flex-col gap-10">
          <div className="space-y-2">
            <h1 className="app-display">{t("nav.settings")}</h1>
            <p className="app-caption max-w-[760px]">
              {t("home.cards.settings")}
            </p>
          </div>
          <GeneralSettings />
          <AdvancedSettings />
          {settings?.debug_mode && <DebugSettings />}
          <AboutSettings />
        </div>
      </section>
    </div>
  );
};
