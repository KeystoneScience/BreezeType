import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  fromJsonSchema,
  McpServer,
  ResourceTemplate,
  StdioServerTransport,
} from "@modelcontextprotocol/server";

const SERVER_NAME = "breeze-local-context";
const SERVER_VERSION = "0.1.0";
const APP_IDENTIFIER = "com.pais.breeze.dev";
const MODEL_CONTEXT_DIR = "mcp";
const MANIFEST_FILE = "manifest.json";
const TASKS_FILE = "tasks.json";
const CLIPBOARD_FILE = "clipboard.json";
const DEFAULT_HISTORY_LIMIT = 25;
const DEFAULT_MEETINGS_LIMIT = 20;
const DEFAULT_CLIPBOARD_LIMIT = 20;
const DEFAULT_TASKS_LIMIT = 50;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_HELPER = path.join(SCRIPT_DIR, "breeze_mcp_sqlite.py");
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function ensureNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function compactText(value, limit = 320) {
  if (!value) return "";
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function parseJsonFile(filePath, fallback) {
  if (!filePath || !existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    return {
      ...fallback,
      available: false,
      error: `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function defaultAppDataDir() {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", APP_IDENTIFIER);
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(home, "AppData", "Roaming"),
        APP_IDENTIFIER,
      );
    default: {
      const base =
        process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
      return path.join(base, APP_IDENTIFIER);
    }
  }
}

function manifestPathFromEnvironment() {
  if (process.env.BREEZE_MCP_MANIFEST) {
    return path.resolve(process.env.BREEZE_MCP_MANIFEST);
  }
  const appDataDir = process.env.BREEZE_APP_DATA_DIR
    ? path.resolve(process.env.BREEZE_APP_DATA_DIR)
    : defaultAppDataDir();
  return path.join(appDataDir, MODEL_CONTEXT_DIR, MANIFEST_FILE);
}

function buildFallbackManifest(manifestPath) {
  const modelContextDir = path.dirname(manifestPath);
  const appDataDir = path.dirname(modelContextDir);
  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    appDataDir,
    server: {
      name: SERVER_NAME,
      version: 1,
      transport: "stdio",
      entrypointScript: "scripts/breeze-mcp.mjs",
      description:
        "Read-only MCP surface for local BreezeType tasks, clipboard history, transcription history, and meetings.",
    },
    datasets: {
      tasks: {
        kind: "json",
        path: path.join(modelContextDir, TASKS_FILE),
        readOnly: true,
      },
      clipboard: {
        kind: "json",
        path: path.join(modelContextDir, CLIPBOARD_FILE),
        readOnly: true,
        sessionScoped: true,
      },
      history: {
        kind: "sqlite",
        path: path.join(appDataDir, "history.db"),
        table: "transcription_history",
        readOnly: true,
      },
      meetings: {
        kind: "sqlite",
        path: path.join(appDataDir, "meetings.db"),
        tables: [
          "meetings",
          "meeting_transcripts",
          "meeting_notes",
          "participants",
          "meeting_participants",
          "tags",
          "meeting_tags",
        ],
        readOnly: true,
      },
    },
  };
}

function loadManifest() {
  const manifestPath = manifestPathFromEnvironment();
  const fallback = buildFallbackManifest(manifestPath);
  if (!existsSync(manifestPath)) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    return {
      ...fallback,
      ...parsed,
      datasets: {
        ...fallback.datasets,
        ...(parsed.datasets || {}),
      },
    };
  } catch (error) {
    return {
      ...fallback,
      available: false,
      error: `Failed to read manifest: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readTasksSnapshot(manifest) {
  return parseJsonFile(manifest.datasets?.tasks?.path, {
    schemaVersion: 1,
    updatedAt: null,
    tasks: [],
    habits: [],
    smartFilters: [],
    focusSessions: [],
    available: false,
  });
}

function readClipboardSnapshot(manifest) {
  return parseJsonFile(manifest.datasets?.clipboard?.path, {
    schemaVersion: 1,
    updatedAt: null,
    entries: [],
    available: false,
  });
}

function runSqliteCommand(manifest, datasetName, command, payload) {
  const dbPath = manifest.datasets?.[datasetName]?.path;
  if (!dbPath || !existsSync(dbPath)) {
    return { available: false, path: dbPath || null };
  }
  const raw = execFileSync(
    "python3",
    [SQLITE_HELPER, command, dbPath, JSON.stringify(payload)],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

function jsonResource(uri, data) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function filterTasks(
  snapshot,
  {
    query = "",
    includeCompleted = true,
    limit = DEFAULT_TASKS_LIMIT,
    tag = null,
    overdueOnly = false,
  } = {},
) {
  const normalizedQuery = String(query).trim().toLowerCase();
  const normalizedTag =
    typeof tag === "string" && tag.trim() ? tag.trim().toLowerCase() : null;
  const now = Date.now();

  return (snapshot.tasks || [])
    .filter((task) => includeCompleted || !task.completed)
    .filter(
      (task) =>
        !normalizedTag ||
        (task.tags || []).some(
          (item) => String(item).toLowerCase() === normalizedTag,
        ),
    )
    .filter(
      (task) =>
        !overdueOnly ||
        (task.dueAt != null && Number(task.dueAt) < now && !task.completed),
    )
    .filter((task) => {
      if (!normalizedQuery) return true;
      const haystack = [
        task.title,
        task.notes,
        ...(task.tags || []),
        ...(task.subtasks || []).map((item) => item.title),
      ]
        .filter(Boolean)
        .join("\n")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, ensureNumber(limit, DEFAULT_TASKS_LIMIT, 1, 100))
    .map((task) => ({
      id: task.id,
      title: task.title,
      completed: Boolean(task.completed),
      dueAt: task.dueAt ?? null,
      updatedAt: task.updatedAt ?? null,
      priority: task.priority ?? null,
      tags: task.tags || [],
      notesPreview: compactText(task.notes || "", 220),
      important: Boolean(task.important),
      urgent: Boolean(task.urgent),
    }));
}

function filterClipboardEntries(
  snapshot,
  { query = "", limit = DEFAULT_CLIPBOARD_LIMIT } = {},
) {
  const normalizedQuery = String(query).trim().toLowerCase();
  return (snapshot.entries || [])
    .filter((entry) => {
      if (!normalizedQuery) return true;
      return String(entry.text || "")
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .slice(0, ensureNumber(limit, DEFAULT_CLIPBOARD_LIMIT, 1, 100))
    .map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      textPreview: compactText(entry.text, 260),
      source_app_name: entry.source_app_name ?? null,
      source_app_identifier: entry.source_app_identifier ?? null,
    }));
}

function buildManifestResource() {
  const manifest = loadManifest();
  return {
    ...manifest,
    mcp: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "stdio",
      resources: [
        "breeze://manifest",
        "breeze://tasks/all",
        "breeze://clipboard/recent",
        "breeze://history/recent",
        "breeze://meetings/recent",
        "breeze://history/entry/{id}",
        "breeze://meetings/{id}",
        "breeze://meetings/{id}/transcript",
      ],
      tools: [
        "list_tasks",
        "search_tasks",
        "list_clipboard_history",
        "search_clipboard_history",
        "list_transcription_history",
        "search_transcription_history",
        "list_meetings",
        "search_meetings",
      ],
    },
  };
}

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions:
      "Read-only local BreezeType context. Use resources for durable snapshots and tools for targeted search. Do not expect mutation support.",
  },
);

server.registerResource(
  "manifest",
  "breeze://manifest",
  {
    title: "BreezeType MCP manifest",
    description: "Dataset paths plus the hidden BreezeType MCP surface.",
    mimeType: "application/json",
  },
  async (uri) => jsonResource(uri.href, buildManifestResource()),
);

server.registerResource(
  "tasks-all",
  "breeze://tasks/all",
  {
    title: "All BreezeType tasks",
    description:
      "Full task snapshot mirrored from the local BreezeType task store.",
    mimeType: "application/json",
  },
  async (uri) => {
    const manifest = loadManifest();
    return jsonResource(uri.href, readTasksSnapshot(manifest));
  },
);

server.registerResource(
  "clipboard-recent",
  "breeze://clipboard/recent",
  {
    title: "Recent clipboard history",
    description: "Recent clipboard entries captured by the running BreezeType app.",
    mimeType: "application/json",
  },
  async (uri) => {
    const manifest = loadManifest();
    return jsonResource(uri.href, readClipboardSnapshot(manifest));
  },
);

server.registerResource(
  "history-recent",
  "breeze://history/recent",
  {
    title: "Recent transcription history",
    description: "Recent BreezeType transcription history entries.",
    mimeType: "application/json",
  },
  async (uri) => {
    const manifest = loadManifest();
    return jsonResource(
      uri.href,
      runSqliteCommand(manifest, "history", "history_recent", {
        limit: DEFAULT_HISTORY_LIMIT,
      }),
    );
  },
);

server.registerResource(
  "meetings-recent",
  "breeze://meetings/recent",
  {
    title: "Recent meetings",
    description: "Recent BreezeType meeting records.",
    mimeType: "application/json",
  },
  async (uri) => {
    const manifest = loadManifest();
    return jsonResource(
      uri.href,
      runSqliteCommand(manifest, "meetings", "meetings_recent", {
        limit: DEFAULT_MEETINGS_LIMIT,
      }),
    );
  },
);

server.registerResource(
  "history-entry",
  new ResourceTemplate("breeze://history/entry/{id}", { list: undefined }),
  {
    title: "Transcription history entry",
    description: "Full BreezeType transcription history entry by id.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const manifest = loadManifest();
    return jsonResource(
      uri.href,
      runSqliteCommand(manifest, "history", "history_entry", {
        id: ensureNumber(variables.id, 0, 0, Number.MAX_SAFE_INTEGER),
      }),
    );
  },
);

server.registerResource(
  "meeting-entry",
  new ResourceTemplate("breeze://meetings/{id}", { list: undefined }),
  {
    title: "Meeting record",
    description: "Meeting metadata, tags, notes, and participants by id.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const manifest = loadManifest();
    return jsonResource(
      uri.href,
      runSqliteCommand(manifest, "meetings", "meeting_entry", {
        id: ensureNumber(variables.id, 0, 0, Number.MAX_SAFE_INTEGER),
      }),
    );
  },
);

server.registerResource(
  "meeting-transcript",
  new ResourceTemplate("breeze://meetings/{id}/transcript", {
    list: undefined,
  }),
  {
    title: "Meeting transcript",
    description: "Meeting transcript text and segments by meeting id.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const manifest = loadManifest();
    return jsonResource(
      uri.href,
      runSqliteCommand(manifest, "meetings", "meeting_transcript", {
        id: ensureNumber(variables.id, 0, 0, Number.MAX_SAFE_INTEGER),
      }),
    );
  },
);

server.registerTool(
  "list_tasks",
  {
    title: "List BreezeType tasks",
    description: "List tasks from the hidden local BreezeType task snapshot.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: fromJsonSchema({
      type: "object",
      properties: {
        includeCompleted: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        tag: { type: "string" },
        overdueOnly: { type: "boolean" },
      },
      additionalProperties: false,
    }),
  },
  async (args = {}) => {
    const manifest = loadManifest();
    const snapshot = readTasksSnapshot(manifest);
    const tasks = filterTasks(snapshot, args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: tasks.length, tasks }, null, 2),
        },
      ],
      structuredContent: { count: tasks.length, tasks },
    };
  },
);

