/**
 * The curation loader and binder (epic #1586, phase 5; ADR 0083).
 *
 * The committed `shared/neurobagel/curation.json` is the real input: the loader accepts it, and
 * every negative case below is that file with ONE thing made wrong, so a rejection is the
 * loader's answer to that thing and nothing else.
 * The binder is driven with the real fixtures the entries were reviewed against (documents
 * captured byte for byte from data.nemar.org), and with those same tables altered, which is the
 * only way to see a stale pin or an uncovered value: no dataset in the catalog changes under us.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import {
  CURATION_PATH,
  FIXTURE_ROOT,
  fixtureIds,
  latestReviewDate,
  loadCuration,
  parseCommittedCuration,
} from "../scripts/neurobagel/fixtures-io";
import {
  CurationError,
  curatedColumnFrom,
  lookupCuration,
  parseCuration,
} from "../shared/neurobagel/curation";
import { bindCuratedColumn, bindCuration } from "../shared/neurobagel/curation-bind";
import type { CuratedColumn, CurationEntry } from "../shared/neurobagel/curation-types";
import { contentMatchesPin, gitBlobSha, gitBlobShaOfBytes } from "../shared/neurobagel/git-blob";
import { scanKeys } from "../shared/neurobagel/json-keys";
import { parseTsv } from "../shared/neurobagel/tsv";

type Json = Record<string, unknown>;
const fileText = readFileSync(CURATION_PATH, "utf8");
const fileJson = JSON.parse(fileText) as { datasets: Record<string, Json>; format: number };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The committed file with `change` applied to a copy of its parsed form, as text. */
function mutated(
  change: (file: { datasets: Record<string, Json>; format: number }) => void,
): string {
  const copy = clone(fileJson);
  change(copy);
  return JSON.stringify(copy);
}

/** The problems the loader reports for `text`, or `[]` when it accepts it. */
function problemsOf(text: string): string[] {
  try {
    parseCuration(text);
    return [];
  } catch (error) {
    if (!(error instanceof CurationError)) throw error;
    return error.problems;
  }
}

const fixtureText = (id: string, name: string): string | null => {
  try {
    return readFileSync(join(FIXTURE_ROOT, id, name), "utf8");
  } catch {
    return null;
  }
};
const entryFor = (id: string): CurationEntry => {
  const entry = loadCuration().entries.get(id);
  if (entry === undefined) throw new Error(`no committed curation entry for ${id}`);
  return entry;
};
/** A column block of the committed file, as a fresh copy that a test may edit. */
const column = (id: string, name: string): Json =>
  clone((fileJson.datasets[id].columns as Record<string, Json>)[name]);
/** The same block inside a mutated copy of the file. */
const inCopy = (f: { datasets: Record<string, Json> }, id: string, name: string): Json =>
  (f.datasets[id].columns as Record<string, Json>)[name];

