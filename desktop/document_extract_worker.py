"""Safe local document text extractor for AutoTask AI (PDF, DOCX, PPTX, TXT/MD/CSV).
Reads JSON from stdin: { "path": "...", "maxChars": 4000 }
Emits JSON to stdout: { "ok": true, "text": "...", "format": "pdf" }
"""
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

BLOCKED_SEGMENTS = {'.private', '.ssh', '.git'}
SUPPORTED_EXTS = {'.pdf', '.docx', '.pptx', '.txt', '.md', '.csv'}
MAX_ZIP_XML_BYTES = 2 * 1024 * 1024


def _extract_pptx_chunks(p: Path, max_chars: int) -> list[str]:
    chunks: list[str] = []
    acc_len = 0
    with zipfile.ZipFile(str(p), 'r') as zf:
        slide_entries = []
        notes_map: dict[int, str] = {}
        for name in zf.namelist():
            m_slide = re.fullmatch(r'ppt/slides/slide(\d+)\.xml', name)
            if m_slide:
                slide_entries.append((int(m_slide.group(1)), name))
                continue
            m_note = re.fullmatch(r'ppt/notesSlides/notesSlide(\d+)\.xml', name)
            if m_note:
                notes_map[int(m_note.group(1))] = name

        slide_entries.sort(key=lambda item: item[0])
        for slide_idx, entry_name in slide_entries[:60]:
            info = zf.getinfo(entry_name)
            if info.file_size > MAX_ZIP_XML_BYTES:
                continue
            raw_xml = zf.read(entry_name)
            root = ET.fromstring(raw_xml)
            slide_lines: list[str] = []
            # Collect paragraphs cleanly so text boxes/bullets don't merge words
            for elem in root.iter():
                tag_local = elem.tag.rsplit('}', 1)[-1]
                if tag_local == 'p':
                    p_texts = [
                        (t_node.text or '')
                        for t_node in elem.iter()
                        if t_node.tag.rsplit('}', 1)[-1] == 't' and (t_node.text or '').strip()
                    ]
                    line = ' '.join(s.strip() for s in p_texts if s.strip())
                    if line:
                        slide_lines.append(line)
            if not slide_lines:
                all_t = [
                    (node.text or '').strip()
                    for node in root.iter()
                    if node.tag.rsplit('}', 1)[-1] == 't' and (node.text or '').strip()
                ]
                if all_t:
                    slide_lines.append(' '.join(all_t))

            note_name = notes_map.get(slide_idx)
            if note_name:
                try:
                    n_info = zf.getinfo(note_name)
                    if n_info.file_size <= MAX_ZIP_XML_BYTES:
                        n_root = ET.fromstring(zf.read(note_name))
                        n_texts = [
                            (node.text or '').strip()
                            for node in n_root.iter()
                            if node.tag.rsplit('}', 1)[-1] == 't' and (node.text or '').strip()
                        ]
                        n_joined = ' '.join(n_texts).strip()
                        if n_joined and not n_joined.isdigit():
                            slide_lines.append(f'Notes: {n_joined}')
                except Exception:
                    pass

            if slide_lines:
                block = f'[Slide {slide_idx}] ' + '\n'.join(slide_lines)
                chunks.append(block)
                acc_len += len(block)
                if acc_len >= max_chars:
                    break
    return chunks


def extract_text(payload: dict) -> dict:
    raw_path = str(payload.get('path') or '').strip()
    if not raw_path or re.match(r'^[a-zA-Z]+://', raw_path):
        raise ValueError('A local file path is required')

    p = Path(raw_path).expanduser().resolve()
    if not p.exists() or not p.is_file() or p.is_symlink():
        raise ValueError('Target file does not exist or is a symlink')
    if any(part.lower() in BLOCKED_SEGMENTS for part in p.parts):
        raise ValueError('Sensitive path segment is not permitted')

    ext = p.suffix.lower()
    if ext not in SUPPORTED_EXTS:
        raise ValueError(f'Unsupported extraction format: {ext}')

    max_chars = max(200, min(int(payload.get('maxChars', 4000) or 4000), 80000))
    chunks: list[str] = []

    if ext == '.pdf':
        from pypdf import PdfReader
        reader = PdfReader(str(p))
        for page in reader.pages[:60]:
            txt = (page.extract_text() or '').strip()
            if txt:
                chunks.append(txt)
            if sum(len(c) for c in chunks) >= max_chars:
                break
    elif ext == '.docx':
        from docx import Document
        doc = Document(str(p))
        for para in doc.paragraphs:
            t = para.text.strip()
            if t:
                chunks.append(t)
        for tbl in doc.tables:
            for row in tbl.rows:
                row_txt = ' | '.join(c.text.strip() for c in row.cells if c.text.strip())
                if row_txt:
                    chunks.append(row_txt)
    elif ext == '.pptx':
        chunks.extend(_extract_pptx_chunks(p, max_chars))
    else:
        chunks.append(p.read_text(encoding='utf-8', errors='replace'))

    combined = '\n'.join(chunks)
    combined = re.sub(r'[ \t]+', ' ', combined)
    combined = re.sub(r'\n{3,}', '\n\n', combined).strip()
    return {
        'ok': True,
        'format': ext.lstrip('.'),
        'text': combined[:max_chars],
        'totalChars': len(combined)
    }


if __name__ == '__main__':
    try:
        req = json.loads(sys.stdin.read(50000))
        if not isinstance(req, dict):
            raise ValueError('JSON object required')
        print(json.dumps(extract_text(req), ensure_ascii=False))
    except Exception as err:
        print(json.dumps({'ok': False, 'error': str(err)}, ensure_ascii=False))
        sys.exit(1)
