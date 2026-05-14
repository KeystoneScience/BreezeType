import React from "react";
import { SettingContainer } from "./SettingContainer";

interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  label: string;
  description: string;
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  showValue?: boolean;
  formatValue?: (value: number) => string;
}

export const Slider: React.FC<SliderProps> = ({
  value,
  onChange,
  min,
  max,
  step = 0.01,
  disabled = false,
  label,
  description,
  descriptionMode = "tooltip",
  grouped = false,
  showValue = true,
  formatValue = (v) => v.toFixed(2),
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(parseFloat(e.target.value));
  };

  const progress = ((value - min) / (max - min)) * 100;

  return (
    <SettingContainer
      title={label}
      description={description}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="horizontal"
      disabled={disabled}
    >
      <div className="w-full">
        <div className="flex h-8 items-center gap-2">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={handleChange}
            disabled={disabled}
            className="h-2 flex-grow cursor-pointer appearance-none rounded-full border border-black/5 bg-white/70 shadow-[0_4px_12px_-10px_rgb(0_0_0_/_0.4)] backdrop-blur-2xl focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_rgba(59,130,246,0.45),0_0_0_4px_rgba(59,130,246,0.16)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-zinc-900/70"
            style={{
              background: `linear-gradient(to right, rgb(37 99 235) ${progress}%, color-mix(in srgb, var(--color-border) 80%, transparent) ${progress}%)`,
            }}
          />
          {showValue && (
            <span className="min-w-12 text-right text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {formatValue(value)}
            </span>
          )}
        </div>
      </div>
    </SettingContainer>
  );
};
