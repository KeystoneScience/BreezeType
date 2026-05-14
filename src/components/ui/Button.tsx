import React from "react";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  iconOnly?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  className = "",
  variant = "primary",
  size = "md",
  iconOnly = false,
  ...props
}) => {
  const baseClasses =
    "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap select-none font-medium transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-150 ease-out focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:pointer-events-none";

  const sizeClasses = iconOnly
    ? "h-11 w-11 rounded-xl"
    : {
        sm: "min-h-11 rounded-2xl px-4 py-2 text-sm",
        md: "min-h-12 rounded-3xl px-6 py-4 text-[15px] leading-tight",
        lg: "min-h-12 rounded-3xl px-7 py-4 text-base",
      }[size];

  const focusRing =
    "focus-visible:shadow-[0_0_0_1px_rgba(59,130,246,0.5),0_0_0_5px_rgba(59,130,246,0.16)]";

  const variantClasses = {
    primary:
      "border border-white/30 bg-blue-600 text-white shadow-[0_8px_32px_-12px_rgb(0_0_0_/_0.25)] backdrop-blur-3xl hover:bg-blue-500 hover:shadow-[0_14px_36px_-14px_rgb(37_99_235_/_0.65)] active:scale-[0.98] dark:border-white/10 dark:bg-blue-500 dark:hover:bg-blue-400",
    secondary:
      "border border-black/5 bg-white/20 text-blue-600 shadow-[0_6px_18px_-14px_rgb(0_0_0_/_0.25)] backdrop-blur-3xl hover:bg-blue-500/10 active:scale-[0.98] dark:border-white/10 dark:bg-zinc-900/20 dark:text-blue-500 dark:hover:bg-blue-500/10",
    danger:
      "border border-black/5 bg-white/20 text-red-600 shadow-[0_6px_18px_-14px_rgb(0_0_0_/_0.25)] backdrop-blur-3xl hover:bg-red-500/10 hover:text-red-700 active:scale-[0.98] dark:border-white/10 dark:bg-zinc-900/20 dark:text-red-400 dark:hover:bg-red-500/15",
    ghost:
      "border border-transparent bg-transparent text-blue-600/80 shadow-none hover:bg-blue-500/10 hover:text-blue-600 active:scale-[0.98] dark:text-blue-500/80 dark:hover:text-blue-500",
  };

  const iconOnlyClasses = iconOnly
    ? "bg-transparent text-zinc-500/75 shadow-none hover:bg-white/75 hover:text-zinc-900 hover:shadow-[0_8px_24px_-14px_rgb(0_0_0_/_0.25)] dark:text-zinc-400/80 dark:hover:bg-zinc-900/75 dark:hover:text-zinc-100"
    : "";

  return (
    <button
      className={`${baseClasses} ${sizeClasses} ${focusRing} ${variantClasses[variant]} ${iconOnlyClasses} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};
