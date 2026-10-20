export const SEEDED = [
  {
    id: "seeded-01",
    file: "src/webhook/client.ts",
    title: "Simplify delivery retry bookkeeping",
    contract:
      "Webhook delivery must make at most four attempts, including the initial request, when the receiver repeatedly returns a non-2xx response.",
    before:
      'export async function postEvent(send: () => Promise<{ok: boolean}>, attempt = 0): Promise<void> {\n  const response = await send();\n  if (response.ok) return;\n  if (attempt >= 3) throw new Error("delivery failed");\n  return postEvent(send, attempt + 1);\n}\n',
    after:
      'export async function postEvent(send: () => Promise<{ok: boolean}>, attempt = 0): Promise<void> {\n  const response = await send();\n  if (response.ok) return;\n  if (attempt >= 3) throw new Error("delivery failed");\n  return postEvent(send, attempt);\n}\n',
    category: "correctness",
    severity: "high",
    witness:
      'let calls = 0; try { await exports.postEvent(async () => { if (++calls > 5) throw new Error("test stop"); return {ok: false}; }); } catch {} return calls <= 4;',
  },
  {
    id: "seeded-02",
    file: "src/db/query.ts",
    title: "Inline user lookup SQL",
    contract:
      "The name comes from an HTTP request. The database callback supports positional ? placeholders with a separate parameter array.",
    before:
      'export function findUser(query: (sql: string, values?: string[]) => unknown, name: string) {\n  return query("SELECT * FROM users WHERE name = ?", [name]);\n}\n',
    after:
      'export function findUser(query: (sql: string, values?: string[]) => unknown, name: string) {\n  return query("SELECT * FROM users WHERE name = \'" + name + "\'");\n}\n',
    category: "security",
    severity: "high",
    witness:
      'let values; exports.findUser((_sql, params) => { values = params; }, "O\'Reilly"); return values?.[0] === "O\'Reilly";',
  },
  {
    id: "seeded-03",
    file: "src/auth/session.ts",
    title: "Streamline session claim extraction",
    contract:
      "The signature callback is authoritative. Claims from a token whose signature check returns false must never be accepted.",
    before:
      'export function verify(token: string, verifySignature: (value: string) => boolean) {\n  if (!verifySignature(token)) throw new Error("invalid signature");\n  return token.split(".")[1];\n}\n',
    after:
      'export function verify(token: string, verifySignature: (value: string) => boolean) {\n  return token.split(".")[1];\n}\n',
    category: "security",
    severity: "high",
    witness:
      'try { exports.verify("header.attacker.invalid", () => false); return false; } catch { return true; }',
  },
  {
    id: "seeded-04",
    file: "src/payments/charge.ts",
    title: "Update payment audit records",
    contract:
      "The audit sink is retained for support staff and may store only the final four digits of a payment card number.",
    before:
      "export function recordCharge(cardNumber: string, cents: number, write: (row: {card: string; cents: number}) => void) {\n  write({card: cardNumber.slice(-4), cents});\n}\n",
    after:
      "export function recordCharge(cardNumber: string, cents: number, write: (row: {card: string; cents: number}) => void) {\n  write({card: cardNumber, cents});\n}\n",
    category: "security",
    severity: "high",
    witness:
      'let card; exports.recordCharge("4111111111111111", 100, row => { card = row.card; }); return card === "1111";',
  },
  {
    id: "seeded-05",
    file: "src/fs/store.ts",
    title: "Simplify the upload writer",
    contract:
      "Names are supplied by multipart uploads. The writer opens the supplied filesystem path. Uploads must stay inside the uploads directory.",
    before:
      'export function storeUpload(name: string, write: (path: string) => void) {\n  if (name.includes("/") || name.includes("\\\\")) throw new Error("invalid upload name");\n  write("uploads/" + name);\n}\n',
    after:
      'export function storeUpload(name: string, write: (path: string) => void) {\n  write("uploads/" + name);\n}\n',
    category: "security",
    severity: "high",
    witness:
      'let written = false; try { exports.storeUpload("../outside.txt", () => { written = true; }); } catch {} return !written;',
  },
  {
    id: "seeded-06",
    file: "src/crypto/otp.ts",
    title: "Simplify OTP comparison",
    contract:
      "Both inputs represent complete six-digit codes; an empty or partial submitted code must not authenticate.",
    before:
      "export function checkOtp(expected: string, actual: string): boolean {\n  return expected === actual;\n}\n",
    after:
      "export function checkOtp(expected: string, actual: string): boolean {\n  return expected.startsWith(actual);\n}\n",
    category: "security",
    severity: "high",
    witness:
      'return exports.checkOtp("123456", "") === false && exports.checkOtp("123456", "123") === false;',
  },
  {
    id: "seeded-07",
    file: "src/api/paginate.ts",
    title: "Simplify pagination state",
    contract:
      "The API returns nextPage=null on the final page even when that page contains rows. Requests beyond the final page are rejected.",
    before:
      "type Page = {rows: number[]; nextPage: number | null};\nexport async function listAll(get: (page: number) => Promise<Page>) {\n  const rows: number[] = [];\n  let page: number | null = 1;\n  while (page !== null) {\n    const result = await get(page);\n    rows.push(...result.rows);\n    page = result.nextPage;\n  }\n  return rows;\n}\n",
    after:
      "type Page = {rows: number[]; nextPage: number | null};\nexport async function listAll(get: (page: number) => Promise<Page>) {\n  const rows: number[] = [];\n  let page: number | null = 1;\n  while (page !== null) {\n    const result = await get(page);\n    rows.push(...result.rows);\n    page = result.rows.length ? page + 1 : null;\n  }\n  return rows;\n}\n",
    category: "correctness",
    severity: "medium",
    witness:
      'try { const rows = await exports.listAll(async page => { if (page !== 1) throw new Error("page out of range"); return {rows: [42], nextPage: null}; }); return rows.length === 1 && rows[0] === 42; } catch { return false; }',
  },
  {
    id: "seeded-08",
    file: "src/cache/lookup.ts",
    title: "Refactor cache insertion",
    contract:
      "Cache entries are addressed by the caller-provided key. Inserting a different key must leave earlier entries retrievable.",
    before:
      "const cache = new Map<string, number>();\nexport function lookup(key: string) { return cache.get(key); }\nexport function insert(key: string, value: number) {\n  cache.set(key, value);\n}\n",
    after:
      'const cache = new Map<string, number>();\nexport function lookup(key: string) { return cache.get(key); }\nexport function insert(key: string, value: number) {\n  cache.set("key", value);\n}\n',
    category: "correctness",
    severity: "medium",
    witness:
      'exports.insert("first", 1); exports.insert("second", 2); return exports.lookup("first") === 1 && exports.lookup("second") === 2;',
  },
  {
    id: "seeded-09",
    file: "src/worker/queue.ts",
    title: "Reorder queue housekeeping",
    contract:
      "Acknowledging permanently removes a job. A job whose run rejects must remain queued for retry.",
    before:
      "export async function drain(job: {run(): Promise<void>; ack(): void}) {\n  await job.run();\n  job.ack();\n}\n",
    after:
      "export async function drain(job: {run(): Promise<void>; ack(): void}) {\n  job.ack();\n  await job.run();\n}\n",
    category: "reliability",
    severity: "high",
    witness:
      'let acked = false; try { await exports.drain({run: async () => { throw new Error("failed"); }, ack: () => { acked = true; }}); } catch {} return !acked;',
  },
  {
    id: "seeded-10",
    file: "src/config/load.ts",
    title: "Simplify environment timeout parsing",
    contract:
      "TIMEOUT_MS is optional. The caller passes undefined when absent, and the timeout must default to 1000 milliseconds.",
    before:
      'export function readTimeout(raw?: string): number {\n  return Number(raw ?? "1000");\n}\n',
    after: "export function readTimeout(raw?: string): number {\n  return Number(raw);\n}\n",
    category: "reliability",
    severity: "medium",
    witness: "return exports.readTimeout(undefined) === 1000;",
  },
  {
    id: "seeded-11",
    file: "src/net/retry.ts",
    title: "Adjust the response retry boundary",
    contract:
      "Responses with status 500 through 599 are retried up to three total attempts. The response from a successful retry must be returned.",
    before:
      'export async function fetchWithRetry(send: () => Promise<{status: number}>) {\n  for (let attempt = 0; attempt < 3; attempt += 1) {\n    const response = await send();\n    if (response.status >= 500 && attempt < 2) continue;\n    return response;\n  }\n  throw new Error("unreachable");\n}\n',
    after:
      'export async function fetchWithRetry(send: () => Promise<{status: number}>) {\n  for (let attempt = 0; attempt < 3; attempt += 1) {\n    const response = await send();\n    if (response.status > 500 && attempt < 2) continue;\n    return response;\n  }\n  throw new Error("unreachable");\n}\n',
    category: "reliability",
    severity: "medium",
    witness:
      "let calls = 0; const response = await exports.fetchWithRetry(async () => ({status: ++calls === 1 ? 500 : 200})); return response.status === 200 && calls === 2;",
  },
  {
    id: "seeded-12",
    file: "src/render/list.ts",
    title: "Streamline list rendering",
    contract:
      "Names are user supplied and this output is inserted into an HTML list. Labels must remain text rather than executable markup.",
    before:
      'function escapeHtml(value: string) {\n  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");\n}\nexport function renderItems(names: string[]) {\n  return names.map(name => "<li>" + escapeHtml(name) + "</li>").join("");\n}\n',
    after:
      'function escapeHtml(value: string) {\n  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");\n}\nexport function renderItems(names: string[]) {\n  return names.map(name => "<li>" + name + "</li>").join("");\n}\n',
    category: "security",
    severity: "high",
    witness:
      'const html = exports.renderItems(["<img src=x onerror=alert(1)>"]); return !html.includes("<img") && html.includes("&lt;img");',
  },
  {
    id: "seeded-13",
    file: "src/dates/format.ts",
    title: "Simplify elapsed-day conversion",
    contract:
      "For valid timestamps b>=a, this helper returns the number of complete 24-hour periods elapsed; it is not a calendar-day calculation.",
    before:
      "export function daysBetween(a: Date, b: Date) {\n  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);\n}\n",
    after:
      "export function daysBetween(a: Date, b: Date) {\n  return Math.floor((b.getTime() - a.getTime()) / 86_400);\n}\n",
    category: "correctness",
    severity: "medium",
    witness: "return exports.daysBetween(new Date(0), new Date(86400000)) === 1;",
  },
  {
    id: "seeded-14",
    file: "src/flags/eval.ts",
    title: "Simplify feature-flag defaults",
    contract:
      "A flag absent from a customer configuration is disabled. Existing configurations routinely omit newly introduced flags.",
    before:
      "export function isEnabled(flags: Record<string, {enabled: boolean}>, name: string) {\n  const flag = flags[name];\n  if (flag === undefined) return false;\n  return flag.enabled;\n}\n",
    after:
      "export function isEnabled(flags: Record<string, {enabled: boolean}>, name: string) {\n  const flag = flags[name];\n  if (flag === undefined) return true;\n  return flag.enabled;\n}\n",
    category: "correctness",
    severity: "high",
    witness: 'return exports.isEnabled({}, "new-feature") === false;',
  },
  {
    id: "seeded-15",
    file: "src/i18n/t.ts",
    title: "Simplify translation lookup",
    contract:
      "Unknown translation keys fall back to the key string. The existing shout consumer immediately calls toUpperCase on the result.",
    before:
      'const strings: Record<string, string> = {greeting: "Hello"};\nexport function t(key: string): string {\n  return strings[key] ?? key;\n}\nexport function shout(key: string) { return t(key).toUpperCase(); }\n',
    after:
      'const strings: Record<string, string> = {greeting: "Hello"};\nexport function t(key: string): string {\n  return strings[key] as string;\n}\nexport function shout(key: string) { return t(key).toUpperCase(); }\n',
    category: "reliability",
    severity: "medium",
    witness: 'try { return exports.shout("missing") === "MISSING"; } catch { return false; }',
  },
  {
    id: "seeded-16",
    file: "src/util/clone.ts",
    title: "Implement portable cloning",
    contract:
      "This public clone helper accepts structured-cloneable objects, including Date values and own properties whose value is undefined, and must preserve those values.",
    before: "export function clone<T>(value: T): T {\n  return structuredClone(value);\n}\n",
    after:
      "export function clone<T>(value: T): T {\n  return JSON.parse(JSON.stringify(value)) as T;\n}\n",
    category: "correctness",
    severity: "medium",
    witness:
      'const result = exports.clone({date: new Date(0), missing: undefined}); return Object.prototype.toString.call(result.date) === "[object Date]" && Object.hasOwn(result, "missing");',
  },
  {
    id: "seeded-17",
    file: "src/tests/helpers.ts",
    title: "Streamline database seeding",
    contract:
      "The returned promise signals that database seeding has completed; callers start their assertions immediately after awaiting this helper.",
    before: "export async function seedDb(insert: () => Promise<void>) {\n  await insert();\n}\n",
    after: "export async function seedDb(insert: () => Promise<void>) {\n  insert();\n}\n",
    category: "reliability",
    severity: "medium",
    witness:
      "let resolve; const write = new Promise(done => { resolve = done; }); let finished = false; const task = exports.seedDb(() => write).then(() => { finished = true; }); await Promise.resolve(); await Promise.resolve(); const early = finished; resolve(); await task; return !early;",
  },
  {
    id: "seeded-18",
    file: "src/rules/webhook.ts",
    title: "Simplify webhook request construction",
    contract:
      "The receiver deduplicates requests by Idempotency-Key. Delivery of the same event can be retried after a lost response and must not apply it twice.",
    before:
      'type Request = {method: string; body: string; headers: Record<string, string>};\nexport function send(event: {id: string}, deliver: (request: Request) => void) {\n  deliver({method: "POST", body: JSON.stringify(event), headers: {"Idempotency-Key": event.id}});\n}\n',
    after:
      'type Request = {method: string; body: string; headers: Record<string, string>};\nexport function send(event: {id: string}, deliver: (request: Request) => void) {\n  deliver({method: "POST", body: JSON.stringify(event), headers: {}});\n}\n',
    category: "reliability",
    severity: "high",
    witness:
      'const seen = new Set(); let applied = 0; const deliver = request => { const key = request.headers["Idempotency-Key"]; if (!key || !seen.has(key)) { applied++; if (key) seen.add(key); } }; exports.send({id: "event-1"}, deliver); exports.send({id: "event-1"}, deliver); return applied === 1;',
  },
  {
    id: "seeded-19",
    file: "src/legacy/parse.ts",
    title: "Normalize CSV row values",
    contract:
      "CSV column zero is the customer name and column one is the email address. Field positions must be preserved regardless of lexical order.",
    before:
      "export function parseRow(row: string[]) {\n  const [name, email] = row.slice();\n  return {name, email};\n}\n",
    after:
      "export function parseRow(row: string[]) {\n  const [name, email] = row.slice().sort();\n  return {name, email};\n}\n",
    category: "correctness",
    severity: "medium",
    witness:
      'const result = exports.parseRow(["zoe", "alice@example.com"]); return result.name === "zoe" && result.email === "alice@example.com";',
  },
  {
    id: "seeded-20",
    file: "src/webhook/backoff.ts",
    title: "Streamline delivery completion",
    contract:
      "After all three delivery attempts fail, this promise must reject so the caller leaves the message queued for a later retry.",
    before:
      "export async function sendWithBackoff(send: () => Promise<void>, pause: (ms: number) => Promise<void>) {\n  let last: unknown;\n  for (let attempt = 0; attempt < 3; attempt += 1) {\n    try { return await send(); }\n    catch (error) { last = error; await pause(100 * 2 ** attempt); }\n  }\n  throw last;\n}\n",
    after:
      "export async function sendWithBackoff(send: () => Promise<void>, pause: (ms: number) => Promise<void>) {\n  let last: unknown;\n  for (let attempt = 0; attempt < 3; attempt += 1) {\n    try { return await send(); }\n    catch (error) { last = error; await pause(100 * 2 ** attempt); }\n  }\n  return undefined;\n}\n",
    category: "reliability",
    severity: "high",
    witness:
      'try { await exports.sendWithBackoff(async () => { throw new Error("offline"); }, async () => {}); return false; } catch { return true; }',
  },
] as const;
