import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import {
  buildActionOutputs,
  buildReviewPlan,
  decideEvent,
  decideExitCode,
  decideSkip,
  extractLastSha,
  type PriceCatalog,
  fetchGatewayCatalog,
  fetchPullFiles,
  formatReviewEvent,
  initialProgress,
  loadConfig,
  parsePriorFingerprints,
  sanitizeForPosting,
  redactSecrets,
  renderJobSummaryMarkdown,
  resolveConfig,
  resolvePricing,
  SUMMARY_MARKER,
} from "@anvia/hammer-core";
import {
  createCompletionModel,
  loadReviewSkills,
  parseModelRefWithBase,
  readFile as readCheckoutFile,
  runReviewPipeline,
  type PromptGuidelines,
  type ReviewPipelineInput,
} from "@anvia/hammer-agents";
import { checkoutHead } from "./checkout";
import { GitHub, proxiedFetch, type GitHubPort, type IssueComment } from "./github";
import { configOverrides, readInputs, type ActionInputs } from "./inputs";
import { createProgressReporter, type ProgressReporter } from "./progress";
import { publishReview, writeProgress, writeSummary, type PublishTarget } from "./publish";

export interface ActionRuntime {
  getInput(name: string): string;
  setSecret(value: string): void;
  setOutput(name: string, value: string): void;
  saveState(name: string, value: string): void;
  info(message: string): void;
  notice(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
  summary(markdown: string): Promise<void>;
}
export interface ActionDependencies {
  github?: GitHubPort;
  model?: ReviewPipelineInput["model"];
  checkout?: typeof checkoutHead;
  skillsDirectory?: string;
  fetchPricing?: (baseUrl: string, apiKey: string) => Promise<PriceCatalog>;
}
const DEFAULT_SKILLS_DIRECTORY = fileURLToPath(new URL("../../../skills", import.meta.url));
const eventSchema = z
  .object({
    sender: z.object({ login: z.string(), type: z.string() }).optional(),
    comment: z.object({ id: z.number().int().positive() }).passthrough().optional(),
  })
  .passthrough();

export async function runAction(
  runtime: ActionRuntime,
  env: NodeJS.ProcessEnv,
  dependencies: ActionDependencies = {},
): Promise<void> {
  let inputs: ActionInputs | undefined;
  let github: GitHubPort | undefined;
  let target: PublishTarget | undefined;
  let comments: IssueComment[] = [];
  let identity = "";
  let progress: ProgressReporter | undefined;
  const cleanError = (error: unknown): string => {
    let message =
      error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
    for (const name of ["api-key", "github-token"]) {
      const value = runtime.getInput(name);
      if (value) message = message.split(value).join("[redacted]");
    }
    return redactSecrets(message);
  };
  const skip = async (reason: string): Promise<void> => {
    runtime.notice(`[hammer] ${reason}`);
    await runtime.summary(renderJobSummaryMarkdown({ skipped: { reason } }));
    for (const [key, value] of Object.entries(buildActionOutputs({ findings: [] })))
      runtime.setOutput(key, value);
  };
  try {
    if (env.GITHUB_EVENT_NAME !== "pull_request" && env.GITHUB_EVENT_NAME !== "issue_comment") {
      await skip(`event ${env.GITHUB_EVENT_NAME ?? "unknown"} is not a review trigger`);
      return;
    }
    for (const name of ["api-key", "github-token"]) {
      const secret = runtime.getInput(name);
      if (secret) runtime.setSecret(secret);
    }
    inputs = readInputs(runtime.getInput);
    const eventPath = z.string().min(1).parse(env.GITHUB_EVENT_PATH);
    const payload = eventSchema.parse(JSON.parse(await readFile(eventPath, "utf8")));
    github =
      dependencies.github ?? new GitHub(inputs["github-token"], z.url().parse(env.GITHUB_API_URL));
    const decision = await decideEvent({
      eventName: env.GITHUB_EVENT_NAME,
      payload,
      reviewDrafts: true,
      getPermission: ({ owner, repo, username }) => github!.permission(owner, repo, username),
    });
    runtime.info(decision.log);
    if (!decision.run) {
      if (decision.reason === "insufficient_permission" && payload.comment)
        await github.react(
          z.string().parse((payload.repository as { owner?: { login?: string } })?.owner?.login),
          z.string().parse((payload.repository as { name?: string })?.name),
          payload.comment.id,
        );
      await skip(decision.message);
      return;
    }
    const { owner, repo, prNumber } = decision;
    const pr = await github.pull(owner, repo, prNumber);
    if (pr.state !== "open") {
      await skip("pull request is closed");
      return;
    }
    const fork = pr.head.repo?.full_name !== pr.base.repo.full_name;
    if (decision.kind === "pull_request" && fork) {
      await skip(
        "Fork PRs are reviewed on a maintainer's /hammer review command; no automatic review is run.",
      );
      return;
    }
    if (decision.kind === "pull_request" && decision.headSha && decision.headSha !== pr.head.sha) {
      await skip("A newer head commit has superseded this event.");
      return;
    }
    target = {
      owner,
      repo,
      number: prNumber,
      headSha: pr.head.sha,
      repoUrl: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${owner}/${repo}`,
    };
    identity = await github.identity();
    comments = await github.comments(owner, repo, prNumber);
    if (
      decision.kind === "comment" &&
      decision.command.toLowerCase().split(/\s/, 1)[0] === "help"
    ) {
      await github.createComment(
        owner,
        repo,
        prNumber,
        "Hammer commands: /hammer review — review the whole PR; /hammer review <instruction> — focus the review; /hammer help — show this help. Commands require write access.",
      );
      return;
    }
    const rawConfig = await github.content(owner, repo, inputs["config-path"], pr.base.sha);
    const config = resolveConfig(
      loadConfig(rawConfig, { source: inputs["config-path"], onWarning: runtime.warning }),
      configOverrides(inputs),
    );
    if (pr.draft && !config.review_drafts) {
      await skip("pull request is a draft and review_drafts is off");
      return;
    }
    const mergeFromBase =
      decision.kind === "pull_request" &&
      decision.action === "synchronize" &&
      (await github.parents(owner, repo, pr.head.sha)).slice(1).includes(pr.base.sha);
    const skipped = decideSkip({
      labels: pr.labels.map((label) => label.name),
      title: pr.title,
      authorLogin: pr.user.login,
      sender: payload.sender ?? { login: "unknown" },
      isMergeFromBase: mergeFromBase,
      remainingFileCount: 1,
      ignoreAuthors: config.ignore_authors,
    });
    if (skipped.skip) {
      await skip(skipped.reason ?? "review skipped");
      return;
    }
    if (!inputs["api-key"]) throw new Error("API key missing or rejected.");
    const modelRef = `${inputs.client}/${inputs.model}`;
    const ref = parseModelRefWithBase(modelRef, inputs["base-url"]);
    if (!ref.ok) throw new Error(ref.issues.map((issue) => issue.message).join("; "));
    if (inputs["lens-endpoint"] || inputs["otel-endpoint"])
      throw new Error("Tracing endpoints are not wired yet; omit them for this preview.");
    let files = await fetchPullFiles((page, perPage) =>
      github!.files(owner, repo, prNumber, page, perPage),
    );
    const anchorFiles = files;
    const lastSha = comments
      .filter((comment) => comment.user?.login === identity)
      .find((comment) => comment.body?.includes(SUMMARY_MARKER))?.body;
    if (decision.kind === "pull_request" && decision.action === "synchronize" && lastSha) {
      const sha = extractLastSha(lastSha);
      if (sha === pr.head.sha) {
        await skip("this head commit was already reviewed");
        return;
      }
      if (sha) {
        try {
          const comparison = await github.compare(owner, repo, sha, pr.head.sha);
          if (comparison.ancestor && comparison.files.length < 300) files = comparison.files;
        } catch {
          runtime.warning("Incremental comparison failed; reviewing the full PR.");
        }
      }
    }
    const plan = buildReviewPlan(files, {
      ignore: config.ignore,
      include: config.include,
      maxFiles: config.max_files,
      maxDiffLines: config.max_diff_lines,
    });
    if (pr.changed_files > 3000) {
      plan.partial = true;
      plan.notReviewed.push({
        path: "(additional files)",
        reason: "GitHub's 3,000-file API limit",
      });
    }
    if (!plan.reviewFiles.length && !plan.notReviewed.length) {
      await skip("no files remain after filtering");
      return;
    }
    const temp = z.string().min(1).parse(env.RUNNER_TEMP);
    await mkdir(temp, { recursive: true });
    const directory = await mkdtemp(join(temp, "hammer-review-"));
    runtime.saveState("review-directory", directory);
    const runUrl =
      env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined;
    const progressTarget = target;
    const progressGithub = github;
    const secrets = [inputs["api-key"], inputs["github-token"]];
    progress = createProgressReporter({
      state: initialProgress({
        files: plan.reviewFiles.length,
        verify: config.verify,
        runUrl,
        lastSha: extractLastSha(lastSha ?? ""),
      }),
      write: (body) =>
        writeProgress(progressGithub, progressTarget, comments, identity, body, secrets),
      warn: runtime.warning,
    });
    await progress.start();
    const checkout = join(directory, "head");
    await (dependencies.checkout ?? checkoutHead)(
      {
        directory: checkout,
        repositoryUrl: pr.base.repo.clone_url,
        headSha: pr.head.sha,
        token: inputs["github-token"],
      },
      () => github!.archive(owner, repo, pr.head.sha),
      env,
    );
    const guidelines: PromptGuidelines = {};
    if (config.use_repo_guidelines)
      for (const [path, key] of [
        ["AGENTS.md", "agentsMd"],
        ["CLAUDE.md", "claudeMd"],
        ["CONTRIBUTING.md", "contributingMd"],
      ] as const) {
        const value = await github.content(owner, repo, path, pr.base.sha);
        if (value !== undefined) guidelines[key] = value;
      }
    const fileContents: Record<string, string> = {};
    for (const file of plan.reviewFiles) {
      const content = await readCheckoutFile(checkout, file.filename);
      if (content.ok) fileContents[file.filename] = content.text.replace(/^\d+: /gm, "");
    }
    const prior = (await github.reviewComments(owner, repo, prNumber)).filter(
      (comment) => comment.user?.login === identity && comment.body?.includes("<!-- hammer:fp="),
    );
    const instruction =
      decision.kind === "comment" ? decision.command.replace(/^review\s*/i, "") : "";
    const gatewayCatalog =
      ref.value.provider === "openai-compatible" && inputs["base-url"]
        ? await (
            dependencies.fetchPricing ??
            ((baseUrl, apiKey) => fetchGatewayCatalog(baseUrl, apiKey, proxiedFetch))
          )(inputs["base-url"], inputs["api-key"])
        : undefined;
    const pricing = resolvePricing(modelRef, inputs.pricing || undefined, gatewayCatalog);
    const skills = await loadReviewSkills(
      dependencies.skillsDirectory ?? DEFAULT_SKILLS_DIRECTORY,
    ).catch((error: unknown) => {
      runtime.warning(`Review skills unavailable; continuing without them: ${cleanError(error)}`);
      return undefined;
    });
    if (skills?.skills.length)
      runtime.info(`[hammer] skills: ${skills.skills.map((entry) => entry.name).join(", ")}`);
    const result = await runReviewPipeline({
      title: pr.title,
      body: pr.body,
      files: plan.reviewFiles,
      anchorFiles,
      config,
      ...(pricing ? { pricing } : {}),
      guidelines,
      fileContents,
      instruction,
      checkoutRoot: checkout,
      discussion: {
        title: pr.title,
        body: pr.body,
        comments: comments
          .slice(-20)
          .map((comment) => ({ author: comment.user?.login ?? "unknown", body: comment.body })),
      },
      modelRef,
      onEvent: (event) => {
        runtime.info(formatReviewEvent(event));
        progress?.onEvent(event);
      },
      ...(skills ? { skills } : {}),
      ...(inputs["base-url"] ? { baseUrl: inputs["base-url"] } : {}),
      ...(inputs["reasoning-effort"] ? { reasoningEffort: inputs["reasoning-effort"] } : {}),
      model:
        dependencies.model ??
        createCompletionModel(ref.value, {
          apiKey: inputs["api-key"],
          nativeJsonSchema: inputs["native-json-schema"],
        }),
      priorFingerprints: parsePriorFingerprints(prior.map((comment) => comment.body ?? "")),
      prior: prior.map((comment) => ({
        path: comment.path,
        line: comment.line ?? comment.original_line ?? 1,
        title: "Previous finding",
        body: comment.body ?? "",
      })),
    });
    await progress.settle();
    const current = await github.pull(owner, repo, prNumber);
    if (
      current.head.sha !== target.headSha ||
      current.base.sha !== pr.base.sha ||
      current.state !== "open"
    ) {
      await skip("pull request changed while reviewing; discarding stale results");
      return;
    }
    const published = await publishReview(
      github,
      target,
      comments,
      identity,
      plan,
      result,
      modelRef,
      [inputs["api-key"], inputs["github-token"]],
    );
    const resultPath = join(directory, "result.json");
    await writeFile(
      resultPath,
      `${JSON.stringify({ ...result, findings: published.findings, headSha: target.headSha }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const outputs = buildActionOutputs({
      findings: published.findings,
      tokens: result.usage.tokens,
      costUsd: result.usage.costUsd,
      resultPath,
      reviewUrl: published.reviewUrl,
    });
    for (const [key, value] of Object.entries(outputs)) runtime.setOutput(key, value);
    await runtime.summary(
      renderJobSummaryMarkdown({
        postedInline: published.postedInline,
        generalNotes: result.generalNotes.length,
        filesReviewed: plan.reviewFiles.map((file) => file.filename),
        filesNotReviewed: plan.notReviewed,
        tokens: result.usage.tokens,
        costUsd: result.usage.costUsd,
        partial: plan.partial || result.partial,
        modelSummary: sanitizeForPosting(result.summary, {
          secrets: [inputs["api-key"], inputs["github-token"]],
        }),
      }),
    );
    const gate = decideExitCode({
      failOn: config.fail_on,
      findings: published.findings,
      failOnError: inputs.fail_on_error,
      errored: result.failedBatches.length > 0,
    });
    if (gate.ok && gate.exitCode) runtime.setFailed(gate.reason);
  } catch (error) {
    await progress?.settle();
    const message = cleanError(error);
    runtime.warning(`[hammer] ${message}`);
    await runtime.summary(renderJobSummaryMarkdown({ error: message }));
    if (github && target && identity) {
      const runUrl =
        env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
          ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
          : undefined;
      try {
        await writeSummary(
          github,
          target,
          comments,
          identity,
          { files: [], error: message, ...(runUrl ? { runUrl } : {}) },
          [runtime.getInput("api-key"), runtime.getInput("github-token")],
        );
      } catch (postError) {
        runtime.warning(`Could not publish error summary: ${cleanError(postError)}`);
      }
    }
    for (const [key, value] of Object.entries(buildActionOutputs({ findings: [] })))
      runtime.setOutput(key, value);
    if (inputs?.fail_on_error ?? runtime.getInput("fail_on_error") === "true")
      runtime.setFailed(message);
  }
}
