import { defineConfig } from "vitest/config";

// These tests start an in-process Postgres (PGlite). Under a full parallel run its start-up alone can
// pass vitest's 5 s default, so they get a longer budget instead of failing on a busy machine.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
