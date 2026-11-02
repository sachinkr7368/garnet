// Pure bookkeeping for several debug sessions at once: which one the panel shows.

export interface SessionLike {
  name: string;
  ended: boolean;
  paused: boolean;
}

export class SessionList<T extends SessionLike> {
  items: T[] = [];
  selected: T | null = null;

  /// Adds a session (named uniquely, e.g. "Sidekiq (2)") and selects it.
  add(s: T): T {
    let name = s.name;
    for (let n = 2; this.items.some((x) => x.name === name); n++) name = `${s.name} (${n})`;
    s.name = name;
    this.items.push(s);
    this.selected = s;
    return s;
  }

  remove(s: T) {
    const i = this.items.indexOf(s);
    if (i < 0) return;
    this.items.splice(i, 1);
    if (this.selected === s) this.selected = this.items.find((x) => x.paused) ?? this.items[Math.min(i, this.items.length - 1)] ?? null;
  }

  select(s: T) {
    if (this.items.includes(s)) this.selected = s;
  }

  live(): T[] {
    return this.items.filter((s) => !s.ended);
  }

  /// A session that just paused takes the panel unless the selected one is itself paused.
  focusOnStop(s: T): boolean {
    if (this.selected && this.selected !== s && this.selected.paused && !this.selected.ended) return false;
    this.selected = s;
    return true;
  }
}
