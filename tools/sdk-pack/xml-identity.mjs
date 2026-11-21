// SPDX-License-Identifier: MIT

const declaration =
  /^\s*(?:<\?xml\s+version\s*=\s*(["'])1\.[01]\1(?:\s+encoding\s*=\s*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>)?/;

function hasDuplicateAttributes(attributes) {
  const names = new Set();
  for (const [, name] of attributes.matchAll(
    /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"[^"<]*"|'[^'<]*')/g,
  )) {
    if (names.has(name)) return true;
    names.add(name);
  }
  return false;
}

/** Read unique direct fields at a fixed path in a package manifest. */
export function readXmlIdentity(xmlText, path, fields) {
  const xml = xmlText.replace(declaration, "");
  const tokens =
    /<!--[\s\S]*?-->|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*\/?>|[^<]+/gy;
  const stack = [];
  const values = new Map();
  let containers = 0;
  let consumed = 0;
  for (const [token, closing, opening, attributes] of xml.matchAll(tokens)) {
    consumed += token.length;
    if (token.startsWith("<!--")) {
      const comment = token.slice(4, -3);
      if (comment.includes("--") || comment.endsWith("-")) return null;
      continue;
    }
    if (closing) {
      if (stack.pop() !== closing) return null;
      continue;
    }
    const inPath = path.every((name, depth) => stack[depth] === name);
    const field = stack[path.length];
    const inField = inPath && stack.length === path.length + 1 && fields.has(field);
    if (!opening) {
      if (inField) values.set(field, values.get(field) + token);
      if (stack.length === 0 && token.trim()) return null;
      continue;
    }
    if (
      inField ||
      (stack.length === 0 && opening !== path[0]) ||
      hasDuplicateAttributes(attributes)
    )
      return null;
    if (
      stack.length < path.length &&
      opening === path[stack.length] &&
      stack.every((name, depth) => name === path[depth])
    ) {
      if (containers !== stack.length) return null;
      containers++;
    }
    if (inPath && stack.length === path.length && fields.has(opening)) {
      if (values.has(opening)) return null;
      values.set(opening, "");
    }
    if (!token.endsWith("/>")) stack.push(opening);
  }
  if (containers !== path.length || stack.length > 0 || consumed !== xml.length) return null;
  return values;
}
