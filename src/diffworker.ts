import { diffLines, splitLines } from "./difflogic";

self.onmessage = (e: MessageEvent<{ id: number; a: string; b: string }>) => {
  const { id, a, b } = e.data;
  self.postMessage({ id, hunks: diffLines(splitLines(a), splitLines(b)) });
};
