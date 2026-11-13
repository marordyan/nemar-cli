/**
 * The hidden subcommand that runs the engine. It lives in a module of its own with no imports,
 * because `src/index.ts` reads it on every CLI invocation to decide whether this process is the
 * engine, and importing it from `client.ts` would load the child-process client and the
 * protocol schemas just for one string.
 */
export const ZARR_ENGINE_COMMAND = "__zarr-engine";
