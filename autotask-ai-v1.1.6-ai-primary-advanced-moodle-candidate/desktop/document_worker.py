"""Safe, constrained Word/PDF/Excel document generation from user-approved plain text.
Receives one JSON payload on stdin; emits JSON containing only generated path/size.
"""
import json, sys, re, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts'
FONTS=['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','C:/Windows/Fonts/arial.ttf']
EXTENSIONS={'txt','md','csv','docx','pdf','xlsx'}

def validate(payload):
    if not isinstance(payload,dict):raise ValueError('Object required')
    kind=payload.get('format','txt').lower()
    if kind not in EXTENSIONS:raise ValueError('Unsupported document format')
    title=str(payload.get('title') or 'Generated document')[:120]
    text=str(payload.get('content') or '')
    if len(text)>150_000 or not text.strip():raise ValueError('Content missing or too long')
    return kind,title,text

def generate(payload):
    kind,title,content=validate(payload)
    OUT.mkdir(parents=True,exist_ok=True)
    safe=re.sub(r'[^A-Za-z0-9_-]+','-',str(payload.get('baseName') or 'document'))[:45].strip('-') or 'document'
    path=OUT/f'{safe}-{uuid.uuid4().hex[:10]}.{kind}'
    if kind in ('txt','md','csv'):
        path.write_text(content,'utf-8')
    elif kind=='docx':
        from docx import Document
        from docx.shared import Pt
        doc=Document();doc.add_heading(title,0)
        for paragraph in content.splitlines():
            doc.add_paragraph(paragraph)
        doc.styles['Normal'].font.size=Pt(11)
        doc.save(path)
    elif kind=='pdf':
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import simpleSplit
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        font='Helvetica'
        for candidate in FONTS:
            if Path(candidate).exists():
                pdfmetrics.registerFont(TTFont('ATUnicode',candidate));font='ATUnicode';break
        c=canvas.Canvas(str(path),pagesize=(595.27,841.89))
        c.setTitle(title);c.setFont(font,15);c.drawString(45,800,title[:85]);c.setFont(font,10.5)
        y=776
        for paragraph in content.splitlines():
            for line in simpleSplit(paragraph or ' ',font,10.5,500):
                if y<55:c.showPage();c.setFont(font,10.5);y=790
                c.drawString(45,y,line);y-=16
        c.save()
    elif kind=='xlsx':
        # This worker creates a simple readable workbook from CSV-like or multiline data.
        # Does NOT evaluate arbitrary Excel formulas supplied by untrusted site content.
        from openpyxl import Workbook
        from openpyxl.styles import Font,PatternFill,Alignment
        from openpyxl.utils import get_column_letter
        import csv,io
        book=Workbook();ws=book.active;ws.title='Output'
        rows=list(csv.reader(io.StringIO(content)))
        for row in rows[:1000]:
            cleaned=[]
            for cell in row[:50]:
                s=str(cell)[:32767]
                if s.startswith(('=','+','-','@')):s="'"+s
                cleaned.append(s)
            ws.append(cleaned)
        ws.freeze_panes='A2'
        for cell in ws[1]:
            cell.font=Font(color='FFFFFF',bold=True);cell.fill=PatternFill('solid',fgColor='303C61')
        for col in ws.columns:
            width=min(42,max(12,max((len(str(c.value or '')) for c in list(col)[:100]),default=10)+3))
            ws.column_dimensions[get_column_letter(col[0].column)].width=width
        book.save(path)
    return {'path':str(path),'bytes':path.stat().st_size,'format':kind}
if __name__=='__main__':
    try:
        request=json.loads(sys.stdin.read(220000));print(json.dumps({'ok':True,**generate(request)},ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e)}));sys.exit(1)
