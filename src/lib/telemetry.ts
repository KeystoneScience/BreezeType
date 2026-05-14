import { getVersion } from "@tauri-apps/api/app";
import {
  platform as getPlatform,
  type as getOsType,
  version as getOsVersion,
} from "@tauri-apps/plugin-os";
import { getServerEndpoint } from "@/lib/serverApi";

type TelemetryMetadata = Record<string, unknown>;

interface AppEventPayload {
  eventName: string;
  eventKey: string | null;
  installId: string;
  sessionId: string;
  eventSource: "desktop";
  appVersion: string | null;
  platform: string | null;
  osType: string | null;
  osVersion: string | null;
  locale: string | null;
  clientCreatedAt: string;
  metadata: TelemetryMetadata;
}

const INSTALL_ID_KEY = "breezetype_telemetry_install_id_v1";
const ONCE_EVENTS_KEY = "breezetype_telemetry_once_events_v1";
const PENDING_EVENTS_KEY = "breezetype_telemetry_pending_events_v1";
const AUTH_TOKEN_KEY = "breeze_auth_token";
const MAX_PENDING_EVENTS = 100;
const MAX_METADATA_STRING_LENGTH = 160;

let authToken: string | null = null;
let flushInFlight = false;
let flushScheduled = false;

let runtimeContext: Pick<
  AppEventPayload,
  "appVersion" | "platform" | "osType" | "osVersion" | "locale"
> = {
  appVersion: null,
  platform: null,
  osType: null,
  osVersion: null,
  locale:
    typeof navigator !== "undefined" && navigator.language
      ? navigator.language
      : null,
};

const safeLocalStorage = () => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const createId = () => {
  const browserCrypto =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;

  if (browserCrypto) {
    if (browserCrypto.randomUUID) {
      return browserCrypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const sessionId = createId();

const getStoredId = (key: string) => {
  const storage = safeLocalStorage();
  const existing = storage?.getItem(key);
  if (existing) return existing;

  const created = createId();
  storage?.setItem(key, created);
  return created;
};

const getInstallId = () => getStoredId(INSTALL_ID_KEY);

const getStoredAuthToken = () =>
  safeLocalStorage()?.getItem(AUTH_TOKEN_KEY) ?? null;

const readJsonArray = <T>(key: string): T[] => {
  const storage = safeLocalStorage();
  if (!storage) return [];

  try {
    const parsed = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

const writeJsonArray = <T>(key: string, value: T[]) => {
  const storage = safeLocalStorage();
  if (!storage) return;
  storage.setItem(key, JSON.stringify(value));
};

const sanitizeMetadataValue = (
  value: unknown,
  depth = 0,
): unknown | undefined => {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return value.slice(0, MAX_METADATA_STRING_LENGTH);
  }
  if (Array.isArray(value)) {
    if (depth >= 2) return undefined;
    return value
      .slice(0, 20)
      .map((item) => sanitizeMetadataValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    if (depth >= 2) return undefined;
    return sanitizeMetadata(value as TelemetryMetadata, depth + 1);
  }
  return undefined;
};

const sanitizeMetadata = (metadata?: TelemetryMetadata, depth = 0) => {
  if (!metadata) return {};

  return Object.fromEntries(
    Object.entries(metadata)
      .slice(0, 30)
      .map(([key, value]) => [
        key.slice(0, MAX_METADATA_STRING_LENGTH),
        sanitizeMetadataValue(value, depth),
      ])
      .filter(([, value]) => value !== undefined),
  );
};

const buildPayload = (
  eventName: string,
  metadata?: TelemetryMetadata,
  options: { eventKey?: string | null } = {},
): AppEventPayload => ({
  eventName,
  eventKey: options.eventKey || null,
  installId: getInstallId(),
  sessionId,
  eventSource: "desktop",
  ...runtimeContext,
  clientCreatedAt: new Date().toISOString(),
  metadata: sanitizeMetadata(metadata),
});

const readPendingEvents = () =>
  readJsonArray<AppEventPayload>(PENDING_EVENTS_KEY);

const writePendingEvents = (events: AppEventPayload[]) => {
  writeJsonArray(PENDING_EVENTS_KEY, events.slice(-MAX_PENDING_EVENTS));
};

const enqueueEvent = (payload: AppEventPayload) => {
  writePendingEvents([...readPendingEvents(), payload]);
};

const postEvent = async (payload: AppEventPayload) => {
  const token = authToken || getStoredAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = token;
  }

  const response = await fetch(getServerEndpoint("/app-events"), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    keepalive: true,
  });

  if (response.ok) return true;

  // Drop malformed payloads, but keep retrying if the endpoint is not deployed
  // yet or the server asks us to slow down.
  return [400, 401, 403, 413].includes(response.status);
};

const scheduleFlush = () => {
  if (flushScheduled) return;
  flushScheduled = true;
  window.setTimeout(() => {
    flushScheduled = false;
    void flushTelemetryEvents();
  }, 250);
};

const flushTelemetryEvents = async () => {
  if (flushInFlight) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  flushInFlight = true;
  try {
    const pending = readPendingEvents();
    const remaining = [...pending];

    while (remaining.length > 0) {
      const event = remaining[0];
      const sent = await postEvent(event);
      if (!sent) break;
      remaining.shift();
      writePendingEvents(remaining);
    }
  } catch {
    // Best-effort telemetry must never interrupt the app.
  } finally {
    flushInFlight = false;
  }
};

const loadRuntimeContext = async () => {
  const getOptional = async <T>(read: () => T | Promise<T>) => {
    try {
      return await Promise.resolve(read());
    } catch {
      return null;
    }
  };

  try {
    const [appVersion, platform, osType, osVersion] = await Promise.all([
      getOptional(getVersion),
      getOptional(getPlatform),
      getOptional(getOsType),
      getOptional(getOsVersion),
    ]);
    runtimeContext = {
      ...runtimeContext,
      appVersion,
      platform,
      osType,
      osVersion,
    };
    scheduleFlush();
  } catch {
    // Runtime fields are helpful context, not a reason to block events.
  }
};

export const setTelemetryAuthToken = (token: string | null) => {
  authToken = token;
  scheduleFlush();
};

export const flushTelemetry = () => flushTelemetryEvents();

export const trackAppEvent = (
  eventName: string,
  metadata?: TelemetryMetadata,
  options: { eventKey?: string | null } = {},
) => {
  enqueueEvent(buildPayload(eventName, metadata, options));
  scheduleFlush();
};

export const trackAppEventOnce = (
  eventName: string,
  metadata?: TelemetryMetadata,
  onceKey = eventName,
) => {
  const tracked = new Set(readJsonArray<string>(ONCE_EVENTS_KEY));
  if (tracked.has(onceKey)) return;

  tracked.add(onceKey);
  writeJsonArray(ONCE_EVENTS_KEY, Array.from(tracked));
  trackAppEvent(eventName, metadata, {
    eventKey: `${getInstallId()}:${onceKey}`,
  });
};

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    scheduleFlush();
  });
  window.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      scheduleFlush();
    }
  });
  void loadRuntimeContext();
}
