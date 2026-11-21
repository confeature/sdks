// SPDX-License-Identifier: MIT

/** Read unique direct fields at a fixed path in a package manifest. */
export function readXmlIdentity(xmlText, path, fields) {
  const xml = xmlText.replace(/^\s*(?:<\?xml[^?]*\?>)?/, "");
  const tokens =
    /<!--[\s\S]*?-->|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/gy;
  const stack = [];
  const values = new Map();
  let containers = 0;
  let consumed = 0;
  for (const [token, closing, opening] of xml.matchAll(tokens)) {
    consumed += token.length;
    if (token.startsWith("<!--")) continue;
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
    if (inField || (stack.length === 0 && opening !== path[0])) return null;
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
