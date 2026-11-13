/**
 * Development entry point of the Zarr engine: `bun run src/lib/zarr-engine/main.ts`.
 * The engine itself is `runEngine` in `run.ts`; the CLI runs it as `nemar __zarr-engine`.
 */

import { runEngine } from "./run.js";

const code = await runEngine();
// Every reply was written before serve resolved; exit now rather than wait for stdin.
process.exit(code);
