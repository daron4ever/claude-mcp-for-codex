import type { ProtocolPhase } from "./native-protocol.js";

export type ClaudeProgress = {
  phase: ProtocolPhase;
  elapsedMs: number;
  responseEventCount: number;
  lastResponseEventAgeMs: number | null;
  retryEventCount: number;
};
export type ProgressObserver = (progress: ClaudeProgress) => void | Promise<void>;

export function progressMessage(progress: ClaudeProgress): string {
  return `phase=${progress.phase} elapsedMs=${progress.elapsedMs} ` +
    `responseEvents=${progress.responseEventCount} ` +
    `lastResponseAgeMs=${progress.lastResponseEventAgeMs ?? "none_observed"} ` +
    `retryEvents=${progress.retryEventCount}`;
}

// One in-flight notification and one replaceable snapshot per request. A slow or
// failed observer cannot hold up parsing, the deadline, cleanup or the result.
export class ProgressReporter {
  private closed = false;
  private inFlight = false;
  private latest: ClaudeProgress | undefined;
  private lastSentAt = -Infinity;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly observer: ProgressObserver) {}

  update(progress: ClaudeProgress): void {
    if (this.closed) return;
    this.latest = progress;
    this.flush();
  }

  stop(): void {
    this.closed = true;
    this.latest = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private flush(): void {
    if (this.closed || this.inFlight || this.latest === undefined) return;
    const wait = 1_000 - (performance.now() - this.lastSentAt);
    if (wait > 0) {
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, wait);
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    const progress = this.latest;
    this.latest = undefined;
    this.inFlight = true;
    this.lastSentAt = performance.now();
    const release = (): void => {
      this.inFlight = false;
      this.flush();
    };
    try { void Promise.resolve(this.observer(progress)).then(release, release); }
    catch { release(); }
  }
}
