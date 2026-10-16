// SPDX-License-Identifier: MIT

/**
 * The one shell grammar a credentialed job may use, and nothing else
 * (#794 review, round 3).
 *
 * Two rounds of modelling bash case by case each left bypasses: arithmetic
 * read where bash ran a subshell, a `case` closing a substitution early, ANSI-C
 * quoting, functions shadowing allowlisted names, variables bound by `read`,
 * `printf -v` and `for`. This lexer models none of it. It accepts:
 *
 *   - simple commands, separated by newlines, `;`, `&&`, `||` and `|`;
 *   - plain words from [A-Za-z0-9_./:=@%+,-] and the exact words `[` and `]`;
 *   - single quotes (literal);
 *   - double quotes holding literal text and `$NAME` / `${NAME}` (an operator
 *     expansion `${NAME#lit}`, `${NAME%lit}` or `${NAME:-lit}`, such as
 *     `${TAG#cli-v}`, is lexed, flagged `opExpansion`, and allowed only inside
 *     a recorded exception; any other `${…}` form is refused);
 *   - the redirections `>`, `>>` and `<`, to a literal target;
 *   - backslash-newline continuations and `#` comments.
 *
 * Anything else is a problem, which refuses the whole block: `$(`, `$((`,
 * `((`, `$'`, `$"`, backticks, `( )`, `{ }`, a glob or brace character,
 * `~`, an unquoted `$`, any other backslash, `&`, `;;`, here-documents and
 * here-strings, descriptor redirections. Keywords, assignments and variable
 * binding builtins are left to the policy, which allows none but if/then/else/fi.
 *
 *   lexStrict(script) → { commands: [{ words, redirects }], problems }
 *
 * A word is { raw, text, hasExpansion, leadsWithExpansion, opExpansion }: `text` is the word with its quotes removed and each expansion
 * kept as `${NAME}`. Zero dependencies, pure.
 */
