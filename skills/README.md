# Skills

Agent Skills that Hammer loads through `@anvia/core/skills` and gives the reviewer as read-only guidance. See [decision 0012](../docs/decision/0012-review-skills.md).

| Skill                                                       | Source                                                                                                                                                      | License |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| [code-review-and-quality](code-review-and-quality/SKILL.md) | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills/blob/aeac41d4d005999432bb7312f7ff06383a91d59d/skills/code-review-and-quality/SKILL.md) | MIT     |

`code-review-and-quality/SKILL.md` is vendored unmodified from the commit above. Hammer's adaptations (severity mapping, what to skip because the agent is read-only) live in the reviewer prompt, not in the skill file. To update it, copy the new upstream file, update the commit link here, and re-run the evals.
