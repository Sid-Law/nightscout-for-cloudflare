const MAX_REGEX_BYTES = 128;
// Workers SQLite enforces SQLITE_MAX_LIKE_PATTERN_LENGTH=50 for LIKE/GLOB.
const MAX_GLOB_BYTES = 50;

export class SafeRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeRegexError";
  }
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function globLiteral(character: string): string {
  switch (character) {
    case "*":
      return "[*]";
    case "?":
      return "[?]";
    case "[":
      return "[[]";
    default:
      return character;
  }
}

/**
 * Compile the bounded, linear subset of MongoDB's string `$regex` contract
 * used by Nightscout API3 into SQLite's case-sensitive GLOB language.
 *
 * Supported constructs are literals, `^`/`$` edge anchors, `.`, `.*`, and
 * the common `\d`, `\D`, `\w`, and `\W` character classes. Backtracking
 * constructs are rejected instead of being evaluated by JavaScript, so a
 * request cannot turn a Worker invocation into a ReDoS workload.
 *
 * Controlled difference: SQLite GLOB's `?`/`*` wildcards cross CR/LF, while
 * MongoDB regex `.` does not without dotAll. Multi-line fields can therefore
 * over-match patterns containing `.`/`.*`; compatibility documentation and
 * contract tests must keep this explicit until a bounded automaton replaces
 * the GLOB subset.
 */
export function compileMongoRegexToSqlGlob(rawPattern: string): string {
  if (bytes(rawPattern) > MAX_REGEX_BYTES) {
    throw new SafeRegexError(`regex pattern exceeds ${MAX_REGEX_BYTES} bytes`);
  }

  let pattern = rawPattern;
  const anchoredStart = pattern.startsWith("^");
  if (anchoredStart) pattern = pattern.slice(1);

  let anchoredEnd = false;
  if (pattern.endsWith("$")) {
    let slashCount = 0;
    for (let index = pattern.length - 2; index >= 0 && pattern[index] === "\\"; index -= 1) {
      slashCount += 1;
    }
    if (slashCount % 2 === 0) {
      anchoredEnd = true;
      pattern = pattern.slice(0, -1);
    }
  }

  let glob = anchoredStart ? "" : "*";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined) throw new SafeRegexError("regex pattern ends with an escape");
      index += 1;
      switch (escaped) {
        case "d":
          glob += "[0-9]";
          break;
        case "D":
          glob += "[^0-9]";
          break;
        case "w":
          glob += "[A-Za-z0-9_]";
          break;
        case "W":
          glob += "[^A-Za-z0-9_]";
          break;
        case "s":
        case "S":
          throw new SafeRegexError(`regex escape \\${escaped} is not supported safely`);
        case ".":
        case "*":
        case "+":
        case "?":
        case "{":
        case "}":
        case "[":
        case "]":
        case "(":
        case ")":
        case "|":
        case "^":
        case "$":
        case "\\":
        case "/":
          glob += globLiteral(escaped);
          break;
        default:
          throw new SafeRegexError(`regex escape \\${escaped} is not supported safely`);
      }
      continue;
    }
    if (character === ".") {
      if (pattern[index + 1] === "*") {
        glob += "*";
        index += 1;
      } else {
        glob += "?";
      }
      continue;
    }
    if (character === "^" || character === "$") {
      throw new SafeRegexError("regex anchors are only supported at pattern edges");
    }
    if ("*+?{}[]()|".includes(character)) {
      throw new SafeRegexError(`regex construct ${character} is not supported safely`);
    }
    glob += globLiteral(character);
  }
  if (!anchoredEnd) glob += "*";
  glob = glob.replace(/\*{2,}/g, "*");
  if (bytes(glob) > MAX_GLOB_BYTES) {
    throw new SafeRegexError(`compiled regex exceeds SQLite's ${MAX_GLOB_BYTES}-byte limit`);
  }
  return glob;
}
