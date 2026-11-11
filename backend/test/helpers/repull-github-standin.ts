/**
 * A `Bun.serve()` stand-in for the api.github.com reads and the one dispatch a re-pull's Worker
 * routes make (epic #1046 phase 6, #1912), installed through NEMAR_GITHUB_API_URL the way the
 * other backend suites install theirs. Not a mock of NEMAR code: every NEMAR component runs, and
 * only GitHub is stood in for, because the organization is shared with production.
 *
 * It answers:
 *  - `GET /repos/nemarDatasets/<id>/pulls/<n>`: an entry of `pulls` (`<id>#<n>`), or, with
 *    `defaultHead` set, an open, unmerged pull request at that head from the release branch the
 *    repull-rows fixtures record (`release/v2.0.0` for #7, `release/v2.0.1` for #8);
 *  - `GET .../commits/refs/tags/<tag>`: the commit in `tags` (`<id>@<tag>`) as a bare id when the
 *    request asks for `application/vnd.github.sha`, as `{ sha }` otherwise; 422 when absent;
 *  - `GET .../compare/<base>...<head>`: `{ status }` from `compares` (`<id>:<base>...<head>`),
 *    `identical` for equal ids and `ahead` otherwise by default, or that HTTP status when the entry is
 *    a number;
 *  - `POST /repos/nemarDatasets/.github/dispatches`: recorded in `dispatches`, answered
 *    `dispatchStatus`;
 *  - `GET .../git/ref/heads/main`: the commit in `mainRefs` (`<id>`) as a ref object, or that HTTP
 *    status when the entry is a number; 404 when absent;
 *  - `GET .../commits/<sha>/check-runs`: the runs in `checkRuns` (`<id>@<sha>`), filtered by the
 *    query's `check_name` and `app_id` as GitHub filters them (unless `checkFiltersIgnored`, a
 *    GitHub that ignored them), or that HTTP status when the entry is a number; none when absent;
 *    `checkTotalCount` makes the list claim more runs than it holds (a page that is not all);
 *  - `POST .../check-runs`, `PATCH .../check-runs/<n>`, `POST .../issues/<n>/comments` and
 *    `PATCH .../issues/comments/<n>`, the writes the ADR 0107 review publishes its check and its
 *    comment with: recorded in `writes` and answered with a new id;
 *  - `PUT .../pulls/<n>/merge`, the Worker's merge of an automatic re-pull: recorded in `merges`
 *    (its body and the token it carried), with `beforeMerge` run first (a test reads the database
 *    there, at the moment the merge arrives). As GitHub does, it answers 409 when the `sha` it was
 *    sent is not the pull request's head, and otherwise merges the entry of `pulls` (merged,
 *    closed, `STANDIN_MERGE_SHA` its merge commit) and answers `{ merged: true }`; `mergeAnswer`
 *    answers another status instead (with `applied`, the merge is made all the same: an answer
 *    lost after GitHub merged), or a 200 whose body does not say it merged.
 * A pull request entry may also name its `number`, `user` and `mergeable_state`, which are answered
 * only when named, and the head's and base's `repo`, which are the dataset's own when not named, as
 * GitHub always names both (`null` stands for a deleted fork's head). A request whose path holds
 * `slow` is answered `slowMs` late. Error answers on the reads added for the machine-clean facts
 * carry `Retry-After: 0`, so a retry does not wait. `pullReadFailures` (`<id>#<n>`) answers that
 * many reads of the pull request 503, with `Retry-After: 0`, before it answers again, so one
 * reader's read fails while a later reader's succeeds. `down` answers every request 503. Every
 * request is recorded in `requests`, and with its query in `urls`.
 */

import type { Server } from "bun";

export interface PullAnswer {
  status?: number;
  number?: number;
  /** The title, answered only when named (the review's intake reads it). */
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: unknown;
  merge_commit_sha?: string | null;
  user?: { login: string; id: number; type: string };
  head?: { sha: string; ref: string; repo?: { full_name: string } | null };
  base?: { ref: string; repo?: { full_name: string; name?: string; owner?: { login: string } } };
  mergeable_state?: string | null;
  /** Keys to leave out of the answer, to stand in for a malformed one. */
  omit?: string[];
}

export interface Dispatch {
  event_type: string;
  client_payload: {
    dataset_id: string;
    ref: string;
    request_id: number;
    callback_token: string;
    callback_url: string;
  };
}

export const STANDIN_MERGE_SHA = "1111111111111111111111111111111111111111";

/** One check run as GitHub's `check-runs` list carries it (`app_id` is its `app.id`). */
export interface CheckRunAnswer {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  app_id: number;
  /** The commit the run is on; the commit asked about when not given. */
  head_sha?: string;
}

/** One merge the stand-in was asked to make. */
export interface MergeAsked {
  path: string;
  body: Record<string, unknown>;
  token: string | null;
}

