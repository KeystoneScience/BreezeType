import React from "react";
import { useTranslation } from "react-i18next";
import {
  ClipboardList,
  History as HistoryIcon,
  HelpCircle,
  Home,
  ListChecks,
  Video,
  Settings,
} from "lucide-react";
import BreezeTypeTextLogo from "./icons/BreezeTypeTextLogo";
import UpdateChecker from "./update-checker";

export type SidebarSection =
  | "home"
  | "history"
  | "clipboard"
  | "tasks"
  | "meetings"
  | "settings"
  | "help";

interface IconProps {
  width?: number | string;
  height?: number | string;
  size?: number | string;
  className?: string;
  [key: string]: any;
}

const PRIMARY_NAV: {
  id: SidebarSection;
  labelKey: string;
  icon: React.ComponentType<IconProps>;
}[] = [
  { id: "home", labelKey: "nav.home", icon: Home },
  { id: "history", labelKey: "nav.history", icon: HistoryIcon },
  { id: "clipboard", labelKey: "nav.clipboardHistory", icon: ClipboardList },
  { id: "tasks", labelKey: "nav.tasks", icon: ListChecks },
  { id: "meetings", labelKey: "nav.meetings", icon: Video },
];

const SECONDARY_NAV: {
  id: SidebarSection;
  labelKey: string;
  icon: React.ComponentType<IconProps>;
}[] = [
  { id: "settings", labelKey: "nav.settings", icon: Settings },
  { id: "help", labelKey: "nav.help", icon: HelpCircle },
];

interface SidebarProps {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSectionChange,
}) => {
  const { t } = useTranslation();

  return (
    <aside className="liquid-glass flex h-full w-60 shrink-0 flex-col overflow-hidden overscroll-none rounded-r-[28px] px-3 pb-4 pt-[calc(var(--titlebar-height)+12px)]">
      <div className="px-2 pb-4">
        <BreezeTypeTextLogo width={168} className="opacity-95" />
        <UpdateChecker
          className="mt-2"
          autoInstallOnIdle={true}
          showWhenUpdateAvailableOnly={true}
          variant="sidebar"
        />
      </div>

      <div className="liquid-separator flex flex-col gap-1 border-t pt-3">
        {PRIMARY_NAV.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;

          return (
            <button
              key={section.id}
              type="button"
              className={`flex min-h-[44px] w-full items-center gap-[8px] rounded-2xl px-[12px] py-[8px] text-left text-[15px] ${
                isActive
                  ? "bg-blue-500/12 text-blue-600 dark:text-blue-500"
                  : "bg-transparent text-zinc-700 hover:bg-blue-500/10 dark:text-zinc-300"
              }`}
              onClick={() => onSectionChange(section.id)}
            >
              <span className="flex h-[20px] w-[20px] shrink-0 translate-y-px items-center justify-center">
                <Icon
                  size={18}
                  strokeWidth={2}
                  absoluteStrokeWidth
                  className="block h-[18px] w-[18px]"
                />
              </span>
              <span
                className="truncate font-medium leading-[20px]"
                title={t(section.labelKey)}
              >
                {t(section.labelKey)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-auto">
        <div className="liquid-separator flex flex-col gap-1 border-t pt-3">
          {SECONDARY_NAV.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                className={`flex min-h-[44px] w-full items-center gap-[8px] rounded-2xl px-[12px] py-[8px] text-left text-[15px] ${
                  isActive
                    ? "bg-blue-500/12 text-blue-600 dark:text-blue-500"
                    : "bg-transparent text-zinc-700 hover:bg-blue-500/10 dark:text-zinc-300"
                }`}
                onClick={() => onSectionChange(section.id)}
              >
                <span className="flex h-[20px] w-[20px] shrink-0 translate-y-px items-center justify-center">
                  <Icon
                    size={18}
                    strokeWidth={2}
                    absoluteStrokeWidth
                    className="block h-[18px] w-[18px]"
                  />
                </span>
                <span
                  className="truncate font-medium leading-[20px]"
                  title={t(section.labelKey)}
                >
                  {t(section.labelKey)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
};
