import { jsonDocumentError, parseJsonBounded } from "./json-errors.js";

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/**
 * Replace a comment span with spaces, preserving every `\n` and `\r` so the
 * sanitized document keeps the exact length, every newline, and every line
 * number of the original — CRLF included. JSON treats space, tab, LF, and CR
 * as whitespace, so the result stays parseable while all offsets survive.
 */
function blankComment(output, start, end) {
  for (let index = start; index < end; index += 1) {
    const character = output[index];
    if (character !== "\n" && character !== "\r") output[index] = " ";
  }
}

/**
 * Consume a JSON string starting at the opening quote. String bytes are never
 * inspected beyond the lexical scan (they are copied through untouched), and a
 * raw newline or end of input is a fixed, bounded "unterminated string" error
 * instead of whatever the parser would echo back.
 */
function consumeString(text, start, file) {
  let index = start + 1;
  let escaped = false;
  while (index < text.length) {
    const character = text[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return index + 1;
    else if (character === "\n") throw jsonDocumentError("unterminated string", { file });
    index += 1;
  }
  throw jsonDocumentError("unterminated string", { file });
}

/**
 * Lexical JSONC sanitization: comments and trailing commas become spaces and
 * nothing else changes. Strings are copied byte-for-byte (a `,}`, `,]`, `/*`,
 * or `//` inside a string is string content, never structure), comments are
 * recognized only outside strings, and a comma is only blanked when the next
 * significant token outside strings/comments closes the value — so the total
 * length, every offset, and every newline of the document are preserved.
 */
function stripJsonc(text, file) {
  const output = text.split("");
  let index = 0;
  let pendingComma = -1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      index = consumeString(text, index, file);
      pendingComma = -1;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      const start = index;
      while (index < text.length && text[index] !== "\n") index += 1;
      blankComment(output, start, index);
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      if (index >= text.length) throw jsonDocumentError("unterminated block comment", { file });
      index += 2;
      blankComment(output, start, index);
      continue;
    }
    if (character === ",") {
      pendingComma = index;
      index += 1;
      continue;
    }
    if ((character === "}" || character === "]") && pendingComma !== -1) {
      output[pendingComma] = " ";
      pendingComma = -1;
      index += 1;
      continue;
    }
    if (!JSON_WHITESPACE.has(character)) pendingComma = -1;
    index += 1;
  }
  return output.join("");
}

/**
 * JSONC is strict JSON plus comments and trailing commas. Callers keep their
 * strict-first, JSONC-only-as-a-fallback semantics; this parser is the bounded
 * fallback. Errors never carry document bytes, parser snippets, or control
 * characters: unterminated strings and block comments are fixed phrases, and a
 * structural failure reports file context plus a safely derived line/column.
 */
export function parseJsonc(text, file = null) {
  return parseJsonBounded(stripJsonc(text, file), { file });
}
