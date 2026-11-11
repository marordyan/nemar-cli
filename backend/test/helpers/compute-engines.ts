/**
 * The two SQL engines a compute migration is proven on (epic #2005 phase A3, #2008): bun:sqlite,
 * which every other suite uses, and Miniflare's D1, the implementation `wrangler --local` runs.
 * bun:sqlite is more permissive than the SQLite D1 ships (a GLOB that D1 calls too complex, a
 * construct it compiles differently), so a CHECK, a trigger or an index proven only on the first is
 * not proven. Both carry every real migration; nothing is stood in for.
 */

import { type MiniflareD1, miniflareD1 } from "./compute-ledger";
import { freshDb, realD1 } from "./d1";

export interface Engine {
  name: string;
  d1: D1Database;
  /** Run a statement; the error text when the engine refused it, else null. */
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
}

export interface Engines {
  engines: Engine[];
  dispose(): Promise<void>;
}

export async function startEngines(): Promise<Engines> {
  const db = freshDb();
  const sqlite = realD1(db);
  const engines: Engine[] = [
    {
      name: "bun:sqlite",
      d1: sqlite,
      async run(sql, ...binds) {
        try {
          db.prepare(sql).run(...(binds as never[]));
          return null;
        } catch (err) {
          return String(err);
        }
      },
      async all<T>(sql: string, ...binds: unknown[]) {
        return db.prepare(sql).all(...(binds as never[])) as T[];
      },
    },
  ];
  const mf: MiniflareD1 = await miniflareD1();
  engines.push({
    name: "Miniflare D1",
    d1: mf.d1,
    async run(sql, ...binds) {
      try {
        await mf.d1
          .prepare(sql)
          .bind(...binds)
          .run();
        return null;
      } catch (err) {
        return String(err);
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return (
        await mf.d1
          .prepare(sql)
          .bind(...binds)
          .all<T>()
      ).results;
    },
  });
  return { engines, dispose: () => mf.dispose() };
}
