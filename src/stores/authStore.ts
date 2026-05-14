import { create } from "zustand";
import { commands, type Result } from "@/bindings";
import { getServerEndpoint, getServerUrl } from "@/lib/serverApi";
import { start as startAuthSession } from "tauri-plugin-auth-session-api";
import {
  setTelemetryAuthToken,
  trackAppEvent,
  trackAppEventOnce,
} from "@/lib/telemetry";

const AUTH_TOKEN_KEY = "breeze_auth_token";
const AUTH_REQUEST_TIMEOUT_MS = 30_000;
const AUTH_SESSION_CALLBACK_SCHEME = "com.pais.breeze.dev";
const AUTH_SESSION_CALLBACK_URL = `${AUTH_SESSION_CALLBACK_SCHEME}:/auth/callback`;
const BROWSER_AUTH_CANCELLED_MESSAGE = "Browser sign-in was cancelled.";
const AUTH_REQUEST_TIMEOUT_MESSAGE =
  "BreezeType sign-in took too long. Check your connection and try again.";
type BrowserAuthProvider = "apple" | "google";
type AuthApiResponse = {
  success?: boolean;
  authToken?: string;
  code?: string;
  desktopState?: string;
  message?: string;
  body?: AuthUser | null;
};
type AuthSessionStartResponse = AuthApiResponse & {
  authUrl?: string;
  callbackUrlScheme?: string;
};

let browserAuthAttemptCounter = 0;
let activeBrowserAuthAttemptId = 0;

const startBrowserAuthAttempt = () => {
  browserAuthAttemptCounter += 1;
  activeBrowserAuthAttemptId = browserAuthAttemptCounter;
  return activeBrowserAuthAttemptId;
};

const isActiveBrowserAuthAttempt = (attemptId: number) =>
  activeBrowserAuthAttemptId === attemptId;

const finishBrowserAuthAttempt = (attemptId: number) => {
  if (isActiveBrowserAuthAttempt(attemptId)) {
    activeBrowserAuthAttemptId = 0;
  }
};

const cancelBrowserAuthListener = async () => {
  try {
    await commands.cancelBrowserAccountAuth();
  } catch (error) {
    console.warn("Failed to cancel browser sign-in listener:", error);
  }
};

const createDesktopState = () => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join(
    "",
  );
};

const getCallbackUrl = (callbackUrl: string, expectedDesktopState?: string) => {
  const url = new URL(callbackUrl);
  if (
    url.protocol !== `${AUTH_SESSION_CALLBACK_SCHEME}:` ||
    url.pathname !== "/auth/callback"
  ) {
    throw new Error("BreezeType sign-in returned an unexpected callback.");
  }
  if (
    expectedDesktopState &&
    url.searchParams.get("desktop_state") !== expectedDesktopState
  ) {
    throw new Error("BreezeType sign-in returned an unexpected state.");
  }

  return url;
};

const getAuthCodeFromCallbackUrl = (
  callbackUrl: string,
  expectedDesktopState: string,
) => {
  const url = getCallbackUrl(callbackUrl, expectedDesktopState);
  const authError = url.searchParams.get("autherror");
  if (authError) {
    throw new Error(authError);
  }

  const authCode = url.searchParams.get("authcode");
  if (!authCode) {
    throw new Error("BreezeType sign-in did not return an authorization code.");
  }

  return authCode;
};

const isAuthSessionUnavailable = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("only available on Apple and Android") ||
    message.includes("plugin:auth-session") ||
    message.includes("command not found")
  );
};

const waitForNativeAuthSessionCode = async (
  provider: BrowserAuthProvider,
): Promise<Result<string, string>> => {
  try {
    if (provider === "google") {
      const result = await commands.beginBrowserAccountAuth(
        "google",
        getServerUrl(),
      );

      if (result.status === "ok") {
        return result;
      }

      return {
        status: "error",
        error:
          typeof result.error === "string"
            ? result.error
            : "Unable to complete Google sign-in. Please try again.",
      };
    }

    const desktopState = createDesktopState();
    const startUrl = new URL(
      `/account/gg/${provider}/desktop/start`,
      getServerUrl(),
    );
    startUrl.searchParams.set("callback_uri", AUTH_SESSION_CALLBACK_URL);
    startUrl.searchParams.set("client_state", desktopState);

    const { response, data } =
      await fetchJsonWithTimeout<AuthSessionStartResponse>(
        startUrl.toString(),
        {
          method: "GET",
        },
      );

    if (!response.ok || !data?.success || !data?.authUrl) {
      throw new Error(
        data?.message ||
          "Unable to start BreezeType sign-in. Please try again.",
      );
    }

    const callbackUrl = await startAuthSession(
      data.authUrl,
      data.callbackUrlScheme || AUTH_SESSION_CALLBACK_SCHEME,
    );

    return {
      status: "ok",
      data: getAuthCodeFromCallbackUrl(callbackUrl, desktopState),
    };
  } catch (error) {
    if (String(error) === "user_cancelled") {
      return { status: "error", error: BROWSER_AUTH_CANCELLED_MESSAGE };
    }
    if (isAuthSessionUnavailable(error)) {
      return {
        status: "error",
        error: "Desktop sign-in is not available in this app build.",
      };
    }
    const message =
      error instanceof Error
        ? error.message
        : "Unable to complete sign-in. Please try again.";
    return { status: "error", error: message };
  }
};

