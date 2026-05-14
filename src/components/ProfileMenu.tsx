import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  LoaderCircle,
  LogOut,
  Mail,
  User,
  UserCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/authStore";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import BreezeTypeTextLogo from "./icons/BreezeTypeTextLogo";

type AuthScreen = "options" | "email";

const optionButtonClass =
  "relative flex min-h-11 w-full items-center justify-center rounded-2xl border border-black/5 bg-white/60 px-4 py-2 text-sm font-medium text-zinc-900 shadow-[0_6px_20px_-14px_rgb(0_0_0_/_0.28)] backdrop-blur-3xl transition-all duration-150 hover:bg-blue-500/10 focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_rgba(59,130,246,0.5),0_0_0_5px_rgba(59,130,246,0.16)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:bg-zinc-900/60 dark:text-zinc-100 dark:hover:bg-blue-500/10";

const optionIconClass =
  "absolute left-4 flex h-6 w-6 items-center justify-center text-zinc-500 dark:text-zinc-400";

const validateEmail = (value: string) =>
  String(value)
    .toLowerCase()
    .match(
      /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
    );

const validatePassword = (value: string) => {
  if (!value.trim()) {
    return "Password cannot be empty.";
  }

  if (value.length > 128) {
    return "Password must be 128 characters or fewer.";
  }

  return null;
};

const AppleIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-current">
    <path d="M15.11 3.17c0 1.14-.42 2.18-1.12 2.96-.77.87-2.02 1.53-3.1 1.44-.14-1.11.44-2.28 1.12-3.03.76-.83 2.08-1.48 3.1-1.37ZM19.17 17.06c-.43.99-.63 1.43-1.18 2.27-.77 1.17-1.87 2.63-3.24 2.64-1.21.01-1.52-.79-3.16-.78-1.64.01-1.98.79-3.19.78-1.37-.01-2.41-1.33-3.19-2.5-2.18-3.28-2.41-7.13-1.07-9.19.95-1.46 2.46-2.32 3.88-2.32 1.45 0 2.36.79 3.55.79 1.16 0 1.86-.8 3.54-.8 1.27 0 2.62.69 3.57 1.89-3.14 1.72-2.63 6.16.49 7.22Z" />
  </svg>
);

const GoogleIcon: React.FC = () => (
  <svg
    viewBox="-1 -1 26 26"
    aria-hidden="true"
    className="block h-[18px] w-[18px] shrink-0 overflow-visible"
  >
    <path
      fill="#4285F4"
      d="M23.49 12.27c0-.79-.07-1.55-.21-2.27H12v4.3h6.44a5.5 5.5 0 0 1-2.39 3.61v2.99h3.87c2.27-2.09 3.57-5.18 3.57-8.63Z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.87-2.99c-1.07.72-2.44 1.15-4.08 1.15-3.14 0-5.8-2.12-6.75-4.96H1.25v3.08A12 12 0 0 0 12 24Z"
    />
    <path
      fill="#FBBC05"
      d="M5.25 14.3A7.2 7.2 0 0 1 4.88 12c0-.8.14-1.57.37-2.3V6.62H1.25A12 12 0 0 0 0 12c0 1.94.46 3.78 1.25 5.38l4-3.08Z"
    />
    <path
      fill="#EA4335"
      d="M12 4.77c1.76 0 3.35.61 4.6 1.82l3.45-3.45C17.95 1.15 15.24 0 12 0A12 12 0 0 0 1.25 6.62l4 3.08C6.2 6.89 8.86 4.77 12 4.77Z"
    />
  </svg>
);

interface AuthOptionButtonProps {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}

const AuthOptionButton: React.FC<AuthOptionButtonProps> = ({
  label,
  icon,
  disabled,
  onClick,
}) => (
  <button
    type="button"
    className={optionButtonClass}
    disabled={disabled}
    onClick={onClick}
  >
    <span className={optionIconClass}>{icon}</span>
    <span>{label}</span>
  </button>
);

