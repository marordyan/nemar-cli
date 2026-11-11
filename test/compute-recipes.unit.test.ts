/**
 * The recipe registry of NEMAR's pipeline dispatch (epic #2005 phase A6, #2011; ADR 0118).
 *
 * The registry's numbers are initial and the owner adjusts them, so what is pinned is not a value
 * but a shape: every entry is a valid job under the strict `JobSpecSchema` and inside the partition
 * table; the command line a recipe job gets is an absolute argument vector that fits the launch
 * specification; the image digest argument is read back exactly or not at all; and the recipe's own
 * record is read only in the shape the recipe writes. The module is pure and import-free, and the
 * test reads its source to hold it to that.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPUTE_RECIPES,
  PIPELINE_LIVE_STAMP_STATES,
  PIPELINE_STAMP_STATES,
  RECIPE_DATASET_ROOT,
  RECIPE_IMAGE_DIGEST_FLAG,
  RECIPE_PRODUCT_DIR,
  findRecipe,
  readRecipeRecord,
  recipeArguments,
  recipeCommand,
  recipeImageDigestArg,
  recipeLabel,
  recipeRequiredOutputs,
} from "../shared/compute-recipes";
import {
  JobSpecSchema,
  LAUNCHER_OUTPUTS_DIR,
  PARTITIONS,
  type PartitionName,
  estimateSuMilli,
} from "../shared/contract/compute";
import { launchSpecFits } from "../shared/contract/compute-launch";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `ghcr.io/example/nemar-python@${DIGEST}`;

function specOf(recipe: (typeof COMPUTE_RECIPES)[number], over: Record<string, unknown> = {}) {
  return JobSpecSchema.parse({
    name: `${recipe.name} nm000104 v1.0.2`,
    runtime: "image",
    image: IMAGE,
    recipe: recipe.name,
    command: recipeCommand(recipe),
    args: recipeArguments({ datasetId: "nm000104", tag: "v1.0.2", imageDigest: DIGEST }),
    datasets: [{ id: "nm000104", version: "v1.0.2" }],
    partition: recipe.partition,
    nodes: recipe.nodes,
    cores: recipe.cores,
    ...(recipe.memoryMb === undefined ? {} : { memory_mb: recipe.memoryMb }),
    gpus: recipe.gpus,
    minutes: recipe.minutes,
    ...over,
  });
}

describe("the registry", () => {
  test("names are unique, and each is a recipe name the job schema takes", () => {
    const names = COMPUTE_RECIPES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("nemar-floor");
    expect(names).toContain("nemar-ica");
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9-]{0,63}$/);
  });

  test("the floor is automatic on a CPU partition, the ICA is not and needs a GPU", () => {
    const floor = findRecipe("nemar-floor");
    const ica = findRecipe("nemar-ica");
    expect(floor).toMatchObject({ autoDispatch: true, partition: "shared", gpus: 0 });
    expect(ica).toMatchObject({ autoDispatch: false, partition: "gpu-shared" });
    expect(PARTITIONS[ica?.partition as PartitionName].pool).toBe("gpu");
    expect(ica?.gpus).toBeGreaterThanOrEqual(1);
  });

  test("nemar-ica is a placeholder (its numbers are unverified) and nemar-floor is not", () => {
    expect(findRecipe("nemar-ica")?.placeholder).toBe(true);
    expect(findRecipe("nemar-floor")?.placeholder).toBeFalsy();
  });

  test("findRecipe is exact: no case fold, no trim, and a non-string is none", () => {
    for (const bad of ["Nemar-Floor", " nemar-floor", "nemar-floor ", "", null, undefined, 7, {}]) {
      expect(findRecipe(bad)).toBeNull();
    }
    expect(findRecipe("nemar-floor")?.name).toBe("nemar-floor");
    // Own properties only: nothing is looked up by a prototype key.
    expect(findRecipe("constructor")).toBeNull();
  });

  for (const recipe of COMPUTE_RECIPES) {
    describe(recipe.name, () => {
      test("is a valid job under the strict schema and fits the launch specification", () => {
        const spec = specOf(recipe);
        expect(spec.recipe).toBe(recipe.name);
        expect(launchSpecFits(spec)).toBe(true);
      });

      test("is inside the partition table: the pool matches and the ceiling holds", () => {
        const partition = PARTITIONS[recipe.partition as PartitionName];
        expect(partition).toBeDefined();
        // A partition with a ceiling is offered to people too; NEMAR's own jobs may exceed none of it
        // by default, so the entry fits its ceiling where it has one.
        if (partition.ceiling) {
          expect(recipe.nodes).toBeLessThanOrEqual(partition.ceiling.maxNodes);
          expect(recipe.cores).toBeLessThanOrEqual(partition.ceiling.maxCoresPerNode);
          expect(recipe.gpus).toBeLessThanOrEqual(partition.ceiling.maxGpusPerNode);
          expect(recipe.minutes).toBeLessThanOrEqual(partition.ceiling.maxMinutes);
        }
        expect(estimateSuMilli(specOf(recipe))).toBeGreaterThan(0);
      });

      test("its version and engine are plain words the stamp's columns take", () => {
        expect(recipe.version).toMatch(/^[0-9A-Za-z._+-]{1,64}$/);
        expect(recipe.engine).toMatch(/^[0-9A-Za-z._+@-]{1,64}$/);
      });

      test("its required outputs are under the product directory and named by its label", () => {
        const out = recipeRequiredOutputs(recipe);
        const label = recipeLabel(recipe);
        expect(out.record).toBe(`product/desc-${label}_signalJourney.json`);
        expect(out.table).toBe(`product/desc-${label}_recordings.tsv`);
        // The product directory the arguments name is that prefix under the launcher's outputs.
        expect(RECIPE_PRODUCT_DIR).toBe(`/${LAUNCHER_OUTPUTS_DIR}/product`);
      });
    });
  }

  test("the stamp's live states are a subset of its states", () => {
    for (const s of PIPELINE_LIVE_STAMP_STATES) {
      expect((PIPELINE_STAMP_STATES as readonly string[]).includes(s)).toBe(true);
    }
  });
});

describe("the arguments", () => {
  const args = recipeArguments({ datasetId: "nm000104", tag: "v1.0.2", imageDigest: DIGEST });

  test("are an absolute argument vector: the dataset where the launcher binds it, the product under outputs", () => {
    expect(recipeCommand({ name: "nemar-floor" })).toEqual(["nemar-recipe", "run", "nemar-floor"]);
    expect(args).toEqual([
      "--dataset-dir",
      `${RECIPE_DATASET_ROOT}/nm000104`,
      "--out",
      RECIPE_PRODUCT_DIR,
      "--dataset-id",
      "nm000104",
      "--dataset-version",
      "v1.0.2",
      RECIPE_IMAGE_DIGEST_FLAG,
      DIGEST,
    ]);
    // No variable is expanded by a shell, so none may appear.
    for (const a of args) expect(a).not.toMatch(/[$`]/);
  });

  test("a whole-dataset run selects every recording: it names none", () => {
    expect(args).not.toContain("--recording");
  });

  test("the arguments are within the job schema's argument bounds (64 of 1,024 characters)", () => {
    expect(args.length).toBeLessThanOrEqual(64);
    for (const a of args) expect(a.length).toBeLessThanOrEqual(1024);
  });

  test("the image digest is read back exactly", () => {
    expect(recipeImageDigestArg(args)).toBe(DIGEST);
  });

  test("a missing flag, a malformed value, a missing value and a second flag are all none", () => {
    expect(recipeImageDigestArg([])).toBeNull();
    expect(recipeImageDigestArg(["--dataset-dir", "/data/x"])).toBeNull();
    expect(recipeImageDigestArg([RECIPE_IMAGE_DIGEST_FLAG])).toBeNull();
    for (const bad of [
      "sha256:abc",
      `sha256:${"A".repeat(64)}`,
      `sha1:${"a".repeat(64)}`,
      `${DIGEST} `,
      `${"a".repeat(64)}`,
    ]) {
      expect(recipeImageDigestArg([RECIPE_IMAGE_DIGEST_FLAG, bad])).toBeNull();
    }
    expect(
      recipeImageDigestArg([
        RECIPE_IMAGE_DIGEST_FLAG,
        DIGEST,
        RECIPE_IMAGE_DIGEST_FLAG,
        `sha256:${"b".repeat(64)}`,
      ]),
    ).toBeNull();
    // The value that follows another flag is not this flag's.
    expect(recipeImageDigestArg(["--out", RECIPE_IMAGE_DIGEST_FLAG])).toBeNull();
  });
});

describe("the recipe's own record", () => {
  const record = (over: Record<string, unknown> = {}) => ({
    extensions: {
      nemar: {
        recipe: { id: "nemar-floor", version: "1.0.0" },
        engine: { package: "eegprep", version: "0.5.0" },
        counts: { discovered: 3, succeeded: 2, failed: 1, skipped: 0 },
        ...over,
      },
    },
  });

  test("gives the recipe, its version, the engine and the count of recordings that succeeded", () => {
    expect(readRecipeRecord(record())).toEqual({
      recipe: "nemar-floor",
      version: "1.0.0",
      engine: "eegprep@0.5.0",
      succeeded: 2,
    });
  });

  test("is none unless every field is in the shape the recipe writes", () => {
    for (const bad of [
      null,
      "x",
      [],
      {},
      { extensions: {} },
      { extensions: { nemar: {} } },
      record({ recipe: { id: "nemar-floor" } }),
      record({ recipe: { id: "nemar floor", version: "1.0.0" } }),
      record({ recipe: { id: "nemar-floor", version: "1.0/0" } }),
      record({ engine: { package: "eegprep" } }),
      record({ engine: { package: "eeg prep", version: "0.5.0" } }),
      record({ counts: {} }),
      record({ counts: { succeeded: -1 } }),
      record({ counts: { succeeded: 1.5 } }),
      record({ counts: { succeeded: "2" } }),
    ]) {
      expect(readRecipeRecord(bad)).toBeNull();
    }
  });

  test("is none when package@version would not fit the stamp's 64-character engine column", () => {
    const engine = (version: number) =>
      record({ engine: { package: "e".repeat(10), version: "1".repeat(version) } });
    // package + "@" + version: 64 characters fit, 65 do not.
    expect(readRecipeRecord(engine(53))?.engine).toHaveLength(64);
    expect(readRecipeRecord(engine(54))).toBeNull();
  });

  test("takes no text a record could use to put anything else into a stamp", () => {
    const hostile = record({ recipe: { id: "a".repeat(80), version: "1.0.0" } });
    expect(readRecipeRecord(hostile)).toBeNull();
  });
});

describe("the module", () => {
  test("is pure and import-free", () => {
    const src = readFileSync(join(import.meta.dir, "../shared/compute-recipes.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bfetch\s*\(|Date\.now|Math\.random|process\./);
  });
});
