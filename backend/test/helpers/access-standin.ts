/**
 * A stand-in for the ACCESS gateway-attributes endpoint (epic #2005 phase A8, #2013): a real
 * `Bun.serve` HTTP server that records every request it receives (method, path, headers, the raw
 * body and the parsed JSON) and answers as it is told. It decides nothing.
 *
 * NO RESPONSE IN IT WAS RECORDED FROM THE REAL SERVICE, and nothing about the real endpoint is
 * verified here: not the name of the header that carries the key, not the spelling of the body, not
 * what it answers for a duplicate, not whether it takes a `debug` flag as a body field. The shape it
 * speaks is the one the phase issue names (`POST <base>/job_attributes` with `jobid`, `submittime`,
 * `xsederesourcename` and `gatewayuser`), and a test that pins a spelling says so.
 *
 * Behaviours, each for the next `times` requests (default one) and then back to `200`:
 *   `answer(status)`  reply with this status and an empty JSON object;
 *   `redirect(to)`    reply 302 with a `Location` header (a client that follows it makes a second request,
 *                     which is how a test sees a redirect followed);
 *   `hang()`          read the request and never answer: the client's own timeout ends it (its answer
 *                     is lost, which is what a dropped connection after the request left looks like);
 *   `down()`/`up()`   close the port and open it again on the same port (connection refused between).
 *   `beforeAnswer(fn)` run `fn` after the request was recorded and before the answer goes back, once.
 * The base address a test installs as `globalThis.NEMAR_ACCESS_ATTRIBUTES_URL` is `url` (no path), so
 * the request path the stand-in sees is `/job_attributes`.
 */

export interface AccessRequest {
  method: string;
  path: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  raw: string;
  /** The body parsed as JSON, or null when it is not JSON. */
  body: Record<string, unknown> | null;
}

export interface AccessStandin {
  url: string;
  requests: AccessRequest[];
  answer(status: number, times?: number): void;
  redirect(location: string, times?: number): void;
  hang(times?: number): void;
  beforeAnswer(fn: () => Promise<void>): void;
  down(): void;
  up(): void;
  reset(): void;
  stop(): void;
}

type Behaviour =
  | { kind: "answer"; status: number; left: number }
  | { kind: "redirect"; location: string; left: number }
  | { kind: "hang"; left: number };

export function startAccessStandin(): AccessStandin {
  const requests: AccessRequest[] = [];
  const behaviours: Behaviour[] = [];
  let before: (() => Promise<void>) | null = null;

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const raw = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
    requests.push({ method: req.method, path: url.pathname, headers, raw, body });

    const hook = before;
    before = null;
    if (hook) await hook();

    const index = behaviours.findIndex((b) => b.left > 0);
    const behaviour = index === -1 ? undefined : behaviours[index];
    if (behaviour) behaviour.left -= 1;
    if (behaviour?.kind === "hang") return new Promise<Response>(() => {});
    if (behaviour?.kind === "redirect") {
      return new Response("", { status: 302, headers: { Location: behaviour.location } });
    }
    const status = behaviour?.kind === "answer" ? behaviour.status : 200;
    return new Response("{}", { status, headers: { "Content-Type": "application/json" } });
  };

  let server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  const port = server.port;
  let stopped = false;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    answer(status, times = 1) {
      behaviours.push({ kind: "answer", status, left: times });
    },
    redirect(location, times = 1) {
      behaviours.push({ kind: "redirect", location, left: times });
    },
    hang(times = 1) {
      behaviours.push({ kind: "hang", left: times });
    },
    beforeAnswer(fn) {
      before = fn;
    },
    down() {
      if (stopped) return;
      stopped = true;
      server.stop(true);
    },
    up() {
      if (!stopped) return;
      stopped = false;
      server = Bun.serve({ port, hostname: "127.0.0.1", fetch: handle });
    },
    reset() {
      requests.length = 0;
      behaviours.length = 0;
      before = null;
      if (stopped) {
        stopped = false;
        server = Bun.serve({ port, hostname: "127.0.0.1", fetch: handle });
      }
    },
    stop() {
      stopped = true;
      server.stop(true);
    },
  };
}
