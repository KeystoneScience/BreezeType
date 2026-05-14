const SERVER_URL_ENV_KEY = "VITE_BREEZE_SERVER_URL";
const WEB_URL_ENV_KEY = "VITE_BREEZE_WEB_URL";

export const DEFAULT_SERVER_URL = "https://api.breezetype.com";
export const DEFAULT_WEB_URL = "https://breezetype.com";

const readConfiguredUrl = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const isLoopbackHttpUrl = (url: URL) =>
  url.protocol === "http:" &&
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);

const normalizeBaseUrl = (rawUrl: string, envKey: string, server = false) => {
  const url = new URL(rawUrl.trim());

  if (server && url.protocol !== "https:" && !isLoopbackHttpUrl(url)) {
    throw new Error(
      `${envKey} must use HTTPS, or HTTP only for localhost development.`,
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/+$/, "");
};

const appendPath = (baseUrl: string, path: string) =>
  `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

/*
 * Server-backed capabilities stay in the same open-source desktop app:
 * auth, account sync, telemetry, support, and cloud meeting sharing all cross
 * this BreezeType API boundary. Keep committed defaults on the public API
 * domain; use env overrides only for local development or deliberate deploys.
 */
export const getServerUrl = () =>
  normalizeBaseUrl(
    readConfiguredUrl(import.meta.env.VITE_BREEZE_SERVER_URL) ||
      DEFAULT_SERVER_URL,
    SERVER_URL_ENV_KEY,
    true,
  );

export const getServerEndpoint = (path: string) =>
  appendPath(getServerUrl(), path);

export const buildServerEndpoint = (serverUrl: string, path: string) =>
  appendPath(normalizeBaseUrl(serverUrl, SERVER_URL_ENV_KEY, true), path);

export const getWebUrl = () =>
  normalizeBaseUrl(
    readConfiguredUrl(import.meta.env.VITE_BREEZE_WEB_URL) || DEFAULT_WEB_URL,
    WEB_URL_ENV_KEY,
  );

export const getWebEndpoint = (path: string) => appendPath(getWebUrl(), path);
