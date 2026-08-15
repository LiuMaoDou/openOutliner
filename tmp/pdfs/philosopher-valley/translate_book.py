from __future__ import annotations

import json
import math
import re
import subprocess
import sys
import time
from pathlib import Path


WORK_DIR = Path(
    "/Users/liujiannan/Desktop/Codex/openOutliner/tmp/pdfs/philosopher-valley"
)
MANIFEST_PATH = WORK_DIR / "manifest.json"
RAW_DIR = WORK_DIR / "translated_raw"
LOG_DIR = WORK_DIR / "logs"

COMPLETE_SENTINEL = "<!-- TRANSLATION_COMPLETE -->"
MAX_CHUNK_CHARS = 26000

PROMPT = """You are translating a user-supplied English nonfiction book into Simplified Chinese.

Translate the complete marked source below into polished, publication-quality Simplified Chinese Markdown.

Hard requirements:
1. Translate every heading and every paragraph in full. Do not summarize, abridge, omit, censor, fact-check, annotate, or add commentary.
2. Preserve the Markdown H1 heading and all paragraph boundaries.
3. Every body paragraph begins with a marker like [[P001]]. Reproduce every marker exactly once, in the same order, at the start of its translated paragraph. Never translate, rename, merge, split, or omit markers.
4. The token [LIG] inside an English word represents a PDF ligature lost during extraction. Infer the intended fi, fl, ff, ffi, or ffl spelling from context before translating. Do not reproduce [LIG] in the Chinese output.
5. Preserve all names, dates, monetary amounts, quoted speech, qualifications, and factual relationships exactly.
6. Use these terms consistently: Alex Karp=亚历克斯·卡普; Palantir=帕兰提尔; Peter Thiel=彼得·蒂尔; Shyam Sankar=沙亚姆·桑卡尔; Haverford College=哈弗福德学院; Foundry, Gotham, Apollo, AIP keep their English product names; 'the West'=西方; wokeness=觉醒主义 or 觉醒文化 as context requires.
7. Use fluent contemporary Chinese nonfiction prose, Chinese punctuation, and Chinese book-title marks where appropriate. Do not leave ordinary English prose untranslated.
8. Output only the translated Markdown. Do not use a code fence.
9. After the final translated paragraph, output this exact final line: <!-- TRANSLATION_COMPLETE -->

MARKED SOURCE:
"""


def mark_source(source: str) -> tuple[str, list[str]]:
    source = source.replace("\n\n[[END_OF_SOURCE]]\n", "\n").strip()
    blocks = source.split("\n\n")
    heading = blocks[0]
    body = blocks[1:]
    markers = [f"P{i:03d}" for i in range(1, len(body) + 1)]
    marked = [heading]
    marked.extend(f"[[{marker}]] {paragraph}" for marker, paragraph in zip(markers, body))
    return "\n\n".join(marked), markers


def split_marked_source(source: str) -> list[tuple[str, list[str]]]:
    marked_source, all_markers = mark_source(source)
    blocks = marked_source.split("\n\n")
    heading = blocks[0]
    body = blocks[1:]
    total_chars = len(heading) + sum(len(block) + 2 for block in body)
    chunk_count = max(1, math.ceil(total_chars / MAX_CHUNK_CHARS))
    target_chars = math.ceil(total_chars / chunk_count)
    chunks: list[tuple[str, list[str]]] = []
    current: list[str] = []
    current_chars = len(heading)
    for block_index, block in enumerate(body):
        if (
            current
            and current_chars >= target_chars
            and len(chunks) < chunk_count - 1
            and len(body) - block_index >= chunk_count - len(chunks) - 1
        ):
            markers = re.findall(r"\[\[(P\d{3})\]\]", "\n\n".join(current))
            chunks.append(("\n\n".join([heading, *current]), markers))
            current = []
            current_chars = len(heading)
        current.append(block)
        current_chars += len(block) + 2
    if current:
        markers = re.findall(r"\[\[(P\d{3})\]\]", "\n\n".join(current))
        chunks.append(("\n\n".join([heading, *current]), markers))
    assert [marker for _, markers in chunks for marker in markers] == all_markers
    return chunks


def validate_translation(text: str, markers: list[str], source_chars: int) -> list[str]:
    errors = []
    if not text.lstrip().startswith("# "):
        errors.append("missing H1 at start")
    if COMPLETE_SENTINEL not in text:
        errors.append("missing completion sentinel")
    found = re.findall(r"\[\[(P\d{3})\]\]", text)
    if found != markers:
        errors.append(
            f"paragraph markers mismatch: expected {len(markers)}, found {len(found)}"
        )
    if "[LIG]" in text:
        errors.append("unresolved ligature marker")
    if "[[END_OF_SOURCE]]" in text:
        errors.append("source terminator leaked")
    ratio = len(text) / max(source_chars, 1)
    if ratio < 0.28:
        errors.append(f"suspiciously short output ratio {ratio:.3f}")
    if ratio > 1.50:
        errors.append(f"suspiciously long output ratio {ratio:.3f}")
    return errors


