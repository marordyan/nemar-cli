---
name: api-mounted-twice-full-path
description: "nemar-cli backend mounts the api sub-app at both / and /nemar, and Hono gives middleware the FULL request path, so any path-matching middleware must strip the prefix or it silently matches nothing for one spelling"
metadata:
  node_type: memory
  type: project
---

`backend/src/index.ts` does **both** `app.route("/nemar", api)` and `app.route("/", api)`.
Hono's `route()` strips the prefix for ROUTING but middleware registered inside `api`
(`api.use("*", ...)`) still sees `c.req.path` as the FULL original path.

So any middleware that matches on a path literal sees `/nemar/auth/login` for one of the two
live spellings and matches nothing.

**Why:** a rule keyed on a path literal (the per-route limit on the sign-in routes in
`middleware/rateLimit.ts` was one) silently stops applying to anyone who types the prefix, and
nothing fails: the request just falls through to the generic limit. Found reviewing PR #1384
(2026-09-13).

**How to apply:** `__normalizeMountPath` in `middleware/rateLimit.ts` is the fix for that one
middleware, and bucket selection now goes through it. It is NOT applied globally, so a NEW
path-matching middleware has the same trap waiting. Verify empirically rather than reasoning
about Hono's semantics: mount a probe sub-app at both paths, log `c.req.path` from inside it,
and assert both spellings. See [[verify-fix-against-known-broken]] and
[[test-entry-point-not-callee]].
