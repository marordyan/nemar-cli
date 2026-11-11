/**
 * The two per-job tokens of the compute gateway (epic #2005 phase A5, #2010; ADR 0118).
 *
 * Both are HMAC-SHA256 hex digests over a job id and the job's `webhook_nonce`, signed with the callback
 * secret under a domain tag of their own, so one secret signs every callback of the Worker and no token
 * of one kind answers for another. Real `crypto.subtle` round trips over the real functions; no mocks.
 *
 * CI TIER: unit-pure. Hermetic: pure functions and a real WebCrypto, no server, no database.
 */

import { describe, expect, test } from "bun:test";
import {
  COMPUTE_JOB_TOKEN_DOMAIN,
  COMPUTE_WEBHOOK_TOKEN_DOMAIN,
  encodeComputeTokenPayload,
  signComputeToken,
  verifyComputeToken,
} from "../src/services/compute-tokens";
import {
  APPROVAL_DISPATCH_TOKEN_DOMAIN,
  IDENTIFIER_REPULL_TOKEN_DOMAIN,
  IDENTIFIER_SCREEN_TOKEN_DOMAIN,
  IDENTIFIER_SWEEP_TOKEN_DOMAIN,
  PR_REVIEW_TOKEN_DOMAIN,
  PUBLICATION_REVIEW_TOKEN_DOMAIN,
  REPULL_DISPATCH_TOKEN_DOMAIN,
  signPrReviewCallbackToken,
  signPrescreenCallbackToken,
  signRepullDispatchToken,
} from "../src/services/github/callback-tokens";

const SECRET = "test-secret-do-not-use-in-prod";
const PAYLOAD = {
  jobId: "job_0123456789abcdef01234567",
  nonce: "0f4b8e3c-7a1d-4c2e-9b6f-1d2e3f4a5b6c",
};
const JOB_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

describe("the compute tokens", () => {
  test("a token round-trips, and has the shape the launch specification takes for `job_token`", async () => {
    for (const kind of ["webhook", "job"] as const) {
      const token = await signComputeToken(kind, PAYLOAD, SECRET);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(token).toMatch(JOB_TOKEN_RE);
      expect(await verifyComputeToken(kind, token, PAYLOAD, SECRET)).toBe(true);
    }
  });

  test("a token binds the job, the nonce and the secret", async () => {
    const token = await signComputeToken("job", PAYLOAD, SECRET);
    for (const other of [
      { ...PAYLOAD, jobId: "job_0123456789abcdef01234568" },
      { ...PAYLOAD, nonce: `${PAYLOAD.nonce.slice(0, -1)}d` },
    ]) {
      expect(await verifyComputeToken("job", token, other, SECRET)).toBe(false);
    }
    expect(await verifyComputeToken("job", token, PAYLOAD, `${SECRET}x`)).toBe(false);
    expect(await verifyComputeToken("job", "", PAYLOAD, SECRET)).toBe(false);
    expect(await verifyComputeToken("job", token, PAYLOAD, "")).toBe(false);
    expect(await verifyComputeToken("job", token.slice(1), PAYLOAD, SECRET)).toBe(false);
  });

  test("the webhook token and the job token are different kinds: neither answers for the other", async () => {
    const webhook = await signComputeToken("webhook", PAYLOAD, SECRET);
    const job = await signComputeToken("job", PAYLOAD, SECRET);
    expect(webhook).not.toBe(job);
    expect(await verifyComputeToken("job", webhook, PAYLOAD, SECRET)).toBe(false);
    expect(await verifyComputeToken("webhook", job, PAYLOAD, SECRET)).toBe(false);
    expect(COMPUTE_WEBHOOK_TOKEN_DOMAIN).not.toBe(COMPUTE_JOB_TOKEN_DOMAIN);
  });

  test("each message begins with a tag line no other callback kind begins with, so one secret signs them all", async () => {
    expect(encodeComputeTokenPayload("webhook", PAYLOAD).split("\n")[0]).toBe(
      COMPUTE_WEBHOOK_TOKEN_DOMAIN,
    );
    expect(encodeComputeTokenPayload("job", PAYLOAD).split("\n")[0]).toBe(COMPUTE_JOB_TOKEN_DOMAIN);
    const others = [
      APPROVAL_DISPATCH_TOKEN_DOMAIN,
      IDENTIFIER_REPULL_TOKEN_DOMAIN,
      IDENTIFIER_SCREEN_TOKEN_DOMAIN,
      IDENTIFIER_SWEEP_TOKEN_DOMAIN,
      PR_REVIEW_TOKEN_DOMAIN,
      PUBLICATION_REVIEW_TOKEN_DOMAIN,
      REPULL_DISPATCH_TOKEN_DOMAIN,
    ];
    for (const domain of others) {
      expect(domain).not.toBe(COMPUTE_WEBHOOK_TOKEN_DOMAIN);
      expect(domain).not.toBe(COMPUTE_JOB_TOKEN_DOMAIN);
    }
    // Another kind's token for the very same fields is not ours, in either direction.
    const ours = await signComputeToken("webhook", PAYLOAD, SECRET);
    const review = await signPrReviewCallbackToken(
      { datasetId: PAYLOAD.jobId, reviewId: 1, nonce: PAYLOAD.nonce },
      SECRET,
    );
    const dispatch = await signRepullDispatchToken(
      { dispatchId: 1, datasetId: PAYLOAD.jobId, nonce: PAYLOAD.nonce },
      SECRET,
    );
    const prescreen = await signPrescreenCallbackToken(
      { datasetId: PAYLOAD.jobId, requestId: 1, nonce: PAYLOAD.nonce },
      SECRET,
    );
    for (const other of [review, dispatch, prescreen]) {
      expect(await verifyComputeToken("webhook", other, PAYLOAD, SECRET)).toBe(false);
      expect(await verifyComputeToken("job", other, PAYLOAD, SECRET)).toBe(false);
      expect(other).not.toBe(ours);
    }
  });

  test("a field that could move a line boundary is refused by the signer and never verifies", async () => {
    await expect(signComputeToken("job", { ...PAYLOAD, nonce: "a\nb" }, SECRET)).rejects.toThrow();
    await expect(
      signComputeToken("job", { jobId: "job_x\r", nonce: "n" }, SECRET),
    ).rejects.toThrow();
    const token = await signComputeToken("job", PAYLOAD, SECRET);
    expect(
      await verifyComputeToken("job", token, { ...PAYLOAD, nonce: `${PAYLOAD.nonce}\nx` }, SECRET),
    ).toBe(false);
    await expect(signComputeToken("job", PAYLOAD, "")).rejects.toThrow();
  });
});
