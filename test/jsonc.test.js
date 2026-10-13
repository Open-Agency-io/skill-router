import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonc } from "../src/jsonc.js";

/** Captured thrown error (assert.throws itself returns undefined). */
function captured(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected a thrown error");
}

/**
 * JSONC is strict JSON plus comments and trailing commas. The sanitizer is
 * lexical: string bytes are copied through untouched, comments are recognized
 * only outside strings, and every comment/trailing comma becomes spaces so the
 * document keeps its exact length, offsets, and newlines. Errors are fixed and
 * bounded: never a parser snippet, document byte, or control character.
 */

test("structure characters inside strings are string content, never structure", () => {
  const document = '{"a": "x,}", "b": "y,]", "c": "/*", "d": "//", "e": "trail,"}';
  assert.deepEqual(parseJsonc(document), { a: "x,}", b: "y,]", c: "/*", d: "//", e: "trail," });
  assert.deepEqual(parseJsonc(document), JSON.parse(document), "strict JSON is unchanged");

  // A trailing comma *inside* a string must never be blanked, and comment
  // markers inside strings must never start a comment.
  assert.deepEqual(parseJsonc('{ "a": "1,2,}", "b": "// not a comment", "c": "/* still a string */" }'), {
    a: "1,2,}",
    b: "// not a comment",
    c: "/* still a string */",
  });
  // Escaped quotes keep the scan honest.
  assert.deepEqual(parseJsonc('{ "a": "say \\"hi, } and // done\\"", }'), { a: 'say "hi, } and // done"' });
  assert.deepEqual(parseJsonc('{ "a": "ends with an escaped quote \\"", }'), { a: 'ends with an escaped quote "' });
});

test("comments and trailing commas are accepted wherever JSONC allows them", () => {
  assert.deepEqual(parseJsonc('{ "a": 1, }'), { a: 1 });
  assert.deepEqual(parseJsonc("[1, 2, ]"), [1, 2]);
  assert.deepEqual(parseJsonc('{ "a": [1,], "b": {"c": 2,}, }'), { a: [1], b: { c: 2 } });
  // Comments before, between, and after the trailing comma.
  assert.deepEqual(parseJsonc('{ /* pre */ "a": 1, /* mid */ } // post\n'), { a: 1 });
  assert.deepEqual(parseJsonc('{\n  "a": 1, // trailing note\n  "b": 2,\n}\n'), { a: 1, b: 2 });
  assert.deepEqual(parseJsonc('{\n  // leading note\n  "a": [1, 2,], // note\n}\n'), { a: [1, 2] });
  // A line comment at end of input without a newline.
  assert.deepEqual(parseJsonc('{"a": 1} // eof'), { a: 1 });
});

test("every newline and offset survives, CRLF included", () => {
  const crlf = '{\r\n  "a": 1,\r\n  /* multi\r\n     line */ "b": [1, 2,],\r\n}\r\n';
  assert.deepEqual(parseJsonc(crlf), { a: 1, b: [1, 2] });

  // The trailing comma is replaced, not removed: an error *after* the stripped
  // region still reports the line/column of the original document.
  const offsetProbe = '{\n  // c1\n  /* c2\n     c3 */\n} junk\n';
  const error = captured(() => parseJsonc(offsetProbe, "/tmp/probe.jsonc"));
  assert.match(error.message, /^Invalid JSON in \/tmp\/probe\.jsonc at line 5, column 3$/);
  // ...and the reported numbers match the original document's `junk` token.
  assert.equal(offsetProbe.split("\n")[4].indexOf("junk") + 1, 3);

  // A doubled comma after a CRLF comment block still points at the original
  // closing brace line, proving offsets were preserved through the blanking.
  const doubled = '{\r\n  /* a\r\n     b */ "a": 1,,\r\n}\r\n';
  const doubledError = captured(() => parseJsonc(doubled));
  assert.match(doubledError.message, /^Invalid JSON at line 4, column 1$/);
});

test("malformed input fails with fixed bounded errors and no document bytes", () => {
  const secret = "sk-live-9d2b7c0e4a1f5e3d";
  const unterminatedString = captured(() => parseJsonc(`{\n  "a": "${secret}\n}\n`, "/tmp/bad.jsonc"));
  assert.equal(unterminatedString.message, "Invalid JSON in /tmp/bad.jsonc: unterminated string");
  assert.equal(unterminatedString.message.includes(secret), false);
  assert.equal(/[\u0000-\u001f]/.test(unterminatedString.message), false, "control-free");

  // End of input inside a string is the same fixed error.
  const eofString = captured(() => parseJsonc(`{"a": "${secret}`));
  assert.equal(eofString.message, "Invalid JSON: unterminated string");

  const unterminatedBlock = captured(() => parseJsonc(`{\n  "a": 1\n} /* ${secret}`, "/tmp/bad.jsonc"));
  assert.equal(unterminatedBlock.message, "Invalid JSON in /tmp/bad.jsonc: unterminated block comment");
  assert.equal(unterminatedBlock.message.includes(secret), false);

  // Structural failures carry file context and, when safely derivable, a
  // line/column — never the parser's snippet-bearing message.
  const structural = captured(() => parseJsonc(`{\n  "a": "x"} ${secret}`, "/tmp/bad.jsonc"));
  assert.match(structural.message, /^Invalid JSON in \/tmp\/bad\.jsonc at line \d+, column \d+$/);
  assert.equal(structural.message.includes(secret), false);
  assert.equal(structural.message.includes("is not valid JSON"), false, "parser text is never copied");

  // Without a file label the message is still fixed and bounded.
  const unlabeled = captured(() => parseJsonc("{"));
  assert.match(unlabeled.message, /^Invalid JSON/);
});

test("an empty slot is rejected, not silently reshaped", () => {
  // A single stray comma still collapses exactly like the historical
  // trailing-comma rule (`,` + closing bracket), but a doubled comma leaves an
  // empty slot that must fail instead of reshaping the document.
  assert.deepEqual(parseJsonc("[,]"), []);
  assert.throws(() => parseJsonc("[1,,]"), /Invalid JSON/);
  assert.throws(() => parseJsonc('{"a": 1,,}'), /Invalid JSON/);
  // A comment between two commas still leaves an empty slot.
  assert.throws(() => parseJsonc("[1, /* gap */ , 2]"), /Invalid JSON/);
});
