import React from "react";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "primary";
  className?: string;
}

const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "primary",
  className = "",
}) => {
  const variantClasses = {
    primary:
      "border border-black/5 bg-blue-500/10 text-blue-600 dark:border-white/10 dark:text-blue-400",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
};

export default Badge;
