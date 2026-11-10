import { access, cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REPO_SKILLS_PATH = ".hammer/skills";
const MAX_SKILLS = 5;
const MAX_REFERENCES = 20;
const MAX_FILE_CHARS = 100_000;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface RepoSkillSource {
  directory(path: string): Promise<Array<{ name: string; type: string }> | undefined>;
  content(path: string): Promise<string | undefined>;
}

export interface RepoSkillsResult {
  directory: string;
  names: string[];
}

function clip(text: string): string {
  return text.slice(0, MAX_FILE_CHARS);
}

function skillName(markdown: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  const match = front === undefined ? null : /^name:\s*["']?([^\r\n"']+?)["']?\s*$/m.exec(front);
  return match?.[1];
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function stageOne(
  source: RepoSkillSource,
  stagingDirectory: string,
  base: string,
  warn: (message: string) => void,
): Promise<string | undefined> {
  const instructions = await source.content(`${base}/SKILL.md`);
  if (instructions === undefined) {
    warn(`Skipping ${base}: no SKILL.md`);
    return undefined;
  }
  const name = skillName(instructions);
  if (name === undefined || !NAME_RE.test(name)) {
    warn(`Skipping ${base}: SKILL.md needs a frontmatter name`);
    return undefined;
  }
  const target = join(stagingDirectory, name);
  if (await exists(target)) {
    warn(`Skipping ${base}: a skill named ${name} already exists`);
    return undefined;
  }
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "SKILL.md"), clip(instructions));
  const references = (await source.directory(`${base}/references`)) ?? [];
  const files = references.filter((ref) => ref.type === "file" && NAME_RE.test(ref.name));
  if (files.length > 0) await mkdir(join(target, "references"), { recursive: true });
  for (const ref of files.slice(0, MAX_REFERENCES)) {
    try {
      const text = await source.content(`${base}/references/${ref.name}`);
      if (text !== undefined) await writeFile(join(target, "references", ref.name), clip(text));
    } catch (error) {
      warn(
        `Skipping ${base}/references/${ref.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return name;
}

export async function stageRepoSkills(
  source: RepoSkillSource,
  bundledDirectory: string,
  stagingDirectory: string,
  warn: (message: string) => void = () => {},
): Promise<RepoSkillsResult> {
  await cp(bundledDirectory, stagingDirectory, { recursive: true });
  const names: string[] = [];
  const entries = (await source.directory(REPO_SKILLS_PATH)) ?? [];
  const candidates = entries.filter((entry) => entry.type === "dir" && NAME_RE.test(entry.name));
  for (const entry of candidates.slice(0, MAX_SKILLS)) {
    const base = `${REPO_SKILLS_PATH}/${entry.name}`;
    try {
      const name = await stageOne(source, stagingDirectory, base, warn);
      if (name !== undefined) names.push(name);
    } catch (error) {
      warn(`Skipping ${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { directory: stagingDirectory, names };
}
