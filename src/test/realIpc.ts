/// The real `api` from `src/ipc.ts`, so every command reaches `fake.handlers`, keeping the fake's file and config storage.
/// Use with `vi.mock("@tauri-apps/api/core", () => import("./fakeIpc"))` and `vi.mock("../ipc", () => import("./realIpc"))`.
import { vi } from "vitest";
import * as f from "./fakeIpc";

const real = await vi.importActual<typeof import("../ipc")>("../ipc");
const local = ["readFile", "writeFile", "createPath", "deletePath", "configRead", "configWrite", "configPath", "canonicalPath", "gitSetTrusted", "runCapture", "indexFiles"];
export const { invoke, Channel } = f;
export const api = new Proxy(real.api, { get: (t, k: string) => (local.includes(k) ? (f.api as never)[k] : t[k as keyof typeof t]) });