export function lexStrict(src) {
  const commands = [];
  const problems = [];
  const refuse = (what) => {
    if (!problems.includes(what)) problems.push(what);
  };
  let words = [];
  let redirects = [];
  let word = null;
  let pendingRedirect = null;

  const fresh = () => ({
    raw: "",
    text: "",
    hasExpansion: false,
    leadsWithExpansion: false,
    opExpansion: false,
  });
  const ensure = () => {
    if (word === null) word = fresh();
    return word;
  };
  const endWord = () => {
    if (word === null) return;
    if (pendingRedirect !== null) {
      redirects.push({ op: pendingRedirect, word });
      pendingRedirect = null;
    } else words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (pendingRedirect !== null) refuse(`a ${pendingRedirect} with no target`);
    pendingRedirect = null;
    if (words.length > 0 || redirects.length > 0) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };
  const literal = (w, s) => {
    w.text += s;
  };

  const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
  /** `$…` inside double quotes, at src[i] === "$"; returns the new index. */
  function expansion(w, i) {
    const rest = src.slice(i + 1);
    const lead = w.text === "";
    let m = NAME.exec(rest);
    if (m !== null) {
      w.text += `\${${m[0]}}`;
      w.hasExpansion = true;
      if (lead) w.leadsWithExpansion = true;
      return i + 1 + m[0].length;
    }
    if (rest.startsWith("{")) {
      const end = rest.indexOf("}");
      const body = end === -1 ? null : rest.slice(1, end);
      if (body === null || /[$`({]/.test(body)) {
        refuse("an expansion this grammar does not allow (${ with $, (, { or `)");
        return end === -1 ? src.length : i + 2 + end;
      }
      // A plain name, or the operator forms the exceptions use (`#`, `%`, `:-`)
      // with a literal operand: never a subscript, `@` transform, `/`
      // substitution, `#` length, `!` indirection or substring offset.
      const plain = new RegExp(`${NAME.source}$`).test(body);
      if (!plain && !/^[A-Za-z_][A-Za-z0-9_]*(?:#|%|:-)[A-Za-z0-9_.\/-]*$/.test(body)) {
        refuse("an operator expansion other than ${NAME#…}, ${NAME%…} or ${NAME:-…}");
        return i + 2 + end;
      }
      if (!plain) w.opExpansion = true;
      w.text += `\${${body}}`;
      w.hasExpansion = true;
      if (lead) w.leadsWithExpansion = true;
      return i + 2 + end;
    }
    refuse("an expansion this grammar does not allow ($(, $((, $', $\" or a special parameter)");
    return i + 1;
  }

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      refuse("a backslash outside quotes");
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const w = ensure();
      if (end === -1) {
        refuse("an unterminated single quote");
        break;
      }
      w.raw += src.slice(i, end + 1);
      literal(w, src.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const w = ensure();
      const start = i;
      i += 1;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (d === "\\") {
          const n = src[i + 1];
          if (n === "\n") i += 2;
          else if (n === '"' || n === "\\" || n === "$" || n === "`") {
            literal(w, n);
            i += 2;
          } else {
            literal(w, "\\");
            i += 1;
          }
        } else if (d === "$") i = expansion(w, i);
        else if (d === "`") {
          refuse("a backtick command substitution");
          i += 1;
        } else {
          literal(w, d);
          i += 1;
        }
      }
      if (!closed) refuse("an unterminated double quote");
      w.raw += src.slice(start, i);
      continue;
    }
    if (c === "#" && word === null) {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i += 1;
      continue;
    }
    if (c === "\n") {
      endCommand();
      i += 1;
      continue;
    }
    if (c === ";") {
      if (src[i + 1] === ";") refuse("a ;; (case)");
      endCommand();
      i += src[i + 1] === ";" ? 2 : 1;
      continue;
    }
    if (c === "&" || c === "|") {
      if (src[i + 1] === c) {
        endCommand();
        i += 2;
        continue;
      }
      if (c === "&") refuse("a & (background job or descriptor redirection)");
      if (c === "|" && src[i + 1] === "&") refuse("a |& pipe");
      endCommand();
      i += 1;
      continue;
    }
    if (c === ">" || c === "<") {
      if (word !== null && /^\d+$/.test(word.raw)) refuse("a descriptor redirection");
      endWord();
      const two = src.slice(i, i + 2);
      if (two === "<<") refuse("a here-document or here-string");
      else if (two === "<(" || two === ">(") refuse("a process substitution");
      else if (/^(?:>&|<&|>\||<>)$/.test(two)) refuse("a descriptor redirection");
      const op = two === ">>" ? ">>" : c;
      if (pendingRedirect !== null) refuse("two redirections in a row");
      pendingRedirect = op;
      i += op.length;
      continue;
    }
    if ("(){}".includes(c)) {
      refuse("a ( ) or { } (subshell, group, function, arithmetic or brace expansion)");
      i += 1;
      continue;
    }
    if ("*?[]".includes(c)) {
      // `[` and `]` are the test command's words, alone; anywhere else a glob.
      const alone =
        (c === "[" || c === "]") &&
        word === null &&
        (i + 1 >= src.length || /[\s;|&]/.test(src[i + 1]));
      if (!alone) refuse("a glob character (* ? [ ])");
      const w = ensure();
      w.raw += c;
      literal(w, c);
      i += 1;
      continue;
    }
    if (c === "~") refuse("a ~ (tilde expansion)");
    if (c === "$") refuse("an unquoted $ (every expansion is double-quoted)");
    if (c === "`") refuse("a backtick command substitution");
    if (c === "!" && word === null && /[\s]/.test(src[i + 1] ?? " ")) refuse("a ! (negation)");
    const w = ensure();
    w.raw += c;
    if (!/[A-Za-z0-9_./:=@%+,!-]/.test(c))
      refuse(`a character this grammar does not allow (${JSON.stringify(c)})`);
    literal(w, c);
    i += 1;
  }
  endCommand();
  return { commands, problems };
}
