export const STREAM_IDLE_MS = 120_000;
export const COMPLETION_TIMEOUT_MS = 300_000;

export interface IdleSignal {
  signal: AbortSignal;
  touch: () => void;
  clear: () => void;
}

export function createIdleSignal(idleMs: number, parent?: AbortSignal | undefined): IdleSignal {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new DOMException("The stream went quiet.", "TimeoutError")),
      idleMs,
    );
  };
  touch();
  return {
    signal: parent ? AbortSignal.any([controller.signal, parent]) : controller.signal,
    touch,
    clear: () => clearTimeout(timer),
  };
}
