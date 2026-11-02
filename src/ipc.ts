import { Channel, invoke } from "@tauri-apps/api/core";

export { Channel, invoke };

export type PtyEvent = { type: "data"; data: string } | { type: "exit"; code: number | null };
export type RpcEvent =
  | { type: "message"; body: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; code: number | null };

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface ProjectInfo {
  root: string;
  name: string;
  git: boolean;
  rails: boolean;
  rspec: boolean;
  minitest: boolean;
  binRspec: boolean;
  debugBundled: boolean;
}

export interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
}

export interface Hunk {
  kind: "added" | "modified" | "deleted";
  start: number;
  end: number;
}

export const api = {
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
  createPath: (path: string, dir: boolean) => invoke<void>("create_path", { path, dir }),
  renamePath: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  deletePath: (path: string) => invoke<void>("delete_path", { path }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  findFiles: (query: string, limit: number) => invoke<string[]>("find_files", { query, limit }),
  indexFiles: () => invoke<string[]>("index_files"),
  openProject: (path: string) => invoke<ProjectInfo>("open_project", { path }),
  runCapture: (root: string, command: string, timeoutSecs?: number) =>
    invoke<string>("run_capture", { root, command, timeoutSecs }),
  initialPath: () => invoke<string | null>("initial_path"),
  configPath: (name: string) => invoke<string>("config_path", { name }),
  gitSetTrusted: (trusted: boolean) => invoke<void>("git_set_trusted", { trusted }),
  canonicalPath: (path: string) => invoke<string>("canonical_path", { path }),
  configRead: (name: string) => invoke<string | null>("config_read", { name }),
  configWrite: (name: string, content: string) => invoke<void>("config_write", { name, content }),
  gitStatus: (root: string) => invoke<GitStatusEntry[]>("git_status", { root }),
  gitBranch: (root: string) => invoke<string>("git_branch", { root }),
  gitShow: (root: string, path: string, rev: string) => invoke<string>("git_show", { root, path, rev }),
  gitDiffHunks: (root: string, path: string) => invoke<Hunk[]>("git_diff_hunks", { root, path }),
  gitStage: (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths }),
  gitUnstage: (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths }),
  gitCommit: (root: string, message: string) => invoke<string>("git_commit", { root, message }),
  gitBlameLine: (root: string, path: string, line: number) =>
    invoke<{ hash: string; author: string; time: number; summary: string }>("git_blame_line", { root, path, line }),
  freePort: () => invoke<number>("free_port"),
};