export interface RepullGitHub {
  requests: string[];
  pulls: Record<string, PullAnswer>;
  /** The merges asked for, in order. */
  merges: MergeAsked[];
  /** Run when a merge arrives, before it is answered. */
  beforeMerge: ((asked: MergeAsked) => void | Promise<void>) | null;
  /**
   * What a merge is answered instead of GitHub's own: a status (`applied` makes the merge all the
   * same, as a gateway's answer lost after GitHub merged), or `not-merged`, a 200 whose body does
   * not say `merged: true`. Null: merged when the `sha` is the head, 409 otherwise.
   */
  mergeAnswer: { status: number; applied?: boolean } | "not-merged" | null;
  defaultHead: string | null;
  tags: Record<string, string>;
  compares: Record<string, string | number>;
  dispatches: Dispatch[];
  dispatchStatus: number;
  /** The review's check-run and comment writes, as `<METHOD> <path>`. */
  writes: string[];
  /** A status every check-run and comment write is answered with, refusing it; 0 takes them. */
  writeStatus: number;
  mainRefs: Record<string, string | number>;
  checkRuns: Record<string, CheckRunAnswer[] | number>;
  checkFiltersIgnored: boolean;
  /** The `total_count` the check-runs list claims, when it is not the runs it holds. */
  checkTotalCount: number | null;
  slow: string | null;
  slowMs: number;
  urls: string[];
  /** How many more reads of a pull request (`<id>#<n>`) answer 503 before it answers again. */
  pullReadFailures: Record<string, number>;
  down: boolean;
  reset(): void;
  stop(): void;
}

