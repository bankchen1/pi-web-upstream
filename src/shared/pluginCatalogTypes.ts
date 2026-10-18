import type { JsonValue, PluginCapability, SessionUiMetadata, WorkspaceProviderMetadata, WorkspaceRemovalPresentation } from "./pluginApiTypes.js";

export interface PluginCatalogProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}
export interface PluginCatalogWorkspace {
  readonly id: string;
  readonly projectId: string;
  readonly path: string;
  readonly label: string;
  readonly isMain: boolean;
  readonly provider?: WorkspaceProviderMetadata;
  readonly removal?: WorkspaceRemovalPresentation;
}
export interface PluginSessionSnapshot {
  readonly id: string;
  readonly cwd: string;
  readonly name?: string;
  readonly metadata?: SessionUiMetadata;
  readonly archived: boolean;
  /** Stable ID of a parent session in the same authorized workspace, when present. */
  readonly parentSessionId?: string;
  /** PI WEB archive timestamp, when this session is archived. */
  readonly archivedAt?: string;
  readonly runtime: "not-hosted" | "idle" | "busy";
}
export interface PluginWorkspaceSelection {
  readonly projectId: string;
  readonly workspaceId: string;
}
export interface PluginSessionSelection extends PluginWorkspaceSelection {
  readonly sessionId: string;
}
export interface PluginSessionHistoryPageRequest { readonly before?: number; readonly limit?: number }
export interface PluginSessionHistoryPage {
  readonly messages: readonly unknown[];
  readonly start: number;
  readonly total: number;
}
export interface PluginCatalogReadOptions { readonly signal?: AbortSignal }
export interface PluginCatalogV1 {
  readonly version: 1;
  readonly projects: {
    readonly list: (options?: PluginCatalogReadOptions) => Promise<readonly PluginCatalogProject[]>;
    readonly get: (projectId: string, options?: PluginCatalogReadOptions) => Promise<PluginCatalogProject>;
  };
  readonly workspaces: {
    readonly list: (projectId: string, options?: PluginCatalogReadOptions) => Promise<readonly PluginCatalogWorkspace[]>;
    readonly get: (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) => Promise<PluginCatalogWorkspace>;
  };
  readonly sessions: {
    readonly list: (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) => Promise<readonly PluginSessionSnapshot[]>;
    readonly get: (selection: PluginSessionSelection, options?: PluginCatalogReadOptions) => Promise<PluginSessionSnapshot>;
    /** Present when the host supports observational transcript reads. Never opens a cold runtime. */
    readonly readMessages?: (selection: PluginSessionSelection, page?: PluginSessionHistoryPageRequest, options?: PluginCatalogReadOptions) => Promise<PluginSessionHistoryPage>;
  };
}

export const PI_WEB_HOST_CATALOG_CAPABILITY: PluginCapability<PluginCatalogV1, 1> = Object.freeze({
  pluginId: "pi-web.host",
  id: "catalog",
  version: 1,
  parse: snapshotCatalog,
});

function snapshotCatalog(value: unknown): PluginCatalogV1 {
  const catalog = record(value);
  if (catalog["version"] !== 1) throw invalid();
  const projects = methods(catalog["projects"]);
  const workspaces = methods(catalog["workspaces"]);
  const sessions = methods(catalog["sessions"]);
  const historyReader = sessions.readMessages;
  return Object.freeze({
    version: 1,
    projects: Object.freeze({
      list: async (options?: PluginCatalogReadOptions) => array(await projects.list(options), snapshotProject),
      get: async (projectId: string, options?: PluginCatalogReadOptions) => {
        const id = text(projectId);
        const result = snapshotProject(await projects.get(id, options));
        if (result.id !== id) throw invalid();
        return result;
      },
    }),
    workspaces: Object.freeze({
      list: async (projectId: string, options?: PluginCatalogReadOptions) => {
        const id = text(projectId);
        return array(await workspaces.list(id, options), (row) => workspaceFor(row, id));
      },
      get: async (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) => {
        const requested = snapshotSelection(selection);
        const result = workspaceFor(await workspaces.get(requested, options), requested.projectId);
        if (result.id !== requested.workspaceId) throw invalid();
        return result;
      },
    }),
    sessions: Object.freeze({
      list: async (selection: PluginWorkspaceSelection, options?: PluginCatalogReadOptions) =>
        array(await sessions.list(snapshotSelection(selection), options), snapshotSession),
      get: async (selection: PluginSessionSelection, options?: PluginCatalogReadOptions) => {
        const requested = snapshotSelection(selection, true);
        const result = snapshotSession(await sessions.get(requested, options));
        if (result.id !== requested.sessionId) throw invalid();
        return result;
      },
      ...(historyReader === undefined ? {} : {
        readMessages: async (selection: PluginSessionSelection, page?: PluginSessionHistoryPageRequest, options?: PluginCatalogReadOptions) => {
          const requested = snapshotSelection(selection, true);
          const requestedPage = page === undefined ? undefined : snapshotHistoryPage(page);
          const result = record(await historyReader(requested, requestedPage, options));
          const messages = unknownArray(result["messages"]);
          const start = integer(result["start"]);
          const total = integer(result["total"]);
          if (messages === undefined || start === undefined || total === undefined || start < 0 || total < 0) throw invalid();
          return Object.freeze({ messages: Object.freeze(messages.map((message: unknown) => message)), start, total });
        },
      }),
    }),
  });
}

