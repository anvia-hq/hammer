import {
  applyProgressEvent,
  renderProgressBody,
  type ProgressState,
  type ReviewEvent,
} from "@anvia/hammer-core";

export const PROGRESS_INTERVAL_MS = 8000;

export interface ProgressReporterOptions {
  state: ProgressState;
  write: (body: string) => Promise<void>;
  warn: (message: string) => void;
  intervalMs?: number;
  now?: () => number;
}

export interface ProgressReporter {
  start(): Promise<void>;
  onEvent(event: ReviewEvent): void;
  settle(): Promise<void>;
}

export function createProgressReporter(options: ProgressReporterOptions): ProgressReporter {
  const interval = options.intervalMs ?? PROGRESS_INTERVAL_MS;
  const now = options.now ?? Date.now;
  let state = options.state;
  let inflight: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastWrite = 0;
  let closed = false;
  let failed = false;

  const write = (): Promise<void> => {
    inflight = inflight.then(async () => {
      if (closed || failed) return;
      lastWrite = now();
      try {
        await options.write(renderProgressBody(state));
      } catch (error) {
        failed = true;
        options.warn(
          `Progress comment could not be updated; the final review is unaffected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    return inflight;
  };

  return {
    start: () => write(),
    onEvent(event) {
      if (closed || failed) return;
      state = applyProgressEvent(state, event);
      if (timer !== undefined) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          void write();
        },
        Math.max(0, lastWrite + interval - now()),
      );
    },
    async settle() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await inflight;
    },
  };
}
