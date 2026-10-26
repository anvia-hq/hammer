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

const HEX_RUN = /^[0-9a-f]+$/i;
const WORD = /[A-Z]?[a-z]{3,}|[A-Z]{3,}(?![a-z])/g;
const MIN_RANDOM_ENTROPY = 3.5;
const MAX_WORD_SHARE = 0.5;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Paths and identifiers match the run pattern too, and long ones have entropy as
// high as a token's. Words are what tell them apart: at a 0.5 word share this
// keeps every long run in this repo and still catches about 96% of random
// base64. The known-prefix patterns and exact-secret matching cover the rest.
function looksRandom(run: string): boolean {
  if (HEX_RUN.test(run)) return true;
  if (!/[A-Za-z]/.test(run) || shannonEntropy(run) < MIN_RANDOM_ENTROPY) return false;
  const wordChars = (run.match(WORD) ?? []).reduce((total, word) => total + word.length, 0);
  return wordChars / run.length < MAX_WORD_SHARE;
}

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
  ].map((regex, index) => ({
    name: `hammer-secret-${index}`,
    regex,
    ...(regex === HIGH_ENTROPY_RUN ? { validate: looksRandom } : {}),
  })),
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