server.registerTool(
  "search_tasks",
  {
    title: "Search BreezeType tasks",
    description: "Search task titles, notes, subtasks, and tags.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: fromJsonSchema({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        includeCompleted: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        tag: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    }),
  },
  async (args) => {
    const manifest = loadManifest();
    const snapshot = readTasksSnapshot(manifest);
    const tasks = filterTasks(snapshot, args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { query: args.query, count: tasks.length, tasks },
            null,
            2,
          ),
        },
      ],
      structuredContent: { query: args.query, count: tasks.length, tasks },
    };
  },
);

server.registerTool(
  "list_clipboard_history",
  {
    title: "List clipboard history",
    description:
      "List recent clipboard entries mirrored from the running BreezeType session.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: fromJsonSchema({
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    }),
  },
  async (args = {}) => {
    const manifest = loadManifest();
    const snapshot = readClipboardSnapshot(manifest);
    const entries = filterClipboardEntries(snapshot, args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: entries.length, entries }, null, 2),
        },
      ],
      structuredContent: { count: entries.length, entries },
    };
  },
);

server.registerTool(
  "search_clipboard_history",
  {
    title: "Search clipboard history",
    description: "Search recent BreezeType clipboard entries.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: fromJsonSchema({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    }),
  },
  async (args) => {
    const manifest = loadManifest();
    const snapshot = readClipboardSnapshot(manifest);
    const entries = filterClipboardEntries(snapshot, args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { query: args.query, count: entries.length, entries },
            null,
            2,
          ),
        },
      ],
      structuredContent: { query: args.query, count: entries.length, entries },
    };
  },
);

