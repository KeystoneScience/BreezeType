/* eslint-disable i18next/no-literal-string */
import React from "react";

interface SettingsErrorBoundaryProps {
  children: React.ReactNode;
  onExit?: () => void;
}

interface SettingsErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class SettingsErrorBoundary extends React.Component<
  SettingsErrorBoundaryProps,
  SettingsErrorBoundaryState
> {
  state: SettingsErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: Error): SettingsErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || "Unknown error",
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Settings page crashed:", error, info);
  }

  handleExit = () => {
    this.setState({ hasError: false, message: "" });
    this.props.onExit?.();
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="liquid-glass mx-auto w-full max-w-[980px] rounded-3xl p-6">
        <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Settings crashed
        </h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Something went wrong while rendering Settings. You can go back or
          reload the app.
        </p>
        <p className="mt-3 text-xs font-mono text-zinc-500/85 dark:text-zinc-400/85">
          {this.state.message}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <button
            className="min-h-11 rounded-3xl border border-white/30 bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-[0_8px_24px_-14px_rgb(37_99_235_/_0.65)] transition-all hover:bg-blue-500 active:scale-[0.98] dark:border-white/10 dark:bg-blue-500 dark:hover:bg-blue-400"
            onClick={this.handleExit}
          >
            Back to Home
          </button>
          <button
            className="min-h-11 rounded-3xl border border-black/5 bg-white/25 px-5 py-2 text-sm font-medium text-blue-600 backdrop-blur-3xl transition-all hover:bg-blue-500/10 active:scale-[0.98] dark:border-white/10 dark:bg-zinc-900/25 dark:text-blue-500"
            onClick={this.handleReload}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
