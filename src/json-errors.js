import { readFile } from "node:fs/promises";

/**
 * One bounded, byte-safe error vocabulary for every raw JSON parse site.
 *
 * Parser messages are implementation text: the JavaScript engine embeds
 * document snippets and surrounding bytes in its SyntaxError messages, so
 * copying one into an operation error can leak untrusted document content,
 * control characters, or unbounded volume. Nothing here ever copies parser
 * text, document bytes, or a control character into a message. A location is
 * reported only when it can be derived safely: the parser's `at position N`
 * marker is the *only* fragment ever read back from its message (digits,
 * validated against the document length), and line and column are recomputed
 * from the document the caller already holds. Everything else is a fixed,
 * bounded phrase plus fixed file context.
 */
const MAX_JSON_LABEL_LENGTH = 300;

/**
 * The only read failures that get a fixed mapped message. Any other code
 * (ENOENT, EPERM platform variants, a future code) keeps its original error so
 * callers can still classify it themselves; an unknown condition is never
 * relabeled as a known one.
 */
const UNREADABLE_CODES = new Set(["EBUSY", "EACCES", "EISDIR", "ELOOP", "EPERM", "EFTYPE"]);

/** File context is bounded and control-scrubbed before it can reach a message. */
function boundedLabel(value) {
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return text.length > MAX_JSON_LABEL_LENGTH ? `${text.slice(0, MAX_JSON_LABEL_LENGTH)}…` : text;
}

/** Line/column derived from a parser position marker, or `null` when unsafe. */
function derivedLocation(text, cause) {
  const match = /at position (\d+)/.exec(String(cause?.message ?? ""));
  if (!match) return null;
  const position = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(position) || position < 0 || position > text.length) return null;
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < position; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: position - lineStart + 1 };
}

/**
 * Fixed bounded error for a condition the parser itself never saw (an
 * unterminated string or comment found lexically). `detail` must be a fixed,
 * internal phrase — never untrusted material.
 */
export function jsonDocumentError(detail, { file = null, kind = "JSON" } = {}) {
  const where = file ? ` in ${boundedLabel(file)}` : "";
  return new Error(`Invalid ${kind}${where}: ${detail}`);
}

/** Bounded error for a document the parser rejected: file context plus, when
 * safely derivable, line and column. Never the parser's own text. */
export function jsonSyntaxError(text, cause, { file = null, kind = "JSON" } = {}) {
  const where = file ? ` in ${boundedLabel(file)}` : "";
  const location = derivedLocation(text, cause);
  const at = location ? ` at line ${location.line}, column ${location.column}` : "";
  return new Error(`Invalid ${kind}${where}${at}`);
}

/** Fixed file-context error for a document that could not be read at all. */
export function mapJsonReadError(file, error) {
  if (!error || !UNREADABLE_CODES.has(error.code)) return error;
  const mapped = new Error(`Cannot read JSON document in ${boundedLabel(file)} (${error.code})`);
  mapped.code = error.code;
  return mapped;
}

/** Read a JSON document as text, mapping the controllable read failures. */
export async function readJsonText(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw mapJsonReadError(file, error);
  }
}

/** Strict `JSON.parse` behind the bounded error vocabulary. */
export function parseJsonBounded(text, { file = null, kind = "JSON" } = {}) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw jsonSyntaxError(text, error, { file, kind });
  }
}