server.registerTool(
  "list_transcription_history",
  {
    title: "List transcription history",
    description: "List recent BreezeType transcription history entries.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: fromJsonSchema({
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    }),
  },
  async (args = {}) => {
    const manifest = loadManifest();
    const result = runSqliteCommand(manifest, "history", "history_recent", {
      limit: ensureNumber(args.limit, DEFAULT_HISTORY_LIMIT, 1, 100),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "search_transcription_history",
  {
    title: "Search transcription history",
    description:
      "Search BreezeType transcription history by title, text, app, or browser context.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: fromJsonSchema({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    }),
  },
  async (args) => {
    const manifest = loadManifest();
    const result = runSqliteCommand(manifest, "history", "history_search", {
      query: args.query,
      limit: ensureNumber(args.limit, DEFAULT_HISTORY_LIMIT, 1, 100),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "list_meetings",
  {
    title: "List meetings",
    description: "List recent BreezeType meetings.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: fromJsonSchema({
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    }),
  },
  async (args = {}) => {
    const manifest = loadManifest();
    const result = runSqliteCommand(manifest, "meetings", "meetings_recent", {
      limit: ensureNumber(args.limit, DEFAULT_MEETINGS_LIMIT, 1, 100),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "search_meetings",
  {
    title: "Search meetings",
    description:
      "Search BreezeType meetings across names, transcripts, notes, tags, and participants.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: fromJsonSchema({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        includeTranscript: { type: "boolean" },
      },
      required: ["query"],
      additionalProperties: false,
    }),
  },
  async (args) => {
    const manifest = loadManifest();
    const result = runSqliteCommand(manifest, "meetings", "meetings_search", {
      query: args.query,
      limit: ensureNumber(args.limit, DEFAULT_MEETINGS_LIMIT, 1, 100),
      includeTranscript: Boolean(args.includeTranscript),
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