const waitForAccountAuthCode = async (
  provider: BrowserAuthProvider,
): Promise<Result<string, string>> => {
  return waitForNativeAuthSessionCode(provider);
};

const fetchJsonWithTimeout = async <T>(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  timeoutMessage = AUTH_REQUEST_TIMEOUT_MESSAGE,
): Promise<{ response: Response; data: T }> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, AUTH_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const data = (await response.json()) as T;
    return { response, data };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

export interface AuthUser {
  user_id?: string;
  email?: string;
  name?: string | null;
  profile_image?: string | null;
}

interface AuthStore {
  token: string | null;
  user: AuthUser | null;
  isLoading: boolean;
  browserAuthProvider: BrowserAuthProvider | null;
  error: string | null;
  initialize: () => Promise<void>;
  clearError: () => void;
  login: (
    email: string,
    password: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  loginWithBrowser: (
    provider: BrowserAuthProvider,
  ) => Promise<{ ok: boolean; error?: string }>;
  cancelBrowserLogin: () => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<boolean>;
}

const getStoredToken = () => {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(AUTH_TOKEN_KEY);
};

const setStoredToken = (token: string | null) => {
  if (typeof window === "undefined") return;
  if (token) {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
  }
};

export const useAuthStore = create<AuthStore>((set, get) => ({
  token: null,
  user: null,
  isLoading: false,
  browserAuthProvider: null,
  error: null,

  initialize: async () => {
    const token = getStoredToken();
    if (token) {
      setTelemetryAuthToken(token);
      set({ token });
      await get().refreshUser();
      return;
    }
    setTelemetryAuthToken(null);
    set({ token: null, user: null, error: null });
  },

  clearError: () => {
    set({ error: null });
  },

  loginWithBrowser: async (provider) => {
    const attemptId = startBrowserAuthAttempt();
    trackAppEvent("activation.auth_started", { provider, method: "browser" });
    set({ isLoading: true, browserAuthProvider: provider, error: null });
    try {
      const authCodeResult = await waitForAccountAuthCode(provider);
      if (!isActiveBrowserAuthAttempt(attemptId)) {
        return { ok: false, error: BROWSER_AUTH_CANCELLED_MESSAGE };
      }

      if (authCodeResult.status !== "ok") {
        if (authCodeResult.error === BROWSER_AUTH_CANCELLED_MESSAGE) {
          trackAppEvent("activation.auth_cancelled", {
            provider,
            method: "browser",
          });
          finishBrowserAuthAttempt(attemptId);
          set({ isLoading: false, browserAuthProvider: null, error: null });
          return { ok: false, error: BROWSER_AUTH_CANCELLED_MESSAGE };
        }
        throw new Error(authCodeResult.error);
      }

      const authCode = authCodeResult.data;

      set({ browserAuthProvider: null });
      const { response, data } = await fetchJsonWithTimeout<AuthApiResponse>(
        getServerEndpoint("/account/authcode/login"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: authCode }),
        },
      );
      if (!isActiveBrowserAuthAttempt(attemptId)) {
        return { ok: false, error: BROWSER_AUTH_CANCELLED_MESSAGE };
      }

      if (!response.ok || !data?.success || !data?.authToken) {
        const message =
          data?.message || "Unable to complete sign-in. Please try again.";
        trackAppEvent("activation.auth_failed", {
          provider,
          method: "browser",
          reason: "server_rejected",
          status: response.status,
        });
        finishBrowserAuthAttempt(attemptId);
        set({ isLoading: false, browserAuthProvider: null, error: message });
        return { ok: false, error: message };
      }

      setStoredToken(data.authToken);
      setTelemetryAuthToken(data.authToken);
      set({
        token: data.authToken,
        isLoading: false,
        browserAuthProvider: null,
      });
      const didRefreshUser = await get().refreshUser();
      if (!isActiveBrowserAuthAttempt(attemptId)) {
        return { ok: false, error: BROWSER_AUTH_CANCELLED_MESSAGE };
      }

      if (!didRefreshUser) {
        const message =
          get().error || "Signed in, but we could not load your account.";
        setStoredToken(null);
        setTelemetryAuthToken(null);
        trackAppEvent("activation.auth_failed", {
          provider,
          method: "browser",
          reason: "account_refresh_failed",
        });
        finishBrowserAuthAttempt(attemptId);
        set({
          token: null,
          user: null,
          isLoading: false,
          browserAuthProvider: null,
          error: message,
        });
        return { ok: false, error: message };
      }
      finishBrowserAuthAttempt(attemptId);
      set({ browserAuthProvider: null, isLoading: false, error: null });
      trackAppEvent("activation.auth_succeeded", {
        provider,
        method: "browser",
      });
      trackAppEventOnce("activation.first_auth_succeeded", {
        provider,
        method: "browser",
      });
      return { ok: true };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to complete sign-in. Please try again.";
      trackAppEvent("activation.auth_failed", {
        provider,
        method: "browser",
        reason: "exception",
      });
      if (isActiveBrowserAuthAttempt(attemptId)) {
        finishBrowserAuthAttempt(attemptId);
        set({ isLoading: false, browserAuthProvider: null, error: message });
      }
      return { ok: false, error: message };
    }
  },

  cancelBrowserLogin: async () => {
    const provider = get().browserAuthProvider;
    activeBrowserAuthAttemptId += 1;
    await cancelBrowserAuthListener();
    trackAppEvent("activation.auth_cancelled", { provider, method: "browser" });
    set({
      isLoading: false,
      browserAuthProvider: null,
      error: null,
    });
  },

  login: async (email, password) => {
    trackAppEvent("activation.auth_started", { method: "email" });
    set({ isLoading: true, error: null });
    try {
      const { response, data } = await fetchJsonWithTimeout<AuthApiResponse>(
        getServerEndpoint("/account/gg/email"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
        "BreezeType sign-in took too long. Check your connection and try again.",
      );

      if (!response.ok || !data?.success || !data?.authToken) {
        const message = data?.message || "Unable to sign in. Please try again.";
        trackAppEvent("activation.auth_failed", {
          method: "email",
          reason: "server_rejected",
          status: response.status,
        });
        set({ isLoading: false, error: message });
        return { ok: false, error: message };
      }

      setStoredToken(data.authToken);
      setTelemetryAuthToken(data.authToken);
      set({ token: data.authToken, isLoading: false });
      const didRefreshUser = await get().refreshUser();
      if (!didRefreshUser) {
        const message =
          get().error || "Signed in, but we could not load your account.";
        setStoredToken(null);
        setTelemetryAuthToken(null);
        trackAppEvent("activation.auth_failed", {
          method: "email",
          reason: "account_refresh_failed",
        });
        set({ token: null, user: null, isLoading: false, error: message });
        return { ok: false, error: message };
      }
      trackAppEvent("activation.auth_succeeded", { method: "email" });
      trackAppEventOnce("activation.first_auth_succeeded", {
        method: "email",
      });
      return { ok: true };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to reach the BreezeType server.";
      trackAppEvent("activation.auth_failed", {
        method: "email",
        reason: "exception",
      });
      set({ isLoading: false, error: message });
      return { ok: false, error: message };
    }
  },

  logout: () => {
    activeBrowserAuthAttemptId += 1;
    void cancelBrowserAuthListener();
    setStoredToken(null);
    setTelemetryAuthToken(null);
    set({
      token: null,
      user: null,
      browserAuthProvider: null,
      error: null,
      isLoading: false,
    });
  },

  refreshUser: async () => {
    const token = get().token;
    if (!token) {
      set({ user: null, error: null, isLoading: false });
      return false;
    }
    set({ isLoading: true, error: null });
    try {
      const { response, data } = await fetchJsonWithTimeout<AuthApiResponse>(
        getServerEndpoint("/account"),
        {
          headers: { Authorization: token },
        },
        "BreezeType account lookup took too long. Check your connection and try again.",
      );
      if (get().token !== token) {
        return false;
      }
      if (!response.ok || !data?.success) {
        setStoredToken(null);
        setTelemetryAuthToken(null);
        set({ token: null, user: null, isLoading: false });
        return false;
      }
      set({ user: data.body, isLoading: false });
      trackAppEvent("activation.account_identified");
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to refresh account info.";
      if (get().token !== token) {
        return false;
      }
      set({ error: message, isLoading: false });
      return false;
    }
  },
}));
