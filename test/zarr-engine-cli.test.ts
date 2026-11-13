/**
 * `nemar engine status` and `nemar engine cache clear` as real subprocesses (the CLI entry, which
 * starts the real engine), against the nm099500 stand-in on 127.0.0.1. Each run has an isolated
 * config directory and disk cache, NEMAR_NO_UPDATE_CHECK=1 and NO_COLOR=1, and the API URL is the
 * stand-in too, so nothing reaches a real host.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIDS, ID, type Standin, runNemar, startStandin } from "./helpers/zarr-engine-standin.js";

setDefaultTimeout(60_000);

let standin: Standin;
let tmp: string;
beforeAll(() => {
  standin = startStandin();
});
afterAll(() => standin.stop());
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nemar-engine-cli-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const cacheDir = () => join(tmp, "cache");
const env = (extra: Record<string, string> = {}) => ({
  ...standin.env({ config: join(tmp, "config"), cache: cacheDir() }),
  ...extra,
});
const nemar = (args: string[], extra: Record<string, string> = {}) => runNemar(args, env(extra));
const readWindow = () =>
  nemar(["zarr", "read", ID, BIDS, "--start", "1", "--duration", "1", "--json"]);
const status = async () => JSON.parse((await nemar(["engine", "status", "--json"])).stdout);

/** Entry files under the cache directory, by walking it the way the cache lays it out. */
function entryFiles(): string[] {
  if (!existsSync(cacheDir())) return [];
  return readdirSync(cacheDir())
    .filter((sub) => /^[0-9a-f]{2}$/.test(sub))
    .flatMap((sub) =>
      readdirSync(join(cacheDir(), sub))
        .filter((n) => !n.startsWith("."))
        .map((n) => join(cacheDir(), sub, n)),
    );
}

