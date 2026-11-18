from pathlib import Path
import os
from playwright.sync_api import sync_playwright
project=Path(__file__).resolve().parent.parent
src=(project/'dist/src/scanner.js').read_text(encoding='utf-8')
start='return target.evaluate(({ containers }) => {'
end='}, { containers: hints.questionContainers });'
assert start in src and end in src
scanner='({ containers }) => {'+src.split(start,1)[1].split(end,1)[0]+'}'
other=(project/'dist/src/lms/advanced-adapters.js').read_text(encoding='utf-8')
start='const scan = await target.evaluate(({ blockId, qid, mode }) => {'
end='}, { blockId, qid: q.id, mode:'
assert start in other and end in other
adapter='({blockId,qid,mode}) => {'+other.split(start,1)[1].split(end,1)[0]+'}'
passed=0

def html(typ,inner):
 return f'<html><body><div class="que {typ}" id="question-7001-1"><div class="formulation"><div class="qtext">{inner}</div></div></div></body></html>'
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,args=['--no-sandbox'],**({'executable_path':os.environ['AUTOTASK_CHROMIUM_EXECUTABLE_PATH']} if os.environ.get('AUTOTASK_CHROMIUM_EXECUTABLE_PATH') else {}))
 pg=browser.new_page()
 pg.set_content(html('shortanswer','What is <math><mfrac><mn>1</mn><mn>2</mn></mfrac></math> + 1? <input type="text" name="q7001:1_answer">'))
 qs=pg.evaluate(scanner,{'containers':['.question']})
 assert len(qs)==1,qs
 assert r'\frac{1}{2}' in qs[0]['prompt'],qs
 passed+=1;print('PASS BROWSER-MATH: MathML without TeX annotation is recovered accurately')
 pg.set_content(html('ordering','Order items') .replace('</div></div></body>', '<div class="sortablelist"><div class="sortableitem" draggable="true">A</div><div class="sortableitem" draggable="true">B</div></div></div></body>'))
 out=pg.evaluate(adapter,{'blockId':'question-7001-1','qid':'m1','mode':'ordering'})
 assert out and len(out['items'])==2,out
 assert pg.locator('[data-atqa-choice="m1_o0"]').count()==1
 passed+=1;print('PASS BROWSER-ORDER: ordering item IDs attached to actual DOM')
 pg.set_content('<html><body><div class="que ddwtos" id="question-7001-1"><div class="qtext">Drag</div><div class="formulation"><div class="draghome"><div draggable="true">Paris</div></div><div class="dropzone" data-dropzone="France" style="width:120px;height:40px">&nbsp;</div></div></div></body></html>')
 out=pg.evaluate(adapter,{'blockId':'question-7001-1','qid':'m1','mode':'dragdrop'})
 assert out and out['items'][0]['text']=='Paris' and out['zones'][0]['text']=='France',out
 passed+=1;print('PASS BROWSER-DRAG: drag item and target zone identified from local fixture')
 pg.set_content('<html><body><div class="que coderunner" id="question-7001-1"><div class="formulation"><textarea class="coderunner-answer" style="min-width:120px"> </textarea></div></div></body></html>')
 out=pg.evaluate(adapter,{'blockId':'question-7001-1','qid':'m1','mode':'code'})
 assert out and pg.locator('[data-atqa-id="m1"]').count()==1,out
 passed+=1;print('PASS BROWSER-CODE: visible CodeRunner draft field recognised')
 pg.set_content('<html><body><div class="que essay" id="question-7001-1"><div class="formulation"><div class="filemanager"><a class="fp-btn-add" role="button">Add...</a><div class="fp-content"></div></div></div></div></body></html>')
 out=pg.evaluate(adapter,{'blockId':'question-7001-1','qid':'m1_att','mode':'file'})
 assert out and pg.locator('.filemanager[data-atqa-id="m1_att"]').count()==1,out
 passed+=1;print('PASS BROWSER-FILE: Moodle-like filemanager detected without using hidden inputs')
 pg.set_content('<html><body><div class="que ordering" id="question-7001-1"><div class="formulation"><div class="sortablelist"><div class="sortableitem">Same</div><div class="sortableitem">Same</div></div></div></div></body></html>')
 out=pg.evaluate(adapter,{'blockId':'question-7001-1','qid':'m1','mode':'ordering'})
 assert out is None,out
 passed+=1;print('PASS BROWSER-AMBIGUOUS: duplicated ordering labels refused')
 browser.close()
print(f'BROWSER DOM RESULT {passed}/{passed} PASS, synthetic local HTML only')
