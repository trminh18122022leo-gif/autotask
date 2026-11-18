"""Handwriting synthesis worker for AutoTask AI.
Analyzes an optional user handwriting sample image (.png/.jpg) or custom font (.ttf/.otf)
to match ink color, stroke weight, baseline jitter, and spacing, then renders authentic
multi-page handwritten assignments onto notebook paper (lined/grid/blank) as PDF, PNG, or DOCX.
"""
from __future__ import annotations

import json
import random
import re
import sys
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / 'artifacts' / 'handwriting'
BLOCKED_SEGMENTS = {'.private', '.ssh', '.git'}
SUPPORTED_OUT_FORMATS = {'pdf', 'png', 'docx'}

WINDOWS_FONT_CANDIDATES = [
    r'C:\Windows\Fonts\inkfree.ttf',
    r'C:\Windows\Fonts\segoesc.ttf',
    r'C:\Windows\Fonts\segoepr.ttf',
    r'C:\Windows\Fonts\comic.ttf',
    r'C:\Windows\Fonts\calibrii.ttf',
    r'C:\Windows\Fonts\ariali.ttf',
]


def validate_safe_path(raw: str | None, allowed_exts: set[str], must_exist: bool) -> Path | None:
    if not raw or not str(raw).strip():
        return None
    s = str(raw).strip()
    if re.match(r'^[a-zA-Z]+://', s):
        raise ValueError('URL paths are not allowed')
    p = Path(s).expanduser().resolve()
    if any(part.lower() in BLOCKED_SEGMENTS for part in p.parts):
        raise ValueError('Sensitive path segment is not permitted')
    if p.suffix.lower() not in allowed_exts:
        raise ValueError(f'Unsupported file extension: {p.suffix}')
    if must_exist:
        if not p.exists() or not p.is_file() or p.is_symlink():
            raise ValueError(f'File does not exist or is symlink: {p}')
    else:
        if p.exists() and p.is_symlink():
            raise ValueError('Refusing symlink output path')
    return p


def analyze_handwriting_sample(sample_path: Path | None) -> dict:
    """Extracts user handwriting visual style (ink RGB, stroke thickness, slant, jitter)."""
    style = {
        'inkRgb': (24, 52, 138),  # natural dark blue ballpoint default
        'strokeWeight': 0,
        'slantRatio': -0.05,
        'jitterPx': 1.6,
        'customFontPath': None,
        'usedCustomSample': False,
    }
    if sample_path is None:
        return style

    ext = sample_path.suffix.lower()
    if ext in {'.ttf', '.otf'}:
        style['customFontPath'] = str(sample_path)
        style['usedCustomSample'] = True
        return style

    if ext in {'.png', '.jpg', '.jpeg'}:
        img = Image.open(sample_path).convert('RGB')
        img.thumbnail((600, 600))
        pixels = list(img.getdata())
        # Separate dark ink strokes from bright paper background
        # Keep non-white pixels (brightness significantly darker than median bright background)
        sorted_lum = sorted(int(0.299 * r + 0.587 * g + 0.114 * b) for r, g, b in pixels)
        bg_lum = sorted_lum[int(len(sorted_lum) * 0.85)] if sorted_lum else 245
        ink_thresh = max(35, bg_lum - 55)

        ink_pixels = [
            (r, g, b)
            for (r, g, b) in pixels
            if (0.299 * r + 0.587 * g + 0.114 * b) < ink_thresh
        ]

        if len(ink_pixels) >= 12:
            avg_r = sum(p[0] for p in ink_pixels) // len(ink_pixels)
            avg_g = sum(p[1] for p in ink_pixels) // len(ink_pixels)
            avg_b = sum(p[2] for p in ink_pixels) // len(ink_pixels)
            style['inkRgb'] = (avg_r, avg_g, avg_b)

            ink_density = len(ink_pixels) / max(1, len(pixels))
            style['strokeWeight'] = 1 if ink_density > 0.09 else 0
            # Derive subtle natural baseline jitter from ink ratio bounded smoothly
            style['jitterPx'] = round(min(2.6, max(1.1, 1.3 + ink_density * 6.0)), 2)
            style['usedCustomSample'] = True

    return style


