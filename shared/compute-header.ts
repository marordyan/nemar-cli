/**
 * The inline job header (epic #2005 phase A1, #2006; ADR 0118): a script states what a job asks for
 * in a comment block, in the manner of Python's inline script metadata (PEP 723), and command-line
 * flags override it. Zero imports and zero dependencies, so the CLI, the Worker and the tests read
 * the same few hundred lines and none of them needs a TOML library.
 *
 * Three homes, one body:
 *
 *     # /// nemar          (Python: every line of the block starts `# `)
 *     # cores = 8
 *     # ///
 *
 *     % /// nemar          (MATLAB: the same body behind `% `)
 *
 *     nemar-job.toml       (a folder's own file: the whole file is the body)
 *
 * The body is a SUBSET of TOML, because it is text a script's author wrote and NEMAR acts on it:
 * bare keys; double-quoted strings with the escapes `\\`, `\"`, `\n` and `\t`; non-negative
 * integers; arrays of strings, on one line or several, with comments and a trailing comma; and `#`
 * comments after a value. Tables, floats, booleans, dates, literal strings, multi-line strings,
 * signed or underscored numbers, dotted and quoted keys are refused, never guessed at. The keys
 * are the eleven in {@link HEADER_KEYS}.
 *
 * A PEP 723 `# /// script` block, or a block of any other type, is none of this module's business
 * and is skipped whole, errors and all. A second `nemar` block is an error.
 */

/** The eleven keys a header may set. */
export const HEADER_KEYS = [
  "name",
  "runtime",
  "entry",
  "datasets",
  "partition",
  "nodes",
  "cores",
  "memory",
  "time",
  "gpus",
  "args",
] as const;

export type HeaderKey = (typeof HEADER_KEYS)[number];

/** What a header can be wrong about, and nothing else. */
export const HEADER_ERROR_CODES = [
  "unterminated_block",
  "duplicate_block",
  "bad_line",
  "duplicate_key",
  "unknown_key",
  "unsupported_value",
  "bad_string",
  "input_too_large",
] as const;

export type HeaderErrorCode = (typeof HEADER_ERROR_CODES)[number];

/** Larger input is refused unread. Counted in UTF-8 bytes. */
export const HEADER_MAX_BYTES = 256 * 1024;

/** `python` and `matlab` read a comment block; `toml` reads a whole `nemar-job.toml`. */
export type HeaderKind = "python" | "matlab" | "toml";

export interface HeaderError {
  /** The physical line in the text, from 1. */
  line: number;
  code: HeaderErrorCode;
}

/** The values a header holds, as written: strings, integers and arrays of strings. */
export interface HeaderFields {
  name?: string;
  runtime?: string;
  entry?: string;
  datasets?: string[];
  partition?: string;
  nodes?: number;
  cores?: number;
  memory?: string;
  time?: string;
  gpus?: number;
  args?: string[];
}

/** The line each key was written on. */
export type HeaderLines = Partial<Record<HeaderKey, number>>;

export type HeaderResult =
  | {
      ok: true;
      /** Whether a `nemar` block (or, for `toml`, a file) was there at all. */
      found: boolean;
      fields: HeaderFields;
      lines: HeaderLines;
    }
  | { ok: false; errors: HeaderError[] };

type ValueKind = "string" | "int" | "strings";

const KEY_KIND: Readonly<Record<HeaderKey, ValueKind>> = {
  name: "string",
  runtime: "string",
  entry: "string",
  datasets: "strings",
  partition: "string",
  nodes: "int",
  cores: "int",
  memory: "string",
  time: "string",
  gpus: "int",
  args: "strings",
};

const isHeaderKey = (key: string): key is HeaderKey =>
  (HEADER_KEYS as readonly string[]).includes(key);

/** One line of the body, and the physical line it came from. */
interface BodyLine {
  text: string;
  line: number;
}

type Value = string | number | string[];

type Parsed =
  | {
      ok: true;
      value: Value;
      /** The index of the next body line to read. */
      next: number;
      /** What followed the value on its last line: only blanks and a comment are allowed. */
      trailing: string;
    }
  | {
      ok: false;
      code: HeaderErrorCode;
      /** The line to report: the key's for a bad statement, the element's for a bad element. */
      line: number;
      /** The index of the next body line to read. */
      next: number;
    };

const ESCAPES: Readonly<Record<string, string>> = { "\\": "\\", '"': '"', n: "\n", t: "\t" };

/** A line that begins a statement: a bare key and an equals sign. Never valid inside an array. */
const STATEMENT_START = /^[ \t]*[A-Za-z0-9_-]+[ \t]*=/;

