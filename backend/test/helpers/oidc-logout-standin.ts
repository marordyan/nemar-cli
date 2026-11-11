/**
 * A partner's back-channel logout endpoint, as a real HTTPS server on the loopback interface (epic
 * #2014 phase #2019). The Worker's sender makes a real outbound request to it; nothing about NEMAR's
 * sending logic is replaced. What the stand-in supplies is the PARTNER: it records every request it
 * receives (method, path, headers, body) and answers as the test says (a status, a redirect, silence).
 *
 * WHY TLS. A back-channel logout address is an https address, and the registry and the table refuse
 * any other, loopback included (`backchannel_logout_uri` CHECKs `https://`). So the stand-in serves
 * TLS with a throwaway self-signed certificate that `openssl` makes into a temporary directory when
 * the stand-in starts: no key is committed. The one thing a test must do to reach it is to let the
 * process accept that certificate, which the stand-in does for the process
 * (`NODE_TLS_REJECT_UNAUTHORIZED=0`, restored when it stops) rather than by giving the sender an option
 * it would never have in a Worker.
 *
 * No response of a real partner was recorded for this: the answers are those OpenID Connect
 * Back-Channel Logout 1.0 section 2.8 defines (200 for a logout done, 400 for a token refused, 501 for
 * no support) and the failures a network has (a 5xx, a redirect, no answer, no listener).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

/** One request the partner received. */
export interface LogoutRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  /** The body read as a form, which is what a logout request is. */
  form: URLSearchParams;
}

export type Responder = (req: LogoutRequest, count: number) => Response | Promise<Response>;

export interface LogoutStandin {
  /** The address to register: `https://127.0.0.1:<port>/oidc/logout`. */
  url: string;
  host: string;
  port: number;
  /** Every request received, in order. */
  requests: LogoutRequest[];
  /** Change how the partner answers from now on. */
  respond(responder: Responder): void;
  stop(): Promise<void>;
}

let material: { key: string; cert: string } | undefined;

/** A throwaway certificate, made once per process by `openssl` into a directory that is removed again. */
function certificate(): { key: string; cert: string } {
  if (material) return material;
  const dir = mkdtempSync(join(tmpdir(), "nemar-logout-standin-"));
  try {
    const made = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { encoding: "utf8" },
    );
    if (made.status !== 0) {
      throw new Error(
        `openssl could not make the stand-in's certificate (status ${made.status}): ${made.error?.message ?? made.stderr}`,
      );
    }
    material = {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
    return material;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Start a partner that answers 200 until told otherwise. */
export function startLogoutStandin(responder?: Responder): LogoutStandin {
  const { key, cert } = certificate();
  const requests: LogoutRequest[] = [];
  let answer: Responder = responder ?? (() => new Response(null, { status: 200 }));
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const server: Server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { key, cert },
    async fetch(req) {
      const body = await req.text();
      const record: LogoutRequest = {
        method: req.method,
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body,
        form: new URLSearchParams(body),
      };
      requests.push(record);
      return answer(record, requests.length);
    },
  });
  return {
    url: `https://127.0.0.1:${server.port}/oidc/logout`,
    host: "127.0.0.1",
    port: server.port as number,
    requests,
    respond(next) {
      answer = next;
    },
    async stop() {
      await server.stop(true);
      if (previous === undefined)
        Reflect.deleteProperty(process.env, "NODE_TLS_REJECT_UNAUTHORIZED");
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    },
  };
}

/** The address of a port nothing listens on: a connection to it is refused. */
export async function refusedAddress(): Promise<string> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  await probe.stop(true);
  return `https://127.0.0.1:${port}/oidc/logout`;
}
