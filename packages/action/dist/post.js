import { createRequire as __hammerCreateRequire } from "node:module"; const require = __hammerCreateRequire(import.meta.url);

// src/post.ts
function post() {
  console.log("[hammer] post step: no temporary files to clean up yet");
}
post();
export {
  post
};
