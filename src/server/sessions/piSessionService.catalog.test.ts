import { describe, expect, it, vi } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, emptyArchiveStore, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, testModelRuntime } from "./piSessionService.testSupport.js";

describe("read-only session catalog", () => {
  it("lists cold conversations without opening a runtime or leaking transcript/file fields", async () => {
    const gateway = sessionGateway([{ ...sessionRecord("cold"), firstMessage: "private text" }]);
    const open = vi.spyOn(gateway, "open");
    const createRuntime = vi.fn(runtimeCreator(fakeRuntime().runtime));
    const events = new CapturingSessionEventHub();
    const service = new PiSessionService(events, { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore(), createAgentRuntime: createRuntime });
    try {
      expect(await service.listCatalogSessions("/workspace")).toEqual([
        { id: "cold", cwd: "/workspace", archived: false, runtime: "not-hosted" },
      ]);
      expect(open).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(service.activeCount()).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("reads paged cold history without opening a runtime and preserves turn boundaries", async () => {
    const entries = [
      { type: "message", id: "u1", message: { role: "user", content: "first" } },
      { type: "message", id: "a1", message: { role: "assistant", content: "answer" } },
      { type: "message", id: "u2", message: { role: "user", content: "second" } },
    ];
    const gateway = sessionGateway([sessionRecord("cold")]);
    const readEntries = vi.fn(() => Promise.resolve(entries));
    gateway.readEntries = readEntries;
    const open = vi.spyOn(gateway, "open");
    const createRuntime = vi.fn(runtimeCreator(fakeRuntime().runtime));
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway,
      archiveStore: emptyArchiveStore(), createAgentRuntime: createRuntime,
    });
    try {
      await expect(service.inspectionMessages({ id: "cold", cwd: "/workspace" }, { before: 2, limit: 1 })).resolves.toEqual({
        messages: [
          { role: "user", content: "first", entryId: "u1" },
          { role: "assistant", content: "answer", entryId: "a1" },
        ],
        start: 0,
        total: 3,
      });
      expect(readEntries).toHaveBeenCalledWith("/sessions/cold.jsonl");
      expect(open).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(service.activeCount()).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it("reports already-hosted idle/busy sessions, without assigning runtime state to a cloned file", async () => {
    const fake = fakeRuntime("live");
    const gateway = sessionGateway([]);
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore(), createAgentRuntime: runtimeCreator(fake.runtime) });
    try {
      await service.start("/workspace");
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("idle");
      fake.session.isStreaming = true;
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("busy");
      fake.session.isStreaming = false;
      gateway.list = () => Promise.resolve([sessionRecord("live")]);
      expect((await service.listCatalogSessions("/workspace"))[0]?.runtime).toBe("not-hosted");
    } finally {
      await service.dispose();
    }
  });

  it("rejects cancelled reads before touching storage", async () => {
    const gateway = sessionGateway([]);
    const list = vi.spyOn(gateway, "list");
    const service = new PiSessionService(new CapturingSessionEventHub(), { agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime, sessionManager: gateway, archiveStore: emptyArchiveStore() });
    try {
      await expect(service.listCatalogSessions("/workspace", AbortSignal.abort())).rejects.toThrow();
      expect(list).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
    }
  });
});
