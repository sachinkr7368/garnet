import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../editor", async () => await import("./fakeEditor"));
vi.mock("../debug", () => ({ debugSession: vi.fn(), sessionFor: () => null, stopSession: vi.fn() }));

import { monaco } from "./fakeEditor";
import { cachedSymbols, pullDiagnostics, request, startLsp, stopLsp } from "../lsp";
import { loadSettings, trustProject, updateSetting } from "../settings";
import { state } from "../state";
import { fake } from "./fakeIpc";

const ROOT = "/work/blog";
type Ch = { onmessage: (ev: unknown) => void };
const channels: Ch[] = [];
const sent: { method?: string; id?: number }[] = [];
let holdInitialize = false;
let releaseInitialize = () => {};
const status = () => [...document.querySelectorAll(".status-item")].map((e) => e.textContent!.trim()).find((t) => t.startsWith("Ruby LSP"));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  await stopLsp();
});

beforeEach(async () => {
  fake.reset();
  sent.length = 0;
  holdInitialize = false;
  document.getElementById("overlay-root")!.replaceChildren();
  state.project = { root: ROOT, name: "blog", git: true, rails: true, rspec: false, minitest: true, binRspec: false, debugBundled: false };
  await loadSettings(ROOT);
  await trustProject(ROOT, true);
  fake.handlers.set("lsp_start", (args: { onEvent: Ch }) => (channels.push(args.onEvent), { command: "ruby-lsp", manager: "none", reason: "", prefix: [] }));
  fake.handlers.set("lsp_send", ({ body }: { body: string }) => {
    const msg = JSON.parse(body);
    sent.push(msg);
    const ch = channels.at(-1)!;
    const reply = (result: unknown) => ch.onmessage({ type: "message", body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) });
    if (msg.method === "initialize") {
      const answer = () => reply({ capabilities: { diagnosticProvider: {}, textDocumentSync: 2 } });
      if (holdInitialize) releaseInitialize = answer;
      else setTimeout(answer, 0);
    } else if (msg.id !== undefined && msg.method) setTimeout(() => reply(null), 0);
  });
});

describe("Ruby LSP lifecycle", () => {
  it("ignores the previous server's exit after a restart", async () => {
    await startLsp();
    await startLsp();
    expect(status()).toBe("Ruby LSP");
    channels.at(-2)!.onmessage({ type: "exit", code: 0 });
    await tick();
    expect(status()).toBe("Ruby LSP");
    expect(document.querySelector(".toast.error")).toBeNull();
  });

  it("sends nothing but initialize until the server has initialized", async () => {
    holdInitialize = true;
    const started = startLsp();
    await tick(5);
    await expect(request("textDocument/documentSymbol", {})).rejects.toThrow("not ready");
    expect(sent.map((m) => m.method)).toEqual(["initialize"]);
    releaseInitialize();
    await started;
    expect(sent.map((m) => m.method)).toContain("initialized");
  });

  it("does not touch a model that was disposed before its debounced diagnostics pull", async () => {
    await startLsp();
    const disposed = { isDisposed: () => true, getVersionId: () => { throw new Error("Model is disposed!"); }, uri: { toString: () => "file:///x.rb" } };
    await expect(pullDiagnostics(disposed as never)).resolves.toBeUndefined();
    await expect(cachedSymbols(disposed as never)).resolves.toEqual([]);
  });

  it("re-filters shown diagnostics when the minimum severity changes", async () => {
    await startLsp();
    const markers = vi.fn();
    const model = { isDisposed: () => false, getVersionId: () => 1, uri: { toString: () => "file:///work/blog/a.rb" } };
    monaco.editor = { getModel: () => model, setModelMarkers: markers };
    monaco.Uri = { parse: (s: string) => ({ toString: () => s }) };
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    channels.at(-1)!.onmessage({
      type: "message",
      body: JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: model.uri.toString(), diagnostics: [{ range, severity: 2, message: "w" }, { range, severity: 4, message: "h" }] } }),
    });
    expect(markers.mock.calls.at(-1)![2]).toHaveLength(2);
    await updateSetting("inspections.minSeverity", "warning");
    expect(markers.mock.calls.at(-1)![2].map((m: { message: string }) => m.message)).toEqual(["w"]);
  });
});
