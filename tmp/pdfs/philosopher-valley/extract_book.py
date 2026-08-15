from __future__ import annotations

import json
import re
from pathlib import Path

from pypdf import PdfReader


PDF_PATH = Path(
    "/Users/liujiannan/Desktop/"
    "The+Philosopher+in+the+Valley+Alex+Karp,+Palantir,+and+the+Rise+of+the+"
    "Surveillance+State+(Michael+Steinberger)+(Z-Library).pdf"
)
WORK_DIR = Path(
    "/Users/liujiannan/Desktop/Codex/openOutliner/tmp/pdfs/philosopher-valley"
)
SOURCE_DIR = WORK_DIR / "source"


SECTIONS = [
    {
        "slug": "01_dedication",
        "filename": "01_献词.md",
        "heading": "Dedication",
        "pages": (4, 4),
        "title_lines": 0,
    },
    {
        "slug": "02_prologue",
        "filename": "02_序言_为他自己打造一个安全的世界.md",
        "heading": "Prologue: Making the World Safe for Himself",
        "pages": (5, 15),
        "title_lines": 2,
    },
    {
        "slug": "03_chapter_01",
        "filename": "03_第一章_旧衣厂.md",
        "heading": "Chapter One: The Schmattes Factory",
        "pages": (16, 31),
        "title_lines": 2,
    },
    {
        "slug": "04_chapter_02",
        "filename": "04_第二章_仿佛来自另一条轨道.md",
        "heading": "Chapter Two: Spun from a Different Orbit",
        "pages": (32, 49),
        "title_lines": 2,
    },
    {
        "slug": "05_chapter_03",
        "filename": "05_第三章_心怀芥蒂的硅谷初创公司.md",
        "heading": "Chapter Three: The Silicon Valley Start-up with a Chip on Its Shoulder",
        "pages": (50, 72),
        "title_lines": 3,
    },
    {
        "slug": "06_chapter_04",
        "filename": "06_第四章_洞察之石与窥探之眼.md",
        "heading": "Chapter Four: Seeing Stones and Prying Eyes",
        "pages": (73, 89),
        "title_lines": 2,
    },
    {
        "slug": "07_chapter_05",
        "filename": "07_第五章_商业插曲.md",
        "heading": "Chapter Five: The Commercial Break",
        "pages": (90, 101),
        "title_lines": 2,
    },
    {
        "slug": "08_chapter_06",
        "filename": "08_第六章_与陆军之战.md",
        "heading": "Chapter Six: The War Against the Army",
        "pages": (102, 116),
        "title_lines": 2,
    },
    {
        "slug": "09_chapter_07",
        "filename": "09_第七章_彼得难题.md",
        "heading": "Chapter Seven: The Peter Problem",
        "pages": (117, 143),
        "title_lines": 2,
    },
    {
        "slug": "10_chapter_08",
        "filename": "10_第八章_概念验证.md",
        "heading": "Chapter Eight: Proof of Concept",
        "pages": (144, 167),
        "title_lines": 2,
    },
    {
        "slug": "11_chapter_09",
        "filename": "11_第九章_疯得离谱的首席执行官.md",
        "heading": "Chapter Nine: The Batshit-Crazy CEO",
        "pages": (168, 183),
        "title_lines": 2,
    },
    {
        "slug": "12_chapter_10",
        "filename": "12_第十章_生存危局.md",
        "heading": "Chapter Ten: A Survival Situation",
        "pages": (184, 200),
        "title_lines": 2,
    },
    {
        "slug": "13_chapter_11",
        "filename": "13_第十一章_叛逆者胜出.md",
        "heading": "Chapter Eleven: The Rebels Win",
        "pages": (201, 217),
        "title_lines": 2,
    },
    {
        "slug": "14_epilogue",
        "filename": "14_尾声.md",
        "heading": "Epilogue",
        "pages": (218, 228),
        "title_lines": 1,
    },
    {
        "slug": "15_acknowledgments",
        "filename": "15_致谢.md",
        "heading": "Acknowledgments",
        "pages": (229, 230),
        "title_lines": 1,
    },
    {
        "slug": "16_about_the_author",
        "filename": "16_作者简介.md",
        "heading": "About the Author",
        "pages": (231, 231),
        "title_lines": 1,
    },
    {
        "slug": "17_copyright",
        "filename": "17_版权页.md",
        "heading": "Copyright",
        "pages": (233, 234),
        "title_lines": 0,
        "layout": False,
    },
]


def normalize_line(line: str) -> str:
    line = line.replace("\x00", "[LIG]")
    line = re.sub(r"\s+", " ", line.strip())
    return re.sub(r"\[LIG\]\s+(?=[A-Za-z])", "[LIG]", line)


def layout_page_lines(reader: PdfReader, page_number: int) -> list[tuple[int, str]]:
    text = reader.pages[page_number - 1].extract_text(extraction_mode="layout") or ""
    result: list[tuple[int, str]] = []
    for raw_line in text.splitlines():
        if not raw_line.strip():
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        result.append((indent, normalize_line(raw_line)))
    return result


def join_line(current: str, continuation: str) -> str:
    if current.endswith("-"):
        return current + continuation
    return current + " " + continuation


def extract_layout_section(reader: PdfReader, start: int, end: int, title_lines: int) -> str:
    paragraphs: list[str] = []
    for page_number in range(start, end + 1):
        lines = layout_page_lines(reader, page_number)
        if page_number == start and title_lines:
            lines = lines[title_lines:]

        page_paragraphs: list[str] = []
        current = ""
        for line_index, (indent, text) in enumerate(lines):
            starts_paragraph = indent >= 3
            if page_number == start and line_index == 0:
                starts_paragraph = True

            if starts_paragraph and current:
                page_paragraphs.append(current)
                current = text
            elif current:
                current = join_line(current, text)
            else:
                current = text

        if current:
            page_paragraphs.append(current)

        if page_number > start and lines and lines[0][0] < 3 and paragraphs:
            paragraphs[-1] = join_line(paragraphs[-1], page_paragraphs[0])
            paragraphs.extend(page_paragraphs[1:])
        else:
            paragraphs.extend(page_paragraphs)

    return "\n\n".join(p.strip() for p in paragraphs if p.strip())


def extract_plain_section(reader: PdfReader, start: int, end: int) -> str:
    pages = []
    for page_number in range(start, end + 1):
        text = reader.pages[page_number - 1].extract_text() or ""
        pages.append(text.replace("\x00", "[LIG]").strip())
    return "\n\n".join(pages)


def main() -> None:
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    reader = PdfReader(PDF_PATH)
    manifest = []

    for section in SECTIONS:
        start, end = section["pages"]
        if section.get("layout", True):
            body = extract_layout_section(reader, start, end, section["title_lines"])
        else:
            body = extract_plain_section(reader, start, end)

        source = f"# {section['heading']}\n\n{body}\n\n[[END_OF_SOURCE]]\n"
        source_path = SOURCE_DIR / f"{section['slug']}.md"
        source_path.write_text(source, encoding="utf-8")
        manifest.append(
            {
                **section,
                "source": str(source_path),
                "source_chars": len(source),
                "source_words": len(source.split()),
                "ligature_markers": source.count("[LIG]"),
            }
        )

    (WORK_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    for item in manifest:
        print(
            f"{item['slug']}: pages={item['pages'][0]}-{item['pages'][1]} "
            f"words={item['source_words']} chars={item['source_chars']} "
            f"ligatures={item['ligature_markers']}"
        )


if __name__ == "__main__":
    main()
