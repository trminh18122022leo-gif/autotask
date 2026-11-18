"""Windows UIA + screenshot agent, scoped to exactly one named window.
JSONL protocol; physical input is serialized by its Node queue coordinator.
"""
import argparse
import base64
import hashlib
import io
import json
import sys
import time
from policy import check_action,is_high_risk,is_protected

class DesktopWorker:
    def __init__(self,target,allow_visual_clicks,allow_unmapped_visual_clicks=False):
        if sys.platform!='win32':raise RuntimeError('Windows 10/11 interactive session required')
        import ctypes
        ctypes.windll.user32.SetProcessDPIAware()
        import pyautogui
        from pywinauto import Desktop
        self.pg=pyautogui
        self.pg.FAILSAFE=True
        self.ui=Desktop(backend='uia')
        self.target=target.casefold()
        self.allow_visual_clicks=allow_visual_clicks
        self.allow_unmapped_visual_clicks=allow_unmapped_visual_clicks
        self.snapshot_id=0
        self.last_hwnd=None
        self.last_elements=[]
        self.last_rect=None

    def window(self):
        matches=[]
        for w in self.ui.windows(visible_only=True):
            try:
                if self.target in w.window_text().casefold() and w.is_visible():matches.append(w)
            except Exception:continue
        if len(matches)!=1:raise RuntimeError(f'Expected exactly 1 window for {self.target!r}, found {len(matches)}')
        w=matches[0]
        if self.last_hwnd is not None and w.handle!=self.last_hwnd:
            raise RuntimeError('Target window handle changed; manual review required')
        return w

    def controls(self,w):
        found=[]
        for c in w.descendants():
            if len(found)>=180:break
            try:
                role=c.element_info.control_type
                if role not in {'Button','Edit','CheckBox','RadioButton','ComboBox','ListItem','MenuItem','Hyperlink','Text','TabItem','DataItem','Document','Pane'}:continue
                r=c.rectangle()
                if not c.is_visible() or r.width()<4 or r.height()<4:continue
                name=c.window_text().strip()[:180];aid=(c.element_info.automation_id or '')[:120]
                if role in {'Text','Pane'} and not name and not aid:continue
                found.append((c,{'elementIndex':len(found),'name':name,'role':role,'automationId':aid,
                                 'bounds':[r.left,r.top,r.right,r.bottom],'enabled':bool(c.is_enabled())}))
            except Exception:continue
        return found

    def observe(self):
        w=self.window();rect=w.rectangle()
        if rect.width()<100 or rect.height()<100:raise RuntimeError('Minimized/very small window')
        self.last_hwnd=w.handle
        self.last_rect=(rect.left,rect.top,rect.width(),rect.height())
        self.last_elements=self.controls(w)
        if rect.left<0 or rect.top<0 or rect.right>self.pg.size().width or rect.bottom>self.pg.size().height:
            raise RuntimeError('Move target window inside primary monitor to continue')
        img=self.pg.screenshot(region=self.last_rect)
        img.thumbnail((1280,900))
        out=io.BytesIO();img.save(out,format='PNG',optimize=True)
        self.snapshot_id+=1
        # Screenshot fingerprint is for progress detection, not a cryptographic audit of correctness.
        fingerprint=hashlib.sha256(img.resize((64,48)).tobytes()).hexdigest()
        return {'windowTitle':w.window_text(),'observationId':self.snapshot_id,'fingerprint':fingerprint,
                'windowBounds':[rect.left,rect.top,rect.right,rect.bottom],
                'elements':[e for _,e in self.last_elements],
                'imageBase64':base64.b64encode(out.getvalue()).decode('ascii')}

    def _hit_control(self,x,y):
        hits=[]
        for c,entry in self.last_elements:
            l,t,r,b=entry['bounds']
            if l<=x<=r and t<=y<=b:hits.append(((r-l)*(b-t),entry))
        return min(hits,default=(float('inf'),None),key=lambda v:v[0])[1]

    def action(self,payload):
        action=payload.get('action');check_action(action)
        kind=action['kind']
        if kind=='done':return {'status':'done'}
        if kind=='wait':time.sleep(action['seconds']);return {'status':'ok'}
        if payload.get('observationId')!=self.snapshot_id or self.snapshot_id<1:
            raise RuntimeError('Stale observation; reobserve')
        w=self.window()
        if w.handle!=self.last_hwnd:raise RuntimeError('Target window changed')
        approved=payload.get('approved') is True
        if kind in {'click_element','type_element','click_visual','scroll','press'}:
            w.set_focus();time.sleep(.12)
        if kind in {'click_element','type_element'}:
            idx=action['elementIndex']
            if idx>=len(self.last_elements):raise RuntimeError('Invalid element index')
            control,entry=self.last_elements[idx]
            if not control.is_visible() or not control.is_enabled():raise RuntimeError('Element disappeared')
            r=control.rectangle()
            if [r.left,r.top,r.right,r.bottom]!=entry['bounds']:raise RuntimeError('Element relocated; reobserve')
            if is_protected(entry['name']) or is_protected(entry['automationId']):raise RuntimeError('Protected control: manual interaction required')
            if kind=='type_element':
                if entry['role'] not in {'Edit','Document'}:raise RuntimeError('Not a text field')
                control.set_edit_text(action['text'])
            else:
                if is_high_risk(entry['name']) and not approved:return {'status':'approval_required','label':entry['name']}
                control.click_input()
            return {'status':'ok','target':entry['name']}
        if kind=='click_visual':
            r=w.rectangle()
            if (r.left,r.top,r.width(),r.height())!=self.last_rect:raise RuntimeError('Window moved after observation')
            if not self.allow_visual_clicks:raise RuntimeError('Visual clicks disabled')
            l,t,width,height=self.last_rect
            x0,y0,x1,y1=action['bbox']
            # Only the CENTER can be clicked; no offscreen/outside-window coordinates.
            x=l+round(((x0+x1)/2)*width);y=t+round(((y0+y1)/2)*height)
            hit=self._hit_control(x,y)
            label=action['label']
            if is_protected(label) or (hit and (is_protected(hit['name']) or is_protected(hit['automationId']))):
                raise RuntimeError('Protected visual control')
            if hit is None or hit['role'] in {'Pane','Text','Document'}:
                if not (self.allow_unmapped_visual_clicks and payload.get('doubleVerified') is True):
                    raise RuntimeError('No UIA match; opt-in + second vision verification required')
                label=f'Visual only: {label}'
            elif hit['role'] in {'Edit','Document'}:
                raise RuntimeError('Visual click into text control is not allowed; use type_element')
            else:label=hit['name'] or label
            if (is_high_risk(action['label']) or is_high_risk(label)) and not approved:
                return {'status':'approval_required','label':label}
            self.pg.click(x,y)
            return {'status':'ok','target':label}
        if kind=='scroll':
            l,t,w,h=self.last_rect
            self.pg.moveTo(l+w//2,t+h//2,duration=.10)
            self.pg.scroll(action['amount']);return {'status':'ok'}
        if kind=='press':
            keys=action['key'].split('+')
            self.pg.hotkey(*keys) if len(keys)>1 else self.pg.press(keys[0])
            return {'status':'ok'}
        raise RuntimeError('Unknown action')

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--window-title',required=True)
    p.add_argument('--allow-visual-clicks',action='store_true')
    p.add_argument('--allow-unmapped-visual-clicks',action='store_true')
    args=p.parse_args()
    try:bot=DesktopWorker(args.window_title,args.allow_visual_clicks,args.allow_unmapped_visual_clicks)
    except Exception as e:
        print(json.dumps({'ready':False,'error':str(e)},ensure_ascii=False),flush=True);return 1
    print(json.dumps({'ready':True}),flush=True)
    for line in sys.stdin:
        try:
            req=json.loads(line)
            if req.get('command')=='observe':res=bot.observe()
            elif req.get('command')=='act':res=bot.action(req)
            elif req.get('command')=='quit':print(json.dumps({'status':'bye'}),flush=True);break
            else:raise ValueError('Unknown command')
            print(json.dumps({'ok':True,'result':res},ensure_ascii=False),flush=True)
        except Exception as e:print(json.dumps({'ok':False,'error':str(e)},ensure_ascii=False),flush=True)
    return 0
if __name__=='__main__':raise SystemExit(main())
