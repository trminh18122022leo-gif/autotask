"""Safe Microsoft Word UI/COM automation worker for AutoTask AI.
Launches or attaches to the user's visible Microsoft Word (WINWORD.EXE),
types structured Vietnamese/Unicode essay/report content live into a new document,
saves it directly as .docx (without hitting OneDrive Save-As modals),
closes only the newly created document to release file locks, and preserves
any pre-existing user Word windows/documents.
"""
from __future__ import annotations

import argparse
import ctypes
import gc
import json
import os
import re
import sys
import time
import uuid
import winreg
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT_DIR = ROOT / 'artifacts' / 'word-assignments'
BLOCKED_SEGMENTS = {'.private', '.ssh', '.git'}
WD_FORMAT_XML_DOCUMENT = 16  # .docx


def find_word_executable() -> str | None:
    for reg_root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for subkey in (
            r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE',
            r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE',
        ):
            try:
                with winreg.OpenKey(reg_root, subkey) as k:
                    val, _ = winreg.QueryValueEx(k, '')
                    if val and Path(val).exists():
                        return str(val)
            except OSError:
                continue
    for cand in (
        r'C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE',
        r'C:\Program Files (x86)\Microsoft Office\root\Office16\WINWORD.EXE',
    ):
        if Path(cand).exists():
            return cand
    return None


def is_word_com_registered() -> bool:
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r'Word.Application\CLSID'):
            return True
    except OSError:
        return False


def check_environment() -> dict:
    info = {
        'ok': False,
        'platform': sys.platform,
        'wordExecutable': None,
        'wordComRegistered': False,
        'win32comAvailable': False,
        'pywinautoAvailable': False,
        'pythonDocxAvailable': False,
    }
    if sys.platform != 'win32':
        return info

    info['wordExecutable'] = find_word_executable()
    info['wordComRegistered'] = is_word_com_registered()

    for mod, key in (
        ('win32com.client', 'win32comAvailable'),
        ('pywinauto', 'pywinautoAvailable'),
        ('docx', 'pythonDocxAvailable'),
    ):
        try:
            __import__(mod)
            info[key] = True
        except Exception:
            info[key] = False

    info['ok'] = bool(info['wordComRegistered'] and info['win32comAvailable'])
    return info


def resolve_safe_output_path(raw_path: str | None, title: str) -> Path:
    if raw_path and str(raw_path).strip():
        s = str(raw_path).strip()
        if re.match(r'^[a-zA-Z]+://', s):
            raise ValueError('URL output path is not allowed')
        p = Path(s).expanduser().resolve()
        if p.suffix.lower() != '.docx':
            raise ValueError('Word output file must end with .docx')
        if any(part.lower() in BLOCKED_SEGMENTS for part in p.parts):
            raise ValueError('Sensitive output path segment is not permitted')
        if p.exists() and p.is_symlink():
            raise ValueError('Refusing symlink output path')
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    DEFAULT_OUT_DIR.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r'[^A-Za-z0-9_-]+', '-', title or 'assignment').strip('-')[:40] or 'assignment'
    return (DEFAULT_OUT_DIR / f'{slug}-{uuid.uuid4().hex[:8]}.docx').resolve()


def com_retry(fn, attempts: int = 12, delay_s: float = 0.25):
    """Retries transient COM RPC_E_CALL_REJECTED / UI-busy errors cleanly."""
    last_err = None
    for _ in range(attempts):
        try:
            return fn()
        except Exception as err:
            last_err = err
            msg = str(err)
            if '-2147418111' in msg or 'Call was rejected by callee' in msg or '-2147417846' in msg:
                time.sleep(delay_s)
                continue
            raise
    raise last_err


def bring_word_to_front(app) -> None:
    try:
        app.WindowState = 0  # wdWindowStateNormal
    except Exception:
        pass
    try:
        hwnd = None
        try:
            hwnd = int(app.ActiveWindow.Hwnd)
        except Exception:
            hwnd = ctypes.windll.user32.FindWindowW('OpusApp', None)
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            ctypes.windll.user32.SetForegroundWindow(hwnd)
    except Exception:
        pass
    try:
        app.Activate()
    except Exception:
        pass


def normalize_inline_markdown(line: str) -> str:
    # Strip markdown emphasis markers while preserving exact text and Vietnamese diacritics
    cleaned = re.sub(r'\*\*(.+?)\*\*', r'\1', line)
    cleaned = re.sub(r'__(.+?)__', r'\1', cleaned)
    cleaned = re.sub(r'`([^`]+)`', r'\1', cleaned)
    return cleaned