const ProfileMenu: React.FC = () => {
  const { t } = useTranslation();
  const {
    user,
    token,
    login,
    loginWithBrowser,
    cancelBrowserLogin,
    logout,
    isLoading,
    browserAuthProvider,
    error,
    clearError,
  } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<AuthScreen>("options");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const displayName = user?.name || user?.email || "BreezeType";
  const activeError = localError || error;

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (!open) {
      if (browserAuthProvider && !token) {
        void cancelBrowserLogin();
      }
      setScreen("options");
      setLocalError(null);
      clearError();
      return;
    }

    if (token) {
      setScreen("options");
    }
  }, [browserAuthProvider, cancelBrowserLogin, clearError, open, token]);

  const handleBrowserSignIn = async (provider: "apple" | "google") => {
    setLocalError(null);
    clearError();
    const result = await loginWithBrowser(provider);
    if (result.ok) {
      setOpen(false);
    }
  };

  const handleEmailLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);

    if (!validateEmail(email.trim())) {
      setLocalError("Enter a valid email address.");
      return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      setLocalError(passwordError);
      return;
    }

    const result = await login(email.trim(), password);
    if (result.ok) {
      setPassword("");
      setOpen(false);
    }
  };

  const renderLoggedOutContent = () => {
    if (screen === "email") {
      return (
        <form onSubmit={handleEmailLogin} className="space-y-4">
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => {
                setLocalError(null);
                clearError();
                setScreen("options");
              }}
              disabled={isLoading}
              className="inline-flex items-center gap-1 rounded-xl px-1.5 py-1 text-xs font-medium text-blue-600/85 transition-colors hover:bg-blue-500/10 hover:text-blue-600 focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_rgba(59,130,246,0.5),0_0_0_4px_rgba(59,130,246,0.16)] dark:text-blue-400/85 dark:hover:bg-blue-500/10 dark:hover:text-blue-400"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t("profileMenu.back", { defaultValue: "Back" })}
            </button>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {t("profileMenu.emailTitle", {
                defaultValue: "Continue with your email below.",
              })}
            </p>
            <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">
              {t("profileMenu.emailDescription", {
                defaultValue:
                  "Use the same BreezeType account you use on the web. If you are new, BreezeType creates your account automatically.",
              })}
            </p>
          </div>

          <div className="space-y-2">
            <Input
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isLoading}
            />
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isLoading}
            />
          </div>

          {activeError && (
            <p className="min-h-[1.25rem] text-xs text-red-500">
              {activeError}
            </p>
          )}

          <Button
            type="submit"
            disabled={isLoading}
            variant="primary"
            size="md"
            className="w-full"
          >
            {isLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <Mail className="h-4 w-4" />
            )}
            {isLoading ? "Signing in..." : "Continue with email"}
          </Button>
        </form>
      );
    }

    return (
      <div className="space-y-4">
        <div className="space-y-3 text-center">
          <div className="flex justify-center">
            <BreezeTypeTextLogo width={168} className="opacity-95" />
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {t("profileMenu.signInTitle", {
                defaultValue: "Sign in to BreezeType",
              })}
            </p>
          </div>
        </div>

        <div className="space-y-2.5">
          <AuthOptionButton
            label={t("profileMenu.apple", { defaultValue: "Apple" })}
            icon={<AppleIcon />}
            disabled={isLoading}
            onClick={() => void handleBrowserSignIn("apple")}
          />
          <AuthOptionButton
            label={t("profileMenu.google", { defaultValue: "Google" })}
            icon={<GoogleIcon />}
            disabled={isLoading}
            onClick={() => void handleBrowserSignIn("google")}
          />
          <AuthOptionButton
            label={t("profileMenu.email", { defaultValue: "Email" })}
            icon={<Mail className="h-5 w-5" />}
            disabled={isLoading}
            onClick={() => {
              setLocalError(null);
              setScreen("email");
            }}
          />
        </div>

        <div className="min-h-[1.25rem] text-center text-xs text-red-500">
          {activeError || null}
        </div>
        {browserAuthProvider ? (
          <div className="space-y-2 text-center">
            <div className="flex items-center justify-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              {t("profileMenu.finishBrowserSignIn", {
                defaultValue:
                  "Finish sign-in in the BreezeType sign-in window.",
              })}
            </div>
            <button
              type="button"
              className="text-xs font-medium text-zinc-500 transition-opacity hover:opacity-70 dark:text-zinc-400"
              onClick={() => {
                void cancelBrowserLogin();
              }}
            >
              {t("profileMenu.cancelSignIn", {
                defaultValue: "Cancel sign-in",
              })}
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div ref={wrapperRef} className="fixed right-2 top-2 z-[70]">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="profile-avatar-button"
        aria-label="Account"
      >
        {user?.profile_image ? (
          <img
            src={user.profile_image}
            alt={displayName}
            className="h-full w-full rounded-full object-cover"
          />
        ) : (
          <UserCircle className="h-5 w-5" />
        )}
      </button>

      {open && (
        <div className="profile-pop absolute right-0 mt-3 w-[22rem]">
          <div className="liquid-glass relative overflow-hidden rounded-3xl">
            <div className="profile-aurora absolute inset-0 opacity-70" />
            <div className="relative z-10 space-y-4 p-5 text-zinc-900 dark:text-zinc-100">
              {token ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="liquid-glass flex h-11 w-11 items-center justify-center rounded-full">
                      <User className="h-5 w-5 text-zinc-700 dark:text-zinc-200" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{displayName}</p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {t("profileMenu.loggedIn", {
                          defaultValue: "Logged in",
                        })}
                      </p>
                    </div>
                  </div>
                  <Button
                    onClick={logout}
                    variant="secondary"
                    size="md"
                    className="w-full"
                  >
                    <LogOut className="h-4 w-4" />
                    {t("profileMenu.logOut", { defaultValue: "Log out" })}
                  </Button>
                </div>
              ) : (
                renderLoggedOutContent()
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProfileMenu;
