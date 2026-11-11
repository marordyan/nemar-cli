---
name: api-hosts-block-python-urllib-ua
description: api.nemar.org and zarr.nemar.org return 403 to the Python-urllib User-Agent only; requests, httpx, curl, empty UA all pass
metadata:
  type: project
---

Verified 2026-09-08: `User-Agent: Python-urllib/3.x` gets HTTP 403 from both `api.nemar.org`
and `zarr.nemar.org`; `python-requests`, `python-httpx`, `curl`, `aiohttp`, `Go-http-client`,
`node`, and an empty UA all get 200. The block is not in Worker code.

**Why:** A urllib-based probe (including my own survey script) reports a false outage,
and a Python agent using stdlib urllib is silently locked out of the "for agents" surfaces.

**How to apply:** Always send a named UA when probing from Python. Treat the rule as an open
question for the MCP / agent-readiness design (#1065, #1063 UA convention), not as a bug in the Worker.