def select_vietnamese_font(custom_font_path: str | None, size: int) -> ImageFont.FreeTypeFont:
    candidates = ([custom_font_path] if custom_font_path else []) + WINDOWS_FONT_CANDIDATES
    for fp in candidates:
        if not fp:
            continue
        p = Path(fp)
        if p.exists():
            try:
                font = ImageFont.truetype(str(p), size)
                # Ensure key Vietnamese glyphs exist
                if all(font.getbbox(ch) is not None for ch in 'ăđơư'):
                    return font
            except Exception:
                continue
    return ImageFont.load_default()


def draw_paper_background(width: int, height: int, paper_style: str, margin_left: int, top_margin: int, line_height: int) -> Image.Image:
    # Subtle warm paper tone with organic grain
    paper_color = (250, 249, 244)
    img = Image.new('RGB', (width, height), paper_color)
    draw = ImageDraw.Draw(img)

    if paper_style == 'lined':
        # Light cyan horizontal ruled lines + classic pink/red vertical left margin
        for y in range(top_margin + line_height, height - 90, line_height):
            draw.line([(45, y), (width - 45, y)], fill=(208, 224, 240), width=2)
        draw.line([(margin_left - 24, 45), (margin_left - 24, height - 45)], fill=(232, 165, 165), width=2)
    elif paper_style == 'grid':
        step = max(24, line_height // 2)
        for y in range(60, height - 60, step):
            draw.line([(45, y), (width - 45, y)], fill=(216, 229, 242), width=1)
        for x in range(45, width - 45, step):
            draw.line([(x, 60), (x, height - 60)], fill=(216, 229, 242), width=1)
        draw.line([(margin_left - 20, 60), (margin_left - 20, height - 60)], fill=(224, 172, 172), width=2)

    return img


def wrap_paragraph(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    cleaned = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    cleaned = re.sub(r'^#{1,3}\s+', '', cleaned).strip()
    if not cleaned:
        return []
    words = cleaned.split(' ')
    lines: list[str] = []
    cur = ''
    for w in words:
        cand = f'{cur} {w}'.strip() if cur else w
        bbox = font.getbbox(cand)
        w_px = (bbox[2] - bbox[0]) if bbox else len(cand) * 14
        if w_px <= max_width or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def generate_handwritten_document(payload: dict) -> dict:
    title = str(payload.get('title') or 'Bài tập tự luận viết tay').strip()[:140]
    content = str(payload.get('content') or '')
    if not content.strip() or len(content) > 80_000:
        raise ValueError('Content must be non-empty and <= 80000 characters')

    out_fmt = str(payload.get('outputFormat') or 'pdf').lower().strip()
    if out_fmt not in SUPPORTED_OUT_FORMATS:
        raise ValueError(f'Unsupported handwriting output format: {out_fmt}')

    paper_style = str(payload.get('paperStyle') or 'lined').lower().strip()
    if paper_style not in {'lined', 'grid', 'blank'}:
        paper_style = 'lined'

    sample_path = validate_safe_path(payload.get('samplePath'), {'.png', '.jpg', '.jpeg', '.ttf', '.otf'}, must_exist=True)
    style = analyze_handwriting_sample(sample_path)

    explicit_out = validate_safe_path(payload.get('outputPath'), {f'.{out_fmt}'}, must_exist=False)
    if explicit_out is not None:
        out_path = explicit_out
        out_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r'[^A-Za-z0-9_-]+', '-', title)[:35].strip('-') or 'handwritten'
        out_path = (OUT_DIR / f'{slug}-{uuid.uuid4().hex[:8]}.{out_fmt}').resolve()

    # A4 portrait at crisp 150 DPI
    page_w, page_h = 1240, 1754
    margin_left = 130
    margin_right = 90
    top_margin = 120
    line_height = 54
    usable_w = page_w - margin_left - margin_right

    title_font = select_vietnamese_font(style['customFontPath'], 36)
    body_font = select_vietnamese_font(style['customFontPath'], 28)

    # Expand input lines into visual lines preserving paragraphs and headings
    visual_rows: list[tuple[str, bool]] = [(title, True), ('', False)]
    for raw_line in content.splitlines():
        s = raw_line.strip()
        if not s:
            visual_rows.append(('', False))
            continue
        is_heading = bool(re.match(r'^#{1,3}\s+', s))
        active_font = title_font if is_heading else body_font
        for wl in wrap_paragraph(s, active_font, usable_w):
            visual_rows.append((wl, is_heading))

    rng = random.Random(42)
    ink = tuple(style['inkRgb'])
    jitter = float(style['jitterPx'])
    pages: list[Image.Image] = []

    def new_page() -> tuple[Image.Image, ImageDraw.ImageDraw, int]:
        p = draw_paper_background(page_w, page_h, paper_style, margin_left, top_margin, line_height)
        return p, ImageDraw.Draw(p), top_margin + 10

    cur_img, cur_draw, y = new_page()
    for text_line, is_heading in visual_rows:
        if y > page_h - 115:
            pages.append(cur_img)
            cur_img, cur_draw, y = new_page()

        if text_line:
            fnt = title_font if is_heading else body_font
            # Slightly darker shade for headings/title to mimic emphasis
            line_ink = tuple(max(0, c - 15) for c in ink) if is_heading else ink
            x = margin_left + (18 if not is_heading else 0) + rng.uniform(-2.0, 2.0)

            for token in text_line.split(' '):
                dx = rng.uniform(-0.8, 0.8)
                dy = rng.uniform(-jitter, jitter)
                word_str = token + ' '
                cur_draw.text((x + dx, y + dy), word_str, font=fnt, fill=line_ink)
                if style['strokeWeight'] > 0:
                    cur_draw.text((x + dx + 0.6, y + dy + 0.3), word_str, font=fnt, fill=line_ink)
                bbox = fnt.getbbox(word_str)
                adv = (bbox[2] - bbox[0]) if bbox else len(word_str) * 14
                x += adv + rng.uniform(-0.5, 1.5)
        y += line_height

    pages.append(cur_img)

    # Apply tiny organic tilt/scan softening to mimic real handwritten paper photo
    final_pages: list[Image.Image] = []
    for p in pages:
        tilted = p.rotate(rng.uniform(-0.35, 0.35), resample=Image.BICUBIC, expand=False, fillcolor=(248, 247, 242))
        tilted = tilted.filter(ImageFilter.GaussianBlur(radius=0.25))
        final_pages.append(tilted)

    if out_fmt == 'pdf':
        final_pages[0].save(
            str(out_path),
            'PDF',
            resolution=150.0,
            save_all=True,
            append_images=final_pages[1:]
        )
    elif out_fmt == 'png':
        # If multiple pages requested in PNG mode, stitch vertically into one submission image
        if len(final_pages) == 1:
            final_pages[0].save(str(out_path), 'PNG')
        else:
            stitched = Image.new('RGB', (page_w, page_h * len(final_pages)), (248, 247, 242))
            for idx, pg in enumerate(final_pages):
                stitched.paste(pg, (0, idx * page_h))
            stitched.save(str(out_path), 'PNG')
    else:
        # docx with embedded handwritten page images
        from docx import Document
        from docx.shared import Inches
        doc = Document()
        temp_imgs: list[Path] = []
        try:
            for idx, pg in enumerate(final_pages):
                tmp_png = out_path.with_name(f'.tmp-hw-{uuid.uuid4().hex[:8]}-{idx}.png')
                pg.save(str(tmp_png), 'PNG')
                temp_imgs.append(tmp_png)
                doc.add_picture(str(tmp_png), width=Inches(6.3))
            doc.save(str(out_path))
        finally:
            for tp in temp_imgs:
                try:
                    tp.unlink()
                except OSError:
                    pass

    size = out_path.stat().st_size
    return {
        'ok': True,
        'path': str(out_path),
        'bytes': size,
        'format': out_fmt,
        'pages': len(final_pages),
        'inkRgb': list(ink),
        'usedCustomSample': style['usedCustomSample']
    }


if __name__ == '__main__':
    try:
        req = json.loads(sys.stdin.read(160_000))
        if not isinstance(req, dict):
            raise ValueError('JSON object required')
        print(json.dumps(generate_handwritten_document(req), ensure_ascii=False))
    except Exception as err:
        print(json.dumps({'ok': False, 'error': str(err)}, ensure_ascii=False))
        sys.exit(1)