def insert_markdown_table_into_word(doc, sel, raw_table_lines: list[str]) -> None:
    parsed_rows: list[list[str]] = []
    for ln in raw_table_lines:
        trimmed = ln.strip().strip('|')
        cells = [normalize_inline_markdown(c.strip()) for c in trimmed.split('|')]
        # Skip markdown separator row like --- | :---: | ---
        if cells and all(re.match(r'^:?-{2,}:?$', c.replace(' ', '')) for c in cells if c):
            continue
        if cells:
            parsed_rows.append(cells)

    if not parsed_rows:
        return
    num_cols = max(len(r) for r in parsed_rows)
    if num_cols <= 0:
        return

    def build_table():
        tbl = doc.Tables.Add(sel.Range, len(parsed_rows), num_cols)
        try:
            tbl.Borders.Enable = True
        except Exception:
            pass
        for r_idx, row_cells in enumerate(parsed_rows, start=1):
            for c_idx in range(1, num_cols + 1):
                val = row_cells[c_idx - 1] if c_idx - 1 < len(row_cells) else ''
                cell_range = tbl.Cell(r_idx, c_idx).Range
                cell_range.Text = val
                cell_range.Font.Name = 'Times New Roman'
                cell_range.Font.Size = 12
                cell_range.Font.Bold = (r_idx == 1)
        # Move Selection cleanly right after the created table
        end_pos = tbl.Range.End
        doc.Range(end_pos, end_pos).Select()
        sel.TypeParagraph()

    com_retry(build_table)


def write_lines_into_word_selection(
    app,
    doc,
    title: str,
    content: str,
    type_delay_ms: int,
    student_header: str | None = None,
    append_mode: bool = False
) -> None:
    sel = com_retry(lambda: doc.ActiveWindow.Selection)
    if append_mode:
        com_retry(lambda: sel.EndKey(6))  # wdStory = 6
        com_retry(lambda: sel.TypeParagraph())

    # Set base Normal style font for Vietnamese academic readability
    try:
        normal_style = doc.Styles('Normal')
        normal_style.Font.Name = 'Times New Roman'
        normal_style.Font.Size = 13
    except Exception:
        pass

    delay_s = max(0, min(int(type_delay_ms), 40)) / 1000.0

    # 1. Optional Student Header + Centered Bold Title
    if student_header and student_header.strip():
        hdr = str(student_header).strip()[:300]
        def write_header():
            sel.ParagraphFormat.Alignment = 0
            sel.Font.Name = 'Times New Roman'
            sel.Font.Size = 12
            sel.Font.Italic = True
            sel.TypeText(hdr)
            sel.TypeParagraph()
            sel.Font.Italic = False
        com_retry(write_header)

    def write_title():
        sel.ParagraphFormat.Alignment = 1  # wdAlignParagraphCenter
        sel.Font.Name = 'Times New Roman'
        sel.Font.Size = 16
        sel.Font.Bold = True
        sel.TypeText(title[:160])
        sel.TypeParagraph()
        sel.Font.Bold = False
        sel.Font.Size = 13
        sel.ParagraphFormat.Alignment = 0  # wdAlignParagraphLeft

    com_retry(write_title)
    if delay_s > 0:
        time.sleep(delay_s)

    # 2. Structured body lines typed live inside Word (headings, bullets, numbered lists, Markdown tables)
    lines = content.splitlines()
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped:
            com_retry(lambda: sel.TypeParagraph())
            i += 1
            continue

        # Detect contiguous Markdown table block
        if stripped.startswith('|') and '|' in stripped[1:]:
            table_block: list[str] = []
            while i < len(lines) and lines[i].strip().startswith('|') and '|' in lines[i].strip()[1:]:
                table_block.append(lines[i])
                i += 1
            insert_markdown_table_into_word(doc, sel, table_block)
            continue

        heading_match = re.match(r'^(#{1,3})\s+(.+)$', stripped)
        if heading_match:
            level = len(heading_match.group(1))
            h_text = normalize_inline_markdown(heading_match.group(2).strip())

            def write_heading(lvl=level, txt=h_text):
                sel.Font.Name = 'Times New Roman'
                sel.Font.Bold = True
                sel.Font.Size = 15 if lvl == 1 else (14 if lvl == 2 else 13)
                sel.TypeText(txt)
                sel.TypeParagraph()
                sel.Font.Bold = False
                sel.Font.Size = 13

            com_retry(write_heading)
            if delay_s > 0:
                time.sleep(delay_s)
            i += 1
            continue

        bullet_match = re.match(r'^[-*•]\s+(.+)$', stripped)
        num_match = re.match(r'^(\d+[.)])\s+(.+)$', stripped)
        if bullet_match:
            body_text = f'• {bullet_match.group(1)}'
        elif num_match:
            body_text = f'{num_match.group(1)} {num_match.group(2)}'
        else:
            body_text = stripped
        body_text = normalize_inline_markdown(body_text)

        def write_body(txt=body_text):
            sel.Font.Name = 'Times New Roman'
            sel.Font.Bold = False
            sel.Font.Size = 13
            # Type in safe chunks so long paragraphs appear progressively without COM buffer overflow
            chunk_size = 180
            for idx in range(0, len(txt), chunk_size):
                sel.TypeText(txt[idx : idx + chunk_size])
                if delay_s > 0:
                    time.sleep(delay_s)
            sel.TypeParagraph()

        com_retry(write_body)
        i += 1


