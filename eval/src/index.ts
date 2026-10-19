import { join } from "node:path";

import { oracleReviewer, runEval } from "./runner";

const casesRoot = join(import.meta.dirname, "..", "cases");

const { totals, scored } = await runEval(casesRoot, oracleReviewer);
const failed = scored.filter((s) => !s.pass).map((s) => s.caseId);

console.log(
  `offline oracle: ${totals.passed}/${totals.cases} passed, ` +
    `precision ${(totals.precision * 100).toFixed(1)}%, ` +
    `high-severity recall ${(totals.recallHigh * 100).toFixed(1)}%`,
);
if (failed.length > 0) {
  console.error(`failing cases: ${failed.join(", ")}`);
  process.exit(1);
}
