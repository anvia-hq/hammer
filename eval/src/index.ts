import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createCompletionModel,
  loadReviewSkills,
  parseModelRefWithBase,
} from "@anvia/hammer-agents";
import { oracleReviewer, runEval } from "./runner";
import { runLiveEval } from "./live";
import { createLlmJudge } from "./judge";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    "base-url": { type: "string" },
    "judge-model": { type: "string" },
    "judge-base-url": { type: "string" },
    "no-verify": { type: "boolean" },
    "no-skills": { type: "boolean" },
    "no-native-json-schema": { type: "boolean" },
    concurrency: { type: "string", default: "1" },
    "reports-dir": { type: "string" },
  },
});
const casesRoot = join(import.meta.dirname, "..", "cases");

function model(ref: string, key: string | undefined, baseUrl?: string) {
  if (!key)
    throw new Error(
      "Live evaluation requires HAMMER_API_KEY and, when judging, HAMMER_JUDGE_API_KEY in the environment.",
    );
  const parsed = parseModelRefWithBase(ref, baseUrl);
  if (!parsed.ok) throw new Error(parsed.issues.map((issue) => issue.message).join("; "));
  return createCompletionModel(parsed.value, {
    apiKey: key,
    nativeJsonSchema: !values["no-native-json-schema"],
  });
}

try {
  if (values.model) {
    const reviewer = model(values.model, process.env.HAMMER_API_KEY, values["base-url"]);
    const judgeRef = values["judge-model"];
    const judge = judgeRef
      ? createLlmJudge({
          reviewerModel: values.model,
          judgeModel: judgeRef,
          model: model(judgeRef, process.env.HAMMER_JUDGE_API_KEY, values["judge-base-url"]),
        })
      : undefined;
    const result = await runLiveEval({
      casesRoot,
      reportsDir: resolve(values["reports-dir"] ?? join(casesRoot, "..", "reports", "live")),
      modelRef: values.model,
      model: reviewer,
      ...(values["no-skills"]
        ? {}
        : { skills: await loadReviewSkills(join(casesRoot, "..", "..", "skills")) }),
      verify: !values["no-verify"],
      concurrency: Number(values.concurrency),
      ...(judge ? { judge, judgeModel: judgeRef! } : {}),
      ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
      onCase: (id) => console.log(`reviewing ${id}`),
    });
    console.log(
      `live model: precision ${(result.totals.precision * 100).toFixed(1)}%, high-severity recall ${(result.totals.recallHigh * 100).toFixed(1)}%, gate ${result.passed ? "PASS" : "FAIL"}`,
    );
    if (!result.passed) process.exitCode = 1;
  } else {
    const { totals, scored } = await runEval(casesRoot, oracleReviewer);
    console.log(
      `offline oracle: ${totals.passed}/${totals.cases} passed, precision ${(totals.precision * 100).toFixed(1)}%, high-severity recall ${(totals.recallHigh * 100).toFixed(1)}%`,
    );
    if (scored.some((score) => !score.pass)) process.exitCode = 1;
  }
} catch {
  console.error(
    "Evaluation could not start. Check model references and the HAMMER_API_KEY / HAMMER_JUDGE_API_KEY environment variables.",
  );
  process.exitCode = 1;
}
