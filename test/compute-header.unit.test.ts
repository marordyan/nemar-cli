/**
 * The zero-dependency parser for the inline job header (epic #2005, phase A1 #2006; ADR 0118):
 * a `# /// nemar` block in a Python file, a `% /// nemar` block in a MATLAB file, or the whole of a
 * `nemar-job.toml`, read as a deliberately small TOML subset.
 *
 * The parser is a security-adjacent input reader (a script's own text decides what a job asks
 * for), so the tests below are mostly refusals: every error code has an input that produces it,
 * and every construct outside the subset is asserted refused rather than guessed at. The module is
 * pure and import-free; the test reads its source to hold it to that.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HEADER_ERROR_CODES,
  HEADER_KEYS,
  HEADER_MAX_BYTES,
  type HeaderFields,
  headerToSpecFields,
  parseJobHeader,
} from "../shared/compute-header";
import {
  COMPUTE_DATASET_ID_RE,
  COMPUTE_DATASET_VERSION_RE,
  JobSpecSchema,
} from "../shared/contract/compute";

/** One header body that uses every key, with each syntax the subset allows. */
const BODY = [
  'name = "eeg-floor"',
  'runtime = "python"',
  'entry = "run.py"',
  "datasets = [",
  '  "nm000104@1.0.2",   # the first one, with a comment',
  '  "ds002718@1.0.5",',
  "]",
  'partition = "shared"',
  "nodes = 2",
  "cores = 8",
  'memory = "16G"',
  'time = "1h30m"',
  "gpus = 0",
  'args = ["--fast", "a \\"quoted\\" arg\\twith\\ttabs", "back\\\\slash"]   # trailing comment',
];

const EXPECTED_FIELDS: HeaderFields = {
  name: "eeg-floor",
  runtime: "python",
  entry: "run.py",
  datasets: ["nm000104@1.0.2", "ds002718@1.0.5"],
  partition: "shared",
  nodes: 2,
  cores: 8,
  memory: "16G",
  time: "1h30m",
  gpus: 0,
  args: ["--fast", 'a "quoted" arg\twith\ttabs', "back\\slash"],
};

/** A body as the content of a comment block: `# ` before each line, a bare `#` for a blank one. */
function commented(body: string[], leader: "#" | "%"): string[] {
  return body.map((l) => (l === "" ? leader : `${leader} ${l}`));
}

function python(body: string[]): string {
  return [
    "#!/usr/bin/env python3",
    "import sys",
    "# /// nemar",
    ...commented(body, "#"),
    "# ///",
    'print("hello")',
    "",
  ].join("\n");
}

function matlab(body: string[]): string {
  return [
    "% analysis entry",
    "% /// nemar",
    ...commented(body, "%"),
    "% ///",
    "disp('hello');",
    "",
  ].join("\n");
}

const toml = (body: string[]): string => `${body.join("\n")}\n`;

/** Every error as `line:code`, so a test reads as the list of what went wrong and where. */
function errorsOf(text: string, kind: "python" | "matlab" | "toml"): string[] {
  const result = parseJobHeader(text, kind);
  if (result.ok) return [];
  return result.errors.map((e) => `${e.line}:${e.code}`);
}

function fieldsOf(text: string, kind: "python" | "matlab" | "toml"): HeaderFields {
  const result = parseJobHeader(text, kind);
  if (!result.ok) throw new Error(`unexpected errors: ${JSON.stringify(result.errors)}`);
  return result.fields;
}

describe("the keys and error codes", () => {
  test("the eleven keys and the eight codes are exactly the ones the phase names", () => {
    expect([...HEADER_KEYS]).toEqual([
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
    ]);
    expect([...HEADER_ERROR_CODES]).toEqual([
      "unterminated_block",
      "duplicate_block",
      "bad_line",
      "duplicate_key",
      "unknown_key",
      "unsupported_value",
      "bad_string",
      "input_too_large",
    ]);
    expect(HEADER_MAX_BYTES).toBe(256 * 1024);
  });
});

