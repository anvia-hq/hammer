export const REDACTED = "[redacted]";

export const MAX_COMMENT_CHARS = 4000;

const ELLIPSIS = "…";
const MENTION_BREAK = "⁠";

export interface SanitizeCommentOptions {
  owner?: string | undefined;
  repo?: string | undefined;
}

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]+/g;
const OPENAI_KEY = /\bsk-[A-Za-z0-9]{16,}\b/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\b(?:ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
const HIGH_ENTROPY_RUN = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g;

export function redactSecrets(text: string): string {
  return text
    .replace(PEM_BLOCK, REDACTED)
    .replace(JWT_LIKE, REDACTED)
    .replace(ANTHROPIC_KEY, REDACTED)
    .replace(OPENAI_KEY, REDACTED)
    .replace(AWS_ACCESS_KEY, REDACTED)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(HIGH_ENTROPY_RUN, REDACTED);
}

const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^()]*\)/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_TAG = /<[^<>]*>/g;
const MENTION = /(^|\s)@(?=\w)/g;

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
  const withoutHtml = withoutForeignLinks.replace(HTML_TAG, "");
  const withoutPings = withoutHtml.replace(MENTION, `$1@${MENTION_BREAK}`);
  if (withoutPings.length > MAX_COMMENT_CHARS) {
    return `${withoutPings.slice(0, MAX_COMMENT_CHARS - 1)}${ELLIPSIS}`;
  }
  return withoutPings;
}

export function sanitizeForPosting(text: string, options: SanitizeCommentOptions = {}): string {
  return sanitizeComment(redactSecrets(text), options);
}
