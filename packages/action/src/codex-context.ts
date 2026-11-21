import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { PullFileEntry } from "@anvia/hammer-core";
import type { PrDiscussionInput, PrMeta } from "@anvia/hammer-agents";

export const CODEX_CONTEXT_ENV = "HAMMER_CODEX_CONTEXT";
export const CODEX_CONTEXT_FILE_NAME = "codex-tools.json";

// The MCP server runs in its own process, so the reviewer's tool context travels through this file
// instead of the Codex environment: the checkout root, the reviewed files and their contents, the
// PR and its discussion, and where the read-only skill tools read from.
const fileSchema = z
  .object({
    sha: z.string(),
    filename: z.string(),
    status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    patch: z.string().optional(),
    previous_filename: z.string().optional(),
  })
  .strict();

const contextSchema = z
  .object({
    checkoutRoot: z.string(),
    files: z.array(fileSchema),
    fileContents: z.record(z.string(), z.string()).default({}),
    pr: z
      .object({ title: z.string(), baseRef: z.string().optional(), headRef: z.string().optional() })
      .strict(),
    discussion: z
      .object({
        title: z.string().optional(),
        body: z.string().nullable().optional(),
        comments: z
          .array(
            z.object({ author: z.string().optional(), body: z.string().nullable().optional() }),
          )
          .optional(),
      })
      .strict(),
    skills: z
      .object({ directory: z.string(), repoSkillNames: z.array(z.string()).optional() })
      .strict()
      .optional(),
  })
  .strict();

export interface CodexToolContext {
  checkoutRoot: string;
  files: PullFileEntry[];
  fileContents: Record<string, string>;
  pr: PrMeta;
  discussion: PrDiscussionInput;
  skills?: { directory: string; repoSkillNames?: string[] | undefined } | undefined;
}

export async function writeCodexToolContext(
  directory: string,
  context: CodexToolContext,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, CODEX_CONTEXT_FILE_NAME);
  const document = contextSchema.parse({
    checkoutRoot: context.checkoutRoot,
    files: context.files,
    fileContents: context.fileContents,
    pr: { title: context.pr.title },
    discussion: {
      ...(context.discussion.title !== undefined ? { title: context.discussion.title } : {}),
      ...(context.discussion.body !== undefined ? { body: context.discussion.body } : {}),
      ...(context.discussion.comments !== undefined
        ? { comments: context.discussion.comments }
        : {}),
    },
    ...(context.skills !== undefined
      ? {
          skills: {
            directory: context.skills.directory,
            ...(context.skills.repoSkillNames !== undefined
              ? { repoSkillNames: context.skills.repoSkillNames }
              : {}),
          },
        }
      : {}),
  });
  await writeFile(path, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  return path;
}

export async function readCodexToolContext(path: string): Promise<CodexToolContext> {
  return contextSchema.parse(JSON.parse(await readFile(path, "utf8"))) as CodexToolContext;
}
