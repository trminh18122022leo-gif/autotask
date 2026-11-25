"""Independent deterministic local action policy; never trust page/model instructions."""
import re

UNSAFE = re.compile(
    r'\b(submit|finish\s+(?:attempt|quiz)|send|delete|remove|purchase|pay|checkout|sign\s*out|log\s*out|confirm\s+order|save\s+changes)\b'
    r'|nộp|gửi|xóa|xoá|thanh toán|đăng xuất|hoàn thành bài|kết thúc bài',re.IGNORECASE)
PROTECTED = re.compile(r'\b(password|passcode|verification code|security code|captcha|one.time code|otp|secret|token)\b'
                       r'|mật khẩu|mã xác (?:thực|nhận)|mã bảo mật',re.IGNORECASE)

def is_high_risk(label):return bool(UNSAFE.search(label or ''))
def is_protected(label):return bool(PROTECTED.search(label or ''))

def check_action(action):
    if not isinstance(action,dict):raise ValueError('Action must be object')
    kind=action.get('kind')
    if kind not in {'click_element','type_element','click_visual','scroll','press','wait','done'}:
        raise ValueError('Unsupported action kind')
    if kind in {'click_element','type_element'}:
        index=action.get('elementIndex')
        if type(index)!=int or index<0 or index>300:raise ValueError('Invalid elementIndex')
    if kind=='type_element':
        value=action.get('text')
        if not isinstance(value,str) or len(value)>5000:raise ValueError('Invalid text')
    if kind=='click_visual':
        rect=action.get('bbox')
        if not isinstance(rect,list) or len(rect)!=4 or any(type(c) not in (float,int) or c<0 or c>1 for c in rect):
            raise ValueError('Expected normalized bbox [x0,y0,x1,y1]')
        x0,y0,x1,y1=rect
        if x1<=x0 or y1<=y0 or (x1-x0)>0.65 or (y1-y0)>0.5 or (x1-x0)<.003 or (y1-y0)<.003:
            raise ValueError('Unsafe bbox dimensions')
        conf=action.get('confidence')
        if type(conf) not in (float,int) or conf<.85 or conf>1:raise ValueError('Visual confidence too low')
        label=action.get('label')
        if not isinstance(label,str) or not 2<=len(label)<=140:raise ValueError('Missing visual target label')
    if kind=='scroll' and (type(action.get('amount'))!=int or not -5<=action['amount']<=5):
        raise ValueError('Invalid scroll')
    if kind=='press' and action.get('key') not in {'tab','shift+tab','esc','ctrl+a','ctrl+f'}:
        raise ValueError('Shortcut not allowlisted')
    if kind=='wait' and (type(action.get('seconds')) not in (int,float) or not 0<=action['seconds']<=3):
        raise ValueError('Invalid wait')
