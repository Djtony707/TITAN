# Known Issues

Last updated: February 20, 2026

1. Discord command ingest loop is not yet implemented.
Impact: `titan discord status/send` works, but inbound Discord events are not processed.
Workaround: use CLI or web dashboard for goal and approval operations.

2. Skill execution requires host `wasmtime` binary.
Impact: `titan skill run` fails if `wasmtime` is missing.
Workaround: install `wasmtime` and re-run skill commands.

3. Web dashboard is currently local-only and unauthenticated.
Impact: do not expose to public network.
Workaround: bind to loopback (`127.0.0.1`) and use local machine access only.
