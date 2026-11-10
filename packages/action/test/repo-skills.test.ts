import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stageRepoSkills, type RepoSkillSource } from "../src/repo-skills";

const bundled = join(import.meta.dirname, "..", "..", "..", "skills");

function source(files: Record<string, string>): RepoSkillSource {
  return {
    directory: async (path) => {
      const prefix = `${path}/`;
      const children = new Map<string, string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const [head] = rest.split("/");
        children.set(head!, rest.includes("/") ? "dir" : "file");
      }
      return children.size === 0
        ? undefined
        : [...children].map(([name, type]) => ({ name, type }));
    },
    content: async (path) => files[path],
  };
}

const skill = (name: string) => `---\nname: ${name}\ndescription: d\n---\nBody`;

describe("stageRepoSkills", () => {
  it("stages the skill by its frontmatter name with its references, next to the bundled ones", async () => {
    const staging = join(await mkdtemp(join(tmpdir(), "hammer-skills-")), "skills");
    const result = await stageRepoSkills(
      source({
        ".hammer/skills/dir/SKILL.md": skill("billing"),
        ".hammer/skills/dir/references/rules.md": "Rules",
      }),
      bundled,
      staging,
    );
    expect(result.names).toEqual(["billing"]);
    expect(await readdir(staging)).toEqual(
      expect.arrayContaining(["billing", "code-review-and-quality"]),
    );
    expect(await readFile(join(staging, "billing", "references", "rules.md"), "utf8")).toBe(
      "Rules",
    );
  });

  it("returns nothing when the repository has no skills", async () => {
    const staging = join(await mkdtemp(join(tmpdir(), "hammer-skills-")), "skills");
    expect((await stageRepoSkills(source({}), bundled, staging)).names).toEqual([]);
  });

  it("never replaces a bundled skill and skips unusable ones", async () => {
    const staging = join(await mkdtemp(join(tmpdir(), "hammer-skills-")), "skills");
    const warnings: string[] = [];
    const result = await stageRepoSkills(
      source({
        ".hammer/skills/a/SKILL.md": skill("code-review-and-quality"),
        ".hammer/skills/b/SKILL.md": "no frontmatter",
        ".hammer/skills/c/SKILL.md": skill("../escape"),
        ".hammer/skills/d/notes.md": "x",
      }),
      bundled,
      staging,
      (message) => warnings.push(message),
    );
    expect(result.names).toEqual([]);
    expect(warnings).toHaveLength(4);
    expect(await readFile(join(staging, "code-review-and-quality", "SKILL.md"), "utf8")).not.toBe(
      skill("code-review-and-quality"),
    );
  });
});

describe("stageRepoSkills robustness", () => {
  it("reads only a frontmatter name, not one in the body", async () => {
    const staging = join(await mkdtemp(join(tmpdir(), "hammer-skills-")), "skills");
    const result = await stageRepoSkills(
      source({ ".hammer/skills/a/SKILL.md": "---\ndescription: d\n---\nname: sneaky\n" }),
      bundled,
      staging,
      () => {},
    );
    expect(result.names).toEqual([]);
  });

  it("skips only the file that cannot be read", async () => {
    const staging = join(await mkdtemp(join(tmpdir(), "hammer-skills-")), "skills");
    const files = {
      ".hammer/skills/a/SKILL.md": skill("good"),
      ".hammer/skills/a/references/big.md": "x",
      ".hammer/skills/a/references/ok.md": "ok",
      ".hammer/skills/b/SKILL.md": skill("bad"),
    };
    const base = source(files);
    const warnings: string[] = [];
    const result = await stageRepoSkills(
      {
        directory: base.directory,
        content: async (path) => {
          if (path.endsWith("big.md") || path.includes("/b/")) throw new Error("too large");
          return base.content(path);
        },
      },
      bundled,
      staging,
      (message) => warnings.push(message),
    );
    expect(result.names).toEqual(["good"]);
    expect(await readFile(join(staging, "good", "references", "ok.md"), "utf8")).toBe("ok");
    expect(warnings).toHaveLength(2);
  });
});
