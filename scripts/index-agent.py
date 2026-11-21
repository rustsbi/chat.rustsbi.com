#!/usr/bin/env python3
"""Build the browser-searchable corpus from a RustSBI Agent checkout.

Usage: python scripts/index-agent.py /path/to/Agent
PDF text extraction requires pypdfium2.
"""
from contextlib import closing
import json
import re
import subprocess
import sys
from pathlib import Path

from pypdfium2 import PdfDocument


def spans(text, target=1060):
    """Split long strings at whitespace where possible, with a small overlap."""
    offset = 0
    while offset < len(text):
        end = min(offset + target, len(text))
        if end < len(text):
            boundary = max(text.rfind("\n", offset + target * 3 // 4, end),
                           text.rfind(" ", offset + target * 3 // 4, end))
            if boundary > offset:
                end = boundary + 1
        if part := text[offset:end].strip():
            yield part
        if end == len(text):
            return
        offset = end - 100


def markdown(path):
    heading, content, first = "", [], 1
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        match = re.match(r"^#{1,6}\s+(.+)", line)
        if match or len("\n".join(content)) + len(line) > 1200:
            yield from ((heading, f"L{first}-L{number - 1}", part)
                        for part in spans("\n".join(content)))
            if match:
                heading = match.group(1)
                content, first = [], number + 1
                continue
            content, first = [], number
        if not re.match(r"^\s*!\[", line):
            content.append(line)
    yield from ((heading, f"L{first}-L{number}", part)
                for part in spans("\n".join(content)))


def pdf(path):
    with PdfDocument(path) as document:
        for index in range(len(document)):
            with closing(document[index]) as page, closing(page.get_textpage()) as text_page:
                text = text_page.get_text_bounded()
                text = re.sub(r"(?<=[\u3400-\u9fff]) +(?=[\u3400-\u9fff])", "", text)
                text = re.sub(r"[ \t]+", " ", text).replace("\r\n", "\n")
                yield from (("", f"p{index + 1}", part) for part in spans(text))


def main(root):
    revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    paths = [root / "README.md", root / "src/evaluation/BasicEval/file/riscv-privileged.pdf"]
    for folder, formats in (("raw_files", (".pdf", ".csv", ".md")), ("rfcs", (".pdf", ".md")), ("src", (".md",))):
        paths.extend(sorted(p for p in (root / folder).rglob("*") if p.suffix.lower() in formats))
    sources, chunks = [], []
    for path in paths:
        if path.suffix == ".pdf":
            sections = list(pdf(path))
        elif path.suffix == ".csv":
            sections = [
                ("RustSBI 问答集", f"L{line}", entry.strip())
                for line, entry in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1)
                if line > 1 and entry.strip()
            ]
        else:
            sections = list(markdown(path))
        if not sections:
            continue
        source = len(sources)
        sources.append(path.relative_to(root).as_posix())
        chunks.extend((source, heading, location, text) for heading, location, text in sections)
    dist = Path(__file__).resolve().parents[1] / "dist"
    (dist / "agent-license.txt").write_bytes((root / "LICENSE").read_bytes())
    output = dist / "knowledge.json"
    output.write_text(json.dumps({"revision": revision, "files": sources, "chunks": chunks},
                                 ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(sources)} files, {len(chunks)} chunks, {output.stat().st_size:,} bytes at {revision}")


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
