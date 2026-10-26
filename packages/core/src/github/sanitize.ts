import { createRedactor } from "@anvia/core/redaction";

export const REDACTED = "[redacted]";

export const MAX_COMMENT_CHARS = 4000;

const ELLIPSIS = "…";
const MENTION_BREAK = "⁠";

export interface SanitizeCommentOptions {
  owner?: string | undefined;
  repo?: string | undefined;
  secrets?: readonly string[];
}

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]+/g;
const OPENAI_KEY = /\bsk-[A-Za-z0-9]{16,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\b(?:ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
const HIGH_ENTROPY_RUN = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g;

const redactor = createRedactor({
  replacement: REDACTED,
  patterns: [
    PEM_BLOCK,
    JWT_LIKE,
    ANTHROPIC_KEY,
    OPENAI_KEY,
    AWS_ACCESS_KEY,
    GITHUB_TOKEN,
    HIGH_ENTROPY_RUN,
  ].map((regex, index) => ({ name: `hammer-secret-${index}`, regex })),
});

export function redactSecrets(text: string): string {
  return redactor.redactString(text);
}

const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^()]*\)/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^<>]*>/g;
const MENTION = /(?<![\w@])@(?=\w)/g;

const ALLOWED_HTML_TAGS = new Set(["details", "summary", "sub", "br"]);
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

function neutralizeHtml(text: string): string {
  return text.replace(HTML_TAG, (match, tag: string) => {
    const name = tag.toLowerCase();
    if (!ALLOWED_HTML_TAGS.has(name)) return "";
    return match.startsWith("</") ? `</${name}>` : `<${name}>`;
  });
}

function allowedLinkPrefix(options: SanitizeCommentOptions): string {
  const owner = options.owner ?? "";
  const repo = options.repo ?? "";
  if (owner !== "" && repo !== "") return `https://github.com/${owner}/${repo}`;
  return "https://github.com/";
}

function isAllowedLink(url: string, prefix: string): boolean {
  return url === prefix || url.startsWith(`${prefix}/`);
}

function flattenDisallowedLinks(text: string, prefix: string): string {
  return text.replace(MARKDOWN_LINK, (match, label: string, url: string) =>
    isAllowedLink(url, prefix) ? match : label,
  );
}

export function sanitizeComment(text: string, options: SanitizeCommentOptions = {}): string {
  const withoutImages = text.replace(MARKDOWN_IMAGE, "");
  const withoutForeignLinks = flattenDisallowedLinks(withoutImages, allowedLinkPrefix(options));
  const withoutComments = withoutForeignLinks.replace(HTML_COMMENT, "");
  const withoutHtml = neutralizeHtml(withoutComments);
  const withoutPings = withoutHtml.replace(MENTION, `@${MENTION_BREAK}`);
  if (withoutPings.length > MAX_COMMENT_CHARS) {
    return `${withoutPings.slice(0, MAX_COMMENT_CHARS - 1)}${ELLIPSIS}`;
  }
  return withoutPings;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
}

function shieldRepoBlobUrls(
  text: string,
  options: SanitizeCommentOptions,
): { text: string; restore: (value: string) => string } {
  const { owner, repo } = options;
  if (!owner || !repo) return { text, restore: (value) => value };
  const slot = (index: number): string => `blob${index}commitref`;
  const pattern = new RegExp(
    `https://github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}/blob/([0-9a-f]{4,64})(?=[/#?\\s)]|$)`,
    "g",
  );
  const shas: string[] = [];
  const masked = text.replace(pattern, (match, sha: string) => {
    shas.push(sha);
    return `${match.slice(0, match.length - sha.length)}${slot(shas.length - 1)}`;
  });
  return {
    text: masked,
    restore: (value) =>
      value.replace(
        /blob(\d+)commitref/g,
        (_token, index: string) => shas[Number(index)] ?? _token,
      ),
  };
}

export function sanitizeForPosting(text: string, options: SanitizeCommentOptions = {}): string {
  for (const secret of options.secrets ?? []) if (secret) text = text.split(secret).join(REDACTED);
  const shielded = shieldRepoBlobUrls(text, options);
  return shielded.restore(sanitizeComment(redactSecrets(shielded.text), options));
}
