import { loadSkills, skill, type SkillSet } from "@anvia/core/skills";

// The SDK's skill tools also include run_skill_script, which executes files. The reviewer is
// read-only (rule 0004), so only the two tools that read markdown are exposed.
const READ_ONLY_SKILL_TOOLS = new Set(["get_skill_instructions", "get_skill_reference"]);

export const SKILL_REVIEW_INSTRUCTIONS = [
  "Skills are available as read-only guidance. Before reading code, call get_skill_instructions once for code-review-and-quality and use it as a lens: its five axes, structural remedies, honesty and dead-code rules.",
  "These rules still decide what is posted. You are read-only: skip anything in a skill that needs running tests, builds, mutation experiments, package managers or editing files, and do not write its checklist, verdict, commit-description or review-speed advice.",
  "Map its labels: Critical is high, an unprefixed Required change is medium, and Optional, Nit and FYI are never findings.",
  "Report a structure or simplicity problem as a maintainability finding only when the skill's presumptive blockers apply or it causes a real defect, and put the concrete restructuring in suggestion or details.",
].join("\n");

export async function loadReviewSkills(directory: string): Promise<SkillSet> {
  const loaded = await loadSkills(skill.local(directory));
  return {
    skills: loaded.skills,
    tools: loaded.tools.filter((tool) => READ_ONLY_SKILL_TOOLS.has(tool.name)),
    instructions: [
      "Available skills (load with get_skill_instructions):",
      ...loaded.skills.map((entry) => `- ${entry.name}: ${entry.description}`),
    ].join("\n"),
  };
}

export type { SkillSet };