const BLANK_OR_COMMENT = /^[ \t]*(#.*)?$/;

/** Reads a double-quoted string at the start of `text`; `end` is the index after the closing quote. */
function readString(text: string): { ok: true; value: string; end: number } | { ok: false } {
  let value = "";
  let j = 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '"') return { ok: true, value, end: j + 1 };
    if (ch === "\\") {
      const escaped = ESCAPES[text[j + 1] ?? ""];
      if (escaped === undefined) return { ok: false };
      value += escaped;
      j += 2;
      continue;
    }
    const code = ch.charCodeAt(0);
    // A raw tab is allowed, as in TOML; every other control character and DEL is not.
    if ((code < 0x20 && ch !== "\t") || code === 0x7f) return { ok: false };
    value += ch;
    j++;
  }
  return { ok: false };
}

/**
 * After an error inside an array, find where the array ends so the next statement is read as
 * usual: scan on, string-aware, to the bracket that closes it, or stop before a line that begins a
 * statement (an array's lines never do), or at the end of the body. Returns the next line index.
 */
function skipArray(body: BodyLine[], index: number, current: string, pos: number): number {
  let depth = 1;
  for (let k = index; k < body.length; k++) {
    const text = k === index ? current : body[k].text;
    if (k > index && STATEMENT_START.test(text)) return k;
    let inString = false;
    for (let j = k === index ? pos : 0; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === "\\") j++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "#") break;
      else if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) return k + 1;
    }
  }
  return body.length;
}

/** Reads an array of strings that starts at the `[` at the head of `first`, possibly over lines. */
function readArray(body: BodyLine[], index: number, first: string): Parsed {
  const keyLine = body[index].line;
  const items: string[] = [];
  let k = index;
  let text = first;
  let pos = 1;
  let afterItem = false;

  // A structural fault is the statement's: reported at the key's line, then skipped past.
  const structural = (): Parsed => ({
    ok: false,
    code: "bad_line",
    line: keyLine,
    next: skipArray(body, k, text, pos),
  });
  const element = (code: HeaderErrorCode): Parsed => ({
    ok: false,
    code,
    line: body[k].line,
    next: skipArray(body, k, text, pos),
  });

  for (;;) {
    while (pos < text.length && (text[pos] === " " || text[pos] === "\t")) pos++;
    if (pos >= text.length || text[pos] === "#") {
      k++;
      if (k >= body.length || STATEMENT_START.test(body[k].text)) {
        // Never closed: the next statement, if any, is read as a statement.
        return { ok: false, code: "bad_line", line: keyLine, next: k };
      }
      text = body[k].text;
      pos = 0;
      continue;
    }
    const ch = text[pos];
    if (ch === "]") {
      return { ok: true, value: items, next: k + 1, trailing: text.slice(pos + 1) };
    }
    if (afterItem) {
      if (ch !== ",") return structural();
      pos++;
      afterItem = false;
      continue;
    }
    if (ch === ",") return structural();
    if (ch === '"') {
      if (text.startsWith('"""', pos)) return element("unsupported_value");
      const str = readString(text.slice(pos));
      if (!str.ok) return element("bad_string");
      items.push(str.value);
      pos += str.end;
      afterItem = true;
      continue;
    }
    // Anything that looks like a value but is not a string: a number, a boolean, a date, a nested
    // array or table, a literal string.
    if (ch === "[" || ch === "{" || ch === "'" || /[A-Za-z0-9_+.:-]/.test(ch)) {
      return element("unsupported_value");
    }
    return structural();
  }
}

/** Reads the value after `=` on body line `index`; `rest` is the text after the equals sign. */
function readValue(body: BodyLine[], index: number, rest: string): Parsed {
  const line = body[index].line;
  const v = rest.replace(/^[ \t]+/, "");
  const c = v[0];
  if (c === '"') {
    if (v.startsWith('"""')) return { ok: false, code: "unsupported_value", line, next: index + 1 };
    const str = readString(v);
    if (!str.ok) return { ok: false, code: "bad_string", line, next: index + 1 };
    return { ok: true, value: str.value, next: index + 1, trailing: v.slice(str.end) };
  }
  if (c === "'" || c === "{")
    return { ok: false, code: "unsupported_value", line, next: index + 1 };
  if (c === "[") return readArray(body, index, v);
  const token = /^[A-Za-z0-9_+.:-]+/.exec(v);
  if (!token) return { ok: false, code: "bad_line", line, next: index + 1 };
  const digits = token[0];
  if (/^(0|[1-9][0-9]*)$/.test(digits) && Number.isSafeInteger(Number(digits))) {
    return { ok: true, value: Number(digits), next: index + 1, trailing: v.slice(digits.length) };
  }
  return { ok: false, code: "unsupported_value", line, next: index + 1 };
}

