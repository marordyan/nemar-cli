/**
 * NEMAR's own processing recipes, as the compute gateway's pipeline dispatch knows them (epic #2005
 * phase A6, #2011; ADR 0118; design section 10). Pure and import-free, like `./compute-state.ts`, so
 * the Worker, the command-line interface and the tests read one table.
 *
 * WHAT A RECIPE ENTRY IS. The Worker's side of a recipe that lives in `nemarOrg/nemar-process`: its
 * name, the version and the engine the Worker EXPECTS it to report, the Tapis application that runs
 * it, the partition and resources one job asks for, and the files a finished run must have written.
 * The recipe's code, the images and the application definitions are that repository's. Every number
 * here is initial: the owner adjusts it with the pilot, and the application id and version follow
 * whatever `nemar-process` publishes. A test pins only that every entry is a valid job under
 * `JobSpecSchema` and inside the partition table.
 *
 * `version` AND `engine` ARE EXPECTATIONS, NOT FACTS. The stamp a run leaves (`compute_pipeline_stamps`)
 * is claimed with these values and, when the run succeeds, rewritten from the recipe's own record
 * (`readRecipeRecord`), so it says what actually ran. A recipe whose record disagrees with this table
 * is a registry out of date, and the daily dispatcher stops dispatching it until the table is fixed
 * (`registry_drift`).
 *
 * HOW A RECIPE IS RUN (nemar-process `docs/recipes.md`). The launcher runs an argument vector, so no
 * shell ever expands a variable: the paths below are absolute. The dataset is bound read-only at
 * `/data/<id>` and the job's outputs directory is `/work/outputs`. The launch specification's
 * environment allowlist is closed to six names and has none for an image digest, so the digest travels
 * as the ARGUMENT `--image-digest`. The recipe cannot check that value against the image it runs in; it
 * is the caller's claim, and the Worker compares it with the launcher's `provenance.json` before it
 * accepts a result (`recipeImageDigestArg`).
 */

/** The states of a stamp, declared once; the migration's CHECK is held to this list by a test. */
export const PIPELINE_STAMP_STATES = ["dispatched", "succeeded", "failed", "refused"] as const;

export type PipelineStampState = (typeof PIPELINE_STAMP_STATES)[number];

/** The states in which a stamp holds its tuple: nothing else may claim it. */
export const PIPELINE_LIVE_STAMP_STATES = ["dispatched", "succeeded"] as const;

/**
 * Where a dataset is bound inside the container, and where a recipe writes its product. Absolute: the
 * command is an argument vector and a variable would not be expanded. The product directory is under
 * the launcher's outputs directory (`work/outputs` on the node, `/work/outputs` in the container).
 */
export const RECIPE_DATASET_ROOT = "/data";
export const RECIPE_PRODUCT_DIR = "/work/outputs/product";

/** The product directory as the result's output paths name it: relative to the outputs directory. */
export const RECIPE_PRODUCT_OUTPUT_PREFIX = "product/";

/** The one flag that carries the image digest, and the shape of its value. */
export const RECIPE_IMAGE_DIGEST_FLAG = "--image-digest";

const IMAGE_DIGEST_VALUE_RE = /^sha256:[0-9a-f]{64}$/;

/** What a recipe's dispatch is eligible on: today only electroencephalography (EEG) datasets. */
export type RecipeEligibility = "eeg";

export interface ComputeRecipe {
  /** The recipe's name, as `nemar-recipe run <name>` takes it. */
  name: string;
  /** The version the Worker expects the recipe to report in its own record. */
  version: string;
  /** The Tapis application that runs a recipe job, and its version. */
  appId: string;
  appVersion: string;
  /** The engine the Worker expects the record to name, as `<package>@<version>`. */
  engine: string;
  partition: string;
  nodes: number;
  cores: number;
  memoryMb?: number;
  gpus: number;
  minutes: number;
  /** The daily dispatcher dispatches a recipe only while this is true. */
  autoDispatch: boolean;
  /**
   * The entry stands for a recipe that does not exist yet, or whose numbers nobody has verified. No
   * path dispatches a placeholder (`recipe_placeholder`): the entry is here so the registry's shape is
   * held, and the flag is removed in the change that makes the recipe real.
   */
  placeholder?: boolean;
  eligibility: RecipeEligibility;
}

/**
 * The recipes. `nemar-floor` annotates every EEG recording of a dataset and runs on a CPU partition;
 * `nemar-ica` needs a GPU and stays out of the daily dispatcher until the 20-dataset pilot has run.
 */
export const COMPUTE_RECIPES: readonly ComputeRecipe[] = Object.freeze([
  Object.freeze({
    name: "nemar-floor",
    version: "1.0.0",
    appId: "nemar-launch",
    appVersion: "1.0.0",
    engine: "eegprep@0.5.0",
    partition: "shared",
    nodes: 1,
    cores: 4,
    memoryMb: 16384,
    gpus: 0,
    minutes: 360,
    autoDispatch: true,
    eligibility: "eeg",
  }),
  Object.freeze({
    name: "nemar-ica",
    version: "1.0.0",
    appId: "nemar-launch",
    appVersion: "1.0.0",
    engine: "eegprep@0.5.0",
    partition: "gpu-shared",
    nodes: 1,
    cores: 10,
    gpus: 1,
    minutes: 720,
    autoDispatch: false,
    placeholder: true,
    eligibility: "eeg",
  }),
]) as readonly ComputeRecipe[];

