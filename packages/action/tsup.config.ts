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
} satisfies Options;
