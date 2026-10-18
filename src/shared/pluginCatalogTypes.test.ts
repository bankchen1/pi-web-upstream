import { describe, expect, it } from "vitest";
import { PI_WEB_HOST_CATALOG_CAPABILITY } from "./pluginCatalogTypes.js";

function provider() {
  return {
    version: 1,
    projects: { list: () => Promise.resolve([{ id: "p", name: "Project", path: "/repo", private: "secret" }]), get: () => Promise.resolve({ id: "p", name: "Project", path: "/repo" }) },
    workspaces: { list: () => Promise.resolve([]), get: () => Promise.resolve({ id: "w", projectId: "p", path: "/repo", label: "Main", isMain: true, data: { secret: true } }) },
    sessions: { list: () => Promise.resolve([]), get: () => Promise.resolve({ id: "s", cwd: "/repo", archived: false, runtime: "idle", transcript: "secret", path: "/private/session.jsonl" }) },
  };
}

describe("catalog public contract", () => {
  it("captures functions and strips private data from every projection", async () => {
    const source = provider();
    const catalog = PI_WEB_HOST_CATALOG_CAPABILITY.parse(source);
    source.projects.list = () => Promise.resolve([]);
    expect(await catalog.projects.list()).toEqual([{ id: "p", name: "Project", path: "/repo" }]);
    expect(await catalog.workspaces.get({ projectId: "p", workspaceId: "w" })).toEqual({ id: "w", projectId: "p", path: "/repo", label: "Main", isMain: true });
    expect(await catalog.sessions.get({ projectId: "p", workspaceId: "w", sessionId: "s" })).toEqual({ id: "s", cwd: "/repo", archived: false, runtime: "idle" });
    expect(Object.isFrozen(catalog.projects)).toBe(true);
  });

  it("validates function groups, selections, returned identities and runtime values", async () => {
    expect(() => PI_WEB_HOST_CATALOG_CAPABILITY.parse({ ...provider(), version: 2 })).toThrow("Invalid");
    expect(() => PI_WEB_HOST_CATALOG_CAPABILITY.parse({ ...provider(), sessions: { list: () => [] } })).toThrow("Invalid");
    const source = provider();
    source.sessions.get = () => Promise.resolve({ id: "s", cwd: "/repo", archived: false, runtime: "invalid", transcript: "", path: "" });
    const catalog = PI_WEB_HOST_CATALOG_CAPABILITY.parse(source);
    await expect(catalog.projects.get("other")).rejects.toThrow("Invalid");
    await expect(catalog.workspaces.get({ projectId: "other", workspaceId: "w" })).rejects.toThrow("Invalid");
    await expect(catalog.sessions.get({ projectId: "p", workspaceId: "w", sessionId: "s" })).rejects.toThrow("Invalid");
    await expect(Reflect.apply(catalog.workspaces.get, undefined, [{ projectId: "p", workspaceId: "w", path: "/injected" }])).rejects.toThrow("Invalid");
  });

  it("supports an optional bounded history reader without breaking older catalog providers", async () => {
    const legacy = PI_WEB_HOST_CATALOG_CAPABILITY.parse(provider());
    expect(legacy.sessions.readMessages).toBeUndefined();
    const source = {
      ...provider(),
      sessions: {
        ...provider().sessions,
        readMessages: (selection: { sessionId: string }, page?: { limit?: number }) => Promise.resolve({
      messages: [{ role: "user", content: `${selection.sessionId}:${String(page?.limit)}` }], start: 0, total: 1,
        }),
      },
    };
    const catalog = PI_WEB_HOST_CATALOG_CAPABILITY.parse(source);
    await expect(catalog.sessions.readMessages?.({ projectId: "p", workspaceId: "w", sessionId: "s" }, { before: 1, limit: 20 })).resolves.toEqual({
      messages: [{ role: "user", content: "s:20" }], start: 0, total: 1,
    });
    await expect(catalog.sessions.readMessages?.({ projectId: "p", workspaceId: "w", sessionId: "s" }, { limit: 101 })).rejects.toThrow("Invalid");
    const invalidSource = { ...source, sessions: { ...source.sessions, readMessages: () => Promise.resolve({ messages: "not-an-array", start: 0, total: 1 }) } };
    await expect(PI_WEB_HOST_CATALOG_CAPABILITY.parse(invalidSource).sessions.readMessages?.({ projectId: "p", workspaceId: "w", sessionId: "s" })).rejects.toThrow("Invalid");
  });
});
