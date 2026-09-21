import { vitestPreset } from "ts-canon/presets/vitest";

// Test files share the repo's data/ and runs/ scratch directories, so they
// run serially to keep CLI end-to-end assertions deterministic.
const config = vitestPreset({ fileParallelism: false });

export { config as default };
