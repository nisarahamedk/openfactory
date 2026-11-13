import { defineConfig } from "vitest/config";

// The conformance tests start real agent processes. Under a full parallel run their start-up alone can
// pass vitest's 5 s default, so they get a longer budget instead of failing on a busy machine.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