export function startRepullGitHub(o: { defaultHead?: string | null } = {}): RepullGitHub {
  const gh: RepullGitHub = {
    requests: [],
    pulls: {},
    merges: [],
    beforeMerge: null,
    mergeAnswer: null,
    defaultHead: o.defaultHead ?? null,
    tags: {},
    compares: {},
    dispatches: [],
    dispatchStatus: 204,
    writes: [],
    writeStatus: 0,
    mainRefs: {},
    checkRuns: {},
    checkFiltersIgnored: false,
    checkTotalCount: null,
    slow: null,
    slowMs: 1_500,
    urls: [],
    pullReadFailures: {},
    down: false,
    reset() {
      gh.requests = [];
      gh.pulls = {};
      gh.merges = [];
      gh.beforeMerge = null;
      gh.mergeAnswer = null;
      gh.defaultHead = o.defaultHead ?? null;
      gh.tags = {};
      gh.compares = {};
      gh.dispatches = [];
      gh.dispatchStatus = 204;
      gh.writes = [];
      gh.writeStatus = 0;
      gh.mainRefs = {};
      gh.checkRuns = {};
      gh.checkFiltersIgnored = false;
      gh.checkTotalCount = null;
      gh.slow = null;
      gh.slowMs = 1_500;
      gh.urls = [];
      gh.pullReadFailures = {};
      gh.down = false;
    },
    stop() {
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
      server.stop(true);
    },
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  /** An error answer a client retries at once. */
  const refuse = (status: number) =>
    new Response(JSON.stringify({ message: "no" }), {
      status,
      headers: { "Content-Type": "application/json", "Retry-After": "0" },
    });
  const server: Server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      gh.requests.push(`${req.method} ${url.pathname}`);
      gh.urls.push(`${req.method} ${url.pathname}${url.search}`);
      if (gh.slow !== null && url.pathname.includes(gh.slow)) await Bun.sleep(gh.slowMs);
      if (gh.down) return new Response("unavailable", { status: 503 });
      if (req.method === "POST" && url.pathname === "/repos/nemarDatasets/.github/dispatches") {
        const body = (await req.json()) as Dispatch;
        if (gh.dispatchStatus < 300) gh.dispatches.push(body);
        return new Response(gh.dispatchStatus < 300 ? null : '{"message":"refused"}', {
          status: gh.dispatchStatus,
        });
      }
      if (
        (req.method === "POST" || req.method === "PATCH") &&
        /^\/repos\/nemarDatasets\/[a-z]{2}\d{6}\/(check-runs(\/\d+)?|issues\/(\d+\/comments|comments\/\d+))$/.test(
          url.pathname,
        )
      ) {
        gh.writes.push(`${req.method} ${url.pathname}`);
        if (gh.writeStatus !== 0) {
          return new Response('{"message":"refused"}', {
            status: gh.writeStatus,
            headers: { "Retry-After": "0" },
          });
        }
        return json({ id: 9000 + gh.writes.length }, req.method === "POST" ? 201 : 200);
      }
      let m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/pulls\/(\d+)\/merge$/.exec(url.pathname);
      if (m && req.method === "PUT") {
        const asked: MergeAsked = {
          path: url.pathname,
          body: ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>,
          token: (req.headers.get("authorization") ?? "").replace(/^Bearer /, "") || null,
        };
        gh.merges.push(asked);
        if (gh.beforeMerge) await gh.beforeMerge(asked);
        const key = `${m[1]}#${m[2]}`;
        const pull = gh.pulls[key];
        const merge = () => {
          if (pull) {
            pull.merged = true;
            pull.state = "closed";
            pull.merge_commit_sha = STANDIN_MERGE_SHA;
          }
        };
        const answer = gh.mergeAnswer;
        if (answer === "not-merged") return json({ message: "Accepted" });
        if (answer !== null) {
          if (answer.applied) merge();
          return json({ message: "no" }, answer.status);
        }
        if (!pull || pull.state === "closed" || pull.merged === true) {
          return json({ message: "Pull Request is not mergeable" }, 405);
        }
        if (asked.body.sha !== (pull.head?.sha ?? gh.defaultHead)) {
          return json(
            { message: "Head branch was modified. Review and try the merge again." },
            409,
          );
        }
        merge();
        return json({
          sha: STANDIN_MERGE_SHA,
          merged: true,
          message: "Pull Request successfully merged",
        });
      }
      m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/pulls\/(\d+)$/.exec(url.pathname);
      if (m) {
        const n = Number(m[2]);
        const failing = gh.pullReadFailures[`${m[1]}#${m[2]}`] ?? 0;
        if (failing > 0) {
          gh.pullReadFailures[`${m[1]}#${m[2]}`] = failing - 1;
          return refuse(503);
        }
        const a: PullAnswer | undefined =
          gh.pulls[`${m[1]}#${m[2]}`] ??
          (gh.defaultHead
            ? {
                head: { sha: gh.defaultHead, ref: n === 8 ? "release/v2.0.1" : "release/v2.0.0" },
              }
            : undefined);
        if (!a) return json({ message: "Not Found" }, 404);
        if (a.status && a.status !== 200) return json({ message: "no" }, a.status);
        // GitHub names both repositories, a deleted fork's head as null: the dataset's own unless
        // the entry names another.
        const own = { full_name: `nemarDatasets/${m[1]}` };
        const head = a.head ?? { sha: gh.defaultHead, ref: "release/v2.0.0" };
        const base = a.base ?? { ref: "main" };
        const body: Record<string, unknown> = {
          number: a.number ?? n,
          state: a.state ?? (a.merged === true ? "closed" : "open"),
          draft: a.draft ?? false,
          merged: a.merged ?? false,
          merge_commit_sha:
            a.merge_commit_sha === undefined ? STANDIN_MERGE_SHA : a.merge_commit_sha,
          head: "repo" in head ? head : { ...head, repo: own },
          base: "repo" in base ? base : { ...base, repo: own },
          ...(a.title === undefined ? {} : { title: a.title }),
          ...(a.user === undefined ? {} : { user: a.user }),
          ...(a.mergeable_state === undefined ? {} : { mergeable_state: a.mergeable_state }),
        };
        for (const k of a.omit ?? []) delete body[k];
        return json(body);
      }
      // GitHub does not read `tags/<tag>` as a ref here: it takes it for a commit id and answers
      // 422. The stand-in said otherwise until the first production re-pull release (2026-11-08).
      if (/^\/repos\/nemarDatasets\/[a-z]{2}\d{6}\/commits\/tags\//.test(url.pathname)) {
        return json(
          { message: `No commit found for SHA: ${url.pathname.split("/commits/")[1]}` },
          422,
        );
      }
      m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/commits\/refs\/tags\/(.+)$/.exec(url.pathname);
      if (m) {
        const sha = gh.tags[`${m[1]}@${decodeURIComponent(m[2] as string)}`];
        if (!sha) return json({ message: "No commit found" }, 422);
        return req.headers.get("Accept") === "application/vnd.github.sha"
          ? new Response(sha, { status: 200 })
          : json({ sha });
      }
      m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/git\/ref\/heads\/main$/.exec(url.pathname);
      if (m) {
        const ref = gh.mainRefs[m[1] as string];
        if (ref === undefined) return refuse(404);
        if (typeof ref === "number") return refuse(ref);
        return json({ ref: "refs/heads/main", object: { sha: ref, type: "commit" } });
      }
      m = /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/commits\/([0-9a-f]{40})\/check-runs$/.exec(
        url.pathname,
      );
      if (m) {
        const sha = m[2] as string;
        const runs = gh.checkRuns[`${m[1]}@${sha}`] ?? [];
        if (typeof runs === "number") return refuse(runs);
        const name = url.searchParams.get("check_name");
        const app = url.searchParams.get("app_id");
        const kept = gh.checkFiltersIgnored
          ? runs
          : runs.filter(
              (r) =>
                (name === null || r.name === name) && (app === null || String(r.app_id) === app),
            );
        return json({
          total_count: gh.checkTotalCount ?? kept.length,
          check_runs: kept.map((r) => ({
            id: r.id,
            name: r.name,
            status: r.status,
            conclusion: r.conclusion,
            head_sha: r.head_sha ?? sha,
            app: { id: r.app_id },
          })),
        });
      }
      m =
        /^\/repos\/nemarDatasets\/([a-z]{2}\d{6})\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(
          url.pathname,
        );
      if (m) {
        const answer =
          gh.compares[`${m[1]}:${m[2]}...${m[3]}`] ?? (m[2] === m[3] ? "identical" : "ahead");
        return typeof answer === "number"
          ? json({ message: "no" }, answer)
          : json({ status: answer });
      }
      return json({ message: "Not Found" }, 404);
    },
  });
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL =
    `http://127.0.0.1:${server.port}`;
  return gh;
}
