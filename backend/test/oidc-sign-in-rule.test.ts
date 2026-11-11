/**
 * The client's sign-in rule (ADR 0119 rule 7), stated twice in `services/oidc-identity.ts`: as SQL
 * every statement that mints repeats (`SIGN_IN_RULE_SQL`), and as the function the routes ask so the
 * person is told why (`signInRuleRefusal`). The two must agree on every account, or a person is told
 * they may sign in and then mints nothing, or the other way round.
 *
 * One table, every combination: rule x status x deleted x kind x proven iD, each row real in
 * bun:sqlite with every migration, each answer from the real statement and the real function.
 */

import { describe, expect, test } from "bun:test";
import { ACCOUNT_COPY } from "../../shared/contract/account-copy";
import { OIDC_SCOPES, type OidcSignInRule } from "../../shared/oidc";
import {
  ORCID_PROVEN_SQL,
  SIGN_IN_RULE_SQL,
  type SignInSubject,
  signInRuleRefusal,
} from "../src/services/oidc-identity";
import { freshDb } from "./helpers/d1";

const RULES: OidcSignInRule[] = ["active_account", "person_proven_orcid"];
const STATUSES = ["pending", "verified", "approved", "revoked"];
const KINDS = ["person", "service", "test"];

describe("SIGN_IN_RULE_SQL and signInRuleRefusal agree", () => {
  test("on every rule, status, deletion, kind and proof", () => {
    const db = freshDb();
    const clients = new Map<OidcSignInRule, number>();
    for (const rule of RULES) {
      db.run(
        `INSERT INTO oidc_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes,
           allowed_grants, sign_in_rule, first_party, consent_mode, audience, created_by)
         VALUES (?, ?, ?, '["https://x.example/cb"]', '["openid"]', '["authorization_code"]', ?, 0,
                 'ask_once', 'https://api.example.org', 1)`,
        [
          `oc_${rule === "active_account" ? "a" : "b"}${"0".repeat(23)}`,
          rule,
          "0".repeat(64),
          rule,
        ],
      );
      clients.set(
        rule,
        db.query<{ id: number }, [string]>("SELECT id FROM oidc_clients WHERE name = ?").get(rule)
          ?.id as number,
      );
    }

    let n = 0;
    const disagreements: string[] = [];
    for (const status of STATUSES) {
      for (const deleted of [false, true]) {
        for (const kind of KINDS) {
          for (const proven of [false, true]) {
            n += 1;
            const orcid = `0000-0002-1825-${String(n).padStart(4, "0")}`;
            db.run(
              `INSERT INTO users (email, status, email_verified, account_kind, orcid, orcid_verified,
                                  deleted_at)
               VALUES (?, ?, 1, ?, ?, 1, ?)`,
              [`rule${n}@example.org`, status, kind, orcid, deleted ? "2026-01-01 00:00:00" : null],
            );
            const userId = db
              .query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?")
              .get(`rule${n}@example.org`)?.id as number;
            if (proven) {
              db.run(
                "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
                [userId, orcid],
              );
            }
            const subject = db
              .query<SignInSubject, [number]>(
                `SELECT u.status, u.deleted_at, u.account_kind, ${ORCID_PROVEN_SQL} AS orcid_proven
                   FROM users u WHERE u.id = ?`,
              )
              .get(userId) as SignInSubject;
            for (const rule of RULES) {
              const sql = db
                .query<{ ok: number }, [number, number]>(
                  `SELECT ${SIGN_IN_RULE_SQL} AS ok FROM users u, oidc_clients c
                    WHERE u.id = ? AND c.id = ?`,
                )
                .get(userId, clients.get(rule) as number)?.ok;
              const ts = signInRuleRefusal(rule, subject) === null ? 1 : 0;
              const row = `${rule} ${status} deleted=${deleted} ${kind} proven=${proven}`;
              if (sql !== ts) disagreements.push(`${row}: SQL ${sql}, refusal says ${ts}`);
              // And each is right: only an active, undeleted account; for the stricter rule, only a
              // person whose iD has a sign-in record.
              const active = (status === "verified" || status === "approved") && !deleted;
              const expected =
                active && (rule === "active_account" || (kind === "person" && proven));
              if (ts !== (expected ? 1 : 0)) disagreements.push(`${row}: expected ${expected}`);
            }
          }
        }
      }
    }
    expect(n).toBe(STATUSES.length * 2 * KINDS.length * 2);
    expect(disagreements).toEqual([]);
  });
});

describe("the consent screen has a sentence for every scope a person can grant", () => {
  test("every scope that is not machine-only has its line, and no machine-only scope has one", () => {
    for (const scope of OIDC_SCOPES) {
      const key = `oidc.consent.scope.${scope.name}`;
      expect({ scope: scope.name, has: key in ACCOUNT_COPY }).toEqual({
        scope: scope.name,
        has: !scope.machineOnly,
      });
    }
  });
});
