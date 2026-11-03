import { gutterDiff } from "./difflogic";

self.onmessage = (e: MessageEvent<{ id: number; a: string; b: string }>) => {
  const { id, a, b } = e.data;
  self.postMessage({ id, hunks: gutterDiff(a, b) });
};