describe("a header in each of its three homes", () => {
  test("Python and MATLAB blocks and a nemar-job.toml give the same fields", () => {
    const fromPython = fieldsOf(python(BODY), "python");
    const fromMatlab = fieldsOf(matlab(BODY), "matlab");
    const fromToml = fieldsOf(toml(BODY), "toml");
    expect(fromPython).toEqual(EXPECTED_FIELDS);
    expect(fromMatlab).toEqual(EXPECTED_FIELDS);
    expect(fromToml).toEqual(EXPECTED_FIELDS);
  });

  test("CRLF line endings and a byte-order mark change nothing", () => {
    expect(fieldsOf(python(BODY).replaceAll("\n", "\r\n"), "python")).toEqual(EXPECTED_FIELDS);
    expect(fieldsOf(`﻿${toml(BODY)}`, "toml")).toEqual(EXPECTED_FIELDS);
    expect(fieldsOf(`﻿${python(BODY)}`, "python")).toEqual(EXPECTED_FIELDS);
  });

  test("the result says where each key was written, in the physical file", () => {
    const result = parseJobHeader(python(BODY), "python");
    if (!result.ok) throw new Error("should parse");
    // Line 1 is the shebang, 2 the import, 3 the opening line, so `name` is on line 4.
    expect(result.lines.name).toBe(4);
    expect(result.lines.runtime).toBe(5);
    expect(result.lines.datasets).toBe(7);
    expect(result.lines.partition).toBe(11);
    expect(result.lines.args).toBe(17);
    const plain = parseJobHeader(toml(BODY), "toml");
    if (!plain.ok) throw new Error("should parse");
    expect(plain.lines.name).toBe(1);
    expect(plain.lines.args).toBe(14);
  });

  test("a file with no nemar block is found:false with no fields", () => {
    for (const [text, kind] of [
      ["print('x')\n", "python"],
      ["", "python"],
      ["disp(1)\n", "matlab"],
      ["% /// nemar\n% cores = 4\n% ///\n", "python"],
      ["# /// nemar\n# cores = 4\n# ///\n", "matlab"],
    ] as const) {
      const result = parseJobHeader(text, kind);
      expect(result.ok, `${kind}: ${text}`).toBe(true);
      if (result.ok) {
        expect(result.found).toBe(false);
        expect(result.fields).toEqual({});
      }
    }
  });

  test("a block that is found is reported found, even when it is empty", () => {
    const result = parseJobHeader("# /// nemar\n# ///\n", "python");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.found).toBe(true);
      expect(result.fields).toEqual({});
    }
  });

  test("a whole nemar-job.toml is always found, and an empty one has no fields", () => {
    for (const text of ["", "\n", "# only a comment\n"]) {
      const result = parseJobHeader(text, "toml");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.found).toBe(true);
        expect(result.fields).toEqual({});
      }
    }
  });

  test("only the opening line `# /// nemar`, exactly, opens a block", () => {
    for (const opening of [
      "#/// nemar",
      "#  /// nemar",
      "# /// nemar extra",
      "  # /// nemar",
      "# ///nemar",
    ]) {
      const text = `${opening}\n# cores = 4\n# ///\n`;
      const result = parseJobHeader(text, "python");
      expect(result.ok, opening).toBe(true);
      if (result.ok) expect(result.found, opening).toBe(false);
    }
  });
});

describe("a PEP 723 script block is not ours", () => {
  const SCRIPT = [
    "# /// script",
    '# requires-python = ">=3.12"',
    '# dependencies = ["numpy"]',
    "# ///",
  ];

  test("an inline script block is ignored", () => {
    const text = [...SCRIPT, "print('x')", ""].join("\n");
    const result = parseJobHeader(text, "python");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.found).toBe(false);
      expect(result.fields).toEqual({});
    }
  });

  test("it does not disturb a nemar block before or after it", () => {
    const nemar = ["# /// nemar", "# cores = 4", "# ///"];
    for (const text of [
      [...SCRIPT, ...nemar, ""].join("\n"),
      [...nemar, ...SCRIPT, ""].join("\n"),
      [...SCRIPT, "x = 1", ...nemar, "y = 2", ""].join("\n"),
    ]) {
      expect(fieldsOf(text, "python")).toEqual({ cores: 4 });
    }
  });

  test("what is inside a script block is not read, even a nemar-looking opening line", () => {
    const text = [
      "# /// script",
      "# /// nemar",
      "# cores = 99",
      "# ///",
      "# /// nemar",
      "# cores = 4",
      "# ///",
      "",
    ].join("\n");
    // The first `# ///` closes the script block, so the second nemar block is the only one.
    expect(fieldsOf(text, "python")).toEqual({ cores: 4 });
  });

  test("an unterminated block of another type is ignored, not an error", () => {
    expect(errorsOf("# /// script\n# dependencies = []\n", "python")).toEqual([]);
    expect(errorsOf("# /// tool-config\n# x = 1\n# ///\n", "python")).toEqual([]);
  });

  test("a stray comment line in a block of another type is not our error either", () => {
    const text = [
      "# /// script",
      "#not-a-pep-723-line",
      "# ///",
      "# /// nemar",
      "# cores = 4",
      "# ///",
      "",
    ];
    expect(fieldsOf(text.join("\n"), "python")).toEqual({ cores: 4 });
    // Nor in the second nemar block, which is only reported as a duplicate.
    const twice = ["# /// nemar", "# cores = 4", "# ///", "# /// nemar", "#stray", "# ///", ""];
    expect(errorsOf(twice.join("\n"), "python")).toEqual(["4:duplicate_block"]);
    // Nor in a nemar block that never closed: that block is the error, once.
    const open = ["# /// nemar", "#stray", 'print("x")', ""];
    expect(errorsOf(open.join("\n"), "python")).toEqual(["1:unterminated_block"]);
  });

  test("a script block's own errors are none of our business", () => {
    const text = ["# /// script", "# not = = toml at all", "# ///", ""].join("\n");
    expect(errorsOf(text, "python")).toEqual([]);
  });
});

