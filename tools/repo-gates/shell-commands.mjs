// SPDX-License-Identifier: MIT

/**
 * The simple commands a bash `run:` block executes: enough of bash's grammar
 * for verify-workflows.mjs to hold a credentialed job to an ALLOWLIST of
 * commands (#794 review).
 *
 * The rule it replaces was one regular expression over each line, a blocklist,
 * and review walked past it five ways: a backslash continuation (`pn\` newline
 * `pm install`), an option before the subcommand (`npm --prefix x ci`), a
 * runner it did not name (`bunx`, `deno`, `tsx`, `go test`), `source x.sh`,
 * and a repository path without `./`. A blocklist answers "is this one of the
 * bad things I thought of"; the question is "is this one of the few things a
 * credentialed job needs", and answering that needs the commands, not lines.
 *
 *   shellCommands(script) → { commands, functions, problems }
 *
 *   commands   every simple command, as its words (raw source text, quotes
 *              kept, backslash-newlines joined, redirections dropped), from
 *              every nesting level: the commands inside a `$( )`, `<( )`,
 *              `${ }` or `$(( ))` are commands too. Split on newlines, `;`,
 *              `&&`, `||`, `|`, `&`, `( )` and `;;`.
 *   functions  the names the script defines (`name() { … }`, `function name`).
 *   problems   constructs it refuses to reason about: backticks, here-documents
 *              (their body would be data to this scanner and code to bash),
 *              an unterminated quote or substitution.
 *
 * A `case` pattern (`*.md5 | *.sha1)`) is skipped, never read as a command.
 * A `for` header and a `case` header are returned as commands like any other;
 * the policy reads their words as data.
 *
 * Zero dependencies, pure: the tests feed it strings.
 */
export function shellCommands(src) {
  const commands = [];
  const functions = new Set();
  const problems = [];
  let i = 0;

  const at = (s) => src.startsWith(s, i);

  function single() {
    const end = src.indexOf("'", i + 1);
    if (end === -1) {
      problems.push("an unterminated single quote");
      i = src.length;
      return;
    }
    i = end + 1;
  }

  function double() {
    i += 1;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === '"') {
        i += 1;
        return;
      } else if (c === "$") dollar();
      else if (c === "`") {
        problems.push("a backtick command substitution (write $( ) instead)");
        i += 1;
      } else i += 1;
    }
    problems.push("an unterminated double quote");
  }

  /** `$((…))`, `$(…)`, `${…}` or a plain `$`. */
  function dollar() {
    if (at("$((")) {
      i += 3;
      arithmetic();
    } else if (at("$(")) {
      i += 2;
      list(")");
    } else if (at("${")) {
      i += 2;
      braces();
    } else i += 1;
  }

  /** The body of `${…}`, which may itself hold quotes and substitutions. */
  function braces() {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === "'") single();
      else if (c === '"') double();
      else if (c === "$") dollar();
      else if (c === "{") {
        depth += 1;
        i += 1;
      } else if (c === "}") {
        i += 1;
        if (depth === 0) return;
        depth -= 1;
      } else i += 1;
    }
    problems.push("an unterminated ${");
  }

  /** The body of `$((…))` or `((…))`: no command, but a `$( )` inside is one. */
  function arithmetic() {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "$") dollar();
      else if (c === "(") {
        depth += 1;
        i += 1;
      } else if (c === ")") {
        if (depth === 0 && src[i + 1] === ")") {
          i += 2;
          return;
        }
        depth -= 1;
        i += 1;
      } else i += 1;
    }
    problems.push("an unterminated $((");
  }

  /** A command list, up to `closer` (the `)` of a substitution) or the end. */
  function list(closer) {
    let words = [];
    let word = "";
    let inWord = false;
    let dropNext = false; // the next word is a redirection's target
    let depth = 0; // `( … )` subshells open in this list
    let caseDepth = 0;
    let atPattern = false;

    const endWord = () => {
      if (!inWord) return;
      if (dropNext) dropNext = false;
      else words.push(word);
      word = "";
      inWord = false;
      if (words.length === 3 && words[0] === "case" && words[2] === "in") {
        commands.push(words);
        words = [];
        caseDepth += 1;
        atPattern = true;
      }
    };
    const endCommand = () => {
      endWord();
      if (words.length === 0) return;
      if (words[0] === "function" && words[1] !== undefined) functions.add(words[1]);
      if (words[0] === "esac") caseDepth = Math.max(0, caseDepth - 1);
      commands.push(words);
      words = [];
    };
    const append = (start) => {
      word += src.slice(start, i);
      inWord = true;
    };

    function redirection() {
      // A number right before the operator is its descriptor: `2>&1`.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      if (at("<<<")) {
        i += 3;
        dropNext = true;
        return;
      }
      if (at("<<")) {
        problems.push("a here-document");
        i += 2;
        dropNext = true;
        return;
      }
      const op = /^(?:&>>|&>|>>|>\||<>|>&|<&|>|<)/.exec(src.slice(i))[0];
      i += op.length;
      const fd = /^(?:\d+|-)(?![\w./])/.exec(src.slice(i));
      if (op.endsWith("&") && fd !== null) i += fd[0].length;
      else dropNext = true;
    }

    while (i < src.length) {
      if (atPattern) {
        while (i < src.length && /\s/.test(src[i])) i += 1;
        if (/^esac(?![\w-])/.test(src.slice(i))) {
          atPattern = false;
          continue;
        }
        while (i < src.length && src[i] !== ")") {
          if (src[i] === "'") single();
          else if (src[i] === '"') double();
          else if (src[i] === "$") dollar();
          else i += src[i] === "\\" ? 2 : 1;
        }
        i += 1;
        atPattern = false;
        continue;
      }
      const c = src[i];
      const start = i;
      if (c === "\\") {
        if (src[i + 1] === "\n") i += 2;
        else {
          i += 2;
          append(start);
        }
      } else if (c === "'") {
        single();
        append(start);
      } else if (c === '"') {
        double();
        append(start);
      } else if (c === "$") {
        dollar();
        append(start);
      } else if (c === "`") {
        problems.push("a backtick command substitution (write $( ) instead)");
        i += 1;
      } else if (c === "#" && !inWord) {
        while (i < src.length && src[i] !== "\n") i += 1;
      } else if (c === " " || c === "\t") {
        endWord();
        i += 1;
      } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
        i += 2;
        list(")");
        append(start);
      } else if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
        redirection();
      } else if (c === "(") {
        const def = /^\(\s*\)/.exec(src.slice(i));
        if (inWord && def !== null && /^[A-Za-z_][\w-]*$/.test(word)) {
          functions.add(word);
          word = "";
          inWord = false;
          i += def[0].length;
          endCommand();
        } else if (!inWord && src[i + 1] === "(") {
          i += 2;
          arithmetic();
        } else {
          endCommand();
          depth += 1;
          i += 1;
        }
      } else if (c === ")") {
        endCommand();
        i += 1;
        if (depth > 0) depth -= 1;
        else if (closer === ")") return;
        else problems.push("an unmatched )");
      } else if (c === ";" && src[i + 1] === ";") {
        endCommand();
        i += 2;
        if (caseDepth > 0) atPattern = true;
      } else if (c === "\n" || c === ";" || c === "|" || c === "&") {
        endCommand();
        i += c !== "\n" && c !== ";" && src[i + 1] === c ? 2 : 1;
      } else {
        i += 1;
        append(start);
      }
    }
    endCommand();
    if (closer !== undefined) problems.push(`an unterminated substitution (no closing ${closer})`);
  }

  list(undefined);
  return { commands, functions, problems };
}
