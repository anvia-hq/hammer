export async function withRetry<T>(run: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= attempts; i += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw last;
}
