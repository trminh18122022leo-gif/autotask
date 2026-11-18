"""Local synthetic form data, no real user data or network requests."""
import sys
from pathlib import Path
from openpyxl import Workbook
from docx import Document
from reportlab.pdfgen.canvas import Canvas

folder = Path(sys.argv[1])
folder.mkdir(parents=True,exist_ok=True)
wb=Workbook();s=wb.active;s.title='Fields'
s.append(['Question','Answer']);s.append(['Student display name','Example Person']);s.append(['Field number','42']);wb.save(folder/'form.xlsx')
doc=Document();doc.add_paragraph('Q: Contact preference');doc.add_paragraph('A: Email')
t=doc.add_table(rows=0,cols=2);t.add_row().cells[0].text='City';t.rows[0].cells[1].text='Ha Noi';doc.save(folder/'form.docx')
c=Canvas(str(folder/'form.pdf'));c.drawString(72,700,'Q: Event title');c.drawString(72,680,'A: Weekly workshop');c.showPage();c.save()
