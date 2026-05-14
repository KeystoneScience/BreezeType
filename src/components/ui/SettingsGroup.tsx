import React from "react";

interface SettingsGroupProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  description,
  children,
}) => {
  return (
    <div className="space-y-3">
      {title && (
        <div className="px-2">
          <h2 className="text-xl font-medium text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {description}
            </p>
          )}
        </div>
      )}
      <div className="liquid-glass overflow-visible rounded-[28px]">
        <div className="divide-y divide-black/5 dark:divide-white/10">
          {children}
        </div>
      </div>
    </div>
  );
};
