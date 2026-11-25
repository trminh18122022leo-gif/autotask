#!/usr/bin/env python3
"""Extract *text-only* form-entry rows from an explicitly selected XLSX/DOCX/PDF.
Never evaluates spreadsheet formulas, runs Office macros, downloads remote resources,
or performs OCR. Outputs simple JSON rows to stdout for the Node form data importer.
"""
import json
import os
import re
import sys
from pathlib import Path

MAX_ROWS = 5000
MAX_CHARS = 1200000


def qa_lines(text):
    rows = []
    question = None
    for raw in text.splitlines():
        line = raw.strip().lstrip('•*').strip()
        q = re.match(r'^(?:Q|Question|Câu hỏi|Cau hoi)\s*:\s*(.+)$', line, re.I)
        a = re.match(r'^(?:A|Answer|Đáp án|Dap an)\s*:\s*(.*)$', line, re.I)
        if q:
            question = q.group(1).strip()
        elif a and question:
            rows.append({'question': question, 'answer': a.group(1).strip()})
            question = None
        elif ' => ' in line:
            key, value = line.split(' => ', 1)
            if key.strip() and value.strip():
                rows.append({'question': key.strip(), 'answer': value.strip()})
        if len(rows) > MAX_ROWS:
            raise ValueError('Too many rows')
    return rows


def xlsx_rows(p):
    from openpyxl import load_workbook
    wb = load_workbook(p, read_only=True, data_only=True, keep_links=False)
    try:
        rows = []
        aliases = {'question': 'question', 'cauhoi': 'question', 'câuhỏi': 'question',
                   'prompt': 'prompt', 'id': 'id', 'stableid': 'stableId',
                   'answer': 'answer', 'dapan': 'answer', 'đápán': 'answer',
                   'text': 'text', 'selected': 'selected',
                   'filepath': 'filePath', 'filename': 'fileName'}
        for sheet in wb.worksheets:
            iterator = sheet.iter_rows(values_only=True)
            first = next(iterator, None)
            if not first:
                continue
            heads = [re.sub(r'[\s_-]', '', str(x or '').casefold()) for x in first]
            if not any(aliases.get(x) in {'answer','text','selected','filePath'} for x in heads):
                continue
            for values in iterator:
                row = {}
                for idx, head in enumerate(heads):
                    if head not in aliases or idx >= len(values):
                        continue
                    value = values[idx]
                    if value is not None and str(value).strip():
                        row[aliases[head]] = str(value).strip()
                if row:
                    rows.append(row)
                if len(rows) > MAX_ROWS:
                    raise ValueError('Too many form data rows')
        return rows
    finally:
        wb.close()


def docx_rows(p):
    from docx import Document
    doc = Document(p)
    text = '\n'.join(x.text for x in doc.paragraphs)
    rows = qa_lines(text[:MAX_CHARS])
    # Common two-column form-data tables: field name, value.
    for table in doc.tables:
        for tr in table.rows:
            cells = [c.text.strip() for c in tr.cells]
            if len(cells) >= 2 and cells[0] and cells[1]:
                if cells[0].casefold() not in {'question','field','trường','câu hỏi'}:
                    rows.append({'question': cells[0], 'answer': cells[1]})
            if len(rows) > MAX_ROWS:
                raise ValueError('Too many form data rows')
    return rows


def pdf_rows(p):
    from pypdf import PdfReader
    reader = PdfReader(p, strict=True)
    if len(reader.pages) > 100:
        raise ValueError('PDF too long for form-data importer')
    text = ''.join((page.extract_text() or '') + '\n' for page in reader.pages)
    if len(text) > MAX_CHARS:
        raise ValueError('PDF text too large')
    return qa_lines(text)


def main():
    if len(sys.argv) != 2:
        raise ValueError('Expected exactly one local file path')
    p = Path(sys.argv[1]).resolve(strict=True)
    if not p.is_file() or p.is_symlink() or p.stat().st_size > 4 * 1024 * 1024:
        raise ValueError('File is invalid, symlinked, or over 4 MB')
    extension = p.suffix.casefold()
    if extension == '.xlsx':
        rows = xlsx_rows(p)
    elif extension == '.docx':
        rows = docx_rows(p)
    elif extension == '.pdf':
        rows = pdf_rows(p)
    else:
        raise ValueError('Unsupported file type')
    if not rows:
        raise ValueError('No form key/value rows found (expected columns question/answer or Q:/A: text)')
    sys.stdout.write(json.dumps({'rows': rows}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Avoid outputting file content or potentially sensitive paths.
        print(f'Form importer failed: {type(exc).__name__}: {str(exc)[:140]}', file=sys.stderr)
        sys.exit(2)