describe("the committed curation.json", () => {
  test("loads, and curates between 3 and 5 NEMAR datasets plus any reused upstream entries", () => {
    const { entries } = loadCuration();
    const own = [...entries.keys()].filter((id) => id.startsWith("nm"));
    expect(own.length).toBeGreaterThanOrEqual(3);
    expect(own.length).toBeLessThanOrEqual(5);
  });

  test("every entry names a dataset that has a captured fixture, and binds to it", async () => {
    for (const [id, entry] of loadCuration().entries) {
      expect(fixtureIds()).toContain(id);
      const tsv = fixtureText(id, "participants.tsv");
      const result = await bindCuration(entry, {
        participantsTsv: tsv,
        participantsJson: fixtureText(id, "participants.json"),
      });
      expect(result.status).toBe("applied");
    }
  });

  test("every entry's pins are the git blob SHAs of its fixture's files", async () => {
    for (const [id, entry] of loadCuration().entries) {
      const tsv = readFileSync(join(FIXTURE_ROOT, id, "participants.tsv"));
      expect(entry.pins.participantsTsv).toBe(await gitBlobShaOfBytes(new Uint8Array(tsv)));
      const json = fixtureText(id, "participants.json");
      expect(entry.pins.participantsJson).toBe(
        json === null
          ? null
          : await gitBlobShaOfBytes(
              new Uint8Array(readFileSync(join(FIXTURE_ROOT, id, "participants.json"))),
            ),
      );
    }
  });

  test("every entry says who reviewed it, and the NEMAR-written ones are marked as not expert-reviewed", () => {
    for (const [id, entry] of loadCuration().entries) {
      expect(entry.evidence.source.trim()).not.toBe("");
      expect(entry.evidence.reviewer.trim()).not.toBe("");
      expect(entry.evidence.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (id.startsWith("nm")) expect(entry.evidence.review).toBe("author");
    }
  });

  test("every curated column is about a variable curation carries and keeps its pinned terms", () => {
    for (const entry of loadCuration().entries.values()) {
      expect(entry.columns.length).toBeGreaterThan(0);
      for (const c of entry.columns) {
        expect(["age", "assessment", "diagnosis", "sex"]).toContain(c.kind);
        if (c.kind === "sex" || c.kind === "diagnosis") {
          for (const term of c.levels.values()) expect(term.identifier).toMatch(/^(snomed|ncit):/);
        }
      }
    }
  });
});

describe("the loader rejects, and says why", () => {
  test("text that is not JSON", () => {
    expect(problemsOf("{")[0]).toContain("not valid JSON");
    expect(problemsOf("")[0]).toContain("not valid JSON");
    expect(problemsOf(`﻿${fileText}`)[0]).toContain("not valid JSON");
  });

  test("a file that is not an object with format 1 and datasets", () => {
    expect(problemsOf("[]").length).toBeGreaterThan(0);
    const withTopLevel = (change: (file: Json) => void): string =>
      mutated((f) => change(f as unknown as Json));
    expect(
      problemsOf(
        withTopLevel((f) => {
          f.format = 2;
        }),
      ).join(),
    ).toContain("format");
    expect(
      problemsOf(
        withTopLevel((f) => {
          Reflect.deleteProperty(f, "format");
        }),
      ).join(),
    ).toContain("format");
    expect(
      problemsOf(
        withTopLevel((f) => {
          f.extra = 1;
        }),
      ).join(),
    ).toContain('unknown key "extra"');
  });

  test("a duplicate dataset id, which JSON.parse would silently resolve to the last", () => {
    const entry = JSON.stringify(fileJson.datasets.nm000149);
    const text = `{"format":1,"datasets":{"nm000149":${entry},"nm000149":${entry}}}`;
    expect(JSON.parse(text)).toBeDefined();
    expect(problemsOf(text)).toEqual(["/datasets/nm000149: this key appears more than once"]);
  });

  test("a duplicate column in one entry", () => {
    const block = JSON.stringify(column("nm000149", "group"));
    const text = fileText.replace(/"group": \{/, `"group": ${block},\n"group": {`);
    expect(problemsOf(text).join()).toContain("/columns/group: this key appears more than once");
  });

  test("a raw level listed twice in one level map", () => {
    const text = fileText.replace(
      '"spinal cord injury": {',
      '"spinal cord injury": {"Label":"Spinal cord injury","TermURL":"snomed:1"},\n"spinal cord injury": {',
    );
    expect(problemsOf(text).join()).toContain("this key appears more than once");
  });

  test("__proto__ as a key anywhere", () => {
    const text = fileText.replace('"format": 1', '"__proto__": {}, "format": 1');
    expect(problemsOf(text)).toEqual(["/__proto__: __proto__ is not allowed as a key"]);
  });

  test("an unknown key at every level", () => {
    const cases: [string, (f: { datasets: Record<string, Json> }) => void][] = [
      [
        "entry",
        (f) => {
          f.datasets.nm000149.note = "x";
        },
      ],
      [
        "evidence",
        (f) => {
          (f.datasets.nm000149.evidence as Json).url = "x";
        },
      ],
      [
        "pins",
        (f) => {
          (f.datasets.nm000149.pins as Json).participants_xml = "x";
        },
      ],
      [
        "annotation block",
        (f) => {
          inCopy(f, "nm000149", "group").Description = "x";
        },
      ],
      [
        "term",
        (f) => {
          const levels = (f.datasets.nm000149.columns as Json).group as {
            Levels: Record<string, Json>;
          };
          levels.Levels["spinal cord injury"].Source = "x";
        },
      ],
    ];
    for (const [label, change] of cases) {
      const text = mutated((f) => change(f));
      expect(problemsOf(text).join(), label).toContain("unknown key");
    }
  });

  test("the annotation tool's legacy Transformation key is not accepted for an age Format", () => {
    const text = mutated((f) => {
      f.datasets.nm000149.columns = {
        age: {
          IsAbout: { Label: "Age", TermURL: "nb:Age" },
          Transformation: { Label: "decimal", TermURL: "nb:FromFloat" },
          VariableType: "Continuous",
        },
      };
    });
    expect(problemsOf(text).join()).toContain("Format");
  });

  test("a diagnosis term that is not in the pinned vocabulary", () => {
    const text = mutated((f) => {
      const g = (f.datasets.nm000149.columns as Json).group as {
        Levels: Record<string, { TermURL: string }>;
      };
      g.Levels["spinal cord injury"].TermURL = "snomed:1";
    });
    expect(problemsOf(text).join()).toContain(
      'Levels["spinal cord injury"]: snomed:1 is not in the pinned diagnosis vocabulary',
    );
  });

  test("a sex level whose term is a diagnosis, and a diagnosis level whose term is a sex", () => {
    const sexAsDiagnosis = mutated((f) => {
      const g = (f.datasets.on001787.columns as Json).gender as {
        Levels: Record<string, { TermURL: string; Label: string }>;
      };
      g.Levels.F = { TermURL: "snomed:35919005", Label: "Autism spectrum disorder" };
    });
    expect(problemsOf(sexAsDiagnosis).join()).toContain("not in the pinned sex vocabulary");
    const diagnosisAsSex = mutated((f) => {
      const g = (f.datasets.nm000149.columns as Json).group as {
        Levels: Record<string, { TermURL: string; Label: string }>;
      };
      g.Levels["spinal cord injury"] = { TermURL: "snomed:248152002", Label: "Female" };
    });
    expect(problemsOf(diagnosisAsSex).join()).toContain("not in the pinned diagnosis vocabulary");
  });

  test("a term whose label is not the pinned label", () => {
    const text = mutated((f) => {
      const g = (f.datasets.nm000149.columns as Json).group as {
        Levels: Record<string, { Label: string }>;
      };
      g.Levels["spinal cord injury"].Label = "Back injury";
    });
    expect(problemsOf(text).join()).toContain('must be "Spinal cord injury", the pinned label');
  });

  test("an IsAbout that is not one of the four curatable variables", () => {
    for (const [about, label] of [
      ["nb:ParticipantID", "Participant ID"],
      ["nb:SessionID", "Session ID"],
      ["nb:SubjectGroup", "Subject Group"],
      ["snomed:248153007", "Male"],
    ]) {
      const text = mutated((f) => {
        f.datasets.nm000149.columns = {
          group: {
            IsAbout: { Label: label, TermURL: about },
            Levels: {},
            VariableType: "Categorical",
          },
        };
      });
      expect(problemsOf(text).join(), about).toContain("is not curatable");
    }
  });

  test("a VariableType that does not suit the variable, and an unknown one", () => {
    const wrongType = mutated((f) => {
      f.datasets.on001787.columns = {
        gender: {
          Format: { Label: "decimal", TermURL: "nb:FromFloat" },
          IsAbout: { Label: "Sex", TermURL: "nb:Sex" },
          VariableType: "Continuous",
        },
      };
    });
    expect(problemsOf(wrongType).join()).toContain("has VariableType Categorical, not Continuous");
    const unknownType = mutated((f) => {
      inCopy(f, "nm000149", "group").VariableType = "Ordinal";
    });
    expect(problemsOf(unknownType).join()).toContain("VariableType must be");
  });

  test("a variable whose label is not the pinned label", () => {
    const text = mutated((f) => {
      (inCopy(f, "nm000149", "group").IsAbout as Json).Label = "Disease";
    });
    expect(problemsOf(text).join()).toContain('the label of nb:Diagnosis must be "Diagnosis"');
  });

  test("an empty level map, a level that is also a missing value, and a repeated missing value", () => {
    const empty = mutated((f) => {
      inCopy(f, "nm000149", "group").Levels = {};
    });
    expect(problemsOf(empty).join()).toContain("Levels is empty");
    const overlap = mutated((f) => {
      inCopy(f, "nm000149", "group").MissingValues = ["spinal cord injury"];
    });
    expect(problemsOf(overlap).join()).toContain("a level cannot also be a missing value");
    const repeated = mutated((f) => {
      inCopy(f, "nm000149", "group").MissingValues = ["n/a", "n/a"];
    });
    expect(problemsOf(repeated).join()).toContain('MissingValues repeats "n/a"');
  });

  test("a diagnosis column may map nothing if it lists its values as missing; no other column may", () => {
    const nothing = (change: Json): string =>
      mutated((f) => {
        Object.assign(inCopy(f, "nm000149", "group"), { Levels: {}, ...change });
      });
    expect(problemsOf(nothing({ MissingValues: ["spinal cord injury"] }))).toEqual([]);
    expect(problemsOf(nothing({ MissingValues: [] })).join()).toContain("Levels is empty");
    // A sex column that maps nothing would only withdraw what the mechanical rule can read.
    const sex = mutated((f) => {
      Object.assign(inCopy(f, "on001787", "gender"), { Levels: {}, MissingValues: ["F", "M"] });
    });
    expect(problemsOf(sex).join()).toContain("Levels is empty");
    const parsed = parseCuration(nothing({ MissingValues: ["spinal cord injury"] }));
    const column = parsed.entries.get("nm000149")?.columns[0] as Extract<
      CuratedColumn,
      { kind: "diagnosis" }
    >;
    expect(column.levels.size).toBe(0);
    expect(column.missingValues).toEqual(["spinal cord injury"]);
  });

  test("a malformed pin: too short, upper case, not hex, missing, or null where a table is required", () => {
    const wrong: [string, unknown][] = [
      ["participants_tsv", "abc123"],
      ["participants_tsv", "EB610A87FF4DFB93EFDCBA2DA17BFEF12DCE9B82"],
      ["participants_tsv", "zb610a87ff4dfb93efdcba2da17bfef12dce9b82"],
      ["participants_tsv", "eb610a87ff4dfb93efdcba2da17bfef12dce9b8"],
      ["participants_tsv", "eb610a87ff4dfb93efdcba2da17bfef12dce9b820"],
      ["participants_tsv", null],
      ["participants_tsv", 7],
    ];
    for (const [key, value] of wrong) {
      const text = mutated((f) => {
        (f.datasets.nm000119.pins as Json)[key] = value;
      });
      expect(problemsOf(text).join(), `${key}=${String(value)}`).toContain(
        "nm000119.pins.participants_tsv",
      );
    }
    const noJsonKey = mutated((f) => {
      Reflect.deleteProperty(f.datasets.nm000119.pins as Json, "participants_json");
    });
    expect(problemsOf(noJsonKey).join()).toContain("pins.participants_json");
    const nullJson = mutated((f) => {
      (f.datasets.nm000119.pins as Json).participants_json = null;
    });
    expect(problemsOf(nullJson)).toEqual([]);
  });

  test("a dataset id curation may not name", () => {
    for (const id of [
      "xx000001",
      "nm99",
      "NM000119",
      "nm0001190",
      "ds000001",
      "nm099900",
      "nm099999",
    ]) {
      const text = mutated((f) => {
        f.datasets[id] = clone(f.datasets.nm000119);
      });
      expect(problemsOf(text).join(), id).toMatch(
        /not a dataset id curation may name|reserved fixture band/,
      );
    }
    for (const id of ["nm099899", "on000117", "on999999"]) {
      const text = mutated((f) => {
        f.datasets[id] = clone(f.datasets.nm000119);
      });
      expect(problemsOf(text), id).toEqual([]);
    }
  });

  test("evidence that is blank, has an unknown review, or a date that does not exist", () => {
    const evidence = (change: Json): string =>
      mutated((f) => {
        Object.assign(f.datasets.nm000119.evidence as Json, change);
      });
    expect(problemsOf(evidence({ source: "  " })).join()).toContain("evidence.source");
    expect(problemsOf(evidence({ reviewer: "" })).join()).toContain("evidence.reviewer");
    expect(problemsOf(evidence({ review: "someone" })).join()).toContain("evidence.review");
    for (const date of [
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "10/02/2026",
      "",
      "2026-2-3",
      "2026-02-29",
    ]) {
      expect(problemsOf(evidence({ date })).join(), date).toContain("evidence.date");
    }
    for (const date of ["2026-10-02", "2028-02-29", "2000-02-29"]) {
      expect(problemsOf(evidence({ date })), date).toEqual([]);
    }
    expect(problemsOf(evidence({ date: "1900-02-29" })).join()).toContain("evidence.date");
  });

  test("a review dated after today is rejected when the caller says what today is", () => {
    const text = mutated((f) => {
      (f.datasets.nm000119.evidence as Json).date = "2026-10-03";
    });
    // The loader has no clock: without a `today` there is nothing to compare with.
    expect(problemsOf(text)).toEqual([]);
    expect(() => parseCuration(text, { today: "2026-10-02" })).toThrow(
      "2026-10-03 is after today, 2026-10-02",
    );
    expect(() => parseCuration(text, { today: "2026-10-03" })).not.toThrow();
    expect(() => parseCuration(text, { today: "10/03/2026" })).toThrow("YYYY-MM-DD");
    // The committed file's own dates are not in the future.
    expect(() =>
      parseCuration(fileText, { today: new Date().toISOString().slice(0, 10) }),
    ).not.toThrow();
  });

  test("problems are reported per stage: keys first, then the shape, then the meaning", () => {
    const meaning = (f: { datasets: Record<string, Json> }) => {
      (f.datasets.nm000149.evidence as Json).date = "tomorrow";
    };
    // A meaning problem alone is reported.
    expect(problemsOf(mutated(meaning)).join()).toContain("evidence.date");
    // With an unknown key beside it, only the shape problem is, until it is fixed.
    const shapeAndMeaning = mutated((f) => {
      meaning(f);
      f.datasets.nm000119.note = "x";
    });
    expect(problemsOf(shapeAndMeaning)).toEqual([expect.stringContaining('unknown key "note"')]);
    // And a duplicated key hides both.
    const entry = JSON.stringify(fileJson.datasets.nm000149);
    const duplicated = `{"format":1,"datasets":{"nm000149":${entry},"nm000149":${entry},"nm000119":{"note":1}}}`;
    expect(problemsOf(duplicated)).toEqual(["/datasets/nm000149: this key appears more than once"]);
  });

  test("an entry with no column, a second sex column, a second age column, and a participant id column", () => {
    const none = mutated((f) => {
      f.datasets.nm000119.columns = {};
    });
    expect(problemsOf(none).join()).toContain("an entry must curate a column");

    const sex = (extra: string): Json => ({
      ...(column("on001787", "gender") as Json),
      _: extra,
    });
    const twoSex = mutated((f) => {
      f.datasets.on001787.columns = {
        gender: column("on001787", "gender"),
        sexo: column("on001787", "gender"),
      };
    });
    expect(problemsOf(twoSex).join()).toContain("more than one sex column");
    expect(sex("")).toBeDefined();

    const age: Json = {
      Format: { Label: "decimal", TermURL: "nb:FromFloat" },
      IsAbout: { Label: "Age", TermURL: "nb:Age" },
      VariableType: "Continuous",
    };
    const twoAge = mutated((f) => {
      f.datasets.on001787.columns = { age1: age, age2: age };
    });
    expect(problemsOf(twoAge).join()).toContain("more than one age column");

    const participant = mutated((f) => {
      f.datasets.nm000149.columns = { participant_id: column("nm000149", "group") };
    });
    expect(problemsOf(participant).join()).toContain("always mapped by the transform");
  });

  test("a column named like the mechanical age, sex or group column but about something else", () => {
    const text = mutated((f) => {
      f.datasets.nm000149.columns = { Sex: column("nm000149", "group") };
    });
    expect(problemsOf(text).join()).toContain("must be about sex, not diagnosis");
    const group = mutated((f) => {
      f.datasets.nm000149.columns = { " GROUP ": column("on001787", "gender") };
    });
    expect(problemsOf(group).join()).toContain("must be about diagnosis, not sex");
    const aligned = mutated((f) => {
      f.datasets.nm000149.columns = { Group: column("nm000149", "group") };
    });
    expect(problemsOf(aligned)).toEqual([]);
  });

  test("an age with a Format outside the pinned vocabulary, and a ValueRange that cannot be right", () => {
    const age = (change: Json): string =>
      mutated((f) => {
        f.datasets.nm000149.columns = {
          age: {
            Format: { Label: "decimal", TermURL: "nb:FromFloat" },
            IsAbout: { Label: "Age", TermURL: "nb:Age" },
            VariableType: "Continuous",
            ...change,
          },
        };
      });
    expect(problemsOf(age({}))).toEqual([]);
    expect(
      problemsOf(age({ Format: { Label: "integer data", TermURL: "nb:FromInt" } })).join(),
    ).toContain("nb:FromFloat reads the same values");
    expect(problemsOf(age({ Format: { Label: "x", TermURL: "nb:FromMonths" } })).join()).toContain(
      "not an age format of the pinned vocabulary",
    );
    expect(
      problemsOf(age({ Format: { Label: "decimal number", TermURL: "nb:FromFloat" } })).join(),
    ).toContain('must be "decimal", the pinned label');
    expect(problemsOf(age({ ValueRange: { Min: 30, Max: 20 } })).join()).toContain(
      "Min is above Max",
    );
    expect(problemsOf(age({ ValueRange: { Min: -1, Max: 20 } })).join()).toContain(
      "within 0 to 120",
    );
    expect(problemsOf(age({ ValueRange: { Min: 1, Max: 121 } })).join()).toContain(
      "within 0 to 120",
    );
    expect(problemsOf(age({ ValueRange: { Min: 0, Max: 120 } }))).toEqual([]);
  });

  test("an assessment tool that is not in the pinned vocabulary", () => {
    const item = (tool: { TermURL: string; Label: string }): string =>
      mutated((f) => {
        f.datasets.nm000149.columns = {
          panas: {
            IsAbout: { Label: "Assessment Tool", TermURL: "nb:Assessment" },
            IsPartOf: tool,
            VariableType: "Collection",
          },
        };
      });
    expect(
      problemsOf(
        item({ TermURL: "snomed:304755000", Label: "Positive and negative affect schedule" }),
      ),
    ).toEqual([]);
    expect(problemsOf(item({ TermURL: "snomed:1", Label: "x" })).join()).toContain(
      "snomed:1 is not in the pinned assessment vocabulary",
    );
    expect(problemsOf(item({ TermURL: "snomed:304755000", Label: "PANAS" })).join()).toContain(
      "the pinned label",
    );
    // A diagnosis term is not an assessment tool.
    expect(
      problemsOf(item({ TermURL: "snomed:35919005", Label: "Autism spectrum disorder" })).join(),
    ).toContain("not in the pinned assessment vocabulary");
  });

  test("every problem at once, not only the first", () => {
    const text = mutated((f) => {
      (f.datasets.nm000149.evidence as Json).date = "tomorrow";
      f.datasets.xx000001 = clone(f.datasets.on001787);
      const g = inCopy(f, "nm000119", "group") as { Levels: Record<string, { TermURL: string }> };
      Object.values(g.Levels)[0].TermURL = "snomed:1";
    });
    const problems = problemsOf(text);
    expect(problems.length).toBe(3);
    expect(() => parseCuration(text)).toThrow(/3 problem\(s\)/);
    // A malformed file is reported whole too, before any term is looked at.
    const shape = mutated((f) => {
      (f.datasets.nm000119.pins as Json).participants_tsv = "x";
      (f.datasets.nm000149.evidence as Json).review = "someone";
    });
    expect(problemsOf(shape).length).toBe(2);
  });

  test("curatedColumnFrom judges a single block by the same rules as the file", () => {
    const ok = curatedColumnFrom("group", column("nm000149", "group"));
    expect("column" in ok && ok.column.kind).toBe("diagnosis");
    const bad = curatedColumnFrom("group", { ...column("nm000149", "group"), Extra: 1 });
    expect("problems" in bad && bad.problems.join()).toContain('unknown key "Extra"');
    expect("problems" in curatedColumnFrom("", column("nm000149", "group"))).toBe(true);
    expect("problems" in curatedColumnFrom("x", 3)).toBe(true);
  });

  test("the entries come back sorted, with levels and missing values in a fixed order", () => {
    const text = mutated((f) => {
      f.datasets.nm000149.columns = {
        group: {
          IsAbout: { Label: "Diagnosis", TermURL: "nb:Diagnosis" },
          Levels: {
            b: { Label: "Spinal cord injury", TermURL: "snomed:90584004" },
            a: { Label: "Spinal cord injury", TermURL: "snomed:90584004" },
          },
          MissingValues: ["z", "n/a", "m"],
          VariableType: "Categorical",
        },
      };
    });
    const file = parseCuration(text);
    expect([...file.entries.keys()]).toEqual([...file.entries.keys()].sort());
    const group = file.entries.get("nm000149")?.columns[0] as Extract<
      CuratedColumn,
      { kind: "diagnosis" }
    >;
    expect([...group.levels.keys()]).toEqual(["a", "b"]);
    expect(group.missingValues).toEqual(["m", "n/a", "z"]);
  });
});

describe("scanKeys", () => {
  test("finds a repeated key at any depth and names its path, and a repeat in two objects is not one", () => {
    expect(scanKeys('{"a":{"b":1,"b":2},"c":[{"d":1,"d":1}]}').duplicates).toEqual([
      "/a/b",
      "/c/0/d",
    ]);
    expect(scanKeys('{"a":{"b":1},"c":{"b":1}}').duplicates).toEqual([]);
  });

  test("reads strings with escapes, empty containers, numbers and literals without losing its place", () => {
    const text =
      '{"k\\"ey": "va\\\\lue", "e": {}, "l": [], "n": -1.5e3, "t": true, "z": null, "k\\"ey": 1}';
    expect(scanKeys(text).duplicates).toEqual(['/k"ey']);
  });

  test("a document with no problem reports none, and __proto__ is found where it is a key only", () => {
    expect(scanKeys(fileText)).toEqual({ duplicates: [], protoKeys: [] });
    expect(scanKeys('{"a":"__proto__"}').protoKeys).toEqual([]);
    expect(scanKeys('{"x":{"__proto__":1}}').protoKeys).toEqual(["/x/__proto__"]);
  });
});

describe("git blob pins", () => {
  test("gitBlobSha is git hash-object: the empty blob and a known one", async () => {
    expect(await gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  test("a pin is of the UTF-8 bytes, so a multi-byte character counts its bytes", async () => {
    expect(await gitBlobSha("é")).toBe(await gitBlobShaOfBytes(new Uint8Array([0xc3, 0xa9])));
  });

  test("text matches only its own pin; absent matches only absent", async () => {
    const pin = await gitBlobSha("a\tb\n");
    expect(await contentMatchesPin("a\tb\n", pin)).toBe(true);
    expect(await contentMatchesPin("a\tb", pin)).toBe(false);
    expect(await contentMatchesPin("a\tb\n", null)).toBe(false);
    expect(await contentMatchesPin(null, pin)).toBe(false);
    expect(await contentMatchesPin(null, null)).toBe(true);
  });

  test("a byte order mark is the one tolerance, in both directions", async () => {
    const bytes = new TextEncoder().encode("﻿a\tb\n");
    const pin = await gitBlobShaOfBytes(bytes);
    expect(await contentMatchesPin("﻿a\tb\n", pin)).toBe(true);
    // The text of the same file from a decoder that drops the mark.
    expect(await contentMatchesPin("a\tb\n", pin)).toBe(true);
    // And the reverse: the file has no mark, the text has one.
    const plainPin = await gitBlobSha("a\tb\n");
    expect(await contentMatchesPin("﻿a\tb\n", plainPin)).toBe(false);
    expect(await contentMatchesPin("﻿﻿a\tb\n", pin)).toBe(false);
  });
});

/**
 * An entry from the REAL loader: the committed entry of `id` (or of `like`, for the evidence and
 * columns it brings), pinned to these documents, with its columns replaced if the test says.
 * No hand-built entry reaches the binder or the transform; they refuse one.
 */
async function loadedEntry(
  id: string,
  tsv: string,
  json: string | null,
  over: { like?: string; columns?: Record<string, Json> } = {},
): Promise<CurationEntry> {
  const raw = clone(fileJson.datasets[over.like ?? id]) as Json;
  raw.pins = {
    participants_json: json === null ? null : await gitBlobSha(json),
    participants_tsv: await gitBlobSha(tsv),
  };
  if (over.columns !== undefined) raw.columns = over.columns;
  const entry = parseCuration(JSON.stringify({ datasets: { [id]: raw }, format: 1 })).entries.get(
    id,
  );
  if (entry === undefined) throw new Error("the loader dropped the entry");
  return entry;
}

/** The committed raw columns of `id`, each with its MissingValues replaced. */
function columnsWithMissing(id: string, missing: string[]): Record<string, Json> {
  const columns = clone(fileJson.datasets[id].columns) as Record<string, Json>;
  for (const column of Object.values(columns)) column.MissingValues = missing;
  return columns;
}

describe("bindCuration", () => {
  const id = "nm000158";
  const tsv = fixtureText(id, "participants.tsv") as string;
  const json = fixtureText(id, "participants.json") as string;
  const docs = { participantsTsv: tsv, participantsJson: json };

  test("applies an entry to the exact documents it pinned", async () => {
    const result = await bindCuration(entryFor(id), docs);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.bound.diagnoses.map((d) => d.name)).toEqual(["group"]);
  });

  test("takes only an entry the loader made, and says so", async () => {
    const forged = { ...entryFor(id) } as unknown as CurationEntry;
    await expect(bindCuration(forged, docs)).rejects.toThrow("not a hand-built object");
  });

  test("a table that changed by one byte is stale, and so is a participants.json that changed", async () => {
    const edited = `${tsv}\n`;
    expect(await bindCuration(entryFor(id), { ...docs, participantsTsv: edited })).toEqual({
      status: "stale",
      staleFiles: ["participants_tsv"],
    });
    const editedJson = json.replace("Unique", "Unique ");
    expect(await bindCuration(entryFor(id), { ...docs, participantsJson: editedJson })).toEqual({
      status: "stale",
      staleFiles: ["participants_json"],
    });
    expect(
      await bindCuration(entryFor(id), { participantsTsv: edited, participantsJson: editedJson }),
    ).toEqual({ status: "stale", staleFiles: ["participants_json", "participants_tsv"] });
  });

  test("a line-ending flip is a change: CRLF to LF makes the pin stale", async () => {
    // The committed on003568 table has CRLF line endings, which git must never normalize.
    const crlf = fixtureText("on003568", "participants.tsv") as string;
    expect(crlf).toContain("\r\n");
    const entry = entryFor("on003568");
    const docs3568 = { participantsTsv: crlf, participantsJson: null };
    expect((await bindCuration(entry, docs3568)).status).toBe("applied");
    const lf = crlf.replace(/\r\n/g, "\n");
    expect(await bindCuration(entry, { ...docs3568, participantsTsv: lf })).toEqual({
      status: "stale",
      staleFiles: ["participants_tsv"],
    });
  });

  test("a pinned table that is now absent, or a pinned participants.json that is now absent, is stale", async () => {
    expect((await bindCuration(entryFor(id), { ...docs, participantsTsv: null })).status).toBe(
      "stale",
    );
    expect(await bindCuration(entryFor(id), { ...docs, participantsJson: null })).toEqual({
      status: "stale",
      staleFiles: ["participants_json"],
    });
  });

  test("a pin of an ABSENT participants.json holds only while it stays absent", async () => {
    const real = "nm000109";
    const text = fixtureText(real, "participants.tsv") as string;
    expect(fixtureText(real, "participants.json")).toBeNull();
    const entry = await loadedEntry(real, text, null, {
      like: "nm000119",
      columns: {
        sex: {
          IsAbout: { Label: "Sex", TermURL: "nb:Sex" },
          Levels: {
            F: { Label: "Female", TermURL: "snomed:248152002" },
            M: { Label: "Male", TermURL: "snomed:248153007" },
          },
          MissingValues: [],
          VariableType: "Categorical",
        },
      },
    });
    // The real table starts with a byte order mark; the text a decoder hands over may not.
    expect(text.startsWith("\uFEFF")).toBe(true);
    for (const given of [text, text.slice(1)]) {
      const result = await bindCuration(entry, { participantsTsv: given, participantsJson: null });
      expect(result.status).toBe("applied");
    }
    expect(
      (await bindCuration(entry, { participantsTsv: text, participantsJson: "{}" })).status,
    ).toBe("stale");
  });

  test("the pinned table cannot be read: invalid, not stale", async () => {
    const broken = '"unterminated\n';
    const entry = await loadedEntry(id, broken, json);
    const result = await bindCuration(entry, { participantsTsv: broken, participantsJson: json });
    expect(result.status).toBe("invalid");
    const noId = "name\tgroup\nx\tacute stroke patients (1-30 days post-stroke)\n";
    const noIdEntry = await loadedEntry(id, noId, json);
    expect(
      (await bindCuration(noIdEntry, { participantsTsv: noId, participantsJson: json })).status,
    ).toBe("invalid");
  });

  test("a value the level map does not cover, in a table the pins now describe, is invalid and names the value", async () => {
    const edited = `${tsv}sub-99\t71\tn/a\tn/a\tn/a\tn/a\tan unreviewed group\thomo sapiens\tn/a\n`;
    const entry = await loadedEntry(id, edited, json);
    const result = await bindCuration(entry, { participantsTsv: edited, participantsJson: json });
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.problems).toEqual([
      'column "group": 1 value(s) are in neither Levels nor MissingValues: "an unreviewed group"',
    ]);
  });

  test("coverage reads EVERY row: blank-id rows and both rows of a conflicting duplicate count", async () => {
    // on004166 has 98 rows with no participant id, and the dictionary is read by bagel over all rows.
    const blank = `${tsv}\t71\tn/a\tn/a\tn/a\tn/a\tvalue in a blank-id row\thomo sapiens\tn/a\n`;
    const blankEntry = await loadedEntry(id, blank, json);
    const blankResult = await bindCuration(blankEntry, {
      participantsTsv: blank,
      participantsJson: json,
    });
    expect(blankResult).toMatchObject({ status: "invalid" });
    // The same participant listed twice with rows that disagree: neither value may escape coverage.
    const twice = `${tsv}sub-1\t71\tn/a\tn/a\tn/a\tn/a\tfirst unseen value\thomo sapiens\tn/a\nsub-1\t71\tn/a\tn/a\tn/a\tn/a\tsecond unseen value\thomo sapiens\tn/a\n`;
    const twiceEntry = await loadedEntry(id, twice, json);
    const twiceResult = await bindCuration(twiceEntry, {
      participantsTsv: twice,
      participantsJson: json,
    });
    expect(twiceResult).toMatchObject({
      status: "invalid",
      problems: [expect.stringContaining("2 value(s) are in neither Levels nor MissingValues")],
    });
  });

  test("a blank cell is a value too: it must be covered or declared missing", async () => {
    const edited = tsv.replace(/(sub-1\t71\tn\/a\tn\/a\tn\/a\tn\/a\t)[^\t]*/, "$1");
    expect(edited).not.toBe(tsv);
    const entry = await loadedEntry(id, edited, json);
    const uncovered = await bindCuration(entry, {
      participantsTsv: edited,
      participantsJson: json,
    });
    expect(uncovered.status).toBe("invalid");
    const declared = await loadedEntry(id, edited, json, { columns: columnsWithMissing(id, [""]) });
    expect(
      (await bindCuration(declared, { participantsTsv: edited, participantsJson: json })).status,
    ).toBe("applied");
  });

  test("a curated column that is not in the header, or is in it twice", async () => {
    const renamed = tsv.replace("\tgroup\t", "\tcohort\t");
    const entry = await loadedEntry(id, renamed, json);
    const missing = await bindCuration(entry, { participantsTsv: renamed, participantsJson: json });
    expect(missing).toEqual({
      status: "invalid",
      problems: ['column "group" is not in the table header'],
    });

    const doubled = tsv.replace("\tspecies\t", "\tgroup\t");
    const twice = await loadedEntry(id, doubled, json);
    const result = await bindCuration(twice, { participantsTsv: doubled, participantsJson: json });
    expect(result).toEqual({
      status: "invalid",
      problems: ['column "group" appears 2 times in the table header'],
    });
  });

  test("the header is matched exactly, not case-insensitively", async () => {
    const [columnName] = Object.keys(fileJson.datasets[id].columns as Json);
    const columns = { Group: (fileJson.datasets[id].columns as Record<string, Json>)[columnName] };
    const entry = await loadedEntry(id, tsv, json, { columns });
    expect((await bindCuration(entry, docs)).status).toBe("invalid");
  });

  test("a participants.json that is not readable JSON, or not an object, never makes the binder throw", async () => {
    for (const broken of ["{not json", "[]", '"a string"', "null", "42", ""]) {
      const entry = await loadedEntry(id, tsv, broken);
      const result = await bindCuration(entry, { participantsTsv: tsv, participantsJson: broken });
      expect(result.status, JSON.stringify(broken)).toBe("applied");
    }
  });

  test("an age column is bound only while participants.json does not declare units other than years", async () => {
    // The real nm000132 table has an age column in years; the test writes the descriptions.
    const table = fixtureText("nm000132", "participants.tsv") as string;
    const ageColumns = {
      age: {
        Format: { Label: "decimal", TermURL: "nb:FromFloat" },
        IsAbout: { Label: "Age", TermURL: "nb:Age" },
        MissingValues: ["", "n/a"],
        VariableType: "Continuous",
      },
    };
    const outcomes: [string | null, string][] = [];
    for (const units of [
      undefined,
      "years",
      "Years",
      "(years)",
      "y",
      "yrs",
      null,
      "months",
      "days",
      "weeks",
      "",
      12,
    ]) {
      const description = JSON.stringify({
        age: units === undefined ? { Description: "Age" } : { Description: "Age", Units: units },
      });
      const entry = await loadedEntry("nm000132", table, description, {
        like: "nm000119",
        columns: ageColumns,
      });
      const result = await bindCuration(entry, {
        participantsTsv: table,
        participantsJson: description,
      });
      outcomes.push([units === undefined ? "(absent)" : JSON.stringify(units), result.status]);
    }
    expect(outcomes).toEqual([
      ["(absent)", "applied"],
      ['"years"', "applied"],
      ['"Years"', "applied"],
      ['"(years)"', "applied"],
      ['"y"', "applied"],
      ['"yrs"', "applied"],
      ["null", "applied"],
      ['"months"', "invalid"],
      ['"days"', "invalid"],
      ['"weeks"', "invalid"],
      ['""', "invalid"],
      ["12", "invalid"],
    ]);
    const months = JSON.stringify({ age: { Units: "months" } });
    const entry = await loadedEntry("nm000132", table, months, {
      like: "nm000119",
      columns: ageColumns,
    });
    const result = await bindCuration(entry, { participantsTsv: table, participantsJson: months });
    expect(result).toMatchObject({
      status: "invalid",
      problems: [expect.stringContaining('declares Units "months", not years')],
    });
  });

  test("an age column on the real nm000157 table, whose ages are all 0, is invalid, not an age of 0 for everyone", async () => {
    const zeros = fixtureText("nm000157", "participants.tsv") as string;
    const description = fixtureText("nm000157", "participants.json") as string;
    const entry = await loadedEntry("nm000157", zeros, description, {
      like: "nm000119",
      columns: {
        age: {
          Format: { Label: "decimal", TermURL: "nb:FromFloat" },
          IsAbout: { Label: "Age", TermURL: "nb:Age" },
          MissingValues: ["", "n/a"],
          VariableType: "Continuous",
        },
      },
    });
    const result = await bindCuration(entry, {
      participantsTsv: zeros,
      participantsJson: description,
    });
    expect(result).toMatchObject({
      status: "invalid",
      problems: [expect.stringContaining("19 of 19 ages are 0")],
    });
    // The reviewer who knows 0 is not an age says so, and then there is nothing left to curate.
    const declared = await loadedEntry("nm000157", zeros, description, {
      like: "nm000119",
      columns: {
        age: {
          Format: { Label: "decimal", TermURL: "nb:FromFloat" },
          IsAbout: { Label: "Age", TermURL: "nb:Age" },
          MissingValues: ["", "0", "n/a"],
          VariableType: "Continuous",
        },
      },
    });
    expect(
      await bindCuration(declared, { participantsTsv: zeros, participantsJson: description }),
    ).toMatchObject({
      status: "invalid",
      problems: [expect.stringContaining("no cell holds an age")],
    });
  });

  test("the zero share is of the AGES, not of the rows: missing cells do not dilute a placeholder", () => {
    const rows = [
      ["sub-1", "0"],
      ["sub-2", "5"],
      ...Array.from({ length: 8 }, (_, i) => [`sub-${i + 3}`, "n/a"]),
    ];
    const table = { header: ["participant_id", "age"], rows };
    const age: CuratedColumn = {
      kind: "age",
      name: "age",
      format: "FromFloat",
      formatTerm: { identifier: "nb:FromFloat", label: "decimal" },
      missingValues: ["n/a"],
      valueRange: null,
    };
    // One of two ages is 0 (half), whatever else the table holds.
    const result = bindCuratedColumn(age, table);
    expect("problems" in result && result.problems[0]).toContain("1 of 2 ages are 0");
  });

  test("only an age of exactly 0 is a placeholder zero: newborns in decimal years are ages", () => {
    const table = {
      header: ["participant_id", "age"],
      rows: [
        ["sub-1", "0.1"],
        ["sub-2", "0.2"],
        ["sub-3", "30"],
      ],
    };
    const age: CuratedColumn = {
      kind: "age",
      name: "age",
      format: "FromFloat",
      formatTerm: { identifier: "nb:FromFloat", label: "decimal" },
      missingValues: [],
      valueRange: null,
    };
    const result = bindCuratedColumn(age, table);
    expect(
      "bound" in result && result.bound.kind === "age" && result.bound.mapping.valueRange,
    ).toEqual({
      min: 0.1,
      max: 30,
    });
  });

  test("an age column: unreadable values, no age at all, and a ValueRange the table does not have", () => {
    const table = {
      header: ["participant_id", "age"],
      rows: [
        ["sub-1", "10"],
        ["sub-2", "20"],
        ["sub-3", "x"],
      ],
    };
    const age = (change: Partial<Extract<CuratedColumn, { kind: "age" }>>): CuratedColumn => ({
      kind: "age",
      name: "age",
      format: "FromFloat",
      formatTerm: { identifier: "nb:FromFloat", label: "decimal" },
      missingValues: [],
      valueRange: null,
      ...change,
    });
    const unreadable = bindCuratedColumn(age({}), table);
    expect("problems" in unreadable && unreadable.problems[0]).toContain(
      "1 value(s) are not ages in nb:FromFloat",
    );
    const ok = bindCuratedColumn(age({ missingValues: ["x"] }), table);
    expect("bound" in ok && ok.bound.kind === "age" && ok.bound.mapping.valueRange).toEqual({
      min: 10,
      max: 20,
    });
    const range = bindCuratedColumn(
      age({ missingValues: ["x"], valueRange: { min: 10, max: 30 } }),
      table,
    );
    expect("problems" in range && range.problems[0]).toContain(
      "ValueRange 10 to 30 is not the table's 10 to 20",
    );
    const exact = bindCuratedColumn(
      age({ missingValues: ["x"], valueRange: { min: 10, max: 20 } }),
      table,
    );
    expect("bound" in exact).toBe(true);
    const none = bindCuratedColumn(age({ missingValues: ["10", "20", "x"] }), table);
    expect("problems" in none && none.problems[0]).toContain("no cell holds an age");
  });

  test("an age value out of 0 to 120, and a European decimal, are read by their declared format", () => {
    const table = {
      header: ["participant_id", "a"],
      rows: [
        ["sub-1", "31,5"],
        ["sub-2", "7"],
      ],
    };
    const euro: CuratedColumn = {
      kind: "age",
      name: "a",
      format: "FromEuro",
      formatTerm: { identifier: "nb:FromEuro", label: "European decimal" },
      missingValues: [],
      valueRange: null,
    };
    const bound = bindCuratedColumn(euro, table);
    expect(
      "bound" in bound && bound.bound.kind === "age" && bound.bound.mapping.ageOf("31,5"),
    ).toBe(31.5);
    const float = bindCuratedColumn({ ...euro, format: "FromFloat" }, table);
    expect("problems" in float).toBe(true);
    const huge = bindCuratedColumn(euro, { ...table, rows: [["sub-1", "2018"]] });
    expect("problems" in huge).toBe(true);
  });

  test("an assessment item: a blank cell that is not declared missing would count as a recorded item", () => {
    const table = {
      header: ["participant_id", "item"],
      rows: [
        ["sub-1", "3"],
        ["sub-2", ""],
        ["sub-3", "n/a"],
      ],
    };
    const item = (missingValues: string[]): CuratedColumn => ({
      kind: "assessment",
      name: "item",
      tool: { identifier: "snomed:304755000", label: "Positive and negative affect schedule" },
      missingValues,
    });
    const undeclared = bindCuratedColumn(item([]), table);
    expect("problems" in undeclared && undeclared.problems[0]).toContain(
      '"", "n/a" appear in the table',
    );
    expect("problems" in bindCuratedColumn(item(["n/a"]), table)).toBe(true);
    expect("bound" in bindCuratedColumn(item(["", "n/a"]), table)).toBe(true);
    // A value that is not a standard missing value needs no declaration.
    expect(
      "bound" in bindCuratedColumn(item(["", "n/a"]), { ...table, rows: [["sub-1", "-"]] }),
    ).toBe(true);
  });
});

describe("lookupCuration: a file that does not load stops conversion", () => {
  const ids = [...loadCuration().entries.keys()];
  const spoilers: [string, (text: string) => string][] = [
    ["an unknown key", (t) => t.replace('"format": 1', '"format": 1, "extra": 1')],
    ["text that is not JSON", (t) => t.slice(0, t.length - 40)],
    [
      "a duplicated dataset",
      (t) => t.replace('"nm000119": {', '"nm000119": {"x": 1},\n"nm000119": {'),
    ],
    ["a term that is not in the vocabulary", (t) => t.replaceAll("snomed:35919005", "snomed:1")],
    ["an empty file", () => ""],
  ];

  test("a good file gives each dataset its entry, and a dataset with none gets none", () => {
    for (const id of ids) {
      const found = lookupCuration(fileText, id);
      expect(found.status).toBe("entry");
      if (found.status === "entry") expect(found.entry.datasetId).toBe(id);
    }
    expect(lookupCuration(fileText, "nm000132")).toEqual({ status: "none" });
  });

  test("a file that does not load is `stop` for every dataset, in particular the two whose entry only withdraws a claim", () => {
    for (const [label, spoil] of spoilers) {
      const text = spoil(fileText);
      expect(() => parseCuration(text), label).toThrow(CurationError);
      for (const id of [...ids, "nm000132"]) {
        const found = lookupCuration(text, id);
        // Never `none` and never `entry`: a writer that read either would convert without the entry.
        expect(found.status, `${label}: ${id}`).toBe("stop");
        if (found.status === "stop") expect(found.problems.length).toBeGreaterThan(0);
      }
    }
    for (const id of ["on004166", "on006801"]) {
      expect(lookupCuration(fileText.slice(0, 100), id).status).toBe("stop");
    }
  });

  test("the options reach the loader: a review dated in the future is a `stop` when today is given", () => {
    const future = mutated((f) => {
      (f.datasets.nm000119.evidence as Json).date = "2099-01-01";
    });
    expect(lookupCuration(future, "nm000119").status).toBe("entry");
    expect(lookupCuration(future, "nm000119", { today: "2026-10-02" }).status).toBe("stop");
  });

  test("a bug in the caller is not swallowed as a `stop`", () => {
    expect(() => lookupCuration(fileText, "nm000119", { today: "not a date" })).toThrow(
      "YYYY-MM-DD",
    );
  });
});

describe("the review date allows one day of slack for time zones", () => {
  // 23:00 UTC on 2026-10-02 is already 2026-10-03 in Auckland (UTC+13) and 2026-10-03 at UTC+14.
  const now = Date.UTC(2026, 9, 2, 23, 0, 0);
  const dated = (date: string): string =>
    mutated((f) => {
      (f.datasets.nm000119.evidence as Json).date = date;
    });

  test("the latest believable date is one day after the UTC date", () => {
    expect(latestReviewDate(now)).toBe("2026-10-03");
    expect(latestReviewDate(Date.UTC(2026, 11, 31, 0, 0, 0))).toBe("2027-01-01");
  });

  test("a review dated today in a zone ahead of UTC is accepted, and one dated two days ahead is not", () => {
    expect(() => parseCommittedCuration(dated("2026-10-02"), now)).not.toThrow();
    expect(() => parseCommittedCuration(dated("2026-10-03"), now)).not.toThrow();
    expect(() => parseCommittedCuration(dated("2026-10-04"), now)).toThrow("is after today");
  });
});

describe("only the loader registers an entry as loaded", () => {
  /** Where `name` is used as an identifier in `source`: an import, a call or any other reference. */
  function usesOf(source: string, name: string): number {
    const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.ES2022, true);
    let found = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name) found++;
      ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
  }

  const ROOT = join(import.meta.dir, "..");
  const sources = ["shared", "scripts", "src", "backend/src", "backend/test", "test"].flatMap(
    (dir) =>
      (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
        .filter((f) => /\.tsx?$/.test(f) && !f.includes("node_modules"))
        .map((f) => relative(ROOT, join(ROOT, dir, f))),
  );
  const ALLOWED = ["shared/neurobagel/curation-loaded.ts", "shared/neurobagel/curation.ts"];

  test("the scan sees the sources it is meant to (it is not vacuous)", () => {
    expect(sources.length).toBeGreaterThan(100);
    for (const allowed of ALLOWED) expect(sources).toContain(allowed);
    expect(
      usesOf(readFileSync(join(ROOT, "shared/neurobagel/curation.ts"), "utf8"), "markLoaded"),
    ).toBeGreaterThan(0);
  });

  test("no other file imports or calls markLoaded", () => {
    const offenders = sources.filter(
      (f) => !ALLOWED.includes(f) && usesOf(readFileSync(join(ROOT, f), "utf8"), "markLoaded") > 0,
    );
    expect(offenders).toEqual([]);
    // It reads every source file in the repository, which took 5.2 s (the default limit is 5 s)
    // with four test workers sharing a 4-vCPU runner. The scan is bounded by the file count,
    // not by a wait, so a longer limit does not hide a hang.
  }, 30_000);

  test("the scanner finds an import, a call, an alias and a re-export", () => {
    expect(usesOf('import { markLoaded } from "./curation-loaded";', "markLoaded")).toBe(1);
    expect(usesOf("const x = markLoaded(data);", "markLoaded")).toBe(1);
    expect(usesOf('import { markLoaded as m } from "./curation-loaded"; m(1);', "markLoaded")).toBe(
      1,
    );
    expect(usesOf('export { markLoaded } from "./curation-loaded";', "markLoaded")).toBe(1);
    expect(usesOf('const s = "markLoaded"; // markLoaded', "markLoaded")).toBe(0);
  });
});
