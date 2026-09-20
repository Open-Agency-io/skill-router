function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("invalid double-quoted string");
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function parseScalar(raw) {
  let value = raw.trim();
  if (!value) return Object.create(null);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (!value.startsWith('"') && !value.startsWith("'")) {
    value = value.replace(/\s+#.*$/, "").trimEnd();
  }
  return unquote(value);
}

export function parseFrontmatter(text) {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { attributes: {}, body: normalized, hasFrontmatter: false };
  }

  const lines = normalized.split("\n");
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing === -1) throw new Error("frontmatter is missing its closing --- delimiter");

  const header = lines.slice(1, closing);
  const attributes = Object.create(null);
  const stack = [{ indent: -1, value: attributes }];

  for (let index = 0; index < header.length; index += 1) {
    const line = header[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line.includes("\t")) throw new Error(`frontmatter line ${index + 1} contains a tab`);

    const indent = line.length - line.trimStart().length;
    const match = line.trim().match(/^([^:#][^:]*):(?:\s*(.*))?$/);
    if (!match) throw new Error(`unsupported frontmatter syntax on line ${index + 1}`);

    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1);
    if (indent <= parent.indent) throw new Error(`invalid indentation on line ${index + 1}`);

    const key = match[1].trim();
    if (!key || Object.hasOwn(parent.value, key)) {
      throw new Error(`invalid or duplicate frontmatter key on line ${index + 1}`);
    }

    const rawValue = match[2] ?? "";
    let value;
    if (/^[>|][+-]?$/.test(rawValue.trim())) {
      const style = rawValue.trim()[0];
      const block = [];
      let cursor = index + 1;
      while (cursor < header.length) {
        const candidate = header[cursor];
        const candidateIndent = candidate.length - candidate.trimStart().length;
        if (candidate.trim() && candidateIndent <= indent) break;
        block.push(candidate);
        cursor += 1;
      }
      const contentIndent = Math.min(
        ...block.filter((item) => item.trim()).map((item) => item.length - item.trimStart().length),
      );
      const content = Number.isFinite(contentIndent)
        ? block.map((item) => (item.trim() ? item.slice(contentIndent) : ""))
        : [];
      value = style === "|" ? content.join("\n") : content.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ");
      index = cursor - 1;
    } else {
      value = parseScalar(rawValue);
    }
    parent.value[key] = value;
    if (rawValue.trim() === "") stack.push({ indent, value });
  }

  return {
    attributes,
    body: lines.slice(closing + 1).join("\n"),
    hasFrontmatter: true,
  };
}

export function skillMetadata(attributes) {
  const own = (key) => (Object.hasOwn(attributes, key) ? attributes[key] : undefined);
  const metadata = own("metadata");
  const opencodeAutoinvoke =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? Object.hasOwn(metadata, "opencode/autoinvoke")
        ? metadata["opencode/autoinvoke"]
        : undefined
      : undefined;

  return {
    name: typeof own("name") === "string" ? own("name").trim() : undefined,
    description:
      typeof own("description") === "string" ? own("description").trim() : undefined,
    compatibility:
      typeof own("compatibility") === "string" ? own("compatibility").trim() : undefined,
    opencodeAutoinvoke:
      opencodeAutoinvoke === false || opencodeAutoinvoke === "false"
        ? false
        : opencodeAutoinvoke === true || opencodeAutoinvoke === "true"
          ? true
          : undefined,
  };
}