def run_chunk(
    item: dict,
    chunk_number: int,
    chunk_count: int,
    marked_source: str,
    markers: list[str],
    attempt: int,
) -> tuple[str, list[str], float]:
    raw_path = RAW_DIR / f"{item['slug']}.md"
    part_path = raw_path if chunk_count == 1 else RAW_DIR / (
        f"{item['slug']}.part{chunk_number:02d}.md"
    )
    stdout_path = LOG_DIR / (
        f"{item['slug']}.part{chunk_number:02d}.attempt{attempt}.stdout.log"
    )
    stderr_path = LOG_DIR / (
        f"{item['slug']}.part{chunk_number:02d}.attempt{attempt}.stderr.log"
    )
    part_note = (
        f"This is part {chunk_number} of {chunk_count} of the same section. "
        "The H1 is repeated only for context; reproduce it in this part.\n\n"
        if chunk_count > 1
        else ""
    )
    prompt = part_note + PROMPT + marked_source
    if attempt > 1:
        prompt = (
            "A previous attempt failed structural validation. Be especially careful to "
            "reproduce every paragraph marker exactly once and finish the entire source.\n\n"
            + prompt
        )

    command = [
        "codex",
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-C",
        "/tmp",
        "-s",
        "read-only",
        "-m",
        "gpt-5.6-terra",
        "-c",
        'model_reasoning_effort="low"',
        "-o",
        str(part_path),
        "-",
    ]
    started = time.monotonic()
    with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open(
        "w", encoding="utf-8"
    ) as stderr:
        result = subprocess.run(
            command,
            input=prompt,
            text=True,
            stdout=stdout,
            stderr=stderr,
            timeout=1800,
        )
    elapsed = time.monotonic() - started
    if result.returncode != 0:
        return "", [f"codex exit code {result.returncode}"], elapsed
    text = part_path.read_text(encoding="utf-8")
    return text, validate_translation(text, markers, len(marked_source)), elapsed


def assemble_chunks(item: dict, chunk_count: int) -> str:
    parts = []
    for chunk_number in range(1, chunk_count + 1):
        part_path = RAW_DIR / f"{item['slug']}.part{chunk_number:02d}.md"
        text = part_path.read_text(encoding="utf-8").strip()
        text = text.replace(COMPLETE_SENTINEL, "").strip()
        if chunk_number > 1:
            blocks = text.split("\n\n", 1)
            if len(blocks) != 2 or not blocks[0].startswith("# "):
                raise ValueError(f"invalid repeated heading in {part_path}")
            text = blocks[1]
        parts.append(text)
    assembled = "\n\n".join(parts) + f"\n\n{COMPLETE_SENTINEL}\n"
    (RAW_DIR / f"{item['slug']}.md").write_text(assembled, encoding="utf-8")
    return assembled


def run_translation(item: dict) -> tuple[str, list[str], float]:
    source = Path(item["source"]).read_text(encoding="utf-8")
    chunks = split_marked_source(source)
    total_elapsed = 0.0
    for chunk_number, (marked_source, markers) in enumerate(chunks, start=1):
        for attempt in range(1, 4):
            text, errors, elapsed = run_chunk(
                item,
                chunk_number,
                len(chunks),
                marked_source,
                markers,
                attempt,
            )
            total_elapsed += elapsed
            if not errors:
                print(
                    f"PART {item['slug']} {chunk_number}/{len(chunks)} "
                    f"output_chars={len(text)} elapsed={elapsed:.1f}s",
                    flush=True,
                )
                break
            print(
                f"RETRY {item['slug']} part={chunk_number}/{len(chunks)} "
                f"attempt={attempt} elapsed={elapsed:.1f}s "
                f"errors={'; '.join(errors)}",
                flush=True,
            )
        else:
            return "", errors, total_elapsed

    if len(chunks) == 1:
        text = (RAW_DIR / f"{item['slug']}.md").read_text(encoding="utf-8")
    else:
        text = assemble_chunks(item, len(chunks))
    _, markers = mark_source(source)
    return text, validate_translation(text, markers, item["source_chars"]), total_elapsed


def main() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    requested_slugs = set(sys.argv[1:])
    if requested_slugs:
        manifest = [item for item in manifest if item["slug"] in requested_slugs]

    failures = []
    for index, item in enumerate(manifest, start=1):
        raw_path = RAW_DIR / f"{item['slug']}.md"
        source = Path(item["source"]).read_text(encoding="utf-8")
        _, markers = mark_source(source)
        if raw_path.exists():
            existing = raw_path.read_text(encoding="utf-8")
            errors = validate_translation(existing, markers, item["source_chars"])
            if not errors:
                print(
                    f"SKIP {index}/{len(manifest)} {item['slug']} "
                    f"chars={len(existing)} paragraphs={len(markers)}",
                    flush=True,
                )
                continue

        print(
            f"START {index}/{len(manifest)} {item['slug']} "
            f"source_chars={item['source_chars']} paragraphs={len(markers)}",
            flush=True,
        )
        text, errors, elapsed = run_translation(item)
        if not errors:
            print(
                f"DONE {index}/{len(manifest)} {item['slug']} "
                f"output_chars={len(text)} elapsed={elapsed:.1f}s",
                flush=True,
            )
        else:
            print(
                f"FAILED_SECTION {item['slug']} elapsed={elapsed:.1f}s "
                f"errors={'; '.join(errors)}",
                flush=True,
            )
            failures.append(item["slug"])

    if failures:
        print("FAILED " + ", ".join(failures), flush=True)
        raise SystemExit(1)
    print("ALL_TRANSLATIONS_VALID", flush=True)


if __name__ == "__main__":
    main()