describe("the subset of TOML", () => {
  test("bare keys, double-quoted strings and escapes", () => {
    const f = fieldsOf('name = "a\\\\b\\"c\\nd\\te"\n', "toml");
    expect(f.name).toBe('a\\b"c\nd\te');
  });

  test("non-negative integers", () => {
    expect(fieldsOf("nodes = 0\ncores = 128\ngpus = 4\n", "toml")).toEqual({
      nodes: 0,
      cores: 128,
      gpus: 4,
    });
    expect(fieldsOf(`cores = ${Number.MAX_SAFE_INTEGER}\n`, "toml").cores).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  test("arrays of strings: empty, single-line, multi-line, with a trailing comma and comments", () => {
    expect(fieldsOf("args = []\n", "toml").args).toEqual([]);
    expect(fieldsOf('args = ["a"]\n', "toml").args).toEqual(["a"]);
    expect(fieldsOf('args = ["a", "b",]\n', "toml").args).toEqual(["a", "b"]);
    expect(fieldsOf('args = [ "a" , "b" ]\n', "toml").args).toEqual(["a", "b"]);
    expect(
      fieldsOf('args = [\n  # first\n  "a",\n\n  "b" # second\n  ,\n]\n', "toml").args,
    ).toEqual(["a", "b"]);
  });

  test("a hash inside a string is text, not a comment", () => {
    expect(fieldsOf('name = "a # not a comment" # a comment\n', "toml").name).toBe(
      "a # not a comment",
    );
    expect(fieldsOf('args = ["#x", "b#"] # c\n', "toml").args).toEqual(["#x", "b#"]);
  });

  test("blank lines, comment lines, indentation and loose spacing", () => {
    expect(fieldsOf('\n# a comment\n   name   =   "x"   \n\tcores=4\n', "toml")).toEqual({
      name: "x",
      cores: 4,
    });
    expect(fieldsOf('name="x"\n', "toml").name).toBe("x");
  });

  test("a key may use letters, digits, dash and underscore, but only a known key is accepted", () => {
    expect(errorsOf("my-key_2 = 1\n", "toml")).toEqual(["1:unknown_key"]);
  });

  test("an empty string and an empty array are values", () => {
    expect(fieldsOf('name = ""\n', "toml").name).toBe("");
  });

  test("a comment line inside a Python block may have extra indentation after the hash", () => {
    const text = '# /// nemar\n#   name = "x"\n#\n#\tcores = 4\n# ///\n';
    expect(fieldsOf(text, "python")).toEqual({ name: "x", cores: 4 });
  });
});

describe("every error code has an input that produces it", () => {
  test("unterminated_block: at the line of the opening", () => {
    expect(errorsOf("import sys\n# /// nemar\n# cores = 4\n", "python")).toEqual([
      "2:unterminated_block",
    ]);
    expect(errorsOf("% /// nemar\n% cores = 4\n", "matlab")).toEqual(["1:unterminated_block"]);
    // Code before the closing line means the block never closed.
    expect(errorsOf('# /// nemar\n# cores = 4\nprint("x")\n# ///\n', "python")).toEqual([
      "1:unterminated_block",
    ]);
    // An opening with nothing after it.
    expect(errorsOf("# /// nemar", "python")).toEqual(["1:unterminated_block"]);
  });

  test("duplicate_block: a second nemar block, at the line of its opening", () => {
    const text = [
      "# /// nemar",
      "# cores = 4",
      "# ///",
      "x = 1",
      "# /// nemar",
      "# cores = 8",
      "# ///",
      "",
    ].join("\n");
    expect(errorsOf(text, "python")).toEqual(["5:duplicate_block"]);
    // The second block's own contents are not also read as errors.
    const worse = text.replace("# cores = 8", "# surprise = 1");
    expect(errorsOf(worse, "python")).toEqual(["5:duplicate_block"]);
    expect(errorsOf("% /// nemar\n% ///\n% /// nemar\n% ///\n", "matlab")).toEqual([
      "3:duplicate_block",
    ]);
  });

  test("bad_line: not a `key = value` line", () => {
    const cases: Array<[string, string]> = [
      ["name", "no equals sign"],
      ["a.b = 1", "a dotted key"],
      ['"name" = "x"', "a quoted key"],
      ["name =", "no value"],
      ["name = # only a comment", "no value before a comment"],
      ['name = "x" extra', "junk after a value"],
      ['name = "x",', "a comma outside an array"],
      ["= 1", "no key"],
      ["name = = 1", "two equals signs"],
      ['datasets = ["a"', "an array that never closes"],
      ['datasets = ["a" "b"]', "a missing comma"],
      ['datasets = ["a",, "b"]', "an empty element"],
      ["datasets = [,]", "a lone comma"],
      ['datasets = ["a"] extra', "junk after an array"],
      ["name 5", "a key and a value with no equals sign"],
    ];
    for (const [line, why] of cases) {
      expect(errorsOf(`${line}\n`, "toml"), why).toEqual(["1:bad_line"]);
    }
  });

  test("bad_line: a Python block line that does not start `# ` or is not a bare `#`", () => {
    expect(errorsOf("# /// nemar\n#cores = 4\n# ///\n", "python")).toEqual(["2:bad_line"]);
    expect(errorsOf("% /// nemar\n%cores = 4\n% ///\n", "matlab")).toEqual(["2:bad_line"]);
  });

  test("duplicate_key: the second write of a key, once", () => {
    expect(errorsOf('name = "a"\nname = "b"\n', "toml")).toEqual(["2:duplicate_key"]);
    expect(errorsOf("cores = 1\ncores = 2\ncores = 3\n", "toml")).toEqual([
      "2:duplicate_key",
      "3:duplicate_key",
    ]);
    // Even when the second value would also be wrong, the key is the error.
    expect(errorsOf('name = "a"\nname = 1.5\n', "toml")).toEqual(["2:duplicate_key"]);
    // A multi-line array is one statement.
    expect(errorsOf('args = [\n"a",\n]\nargs = []\n', "toml")).toEqual(["4:duplicate_key"]);
  });

  test("unknown_key: any key that is not one of the eleven", () => {
    expect(errorsOf("surprise = 1\n", "toml")).toEqual(["1:unknown_key"]);
    expect(errorsOf('Name = "x"\n', "toml")).toEqual(["1:unknown_key"]);
    expect(errorsOf('env = ["A=1"]\n', "toml")).toEqual(["1:unknown_key"]);
    expect(errorsOf('image = "x"\n', "toml")).toEqual(["1:unknown_key"]);
    // The value of an unknown key is read but not reported on top of it, so an array that spans
    // lines does not turn its continuation lines into errors.
    expect(errorsOf('other = [\n  "a",\n  "b",\n]\ncores = 4\n', "toml")).toEqual([
      "1:unknown_key",
    ]);
    // A duplicate of an unknown key is still only unknown.
    expect(errorsOf("x = 1\nx = 2\n", "toml")).toEqual(["1:unknown_key", "2:unknown_key"]);
  });

  test("unsupported_value: anything the subset leaves out", () => {
    const cases: Array<[string, string]> = [
      ["cores = 1.5", "a float"],
      ["cores = -1", "a negative"],
      ["cores = +1", "a signed positive"],
      ["cores = true", "a boolean"],
      ["cores = false", "a boolean"],
      ["cores = 2020-01-01", "a date"],
      ["cores = 12:30:00", "a time"],
      ["cores = 2020-01-01T00:00:00Z", "a datetime"],
      ["cores = 1e3", "an exponent"],
      ["cores = 0x10", "hex"],
      ["cores = 0o7", "octal"],
      ["cores = 0b1", "binary"],
      ["cores = 007", "a leading zero"],
      ["cores = 1_000", "an underscore"],
      ["cores = inf", "infinity"],
      ["cores = nan", "not a number"],
      ["cores = abc", "a bare word"],
      ["cores = 99999999999999999999", "an integer too large to hold exactly"],
      ["name = {a = 1}", "an inline table"],
      ["name = 'literal'", "a literal string"],
      ['name = """multi"""', "a multi-line string"],
      ['args = ["""x"""]', "a multi-line string in an array"],
      ["name = '''multi'''", "a multi-line literal string"],
      ['datasets = [["a"]]', "an array of arrays"],
      ["args = [1, 2]", "an array of integers"],
      ["args = [true]", "an array of booleans"],
      ["args = [{a = 1}]", "an array of tables"],
      ["args = ['x']", "a literal string in an array"],
      ["name = 5", "an integer where a string goes"],
      ['cores = "8"', "a string where an integer goes"],
      ['datasets = "a"', "a string where an array goes"],
      ["args = 5", "an integer where an array goes"],
      ['name = ["a"]', "an array where a string goes"],
      ['cores = ["a"]', "an array where an integer goes"],
      ["[table]", "a table header"],
      ["[[array]]", "an array-of-tables header"],
      ["[tool.nemar]", "a dotted table header"],
    ];
    for (const [line, why] of cases) {
      expect(errorsOf(`${line}\n`, "toml"), why).toEqual(["1:unsupported_value"]);
    }
  });

  test("bad_string: an unterminated string, an escape outside the four, a control character", () => {
    const cases: Array<[string, string]> = [
      ['name = "abc', "no closing quote"],
      ['name = "a\\x"', "a hex escape"],
      ['name = "a\\u0041"', "a unicode escape"],
      ['name = "a\\r"', "a carriage-return escape"],
      ['name = "a\\0"', "a nul escape"],
      ['name = "a\\q"', "an unknown escape"],
      ['name = "a\\', "a backslash at the end"],
      ['name = "a\u0001b"', "a raw control character"],
      ['name = "a\u007fb"', "a raw DEL"],
      ['args = ["ok", "bad\\q"]', "an unknown escape in an array"],
      ['args = ["abc]', "an unterminated string in an array"],
    ];
    for (const [line, why] of cases) {
      expect(errorsOf(`${line}\n`, "toml"), why).toEqual(["1:bad_string"]);
    }
    // A raw tab is allowed, as in TOML.
    expect(fieldsOf('name = "a\tb"\n', "toml").name).toBe("a\tb");
  });

  test("input_too_large: over 256 KiB, counted in bytes, with nothing else reported", () => {
    const at = `# ${"x".repeat(HEADER_MAX_BYTES - 3)}\n`;
    expect(new TextEncoder().encode(at).length).toBe(HEADER_MAX_BYTES);
    expect(parseJobHeader(at, "toml").ok).toBe(true);
    const over = `${at} `;
    expect(errorsOf(over, "toml")).toEqual(["1:input_too_large"]);
    expect(errorsOf(over, "python")).toEqual(["1:input_too_large"]);
    expect(errorsOf(over, "matlab")).toEqual(["1:input_too_large"]);
    // Two bytes a character: well under 256 K characters, over 256 KiB.
    const wide = `# ${"é".repeat(131_072)}`;
    expect(wide.length).toBeLessThan(HEADER_MAX_BYTES);
    expect(errorsOf(wide, "toml")).toEqual(["1:input_too_large"]);
    // Whatever else is wrong with it is not read.
    expect(errorsOf(`surprise = 1\n${"#".repeat(HEADER_MAX_BYTES)}`, "toml")).toEqual([
      "1:input_too_large",
    ]);
  });

  test("every code is produced by at least one of the inputs above", () => {
    const produced = new Set<string>();
    for (const [text, kind] of [
      ["# /// nemar\n", "python"],
      ["# /// nemar\n# ///\n# /// nemar\n# ///\n", "python"],
      ["name\n", "toml"],
      ["cores = 1\ncores = 2\n", "toml"],
      ["x = 1\n", "toml"],
      ["cores = 1.5\n", "toml"],
      ['name = "a\n', "toml"],
      [`${"#".repeat(HEADER_MAX_BYTES + 1)}`, "toml"],
    ] as const) {
      const result = parseJobHeader(text, kind);
      if (!result.ok) for (const e of result.errors) produced.add(e.code);
    }
    expect([...produced].sort()).toEqual([...HEADER_ERROR_CODES].sort());
  });
});

describe("errors are collected, in line order, with the physical line", () => {
  test("several bad lines are all reported", () => {
    const text = [
      'name = "ok"',
      "surprise = 1",
      "cores = 1.5",
      'args = ["a"',
      "nodes = 2",
      "",
    ].join("\n");
    expect(errorsOf(text, "toml")).toEqual(["2:unknown_key", "3:unsupported_value", "4:bad_line"]);
  });

  test("inside a Python block the line is the line in the file", () => {
    const text = [
      "import sys",
      "",
      "# /// nemar",
      '# name = "ok"',
      "# surprise = 1",
      "# cores = 1.5",
      "# ///",
      "",
    ].join("\n");
    expect(errorsOf(text, "python")).toEqual(["5:unknown_key", "6:unsupported_value"]);
  });

  test("errors from the block's own lines and from its statements come out in line order", () => {
    // The stray `#bad` line is found while the block is gathered, the unknown key while it is
    // read; the report is still top to bottom.
    const text = "# /// nemar\n# surprise = 1\n#bad\n# cores = 1.5\n# ///\n";
    expect(errorsOf(text, "python")).toEqual([
      "2:unknown_key",
      "3:bad_line",
      "4:unsupported_value",
    ]);
  });

  test("a statement after an array that was never closed is still read", () => {
    expect(errorsOf('args = ["a"\nsurprise = 1\n', "toml")).toEqual([
      "1:bad_line",
      "2:unknown_key",
    ]);
    expect(errorsOf('args = [\n  "a",\nsurprise = 1\n', "toml")).toEqual([
      "1:bad_line",
      "3:unknown_key",
    ]);
    expect(fieldsOf('args = [\n  "a",\n]\ncores = 4\n', "toml")).toEqual({
      args: ["a"],
      cores: 4,
    });
  });

  test("after a bad element the array is skipped to its own closing bracket, and no further", () => {
    // Never closed: the skip stops before the next statement.
    expect(errorsOf("args = [\n  1,\n  2\nsurprise = 1\n", "toml")).toEqual([
      "2:unsupported_value",
      "4:unknown_key",
    ]);
    // A nested array closes with its own bracket, not the outer one.
    expect(errorsOf('args = [\n  ["a",\n  "b"],\n  "c"\n]\ncores = 4\n', "toml")).toEqual([
      "2:unsupported_value",
    ]);
    // A bracket inside a string, or in a comment, closes nothing.
    expect(errorsOf('args = [\n  1,\n  "a]b",\n]\ncores = 4\n', "toml")).toEqual([
      "2:unsupported_value",
    ]);
    expect(errorsOf('args = [\n  1, # ] is not the end\n  "b",\n]\ncores = 4\n', "toml")).toEqual([
      "2:unsupported_value",
    ]);
    // An escaped quote does not end the string it is in.
    expect(errorsOf('args = [\n  1,\n  "a\\"]b",\n]\ncores = 4\n', "toml")).toEqual([
      "2:unsupported_value",
    ]);
  });

  test("a failed parse returns no fields at all", () => {
    const result = parseJobHeader('name = "ok"\ncores = 1.5\n', "toml");
    expect(result.ok).toBe(false);
    expect("fields" in result).toBe(false);
  });

  test("in a multi-line array a bad element is reported at its own line, the shape of the array at the key's", () => {
    // The first bad element, once; the rest of the array is skipped to its closing bracket.
    expect(errorsOf("args = [\n  1,\n  2,\n]\n", "toml")).toEqual(["2:unsupported_value"]);
    expect(errorsOf('args = [\n  "a",\n  "b\n]\ncores = 4\n', "toml")).toEqual(["3:bad_string"]);
    // Never closed, or junk where a comma or bracket belongs: the statement is the problem.
    expect(errorsOf('name = "ok"\nargs = [\n  "a"\n', "toml")).toEqual(["2:bad_line"]);
    expect(errorsOf('args = [\n  "a"\n  "b"\n]\n', "toml")).toEqual(["1:bad_line"]);
    // After the skipped array, the next statement is read as usual.
    expect(errorsOf("args = [\n  1,\n]\nsurprise = 1\n", "toml")).toEqual([
      "2:unsupported_value",
      "4:unknown_key",
    ]);
  });
});

describe("headerToSpecFields", () => {
  const map = (fields: HeaderFields, lines: Record<string, number> = {}) =>
    headerToSpecFields(fields, lines);
  const mapped = (fields: HeaderFields) => {
    const result = map(fields);
    if (!result.ok) throw new Error(`unexpected errors: ${JSON.stringify(result.errors)}`);
    return result.fields;
  };

  test("maps the whole example: memory to MB, time to minutes, id@version to an object", () => {
    expect(mapped(EXPECTED_FIELDS)).toEqual({
      name: "eeg-floor",
      runtime: "python",
      entry: "run.py",
      datasets: [
        { id: "nm000104", version: "1.0.2" },
        { id: "ds002718", version: "1.0.5" },
      ],
      partition: "shared",
      nodes: 2,
      cores: 8,
      memory_mb: 16384,
      minutes: 90,
      gpus: 0,
      args: ["--fast", 'a "quoted" arg\twith\ttabs', "back\\slash"],
    });
  });

  test("only the keys that were written appear", () => {
    expect(mapped({})).toEqual({});
    expect(mapped({ cores: 4 })).toEqual({ cores: 4 });
    expect(mapped({ time: "2h" })).toEqual({ minutes: 120 });
    expect(Object.keys(mapped({ memory: "1G" }))).toEqual(["memory_mb"]);
  });

  test("memory: M, G and T, binary, with an optional B, to whole megabytes", () => {
    const cases: Array<[string, number]> = [
      ["16G", 16384],
      ["16g", 16384],
      ["16GB", 16384],
      ["512M", 512],
      ["512MB", 512],
      ["1T", 1_048_576],
      ["2TB", 2_097_152],
      ["1G", 1024],
    ];
    for (const [text, mb] of cases) expect(mapped({ memory: text }).memory_mb, text).toBe(mb);
  });

  test("memory: anything else is refused at the key's line", () => {
    for (const bad of [
      "",
      "16",
      "G",
      "0G",
      "0M",
      "16X",
      "16.5G",
      "-1G",
      "1 G",
      "16GiB",
      "G16",
      "1KB",
    ]) {
      const result = map({ memory: bad }, { memory: 9 });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.errors).toEqual([{ line: 9, code: "unsupported_value" }]);
    }
  });

  test("time: hours, minutes or both, to whole minutes", () => {
    const cases: Array<[string, number]> = [
      ["2h", 120],
      ["1h30m", 90],
      ["45m", 45],
      ["90m", 90],
      ["48h", 2880],
      ["0h5m", 5],
      ["1h0m", 60],
    ];
    for (const [text, minutes] of cases) expect(mapped({ time: text }).minutes, text).toBe(minutes);
  });

  test("time: anything else is refused at the key's line", () => {
    for (const bad of [
      "",
      "2",
      "h",
      "m",
      "0m",
      "0h",
      "0h0m",
      "1d",
      "1h1d",
      "30m1h",
      "1.5h",
      "-1h",
      "2 h",
      "1h 30m",
      "PT2H",
      "2:00:00",
    ]) {
      const result = map({ time: bad }, { time: 4 });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.errors).toEqual([{ line: 4, code: "unsupported_value" }]);
    }
  });

  test("datasets: id@version, or an id alone", () => {
    expect(mapped({ datasets: ["nm000104@1.0.2"] }).datasets).toEqual([
      { id: "nm000104", version: "1.0.2" },
    ]);
    expect(mapped({ datasets: ["nm000104"] }).datasets).toStrictEqual([{ id: "nm000104" }]);
    expect(mapped({ datasets: ["on000001@v2.0.0+build.5", "xx099900@1"] }).datasets).toEqual([
      { id: "on000001", version: "v2.0.0+build.5" },
      { id: "xx099900", version: "1" },
    ]);
    expect(mapped({ datasets: [] }).datasets).toEqual([]);
  });

  test("datasets: a bad id or version is refused at the key's line", () => {
    for (const bad of [
      "NM000104",
      "nm00010",
      "nm0001044",
      "nm000104@",
      "@1.0.2",
      "nm000104@../x",
      "nm000104@.1",
      "nm000104@-1",
      "nm000104@_1",
      "nm000104@1@2",
      "nm000104@a b",
      "nm000104 @1",
      "",
      "123456",
    ]) {
      const result = map({ datasets: ["nm000104@1.0.2", bad] }, { datasets: 6 });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.errors).toEqual([{ line: 6, code: "unsupported_value" }]);
    }
  });

  test("integers: nodes and cores at least 1, gpus may be 0", () => {
    expect(mapped({ gpus: 0 }).gpus).toBe(0);
    for (const key of ["nodes", "cores"] as const) {
      const result = map({ [key]: 0 } as HeaderFields, { [key]: 3 });
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.errors).toEqual([{ line: 3, code: "unsupported_value" }]);
    }
  });

  test("every bad key is reported, in the order of the keys, and a missing line is 0", () => {
    const fields: HeaderFields = { memory: "x", time: "y", datasets: ["z"] };
    const result = map(fields, { datasets: 8, memory: 6, time: 7 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        { line: 8, code: "unsupported_value" },
        { line: 6, code: "unsupported_value" },
        { line: 7, code: "unsupported_value" },
      ]);
    }
    const unplaced = map(fields);
    expect(unplaced.ok).toBe(false);
    if (!unplaced.ok) expect(unplaced.errors.map((e) => e.line)).toEqual([0, 0, 0]);
  });

  test("names, runtime, entry, partition and arguments pass through for the specification to judge", () => {
    expect(
      mapped({ name: "n", runtime: "julia", entry: "../x", partition: "nonsense", args: ["a"] }),
    ).toEqual({
      name: "n",
      runtime: "julia",
      entry: "../x",
      partition: "nonsense",
      args: ["a"],
    });
  });

  test("the mapped fields, with what the header cannot say, are a valid job specification", () => {
    const result = parseJobHeader(python(BODY), "python");
    if (!result.ok) throw new Error("should parse");
    const mappedResult = headerToSpecFields(result.fields, result.lines);
    if (!mappedResult.ok) throw new Error("should map");
    // The header carries no bundle, so the CLI adds it after packing the folder.
    const spec = JobSpecSchema.safeParse({
      ...mappedResult.fields,
      bundle: { size: 100, sha256: "a".repeat(64) },
    });
    expect(spec.success).toBe(true);
    if (spec.success) {
      expect(spec.data.memory_mb).toBe(16384);
      expect(spec.data.minutes).toBe(90);
      expect(spec.data.cores).toBe(8);
    }
  });

  test("a header that names no version leaves the job specification to refuse it", () => {
    const fields = mapped({
      datasets: ["nm000104"],
      partition: "shared",
      time: "1h",
      entry: "run.py",
      name: "x",
      runtime: "python",
    });
    const spec = JobSpecSchema.safeParse({
      ...fields,
      bundle: { size: 1, sha256: "a".repeat(64) },
    });
    expect(spec.success).toBe(false);
  });
});

