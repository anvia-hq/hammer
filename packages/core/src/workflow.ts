import { parse as parseYaml } from "yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cancels(concurrency: unknown): boolean {
  if (!isRecord(concurrency)) return false;
  const value = concurrency["cancel-in-progress"];
  return value === true || (typeof value === "string" && value.includes("${{"));
}

export function cancelsInProgress(workflow: string): boolean | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(workflow);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (cancels(parsed.concurrency)) return true;
  const jobs = parsed.jobs;
  if (!isRecord(jobs)) return undefined;
  return Object.values(jobs).some((job) => isRecord(job) && cancels(job.concurrency));
}
