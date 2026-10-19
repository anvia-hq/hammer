import type { Options } from "tsup";

export default {
  // Actions run dist/ directly with no install step, so every dependency is bundled in.
  entry: { index: "src/index.ts", post: "src/post.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  clean: true,
  banner: {
    // Bundled CJS deps call require("process") etc.; ESM output has no
    // require, so provide one or the bundle throws at load on every runner.
    js: 'import { createRequire as __hammerCreateRequire } from "node:module"; const require = __hammerCreateRequire(import.meta.url);',
  },
} satisfies Options;