describe("an unknown kind is refused loudly", () => {
  test("a kind that is not python, matlab or toml throws RangeError, whatever the text", () => {
    for (const kind of ["ruby", "", "Python", "PYTHON", "toml ", "constructor", "__proto__"]) {
      expect(
        () => parseJobHeader("# /// nemar\n# cores = 4\n# ///\n", kind as never),
        kind,
      ).toThrow(RangeError);
      expect(() => parseJobHeader("", kind as never), kind).toThrow(RangeError);
    }
    expect(() => parseJobHeader("x", undefined as never)).toThrow(RangeError);
    expect(() => parseJobHeader("x", null as never)).toThrow(RangeError);
  });
});

describe("the header's own dataset grammar agrees with the contract's", () => {
  // The header module imports nothing, so it carries its own copy of the dataset id and version
  // grammar. This is the check that the copy has not drifted from COMPUTE_DATASET_ID_RE and
  // COMPUTE_DATASET_VERSION_RE, over inputs on both sides of every edge.
  const IDS = [
    "nm000104",
    "on000001",
    "xx099900",
    "ds002718",
    "ab123456",
    "zz000000",
    "NM000104",
    "Nm000104",
    "nM000104",
    "n0000104",
    "nm00010",
    "nm0001044",
    "nm00010a",
    "nm 00104",
    " nm000104",
    "nm000104 ",
    "nm000104\n",
    "\nnm000104",
    "n\u00e9000104",
    "nm00010\u0664",
    "nm00010\uff14",
    "",
    "nm",
    "123456",
    "nm-000104",
    "nm_000104",
  ];
  const VERSIONS = [
    "1",
    "1.0.2",
    "v2.0.0",
    "v2.0.0+build.5",
    "a",
    "A",
    "0",
    "1-rc.1",
    "1_2",
    "1+2",
    `a${"b".repeat(63)}`,
    `a${"b".repeat(64)}`,
    "",
    ".1",
    "-1",
    "_1",
    "+1",
    "1 2",
    " 1",
    "1 ",
    "1\n",
    "\n1",
    "1@2",
    "1/2",
    "..",
    "1\u00e9",
    "\u00e91",
    "1\\2",
  ];

  test("an id is accepted by the header exactly when the contract's pattern accepts it", () => {
    for (const id of IDS) {
      const header = headerToSpecFields({ datasets: [id] }).ok;
      expect(header, JSON.stringify(id)).toBe(COMPUTE_DATASET_ID_RE.test(id));
    }
    expect(IDS.filter((id) => COMPUTE_DATASET_ID_RE.test(id)).length).toBeGreaterThanOrEqual(6);
    expect(IDS.filter((id) => !COMPUTE_DATASET_ID_RE.test(id)).length).toBeGreaterThanOrEqual(15);
  });

  test("a version is accepted by the header exactly when the contract's pattern accepts it", () => {
    for (const version of VERSIONS) {
      const header = headerToSpecFields({ datasets: [`nm000104@${version}`] }).ok;
      expect(header, JSON.stringify(version)).toBe(COMPUTE_DATASET_VERSION_RE.test(version));
    }
    expect(
      VERSIONS.filter((v) => COMPUTE_DATASET_VERSION_RE.test(v)).length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      VERSIONS.filter((v) => !COMPUTE_DATASET_VERSION_RE.test(v)).length,
    ).toBeGreaterThanOrEqual(12);
  });
});

describe("the module imports nothing", () => {
  test("shared/compute-header.ts has no import, require or dynamic import", () => {
    const src = readFileSync(join(import.meta.dir, "../shared/compute-header.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bfrom\s+["']/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).toContain("parseJobHeader");
  });
});
