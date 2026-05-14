import React from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  variant?: "default" | "compact";
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", variant = "default", disabled, ...props }, ref) => {
    const baseClasses =
      "w-full rounded-2xl border border-black/5 bg-white/70 text-[15px] leading-tight text-zinc-900 shadow-[0_6px_20px_-14px_rgb(0_0_0_/_0.3)] backdrop-blur-3xl transition-[background-color,border-color,box-shadow,color,opacity] duration-150 placeholder:text-zinc-500/80 dark:border-white/10 dark:bg-zinc-900/70 dark:text-zinc-100 dark:placeholder:text-zinc-400/80";

    const interactiveClasses = disabled
      ? "cursor-not-allowed opacity-50"
      : "hover:bg-white/85 focus:outline-none focus:bg-white/90 focus:shadow-[0_0_0_1px_rgba(59,130,246,0.42),0_12px_28px_-18px_rgba(37,99,235,0.55)] dark:hover:bg-zinc-900/85 dark:focus:bg-zinc-900/90";

    const variantClasses = {
      default: "min-h-11 px-4 py-2",
      compact: "min-h-10 px-3 py-1.5 text-sm",
    } as const;

    return (
      <input
        ref={ref}
        className={`${baseClasses} ${variantClasses[variant]} ${interactiveClasses} ${className}`}
        disabled={disabled}
        {...props}
      />
    );
  },
);

Input.displayName = "Input";
