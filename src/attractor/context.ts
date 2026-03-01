export class PipelineContext {
  #values = new Map<string, unknown>();
  #logs: string[] = [];

  set(key: string, value: unknown): void {
    this.#values.set(key, value);
  }

  get<T = unknown>(key: string, fallback?: T): T | undefined {
    if (this.#values.has(key)) {
      return this.#values.get(key) as T;
    }
    return fallback;
  }

  getString(key: string, fallback = ""): string {
    const value = this.get(key);
    if (value === undefined || value === null) {
      return fallback;
    }
    return String(value);
  }

  applyUpdates(updates: Record<string, unknown> | undefined): void {
    if (!updates) {
      return;
    }
    for (const [key, value] of Object.entries(updates)) {
      this.set(key, value);
    }
  }

  appendLog(entry: string): void {
    this.#logs.push(entry);
  }

  logs(): string[] {
    return [...this.#logs];
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.#values.entries());
  }

  clone(): PipelineContext {
    const next = new PipelineContext();
    for (const [key, value] of this.#values.entries()) {
      next.set(key, value);
    }
    for (const item of this.#logs) {
      next.appendLog(item);
    }
    return next;
  }
}

