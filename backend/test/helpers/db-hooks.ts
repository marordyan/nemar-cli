/**
 * A D1 handle that runs a hook right after a chosen read returns, to place a write BETWEEN two steps of
 * the code under test (a submitter that binds a job after a sweep took its snapshot, say). It decides
 * nothing: every statement is the real one against the real database, and `batch` is passed through.
 * The hook fires once per arming and then disarms.
 */

export interface DbHook {
  db: D1Database;
  /**
   * Run `hook` once, right after the next `all()` of a statement whose SQL contains `fragment`. A value the
   * hook returns REPLACES the read's result (a reader that took its snapshot before a write).
   */
  armAfterAll(fragment: string, hook: () => Promise<unknown> | unknown): void;
  /** Run `hook` once, right after the next `first()` of a statement whose SQL contains `fragment`. */
  armAfterFirst(fragment: string, hook: () => Promise<unknown> | unknown): void;
}

export function hookedDb(real: D1Database): DbHook {
  const armed: Array<{
    method: "all" | "first";
    fragment: string;
    hook: () => Promise<unknown> | unknown;
  }> = [];
  const take = (method: "all" | "first", sql: string) => {
    const i = armed.findIndex((a) => a.method === method && sql.includes(a.fragment));
    return i === -1 ? undefined : armed.splice(i, 1)[0];
  };
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop !== "prepare") {
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql) as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        const wrapped: Record<string, unknown> = {
          bind: (...a: unknown[]) => {
            statement.bind?.(...a);
            return wrapped;
          },
          run: () => statement.run?.(),
          all: async () => {
            const result = await statement.all?.();
            const replaced = await take("all", sql)?.hook();
            return replaced === undefined ? result : replaced;
          },
          first: async () => {
            const result = await statement.first?.();
            const replaced = await take("first", sql)?.hook();
            return replaced === undefined ? result : replaced;
          },
          __execForBatch: () => statement.__execForBatch?.(),
        };
        return wrapped;
      };
    },
  });
  return {
    db,
    armAfterAll: (fragment, hook) => void armed.push({ method: "all", fragment, hook }),
    armAfterFirst: (fragment, hook) => void armed.push({ method: "first", fragment, hook }),
  };
}