function methods(value: unknown) {
  const owner = record(value);
  const list = owner["list"];
  const get = owner["get"];
  const readMessages = owner["readMessages"];
  if (typeof list !== "function" || typeof get !== "function" || (readMessages !== undefined && typeof readMessages !== "function")) throw invalid();
  const readMessagesMethod = typeof readMessages === "function"
    ? (...args: unknown[]): Promise<unknown> => Promise.resolve(Reflect.apply(readMessages, owner, args))
    : undefined;
  return {
    list: (...args: unknown[]): Promise<unknown> => Promise.resolve(Reflect.apply(list, owner, args)),
    get: (...args: unknown[]): Promise<unknown> => Promise.resolve(Reflect.apply(get, owner, args)),
    ...(readMessagesMethod === undefined ? {} : { readMessages: readMessagesMethod }),
  };
}
function snapshotHistoryPage(value: PluginSessionHistoryPageRequest): PluginSessionHistoryPageRequest {
  const row = record(value);
  if (Reflect.ownKeys(row).some((key) => typeof key !== "string" || (key !== "before" && key !== "limit"))) throw invalid();
  const before = boundedInteger(row["before"], 0, 1_000_000);
  const limit = boundedInteger(row["limit"], 1, 100);
  return Object.freeze({ ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) });
}
function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid();
  return value;
}
function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
function unknownArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item: unknown) => item);
}
function snapshotProject(value: unknown): PluginCatalogProject {
  const row = record(value);
  return Object.freeze({ id: text(row["id"]), name: text(row["name"]), path: text(row["path"]) });
}
function workspaceFor(value: unknown, projectId: string): PluginCatalogWorkspace {
  const row = record(value);
  if (row["projectId"] !== projectId || typeof row["isMain"] !== "boolean") throw invalid();
  let provider: WorkspaceProviderMetadata | undefined;
  if (row["provider"] !== undefined) {
    const source = record(row["provider"]);
    const capabilities = record(source["capabilities"]);
    if (typeof capabilities["remove"] !== "boolean") throw invalid();
    provider = Object.freeze({
      pluginId: text(source["pluginId"]),
      capabilities: Object.freeze({ remove: capabilities["remove"] }),
      ...(source["metadata"] === undefined ? {} : { metadata: jsonObject(source["metadata"]) }),
    });
  }
  const removal = row["removal"] === undefined ? undefined : record(row["removal"]);
  return Object.freeze({
    id: text(row["id"]), projectId, path: text(row["path"]), label: text(row["label"]), isMain: row["isMain"],
    ...(provider === undefined ? {} : { provider }),
    ...(removal === undefined ? {} : { removal: Object.freeze({ actionLabel: text(removal["actionLabel"]), confirmation: text(removal["confirmation"]) }) }),
  });
}
function snapshotSession(value: unknown): PluginSessionSnapshot {
  const row = record(value);
  const runtime = row["runtime"];
  if (typeof row["archived"] !== "boolean" || (runtime !== "not-hosted" && runtime !== "idle" && runtime !== "busy")) throw invalid();
  let metadata: SessionUiMetadata | undefined;
  if (row["metadata"] !== undefined) {
    metadata = Object.freeze(Object.fromEntries(Object.entries(record(row["metadata"])).map(([key, data]) => [key, jsonObject(data)])));
  }
  if (row["name"] !== undefined && typeof row["name"] !== "string") throw invalid();
  if (row["parentSessionId"] !== undefined && typeof row["parentSessionId"] !== "string") throw invalid();
  if (row["archivedAt"] !== undefined && typeof row["archivedAt"] !== "string") throw invalid();
  return Object.freeze({
    id: text(row["id"]), cwd: text(row["cwd"]), archived: row["archived"], runtime,
    ...(row["name"] === undefined ? {} : { name: row["name"] }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(row["parentSessionId"] === undefined ? {} : { parentSessionId: text(row["parentSessionId"]) }),
    ...(row["archivedAt"] === undefined ? {} : { archivedAt: text(row["archivedAt"]) }),
  });
}
function snapshotSelection(value: unknown): PluginWorkspaceSelection;
function snapshotSelection(value: unknown, session: true): PluginSessionSelection;
function snapshotSelection(value: unknown, session = false): PluginWorkspaceSelection | PluginSessionSelection {
  const row = record(value);
  const keys = session ? ["projectId", "workspaceId", "sessionId"] : ["projectId", "workspaceId"];
  if (Reflect.ownKeys(row).some((key) => typeof key !== "string" || !keys.includes(key))) throw invalid();
  return Object.freeze({ projectId: text(row["projectId"]), workspaceId: text(row["workspaceId"]), ...(session ? { sessionId: text(row["sessionId"]) } : {}) });
}
function array<T>(value: unknown, snapshot: (value: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw invalid();
  return Object.freeze(value.map(snapshot));
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid();
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid();
  return value;
}
function jsonObject(value: unknown, ancestors = new Set<object>()): Readonly<Record<string, JsonValue>> {
  const source = record(value);
  if (ancestors.has(source)) throw invalid();
  ancestors.add(source);
  const result = Object.freeze(Object.fromEntries(Object.entries(source).map(([key, data]) => [key, json(data, ancestors)])));
  ancestors.delete(source);
  return result;
}
function json(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw invalid();
    ancestors.add(value);
    const result = Object.freeze(value.map((item: unknown) => json(item, ancestors)));
    ancestors.delete(value);
    return result;
  }
  return jsonObject(value, ancestors);
}
function invalid(): Error { return new Error("Invalid PI WEB host catalog capability v1 data"); }