def compose_in_live_word(payload: dict) -> dict:
    if sys.platform != 'win32':
        raise RuntimeError('Microsoft Word automation requires Windows')

    title = str(payload.get('title') or 'Bài tập tự luận').strip()[:160]
    content = str(payload.get('content') or '')
    if not content.strip() or len(content) > 150_000:
        raise ValueError('Content must be non-empty and <= 150000 characters')

    visible = payload.get('visible', True) is not False
    type_delay_ms = int(payload.get('typeDelayMs', 6) or 0)
    keep_open = bool(payload.get('keepOpen', False))
    student_header = payload.get('studentHeader')
    raw_template = payload.get('templatePath')
    template_path = None
    if raw_template and str(raw_template).strip():
        tp = Path(str(raw_template).strip()).expanduser().resolve()
        if tp.suffix.lower() != '.docx' or not tp.exists() or not tp.is_file() or tp.is_symlink():
            raise ValueError('Invalid Word templatePath')
        if any(part.lower() in BLOCKED_SEGMENTS for part in tp.parts):
            raise ValueError('Sensitive templatePath is not permitted')
        template_path = tp

    abs_path = resolve_safe_output_path(payload.get('outputPath'), title)

    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    app = None
    doc = None
    was_already_running = False
    prev_alerts = None

    try:
        try:
            app = win32com.client.GetActiveObject('Word.Application')
            was_already_running = True
        except Exception:
            app = win32com.client.DispatchEx('Word.Application')
            was_already_running = False

        prev_alerts = getattr(app, 'DisplayAlerts', None)
        app.DisplayAlerts = 0  # wdAlertsNone to suppress blocking Save/Compatibility prompts
        app.Visible = visible

        if template_path is not None:
            doc = com_retry(lambda: app.Documents.Open(str(template_path)))
        else:
            doc = com_retry(lambda: app.Documents.Add())
        if visible:
            bring_word_to_front(app)

        write_lines_into_word_selection(
            app,
            doc,
            title,
            content,
            type_delay_ms,
            student_header=str(student_header) if student_header else None,
            append_mode=(template_path is not None)
        )

        # Explicitly SaveAs2 .docx then Save() so Word commits directly without OneDrive Backstage modal
        com_retry(lambda: doc.SaveAs2(str(abs_path), FileFormat=WD_FORMAT_XML_DOCUMENT))
        com_retry(lambda: doc.Save())

        saved_flag = bool(com_retry(lambda: doc.Saved))
        word_count = int(com_retry(lambda: doc.ComputeStatistics(0)))
        para_count = int(com_retry(lambda: doc.Paragraphs.Count))
        window_title = str(com_retry(lambda: getattr(app, 'Caption', '') or doc.Name))

        if not keep_open:
            com_retry(lambda: doc.Close(0))
            doc = None
            lock_file = abs_path.with_name('~$' + abs_path.name[2:] if len(abs_path.name) > 8 else '~$' + abs_path.name)
            for _ in range(20):
                if not lock_file.exists():
                    break
                time.sleep(0.1)
            time.sleep(0.15)

        if not abs_path.exists():
            raise RuntimeError(f'Word saved call finished but file missing on disk: {abs_path}')

        file_bytes = abs_path.read_bytes()
        if len(file_bytes) < 500 or not file_bytes.startswith(b'PK'):
            raise RuntimeError('Saved Word file is not a valid OOXML (.docx) archive')

        return {
            'ok': True,
            'engine': 'microsoft-word-live',
            'path': str(abs_path),
            'bytes': len(file_bytes),
            'wordCount': word_count,
            'paragraphCount': para_count,
            'saved': saved_flag,
            'windowTitle': window_title,
            'wasAlreadyRunning': was_already_running,
        }
    finally:
        if doc is not None and not keep_open:
            try:
                doc.Close(0)
            except Exception:
                pass
        if app is not None:
            if prev_alerts is not None and was_already_running:
                try:
                    app.DisplayAlerts = prev_alerts
                except Exception:
                    pass
            try:
                remaining_docs = int(app.Documents.Count)
            except Exception:
                remaining_docs = 1
            if not was_already_running and not keep_open and remaining_docs == 0:
                try:
                    app.Quit(0)
                except Exception:
                    pass
        doc = None
        app = None
        gc.collect()
        pythoncom.CoUninitialize()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Check Word COM/executable availability without opening Word')
    args, _ = parser.parse_known_args()

    if args.check:
        print(json.dumps(check_environment(), ensure_ascii=False))
        return 0

    try:
        raw = sys.stdin.read(250_000)
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError('JSON object payload required')
        result = compose_in_live_word(payload)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as err:
        print(json.dumps({'ok': False, 'error': str(err)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
