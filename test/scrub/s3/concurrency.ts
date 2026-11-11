/**
 * Bounded concurrency for the scrub stage tests, which run the real CLI. CI runners have four
 * cores and other test files run beside this one, so every file bounds how many real programs it
 * has going at once.
 *
 * Everything here is a FACTORY. Bun caches a module once per process, so a queue or a counter at
 * the top level of this file would be one queue shared by every test file that imports it. Each
 * test file makes its own limiter or pool, and registers its own `beforeAll`/`describe`: a hook
 * registered at the top level of an imported module binds to the first importing file only.
 */

import { test } from "bun:test";

/**
 * The limit of a test that is declared `test.concurrent`, or sits in a `describe.concurrent`.
 *
 * In Bun 1.4.3 adjacent concurrent tests run as one batch and the timeout of each test counts from
 * the START OF THE BATCH, so the time a test spends waiting for a limiter slot counts against
 * it. On a four-core CI runner the slowest test of a batch took 124 s of the 240 s `SLOW`; a
 * larger limit keeps a slow runner from failing a test that is only queued. Sequential tests
 * keep `SLOW`.
 */
export const BATCH_SLOW = 600_000;

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** At most `n` calls of `fn` at once; the rest wait in the order they asked. */
export function makeLimiter(n: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter, so the count never exceeds `n`.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * Wait for every promise to settle, then return the values, or throw the first failure in the
 * order given. Unlike `Promise.all`, no sibling run is still going when the caller reports.
 */
export async function settleAll<T>(runs: Array<Promise<T>>): Promise<T[]> {
  const settled = await Promise.allSettled(runs);
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
}

/** Run the cases together; wait for all of them, then report the first failure. */
export async function together(cases: Array<() => Promise<void>>): Promise<void> {
  await settleAll(cases.map(async (c) => c()));
}

/**
 * Test bodies that run in the background, at most `n` at a time and in the order the tests are
 * written, once `start` opens the queue. Each test then waits for its own job, so time spent
 * queued is not counted against its timeout; a job has the whole timeout from the moment it
 * starts. The test file calls `beforeAll(pool.start)` itself, or `pool.start()` at the end of
 * the `beforeAll` that builds what the jobs need.
 */
export function makeJobPool(n: number): {
  job(name: string, body: () => Promise<void>, timeout: number): void;
  start(): void;
} {
  const queue: Array<() => void> = [];
  let running = 0;
  let open = false;
  function pump() {
    while (open && running < n) {
      const begin = queue.shift();
      if (!begin) return;
      running++;
      begin();
    }
  }
  return {
    start() {
      open = true;
      pump();
    },
    job(name, body, timeout) {
      const done = new Promise<void>((resolve, reject) => {
        queue.push(() => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const expired = new Promise<never>((_, fail) => {
            timer = setTimeout(
              () => fail(new Error(`${name}: not finished after ${timeout} ms`)),
              timeout,
            );
          });
          Promise.race([body(), expired])
            .then(resolve, reject)
            .finally(() => {
              clearTimeout(timer);
              running--;
              pump();
            });
        });
      });
      // The test below reports a failure; this keeps one that settles first from being "unhandled".
      done.catch(() => {});
      test(name, () => done, timeout);
    },
  };
}