/** The recipe of a name, or null. Exact: no case fold, no trim. */
export function findRecipe(name: unknown): ComputeRecipe | null {
  if (typeof name !== "string") return null;
  return COMPUTE_RECIPES.find((r) => r.name === name) ?? null;
}

/** The label a recipe puts in its product file names: its name without hyphens (`nemarfloor`). */
export function recipeLabel(recipe: Pick<ComputeRecipe, "name">): string {
  return recipe.name.replaceAll("-", "");
}

/**
 * The files a finished run of the recipe must have written, relative to the job's outputs directory:
 * the dataset record, which is the recipe's own record, and the complete recordings table. The table
 * holds the recordings that failed or were skipped, which the dataset record lists only up to a cap.
 */
export function recipeRequiredOutputs(recipe: Pick<ComputeRecipe, "name">): {
  record: string;
  table: string;
} {
  const label = recipeLabel(recipe);
  return {
    record: `${RECIPE_PRODUCT_OUTPUT_PREFIX}desc-${label}_signalJourney.json`,
    table: `${RECIPE_PRODUCT_OUTPUT_PREFIX}desc-${label}_recordings.tsv`,
  };
}

/** The command a recipe job runs; the arguments follow it. */
export function recipeCommand(recipe: Pick<ComputeRecipe, "name">): string[] {
  return ["nemar-recipe", "run", recipe.name];
}

/**
 * The arguments of a recipe job over the whole of one dataset version: where the dataset is, where the
 * product goes, the identity the recipe must not guess, and the image digest. A whole-dataset run
 * names no `--recording`, so it selects every recording the recipe discovers.
 */
export function recipeArguments(input: {
  datasetId: string;
  /** The data-plane tag of the version (`v1.0.2` or `latest`). */
  tag: string;
  /** The image digest, `sha256:<64 hex>`. */
  imageDigest: string;
}): string[] {
  return [
    "--dataset-dir",
    `${RECIPE_DATASET_ROOT}/${input.datasetId}`,
    "--out",
    RECIPE_PRODUCT_DIR,
    "--dataset-id",
    input.datasetId,
    "--dataset-version",
    input.tag,
    RECIPE_IMAGE_DIGEST_FLAG,
    input.imageDigest,
  ];
}

/**
 * The image digest a recipe job's arguments pass, or null when there is not exactly one well-formed
 * value for the flag (none, two, or a value that is not `sha256:` and 64 lowercase hex digits). Exactly
 * one: a second flag would let the recipe and the Worker read different values.
 */
export function recipeImageDigestArg(args: readonly string[]): string | null {
  let found: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== RECIPE_IMAGE_DIGEST_FLAG) continue;
    const value = args[i + 1];
    if (found !== null || value === undefined || !IMAGE_DIGEST_VALUE_RE.test(value)) return null;
    found = value;
    i++;
  }
  return found;
}

// --- The recipe's own record ------------------------------------------------------------------------

/** The most characters of `<package>@<version>`: the stamp's engine column. */
const RECORD_ENGINE_MAX = 64;

const RECORD_WORD_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** What the Worker takes from the recipe's dataset record, and nothing more. */
export interface RecipeRecord {
  recipe: string;
  /** The recipe's version as it reports it. */
  version: string;
  /** `<package>@<version>` of the engine as it reports it. */
  engine: string;
  /** The recordings that succeeded. */
  succeeded: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The identity a recipe's dataset record states, or null when the record does not state it in the shape
 * the recipe writes (`extensions.nemar.recipe`, `.engine` and `.counts`). Nothing else is read, and
 * every word must be a short plain word, so a record can put nothing else into a stamp. The record is
 * written by the job, so this is the recipe's statement of what it is and never an accounting figure.
 */
export function readRecipeRecord(value: unknown): RecipeRecord | null {
  const nemar = object(object(object(value)?.extensions)?.nemar);
  const recipe = object(nemar?.recipe);
  const engine = object(nemar?.engine);
  const counts = object(nemar?.counts);
  if (recipe === null || engine === null || counts === null) return null;
  const { id, version } = recipe;
  const pkg = engine.package;
  const engineVersion = engine.version;
  const succeeded = counts.succeeded;
  if (
    typeof id !== "string" ||
    typeof version !== "string" ||
    typeof pkg !== "string" ||
    typeof engineVersion !== "string" ||
    !RECORD_WORD_RE.test(id) ||
    !RECORD_WORD_RE.test(version) ||
    !RECORD_WORD_RE.test(pkg) ||
    !RECORD_WORD_RE.test(engineVersion) ||
    typeof succeeded !== "number" ||
    !Number.isSafeInteger(succeeded) ||
    succeeded < 0
  ) {
    return null;
  }
  // The stamp's engine column holds 64 characters (migration 0117): a longer value could never be
  // written, so the record is not read rather than left to throw at the update.
  const engineText = `${pkg}@${engineVersion}`;
  if (engineText.length > RECORD_ENGINE_MAX) return null;
  return { recipe: id, version, engine: engineText, succeeded };
}