/** Reads a whole body, appending to `errors` and returning what parsed. */
function readBody(
  body: BodyLine[],
  errors: HeaderError[],
): { fields: HeaderFields; lines: HeaderLines } {
  const fields: Record<string, Value> = {};
  const lines: Record<string, number> = {};
  const seen = new Set<string>();
  let i = 0;
  while (i < body.length) {
    const { text, line } = body[i];
    const s = text.replace(/^[ \t]+/, "");
    if (BLANK_OR_COMMENT.test(s)) {
      i++;
      continue;
    }
    if (s[0] === "[") {
      errors.push({ line, code: "unsupported_value" });
      i++;
      continue;
    }
    const head = /^([A-Za-z0-9_-]+)[ \t]*=/.exec(s);
    if (!head) {
      errors.push({ line, code: "bad_line" });
      i++;
      continue;
    }
    const key = head[1];
    const parsed = readValue(body, i, s.slice(head[0].length));
    i = parsed.next;
    if (!isHeaderKey(key)) {
      errors.push({ line, code: "unknown_key" });
      continue;
    }
    if (seen.has(key)) {
      errors.push({ line, code: "duplicate_key" });
      continue;
    }
    seen.add(key);
    if (!parsed.ok) {
      errors.push({ line: parsed.line, code: parsed.code });
      continue;
    }
    if (!BLANK_OR_COMMENT.test(parsed.trailing)) {
      errors.push({ line, code: "bad_line" });
      continue;
    }
    const kind = KEY_KIND[key];
    const value = parsed.value;
    const fits =
      kind === "int"
        ? typeof value === "number"
        : kind === "string"
          ? typeof value === "string"
          : Array.isArray(value);
    if (!fits) {
      errors.push({ line, code: "unsupported_value" });
      continue;
    }
    fields[key] = value;
    lines[key] = line;
  }
  return { fields: fields as HeaderFields, lines: lines as HeaderLines };
}

function byteLength(text: string): number {
  // Every UTF-16 unit is at least one byte, so a longer string is over the limit unread.
  if (text.length > HEADER_MAX_BYTES) return text.length;
  return new TextEncoder().encode(text).length;
}

/**
 * Reads the header of a script or a job file. `kind` is where it lives: `python` (a `# /// nemar`
 * block), `matlab` (a `% /// nemar` block) or `toml` (a whole `nemar-job.toml`). Returns the
 * fields and the line each was written on, or every error with its physical line, in line order;
 * a header with any error yields no fields at all.
 *
 * The 256 KiB cap ({@link HEADER_MAX_BYTES}) applies to the whole input, not to the block: a
 * caller with a large source file passes a bounded prefix, where the block has to be anyway. A
 * `kind` that is none of the three throws RangeError rather than reading some other comment style.
 */
export function parseJobHeader(text: string, kind: HeaderKind): HeaderResult {
  if (kind !== "python" && kind !== "matlab" && kind !== "toml") {
    throw new RangeError("unknown header kind");
  }
  if (byteLength(text) > HEADER_MAX_BYTES) {
    return { ok: false, errors: [{ line: 1, code: "input_too_large" }] };
  }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const physical = source.split(/\r\n|\n/);
  const errors: HeaderError[] = [];

  if (kind === "toml") {
    const body = physical.map((t, n) => ({ text: t, line: n + 1 }));
    const { fields, lines } = readBody(body, errors);
    return finish(errors, true, fields, lines);
  }

  const leader = kind === "python" ? "#" : "%";
  const opening = new RegExp(`^${leader} /// ([A-Za-z0-9-]+)[ \\t]*$`);
  const closing = new RegExp(`^${leader} ///[ \\t]*$`);
  let found = false;
  let blocks = 0;
  let fields: HeaderFields = {};
  let lines: HeaderLines = {};

  let i = 0;
  while (i < physical.length) {
    const open = opening.exec(physical[i]);
    if (!open) {
      i++;
      continue;
    }
    const openLine = i + 1;
    const content: BodyLine[] = [];
    // Lines that begin with the leader but not as `# ` or a bare `#`; they are errors only in a
    // `nemar` block that is read, never in a block of another type.
    const stray: number[] = [];
    let closed = false;
    let j = i + 1;
    for (; j < physical.length; j++) {
      const l = physical[j];
      if (closing.test(l)) {
        closed = true;
        break;
      }
      if (l === leader || l.startsWith(`${leader} `) || l.startsWith(`${leader}\t`)) {
        content.push({ text: l.slice(leader.length + 1), line: j + 1 });
      } else if (l.startsWith(leader)) {
        stray.push(j + 1);
      } else {
        // Not a comment line: the block was never closed.
        break;
      }
    }
    const resume = closed ? j + 1 : j;
    if (open[1] !== "nemar") {
      i = resume;
      continue;
    }
    blocks++;
    if (blocks > 1) {
      errors.push({ line: openLine, code: "duplicate_block" });
    } else if (!closed) {
      errors.push({ line: openLine, code: "unterminated_block" });
    } else {
      found = true;
      for (const line of stray) errors.push({ line, code: "bad_line" });
      ({ fields, lines } = readBody(content, errors));
    }
    i = resume;
  }
  return finish(errors, found, fields, lines);
}

