import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "hammer-http-smoke-"));
const head = "a".repeat(40),
  base = "b".repeat(40);
const calls = [];
const tar = pack();
tar.entry({ name: "repo-sha/src/a.ts" }, "function get(user) {\n  return user.name;\n}\n");
tar.finalize();
const chunks = [];
for await (const chunk of tar) chunks.push(chunk);
const archive = gzipSync(Buffer.concat(chunks));
let origin;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    const path = url.pathname.replace(/^\/api\/v3/, "");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: request.method, path, body });
    const json = (value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const repo = { full_name: "acme/sandbox", clone_url: `${origin}/acme/sandbox.git` };
    if (path === "/user") return json({ login: "github-actions[bot]", type: "Bot" });
    if (path === "/repos/acme/sandbox/pulls/7")
      return json({
        number: 7,
        state: "open",
        title: "Update user lookup",
        body: "Review data",
        draft: false,
        user: { login: "contributor", type: "User" },
        labels: [],
        changed_files: 1,
        head: { sha: head, repo },
        base: { sha: base, repo },
      });
    if (path === "/repos/acme/sandbox/pulls/7/files")
      return json([
        {
          filename: "src/a.ts",
          sha: head,
          status: "modified",
          additions: 1,
          deletions: 1,
          changes: 2,
          patch:
            "@@ -1,3 +1,3 @@\n function get(user) {\n-  return user?.name;\n+  return user.name;\n }",
        },
      ]);
    if (path.includes("/contents/")) return json({ message: "Not found" }, 404);
    if (path.endsWith(`/tarball/${head}`)) {
      response.writeHead(200, { "content-type": "application/gzip" });
      return response.end(archive);
    }
    if (path === "/v1/chat/completions")
      return json({
        id: "completion-1",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "Updates lookup",
                findings: [
                  {
                    path: "src/a.ts",
                    line: 2,
                    severity: "high",
                    category: "correctness",
                    title: "Null dereference",
                    body: "Null user crashes. Guard before accessing name.",
                    confidence: 0.95,
                  },
                ],
                generalNotes: [],
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    if (request.method === "POST" && path === "/repos/acme/sandbox/pulls/7/reviews")
      return json({ html_url: `${origin}/review/1` });
    if (path === "/repos/acme/sandbox/issues/7/comments")
      return json(request.method === "POST" ? { id: 2 } : []);
    if (path === "/repos/acme/sandbox/pulls/7/comments") return json([]);
    return json({ message: `Unexpected route ${path}` }, 500);
  } catch {
    response.writeHead(500);
    response.end("fixture error");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
const output = join(directory, "output"),
  state = join(directory, "state"),
  summary = join(directory, "summary"),
  event = join(directory, "event.json");
for (const path of [output, state, summary]) await writeFile(path, "");
await writeFile(
  event,
  JSON.stringify({
    action: "opened",
    repository: { owner: { login: "acme" }, name: "sandbox" },
    sender: { login: "contributor", type: "User" },
    pull_request: { number: 7, head: { sha: head }, draft: false },
  }),
);
const env = {
  ...process.env,
  PATH: "",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: event,
  GITHUB_API_URL: `${origin}/api/v3`,
  GITHUB_SERVER_URL: origin,
  GITHUB_OUTPUT: output,
  GITHUB_STATE: state,
  GITHUB_STEP_SUMMARY: summary,
  RUNNER_TEMP: directory,
  INPUT_MODEL: "openai-compatible/test-model",
  "INPUT_BASE-URL": `${origin}/v1`,
  "INPUT_API-KEY": "bundle-test-model-key",
  "INPUT_GITHUB-TOKEN": "bundle-test-github-token",
  INPUT_VERIFY: "false",
  INPUT_FAIL_ON_ERROR: "true",
};
const bundle = join(import.meta.dirname, "..", "dist");
try {
  await execute(process.execPath, [join(bundle, "index.js")], { env, timeout: 30_000 });
  const values = await readFile(output, "utf8");
  const resultPath = /^result_path<<[^\n]+\n([^\n]+)/m.exec(values)?.[1];
  assert.ok(resultPath, "missing result output");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(result.headSha, head);
  assert.equal(result.findings.length, 1);
  assert.equal(result.usage.tokens, 30);
  const review = calls.find((call) => call.method === "POST" && call.path.endsWith("/reviews"));
  assert.equal(review.body.event, "COMMENT");
  assert.equal(review.body.commit_id, head);
  assert.match(review.body.comments[0].body, /<!-- hammer:fp=/);
  const sticky = calls.find(
    (call) => call.method === "POST" && call.path.endsWith("/issues/7/comments"),
  );
  assert.ok(sticky.body.body.includes(`hammer:last-sha=${head}`));
  assert.ok(calls.some((call) => call.path === "/v1/chat/completions"));
  assert.ok(calls.some((call) => call.path.endsWith(`/tarball/${head}`)));
  const saved = /^review-directory<<[^\n]+\n([^\n]+)/m.exec(await readFile(state, "utf8"))?.[1];
  assert.ok(saved);
  await execute(process.execPath, [join(bundle, "post.js")], {
    env: { ...env, "STATE_review-directory": saved },
  });
  await assert.rejects(readFile(resultPath));
  console.log(
    "review smoke ok: bundled action, real provider adapter, HTTP APIs, archive fallback, pinned review, summary, outputs, cleanup",
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
