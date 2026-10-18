import type { FileHandle } from "node:fs/promises";
import type { ClientMessagePage } from "../types.js";
import { historyMessagesFromEntries } from "./transcriptMessages.js";
import { pageMessagesAtSafeBoundary, type MessagePageRequest } from "./messagePaging.js";
import { isRecord, tryParseEntry } from "./sessionFileFormat.js";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;

interface IndexedEntry {
  readonly id: string;
  readonly parentId?: string;
  readonly offset: number;
  readonly length: number;
  readonly type: string;
  readonly role?: string;
  readonly display?: boolean;
}

/**
 * Stream-index a Pi JSONL transcript, then read only the active-branch entries
 * needed for one safe-boundary history page. The compact index scales with the
 * number of entries but intentionally omits message bodies; the file remains
 * untouched and the caller controls path authority before invoking this helper.
 */
export async function readSessionHistoryPage(file: FileHandle, page?: MessagePageRequest): Promise<ClientMessagePage> {
  const index = new Map<string, IndexedEntry>();
  let leafId: string | undefined;
  await scanLines(file, (line, offset, length) => {
    const entry = tryParseEntry(line.toString("utf8"));
    if (entry === undefined || entry["type"] === "session" || typeof entry["id"] !== "string") return;
    const id = entry["id"];
    const parentId = typeof entry["parentId"] === "string" ? entry["parentId"] : undefined;
    const message = entry["message"];
    index.set(id, {
      id, ...(parentId === undefined ? {} : { parentId }), offset, length,
      type: typeof entry["type"] === "string" ? entry["type"] : "",
      ...(isRecord(message) && typeof message["role"] === "string" ? { role: message["role"] } : {}),
      ...(typeof entry["display"] === "boolean" ? { display: entry["display"] } : {}),
    });
    leafId = id;
  });

  const branch: IndexedEntry[] = [];
  const visited = new Set<string>();
  let currentId = leafId;
  while (currentId !== undefined && !visited.has(currentId)) {
    visited.add(currentId);
    const entry = index.get(currentId);
    if (entry === undefined) break;
    branch.push(entry);
    currentId = entry.parentId;
  }
  branch.reverse();

  const visible = branch.flatMap((entry, branchIndex) => {
    const role = visibleRole(entry);
    return role === undefined ? [] : [{ branchIndex, role }];
  });
  const pageResult = pageMessagesAtSafeBoundary(visible.map(({ role }) => ({ role })), page ?? { limit: DEFAULT_PAGE_SIZE });
  const selected = visible.slice(pageResult.start, pageResult.start + pageResult.messages.length);
  const firstSelected = selected.at(0);
  const lastSelected = selected.at(-1);
  if (firstSelected === undefined || lastSelected === undefined) return { messages: [], start: pageResult.start, total: pageResult.total };

  const first = firstSelected.branchIndex;
  const last = lastSelected.branchIndex;
  let contextIndex: number | undefined;
  for (let branchIndex = first - 1; branchIndex >= 0; branchIndex -= 1) {
    if (branch[branchIndex]?.type === "thinking_level_change") {
      contextIndex = branchIndex;
      break;
    }
  }

  const records = new Map<string, Record<string, unknown>>();
  const selectedBranch = branch.slice(first, last + 1);
  const contextEntry = contextIndex === undefined ? undefined : branch[contextIndex];
  const readEntries = contextEntry === undefined ? selectedBranch : [contextEntry, ...selectedBranch];
  for (const entry of readEntries) {
    const line = Buffer.alloc(entry.length);
    const { bytesRead } = await file.read(line, 0, entry.length, entry.offset);
    if (bytesRead !== entry.length) throw new Error("Session transcript changed during history read");
    const parsed = tryParseEntry(line.toString("utf8"));
    if (parsed?.["id"] !== entry.id) throw new Error("Session transcript changed during history read");
    records.set(entry.id, parsed);
  }
  const entries = readEntries.flatMap(({ id }) => {
    const entry = records.get(id);
    return entry === undefined ? [] : [entry];
  });
  return { messages: historyMessagesFromEntries(entries), start: pageResult.start, total: pageResult.total };
}

function visibleRole(entry: IndexedEntry): string | undefined {
  if (entry.type === "message") return entry.role ?? "";
  if (entry.type === "custom_message" && entry.display === true) return "custom";
  if (entry.type === "compaction" || entry.type === "branch_summary") return "system";
  return undefined;
}

async function scanLines(file: FileHandle, visit: (line: Buffer, offset: number, length: number) => void): Promise<void> {
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let position = 0;
  let lineOffset = 0;
  let pending: Buffer[] = [];
  let pendingLength = 0;

  for (;;) {
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    let start = 0;
    while (start < bytesRead) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline < 0 || newline >= bytesRead) {
        const tail = chunk.subarray(start, bytesRead);
        if (tail.length > 0) {
          pending.push(tail);
          pendingLength += tail.length;
          assertEntryLength(pendingLength);
        }
        break;
      }
      const fragment = chunk.subarray(start, newline);
      const length = pendingLength + fragment.length;
      assertEntryLength(length);
      const line = pending.length === 0 ? fragment : Buffer.concat([...pending, fragment], length);
      visit(line, lineOffset, length);
      lineOffset += length + 1;
      pending = [];
      pendingLength = 0;
      start = newline + 1;
    }
  }
  if (pendingLength > 0) {
    const line = pending.length === 1 ? (pending[0] ?? Buffer.alloc(0)) : Buffer.concat(pending, pendingLength);
    visit(line, lineOffset, pendingLength);
  }
}

function assertEntryLength(length: number): void {
  if (length > MAX_ENTRY_BYTES) throw new Error(`Session transcript entry exceeds ${String(MAX_ENTRY_BYTES)} bytes`);
}