function finish(
  errors: HeaderError[],
  found: boolean,
  fields: HeaderFields,
  lines: HeaderLines,
): HeaderResult {
  if (errors.length > 0) {
    // A stable sort by line, so the report reads top to bottom.
    const ordered = errors
      .map((e, n) => ({ e, n }))
      .sort((a, b) => a.e.line - b.e.line || a.n - b.n);
    return { ok: false, errors: ordered.map((x) => x.e) };
  }
  return { ok: true, found, fields, lines };
}

// --- From header to specification fields -------------------------------------------------------

/** A dataset as a header names it: `id@version`, or an id alone for the CLI to resolve. */
export interface SpecDatasetField {
  id: string;
  version?: string;
}

/** The fields of a job specification a header can supply, under the specification's own names. */
export interface SpecFields {
  name?: string;
  runtime?: string;
  entry?: string;
  datasets?: SpecDatasetField[];
  partition?: string;
  nodes?: number;
  cores?: number;
  memory_mb?: number;
  minutes?: number;
  gpus?: number;
  args?: string[];
}

export type SpecFieldsResult =
  | { ok: true; fields: SpecFields }
  | { ok: false; errors: HeaderError[] };

const MEMORY_RE = /^([0-9]+)([MGT])B?$/i;
const TIME_RE = /^(?:([0-9]+)h)?(?:([0-9]+)m)?$/;
const DATASET_RE = /^([a-z]{2}[0-9]{6})(?:@([0-9A-Za-z][0-9A-Za-z._+-]{0,63}))?$/;
const MEGABYTES: Readonly<Record<string, number>> = { M: 1, G: 1024, T: 1024 * 1024 };

/** `16G` is 16384 megabytes (binary, as Slurm reads it); null for anything else. */
function megabytes(text: string): number | null {
  const m = MEMORY_RE.exec(text);
  if (!m) return null;
  const n = Number(m[1]) * MEGABYTES[m[2].toUpperCase()];
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** `2h` is 120, `1h30m` is 90, `45m` is 45; null for anything else, and for zero. */
function minutes(text: string): number | null {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const n = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Maps what a header said onto a job specification's own fields: `memory` (`16G`) to `memory_mb`,
 * `time` (`2h`, `1h30m`) to `minutes`, and `id@version` to `{ id, version }`. The rest pass
 * through for the specification to judge. A value the mapping cannot read is `unsupported_value`
 * at the line `lines` gives for its key (0 when none), one error per key, in the order of
 * {@link HEADER_KEYS}. The result is the header's contribution only: flags override it and the
 * specification schema still validates the whole.
 */
export function headerToSpecFields(
  fields: HeaderFields,
  lines: HeaderLines = {},
): SpecFieldsResult {
  const out: SpecFields = {};
  const errors: HeaderError[] = [];
  for (const key of HEADER_KEYS) {
    const value = fields[key];
    if (value === undefined) continue;
    const refuse = () => errors.push({ line: lines[key] ?? 0, code: "unsupported_value" });
    switch (key) {
      case "name":
      case "runtime":
      case "entry":
      case "partition":
        out[key] = value as string;
        break;
      case "args":
        out.args = value as string[];
        break;
      case "nodes":
      case "cores":
        if ((value as number) >= 1) out[key] = value as number;
        else refuse();
        break;
      case "gpus":
        out.gpus = value as number;
        break;
      case "memory": {
        const mb = megabytes(value as string);
        if (mb === null) refuse();
        else out.memory_mb = mb;
        break;
      }
      case "time": {
        const min = minutes(value as string);
        if (min === null) refuse();
        else out.minutes = min;
        break;
      }
      case "datasets": {
        const parsed: SpecDatasetField[] = [];
        let bad = false;
        for (const entry of value as string[]) {
          const m = DATASET_RE.exec(entry);
          if (!m) bad = true;
          else parsed.push(m[2] === undefined ? { id: m[1] } : { id: m[1], version: m[2] });
        }
        if (bad) refuse();
        else out.datasets = parsed;
        break;
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, fields: out };
}
