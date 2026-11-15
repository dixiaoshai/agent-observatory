# Synthetic Trace protocol fixtures

`protocol/` contains a byte-for-byte snapshot of the synthetic JSON protocol fixtures and manifest from the monorepo's `agent-trace/fixtures/protocol/`. They contain no real user sessions. This copy makes the complete Journal test suite runnable without the Trace package. Missing fixtures are a test failure, not a skipped success.

When the Trace protocol fixtures change, compare/update this copy deliberately and run the Journal suite and cross-module protocol tests. The original generator belongs to Trace and is not needed to run Journal tests.
