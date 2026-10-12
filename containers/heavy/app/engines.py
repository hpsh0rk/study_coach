"""PDF -> ParsedDocument engines. Output keys mirror packages/schema/src/ingest.ts exactly."""

from __future__ import annotations

import importlib.util
import io
import re
from typing import Optional

import pypdfium2 as pdfium

ENGINE_VERSION = "1"


def available_engines() -> list[str]:
    engines = ["pypdfium2"]
    if importlib.util.find_spec("docling") is not None:
        engines.append("docling")
    return engines


def _clean(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def _page_window(count: int, page_range: Optional[tuple[int, int]]) -> range:
    if not page_range:
        return range(1, count + 1)
    start = max(1, min(page_range[0], count))
    end = max(start, min(page_range[1], count))
    return range(start, end + 1)


def _toc(pdf: pdfium.PdfDocument) -> list[dict]:
    toc = []
    for item in pdf.get_toc(max_depth=8):
        if item.page_index is None or not item.title:
            continue
        toc.append({"title": item.title.strip(), "level": item.level + 1, "page": item.page_index + 1})
    return toc


def parse_pypdfium2(data: bytes, page_range: Optional[tuple[int, int]] = None) -> dict:
    pdf = pdfium.PdfDocument(data)
    try:
        count = len(pdf)
        pages, blocks = [], []
        for no in _page_window(count, page_range):
            page = pdf[no - 1]
            width, height = page.get_size()
            pages.append({"no": no, "width": float(width), "height": float(height)})
            textpage = page.get_textpage()
            text = _clean(textpage.get_text_bounded())
            textpage.close()
            page.close()
            blocks.append(
                {
                    "id": f"blk_p{no}",
                    "page": no,
                    "bbox": [0.0, 0.0, float(width), float(height)],
                    "type": "text",
                    "text": text,
                    "confidence": 0.9 if text else 0.0,
                }
            )
        doc = {"parser": {"id": "heavy-pypdfium2", "version": ENGINE_VERSION}, "pageCount": count, "pages": pages, "blocks": blocks}
        toc = _toc(pdf)
        if toc:
            doc["toc"] = toc
        return doc
    finally:
        pdf.close()


_DOCLING_TYPES = {
    "title": "heading",
    "section_header": "heading",
    "page_header": None,
    "page_footer": None,
    "text": "text",
    "paragraph": "text",
    "footnote": "text",
    "list_item": "list",
    "caption": "caption",
    "picture": "figure",
    "chart": "figure",
    "table": "table",
    "formula": "formula",
}


def parse_docling(data: bytes, page_range: Optional[tuple[int, int]] = None) -> dict:
    """Layout-aware parse. Not exercised in CI (the image is ~2 GB); see README "pending"."""
    from docling.datamodel.base_models import DocumentStream
    from docling.document_converter import DocumentConverter

    base = parse_pypdfium2(data, page_range)
    heights = {p["no"]: p["height"] for p in base["pages"]}
    window = set(heights)
    result = DocumentConverter().convert(DocumentStream(name="input.pdf", stream=io.BytesIO(data)))
    document = result.document
    blocks = []
    for i, (item, _level) in enumerate(document.iterate_items()):
        label = str(getattr(item, "label", "")).split(".")[-1].lower()
        kind = _DOCLING_TYPES.get(label, "text")
        prov = (getattr(item, "prov", None) or [None])[0]
        if kind is None or prov is None or prov.page_no not in window:
            continue
        bb = prov.bbox.to_top_left_origin(page_height=heights[prov.page_no])
        block = {
            "id": f"blk_p{prov.page_no}_{i}",
            "page": prov.page_no,
            "bbox": [float(bb.l), float(bb.t), float(bb.r), float(bb.b)],
            "type": kind,
            "confidence": 0.8,
        }
        text = getattr(item, "text", None)
        if text:
            block["text"] = _clean(text)
        if kind == "table" and hasattr(item, "export_to_html"):
            block["html"] = item.export_to_html(doc=document)
        blocks.append(block)
    base["parser"] = {"id": "heavy-docling", "version": ENGINE_VERSION}
    if blocks:
        base["blocks"] = blocks
    return base


def parse_pdf(data: bytes, engine: str = "pypdfium2", page_range: Optional[tuple[int, int]] = None) -> dict:
    if engine == "docling":
        return parse_docling(data, page_range)
    return parse_pypdfium2(data, page_range)
