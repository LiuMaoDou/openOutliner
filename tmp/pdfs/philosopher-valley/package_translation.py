from __future__ import annotations

import json
import re
from pathlib import Path


WORK_DIR = Path(
    "/Users/liujiannan/Desktop/Codex/openOutliner/tmp/pdfs/philosopher-valley"
)
RAW_DIR = WORK_DIR / "translated_raw"
OUTPUT_DIR = Path("/Users/liujiannan/Desktop/The_Philosopher_in_the_Valley_中文翻译_Markdown")
MANIFEST_PATH = WORK_DIR / "manifest.json"


def clean_translation(text: str) -> str:
    text = re.sub(r"^\[\[P\d{3}\]\]\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n*<!-- TRANSLATION_COMPLETE -->\s*", "\n", text)
    return text.strip() + "\n"


def filename_for(index: int, heading: str) -> str:
    title = heading.removeprefix("# ")
    title = title.replace("：", "_").replace(":", "_")
    title = re.sub(r"[\\/:*?\"<>|]", "", title)
    return f"{index:02d}_{title}.md"


def main() -> None:
    if OUTPUT_DIR.exists():
        raise SystemExit(f"Output directory already exists: {OUTPUT_DIR}")
    OUTPUT_DIR.mkdir(parents=True)

    source_manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    output_manifest = []
    toc_lines = [
        "# 《山谷中的哲学家》中文译本",
        "",
        "> 原书：*The Philosopher in the Valley: Alex Karp, Palantir, and the Rise of the Surveillance State*  ",
        "> 作者：Michael Steinberger（迈克尔·斯坦伯格）  ",
        "> 来源：用户提供的 PDF；按原书书签拆分为独立 Markdown 文件。",
        "",
        "## 目录",
        "",
    ]

    for index, item in enumerate(source_manifest, start=1):
        raw_path = RAW_DIR / f"{item['slug']}.md"
        raw = raw_path.read_text(encoding="utf-8")
        clean = clean_translation(raw)
        heading = next(line for line in clean.splitlines() if line.startswith("# "))
        filename = filename_for(index, heading)
        output_path = OUTPUT_DIR / filename
        output_path.write_text(clean, encoding="utf-8")
        toc_lines.append(f"{index}. [{heading.removeprefix('# ')}]({filename})")
        output_manifest.append(
            {
                "index": index,
                "file": filename,
                "heading": heading.removeprefix("# "),
                "original_pages": f"{item['pages'][0]}-{item['pages'][1]}",
                "paragraphs": len(re.findall(r"\[\[P\d{3}\]\]", raw)),
                "translated_characters": len(clean),
            }
        )

    toc_lines.extend(
        [
            "",
            "## 说明",
            "",
            "- 每个文件对应原书一个章节或附录部分；未包含电子书推广页。",
            "- 人名、机构名、产品名尽量保持全文一致；Foundry、Gotham、AIP 等产品名称保留英文。",
            "- 原 PDF 的少量连字字符在提取时缺失，已依据上下文还原后翻译。",
        ]
    )
    (OUTPUT_DIR / "README.md").write_text("\n".join(toc_lines) + "\n", encoding="utf-8")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(output_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"output_dir={OUTPUT_DIR}")
    print(f"files={len(output_manifest)}")
    print(f"translated_characters={sum(x['translated_characters'] for x in output_manifest)}")


if __name__ == "__main__":
    main()
