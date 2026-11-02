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

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  status: string;
  added: number | null;
  deleted: number | null;
  oldRev: string;
  newRev: string;
}

export interface LogCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  refs: string;
  subject: string;
  col: number;
  edges: { from: number; to: number; kind: 0 | 1 | 2 }[];
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  committer: string;
  commitTime: number;
  body: string;
  files: ChangedFile[];
}

export interface LogOpts {
  branch?: string;
  author?: string;
  text?: string;
  path?: string;
  limit: number;
}

export interface OpState {
  op: "" | "merge" | "rebase" | "cherry-pick" | "revert";
  conflicts: string[];
}

export interface MergeInput {
  symlink: boolean;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  merged: string;
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
  gitFileAt: (root: string, rev: string, path: string) => invoke<string | null>("git_file_at", { root, rev, path }),
  gitLog: (root: string, opts: LogOpts) => invoke<LogCommit[]>("git_log", { root, opts }),
  gitDiffFiles: (root: string, spec: string[]) => invoke<ChangedFile[]>("git_diff_files", { root, spec }),
  gitCommitDetails: (root: string, rev: string) => invoke<CommitDetails>("git_commit_details", { root, rev }),
  gitStagePatch: (root: string, path: string, patch: string) => invoke<void>("git_stage_patch", { root, path, patch }),
  gitOpState: (root: string) => invoke<OpState>("git_op_state", { root }),
  gitMergeInput: (root: string, path: string) => invoke<MergeInput>("git_merge_input", { root, path }),
  git: (root: string, ...args: string[]) => invoke<string>("git_run", { root, args }),
  gitStage: (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths }),
  gitUnstage: (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths }),
  gitCommit: (root: string, message: string) => invoke<string>("git_commit", { root, message }),
  gitBlameLine: (root: string, path: string, line: number) =>
    invoke<{ hash: string; author: string; time: number; summary: string }>("git_blame_line", { root, path, line }),
  freePort: () => invoke<number>("free_port"),
};
