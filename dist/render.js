export function element(tag, classes, text) {
  const node = document.createElement(tag);
  if (classes) node.className = classes;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function icon(name) {
  const node = element("i", "icon " + name);
  node.setAttribute("aria-hidden", "true");
  return node;
}

export function sourceLink(source, label) {
  const link = element("a", "", label);
  link.href = source.url;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  return link;
}

function inline(container, text, sources) {
  let start = 0;
  const mark = /(`[^`]+`|\*\*[^*]+\*\*|\[(\d{1,2})\])/g;
  for (const match of text.matchAll(mark)) {
    container.append(text.slice(start, match.index));
    const part = match[0];
    const source = sources?.[Number(match[2]) - 1];
    if (source) container.append(sourceLink(source, part));
    else if (part.charCodeAt(0) === 96) container.append(element("code", "", part.slice(1, -1)));
    else if (part.startsWith("**")) container.append(element("strong", "", part.slice(2, -2)));
    else container.append(part);
    start = match.index + part.length;
  }
  container.append(text.slice(start));
}

function splitTableRow(line) {
  const parts = line.trim().split(/(`[^`]+`|\\[\\|`]|\|)/g);
  const cells = [""];
  for (const part of parts) {
    if (part === "|") cells.push("");
    else cells[cells.length - 1] += part.replaceAll("\\|", "|");
  }
  const separated = cells.length > 1;
  if (!parts[0] && parts[1] === "|") cells.shift();
  if (!parts.at(-1) && parts.at(-2) === "|") cells.pop();
  return { cells: cells.map((cell) => cell.trim()), separated };
}

const blockAfterTable = /^\s*(?:```|~~~|>|#{1,6}(?:\s|$)|(?:[-+*]|\d+[.)])(?:\s|$)|(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$)/;

function tableAt(lines, index, sources) {
  if (!lines[index].includes("|") || !lines[index + 1]?.includes("-")) return null;
  const header = splitTableRow(lines[index]);
  const separators = splitTableRow(lines[index + 1]);
  if (!header.separated || !separators.separated || !header.cells.length ||
      header.cells.length !== separators.cells.length ||
      !separators.cells.every((cell) => /^:?-+:?$/.test(cell))) return null;

  const alignments = separators.cells.map((cell) => {
    if (!cell.endsWith(":")) return "";
    return cell.startsWith(":") ? "align-center" : "align-right";
  });
  const wrapper = element("div", "table-scroll");
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute("aria-label", "表格");
  const table = element("table");
  wrapper.append(table);

  function appendRow(section, tag, values) {
    const row = section.insertRow();
    alignments.forEach((alignment, column) => {
      const cell = element(tag, alignment);
      if (tag === "th") cell.scope = "col";
      inline(cell, values[column] ?? "", sources);
      row.append(cell);
    });
  }

  appendRow(table.createTHead(), "th", header.cells);
  let end = index + 2;
  let body;
  while (end < lines.length && lines[end].trim() && !blockAfterTable.test(lines[end])) {
    body ??= table.createTBody();
    appendRow(body, "td", splitTableRow(lines[end]).cells);
    end++;
  }
  return { wrapper, end };
}

export function formatMarkdown(content, sources) {
  const fragment = document.createDocumentFragment();
  let lines = [];
  let code = null;
  let list = null;
  function flushParagraph() {
    if (!lines.length) return;
    const paragraph = element("p");
    inline(paragraph, lines.join("\n"), sources);
    fragment.append(paragraph);
    lines = [];
  }
  function flushCode() {
    const block = element("pre");
    block.append(element("code", "", code.join("\n")));
    fragment.append(block);
    code = null;
  }
  const input = content.split(/\r?\n/);
  for (let index = 0; index < input.length; index++) {
    const line = input[index];
    if (/^\s*```/.test(line)) {
      if (code) flushCode();
      else {
        flushParagraph();
        list = null;
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)/);
    const table = !heading && !item ? tableAt(input, index, sources) : null;
    if (table) {
      flushParagraph();
      list = null;
      fragment.append(table.wrapper);
      index = table.end - 1;
    } else if (item) {
      flushParagraph();
      const type = /^\d/.test(item[1]) ? "OL" : "UL";
      if (list?.tagName !== type) {
        list = element(type.toLowerCase());
        fragment.append(list);
      }
      const li = element("li");
      inline(li, item[2], sources);
      list.append(li);
    } else {
      list = null;
      if (heading) {
        flushParagraph();
        const title = element("h" + Math.min(5, heading[1].length + 2));
        inline(title, heading[2], sources);
        fragment.append(title);
      } else if (line.trim()) {
        lines.push(line);
      } else {
        flushParagraph();
      }
    }
  }
  if (code) flushCode();
  flushParagraph();
  return fragment;
}
