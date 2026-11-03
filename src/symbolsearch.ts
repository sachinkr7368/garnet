type Json = any;

interface Token {
  readonly isCancellationRequested: boolean;
}
interface Source {
  cancel(): void;
  readonly token: Token;
}

export interface SymbolSearchDeps {
  request: (query: string, token: Token) => Promise<Json[] | null>;
  newSource: () => Source;
  /// ruby-lsp is indexing: an empty reply may only mean "not indexed yet".
  busy: () => boolean;
  current: () => string;
  refresh: () => void;
  retries?: number;
  delayMs?: number;
}

/// Workspace symbols for a popup that shows other results at once: one request in flight (a newer query cancels the
/// older one), replies cached per query, a refresh only for the query on screen, and an empty reply while ruby-lsp is
/// indexing retried a bounded number of times. close() cancels the request and any pending retry.
export function symbolSearch(d: SymbolSearchDeps) {
  const cache = new Map<string, Json[]>();
  const tries = new Map<string, number>();
  let inflight: { q: string; src: Source } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const refreshIf = (q: string) => !closed && d.current() === q && d.refresh();

  const fetch = (q: string) => {
    if (closed) return;
    inflight?.src.cancel();
    const mine = (inflight = { q, src: d.newSource() });
    d.request(q, mine.src.token).then(
      (res) => {
        if (inflight === mine) inflight = null;
        if (closed) return;
        const n = tries.get(q) ?? 0;
        if (!res?.length && d.busy() && n < (d.retries ?? 30)) {
          tries.set(q, n + 1);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => ((timer = null), d.current() === q && !cache.has(q) && inflight?.q !== q && fetch(q)), d.delayMs ?? 1000);
          return;
        }
        cache.set(q, res ?? []);
        refreshIf(q);
      },
      () => {
        if (inflight === mine) inflight = null;
        if (!mine.src.token.isCancellationRequested) cache.set(q, []);
        refreshIf(q);
      },
    );
  };

  return {
    /// Cached symbols for `q`; starts a request when there are none yet.
    get(q: string): Json[] {
      if (!closed && !cache.has(q) && inflight?.q !== q) fetch(q);
      return cache.get(q) ?? [];
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      inflight?.src.cancel();
    },
  };
}
