"""Safe local document text extractor for AutoTask AI (PDF, DOCX, TXT/MD/CSV).
Reads JSON from stdin: { "path": "...", "maxChars": 4000 }
Emits JSON to stdout: { "ok": true, "text": "...", "format": "pdf" }
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BLOCKED_SEGMENTS = {'.private', '.ssh', '.git'}
SUPPORTED_EXTS = {'.pdf', '.docx', '.txt', '.md', '.csv'}


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

    max_chars = max(200, min(int(payload.get('maxChars', 4000) or 4000), 25000))
    chunks: list[str] = []

    if ext == '.pdf':
        from pypdf import PdfReader
        reader = PdfReader(str(p))
        for page in reader.pages[:40]:
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
