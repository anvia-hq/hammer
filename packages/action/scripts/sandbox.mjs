import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const repository = process.env.HAMMER_SANDBOX_REPOSITORY ?? "";
const pullNumber = Number(process.env.HAMMER_SANDBOX_PR);
const client = process.env.HAMMER_SANDBOX_CLIENT;
const model = process.env.HAMMER_SANDBOX_MODEL;
const token = process.env.HAMMER_SANDBOX_TOKEN;
const key = process.env.HAMMER_API_KEY;
if (
  !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
  !Number.isSafeInteger(pullNumber) ||
  pullNumber <= 0 ||
  !client ||
  !model ||
  !token ||
  !key ||
  !process.env.RUNNER_TEMP ||
  !process.env.GITHUB_API_URL
)
  throw new Error(
    "Sandbox run needs repository, PR number, client, model, token, API key, RUNNER_TEMP and GITHUB_API_URL.",
  );
const [owner, repo] = repository.split("/");
const dispatcher = new EnvHttpProxyAgent();
setGlobalDispatcher(dispatcher);
const api = new Octokit({ auth: token, baseUrl: process.env.GITHUB_API_URL });
const directory = mkdtempSync(join(process.env.RUNNER_TEMP, "hammer-sandbox-"));
const bundle = join(import.meta.dirname, "..", "dist");
const state = join(directory, "state");
const output = join(directory, "output");
writeFileSync(state, "");
writeFileSync(output, "");
const environment = {
  ...process.env,
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: join(directory, "event.json"),
  GITHUB_OUTPUT: output,
  GITHUB_STATE: state,
  INPUT_CLIENT: client,
  INPUT_MODEL: model,
  "INPUT_API-KEY": key,
  "INPUT_GITHUB-TOKEN": token,
  INPUT_FAIL_ON_ERROR: "true",
  INPUT_FAIL_ON: "none",
};
function commands(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const result = {};
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i].split("<<");
    if (parts.length !== 2) continue;
    const values = [];
    while (++i < lines.length && lines[i] !== parts[1]) values.push(lines[i]);
    result[parts[0]] = values.join("\n");
  }
  return result;
}
try {
  const { data: pr } = await api.pulls.get({ owner, repo, pull_number: pullNumber });
  if (pr.head.repo?.full_name !== pr.base.repo.full_name)
    throw new Error("Use a same-repository PR for the initial sandbox run.");
  writeFileSync(
    environment.GITHUB_EVENT_PATH,
    JSON.stringify({
      action: "opened",
      repository: { name: repo, owner: { login: owner } },
      sender: { login: "hammer-sandbox-tester", type: "User" },
      pull_request: pr,
    }),
  );
  execFileSync(process.execPath, [join(bundle, "index.js")], {
    env: environment,
    stdio: "inherit",
    timeout: 14 * 60_000,
  });
  const values = commands(output);
  if (!values.result_path || !existsSync(values.result_path))
    throw new Error("Action did not emit a review result.");
  const result = JSON.parse(readFileSync(values.result_path, "utf8"));
  if (result.headSha !== pr.head.sha || result.partial)
    throw new Error("Sandbox review was stale or partial.");
  const comments = await api.paginate(api.issues.listComments, {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  if (
    !comments.some(
      (comment) =>
        comment.body?.includes("<!-- hammer:summary -->") &&
        comment.body.includes(`hammer:last-sha=${pr.head.sha}`),
    )
  )
    throw new Error("Sticky summary with the reviewed SHA was not posted.");
  if (Number(values.findings_count) > 0) {
    const reviews = await api.paginate(api.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    if (
      !reviews.some(
        (review) =>
          review.html_url === values.review_url &&
          review.state === "COMMENTED" &&
          review.commit_id === pr.head.sha,
      )
    )
      throw new Error("A COMMENT review pinned to the head SHA was not found.");
  }
  console.log(
    `Sandbox passed: ${repository}#${pullNumber}, ${values.findings_count} findings, ${values.tokens} tokens.`,
  );
} finally {
  const saved = commands(state)["review-directory"];
  if (saved)
    execFileSync(process.execPath, [join(bundle, "post.js")], {
      env: { ...environment, "STATE_review-directory": saved },
      stdio: "inherit",
    });
  rmSync(directory, { recursive: true, force: true });
  await dispatcher.close();
}
