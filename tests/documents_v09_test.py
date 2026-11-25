"""Unit/integration tests for real office documents; no user data, clean up artifacts."""
import importlib.util, pathlib, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
PATH=ROOT/'desktop'/'document_worker.py'
spec=importlib.util.spec_from_file_location('at_documents',PATH)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class DocumentFormatTests(unittest.TestCase):
    def create(self,kind,content):
        result=module.generate({'format':kind,'title':'Offline verification','baseName':'integration-test','content':content})
        self.addCleanup(lambda: pathlib.Path(result['path']).unlink(missing_ok=True))
        self.assertGreater(result['bytes'],15)
        self.assertEqual(pathlib.Path(result['path']).suffix,'.'+kind)
        return pathlib.Path(result['path'])
    def test_docx(self):
        from docx import Document
        p=self.create('docx','First paragraph\nSecond paragraph')
        text=' '.join(x.text for x in Document(p).paragraphs)
        self.assertIn('Second paragraph',text)
    def test_pdf(self):
        p=self.create('pdf','Vietnamese: Xin chào')
        self.assertTrue(p.read_bytes().startswith(b'%PDF'))
    def test_xlsx(self):
        from openpyxl import load_workbook
        p=self.create('xlsx','Name,Note\nItem,Accepted')
        wb=load_workbook(p);self.assertEqual(wb.active['B2'].value,'Accepted')
    def test_xlsx_formula_injection_is_neutralized(self):
        from openpyxl import load_workbook
        p=self.create('xlsx','Value\n=HYPERLINK("http://bad.example")')
        wb=load_workbook(p);cell=wb.active['A2']
        self.assertNotEqual(cell.data_type,'f')
        self.assertTrue(str(cell.value).startswith("'="))
if __name__=='__main__':unittest.main()