describe("nemar engine status", () => {
  test("starts the engine and reports it, the hosts and an empty cache", async () => {
    const r = await nemar(["engine", "status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/Engine\s+nemar-zarr-engine\/\S+ \(protocol 0\.1\)/);
    expect(r.stdout).toMatch(/Max payload\s+256 MiB/);
    expect(r.stdout).toMatch(new RegExp(`Zarr host\\s+${standin.url} \\(from NEMAR_ZARR_BASE\\)`));
    expect(r.stdout).toMatch(new RegExp(`Data plane\\s+${standin.url}/data`));
    expect(r.stdout).toContain(cacheDir());
    expect(r.stdout).toContain("0 B of 2.0 GiB, 0 entries");
  });

  test("--json has the engine, the hosts and the cache numbers", async () => {
    const doc = await status();
    expect(doc.engine.name).toStartWith("nemar-zarr-engine/");
    expect(doc.engine.protocol).toBe("0.1");
    expect(doc.engine.max_payload_bytes).toBe(256 * 1024 * 1024);
    expect(doc.zarr_base).toBe(standin.url);
    expect(doc.zarr_base_source).toBe("env");
    expect(doc.data_plane).toBe(`${standin.url}/data`);
    expect(doc.cache).toEqual({
      dir: cacheDir(),
      enabled: true,
      bytes: 0,
      entries: 0,
      limit_bytes: 2 * 1024 * 1024 * 1024,
    });
  });

  test("after a read the cache numbers are what is on disk", async () => {
    expect((await readWindow()).exitCode).toBe(0);
    const files = entryFiles();
    expect(files.length).toBeGreaterThan(0);
    const bytes = files.reduce((n, f) => n + readFileSync(f).length, 0);
    const doc = await status();
    expect(doc.cache.entries).toBe(files.length);
    expect(doc.cache.bytes).toBe(bytes);
  });

  test("without NEMAR_ZARR_BASE the host is the account's, and an unknown API host falls back to production", async () => {
    const doc = JSON.parse(
      (await nemar(["engine", "status", "--json"], { NEMAR_ZARR_BASE: "" })).stdout,
    );
    expect(doc.zarr_base).toBe("https://zarr.nemar.org");
    expect(doc.zarr_base_source).toBe("default");
    const text = await nemar(["engine", "status"], { NEMAR_ZARR_BASE: "" });
    expect(text.stdout).toContain("the production default");
  });

  test("a limit of 0 says the cache is off", async () => {
    const r = await nemar(["engine", "status"], { NEMAR_ZARR_DISK_CACHE_BYTES: "0" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("off (NEMAR_ZARR_DISK_CACHE_BYTES=0)");
    const doc = JSON.parse(
      (await nemar(["engine", "status", "--json"], { NEMAR_ZARR_DISK_CACHE_BYTES: "0" })).stdout,
    );
    expect(doc.cache.enabled).toBe(false);
  });

  test("a bad setting is exit 1 naming it, and under --json nothing goes to stdout", async () => {
    const r = await nemar(["engine", "status"], { NEMAR_ZARR_DISK_CACHE_BYTES: "lots" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("NEMAR_ZARR_DISK_CACHE_BYTES");
    const j = await nemar(["engine", "status", "--json"], {
      NEMAR_ZARR_BASE: "http://example.com",
    });
    expect(j.exitCode).toBe(1);
    expect(j.stdout).toBe("");
    expect(j.stderr).toContain("NEMAR_ZARR_BASE");
  });

  test("--help-all shows the examples", async () => {
    const r = await nemar(["engine", "status", "--help-all"]);
    expect(r.stdout).toContain("Examples:");
    expect(r.stdout).toContain("nemar engine status --json");
  });
});

describe("nemar engine cache clear", () => {
  test("removes the entries, reports the bytes freed, and the next read refills the cache", async () => {
    expect((await readWindow()).exitCode).toBe(0);
    const before = await status();
    expect(before.cache.bytes).toBeGreaterThan(0);
    const r = await nemar(["engine", "cache", "clear"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`Cleared the Zarr cache at ${cacheDir()}`);
    expect(entryFiles()).toEqual([]);
    const after = await status();
    expect(after.cache).toMatchObject({ bytes: 0, entries: 0 });
    // A cleared cache means the next read goes to the host again.
    standin.ranges.length = 0;
    expect((await readWindow()).exitCode).toBe(0);
    expect(standin.ranges.length).toBeGreaterThan(0);
  });

  test("--json gives the directory and the bytes freed, then zero the second time", async () => {
    await readWindow();
    const { cache } = await status();
    const first = JSON.parse((await nemar(["engine", "cache", "clear", "--json"])).stdout);
    expect(first).toEqual({ dir: cacheDir(), freed_bytes: cache.bytes, failed: 0 });
    const second = JSON.parse((await nemar(["engine", "cache", "clear", "--json"])).stdout);
    expect(second.freed_bytes).toBe(0);
  });

  test("leaves other files in the directory alone", async () => {
    await readWindow();
    writeFileSync(join(cacheDir(), "keep-me.txt"), "mine");
    expect((await nemar(["engine", "cache", "clear"])).exitCode).toBe(0);
    expect(readFileSync(join(cacheDir(), "keep-me.txt"), "utf8")).toBe("mine");
  });

  test.skipIf(typeof process.getuid !== "function" || process.getuid() === 0)(
    "an entry that cannot be removed is reported, with exit 1",
    async () => {
      await readWindow();
      const sub = readdirSync(cacheDir()).find((n) => /^[0-9a-f]{2}$/.test(n)) ?? "";
      const locked = join(cacheDir(), sub);
      chmodSync(locked, 0o500);
      try {
        const r = await nemar(["engine", "cache", "clear", "--json"]);
        expect(r.exitCode).toBe(1);
        expect(JSON.parse(r.stdout).failed).toBeGreaterThan(0);
        expect(r.stderr).toContain("could not be removed");
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );

  test("refuses a directory the cache did not create, and removes nothing from it", async () => {
    const unrelated = join(tmp, "unrelated");
    mkdirSync(join(unrelated, "ab"), { recursive: true });
    const lookalike = join(unrelated, "ab", "c".repeat(64));
    writeFileSync(lookalike, "mine");
    const r = await nemar(["engine", "cache", "clear"], { NEMAR_ZARR_DISK_CACHE_DIR: unrelated });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("nothing was removed");
    expect(readFileSync(lookalike, "utf8")).toBe("mine");
  });

  test("a bad setting is exit 1", async () => {
    const r = await nemar(["engine", "cache", "clear"], { NEMAR_ZARR_DISK_CACHE_BYTES: "-5" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("NEMAR_ZARR_DISK_CACHE_BYTES");
  });

  test("--help-all shows the examples", async () => {
    const r = await nemar(["engine", "cache", "clear", "--help-all"]);
    expect(r.stdout).toContain("Examples:");
    expect(r.stdout).toContain("nemar engine cache clear");
  });

  test("nemar --help lists the engine group", async () => {
    const r = await nemar(["--help"]);
    expect(r.stdout).toMatch(/^ {2}engine /m);
  });
});
