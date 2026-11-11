// Record what `AbortSignal.timeout` is asked for while a test runs, so a test can assert the exact time
// budget a client call was given (the real function still does the timing). Observation only: restored
// by `restore`, which a test calls in a `finally`.

export function recordAbortTimeouts(): { values: number[]; restore: () => void } {
  const original = AbortSignal.timeout;
  const values: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    values.push(ms);
    return original.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  return {
    values,
    restore: () => {
      AbortSignal.timeout = original;
    },
  };
}
