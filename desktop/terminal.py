"""Tokyo Night ANSI terminal primitives; standard library only and NO_COLOR friendly."""
import os
import re
import shutil
import sys
import json
from pathlib import Path

COLORS = {
    'fg': (192, 202, 245), 'muted': (154, 165, 206), 'border': (65, 72, 104),
    'purple': (187, 154, 247), 'violet': (157, 124, 216), 'cyan': (125, 207, 255),
    'aqua': (115, 218, 202), 'green': (158, 206, 106), 'orange': (255, 158, 100),
    'red': (247, 118, 142),
}

def current_palette():
    try:
        state=json.loads((Path(__file__).resolve().parents[1]/'.private'/'theme.json').read_text('utf-8'))
        if state.get('theme')=='cyberpunk':
            return {'fg':(242,234,255),'muted':(185,165,213),'border':(86,60,131),'purple':(255,79,216),'violet':(178,102,255),'cyan':(0,245,255),'aqua':(78,255,195),'green':(149,255,110),'orange':(255,193,110),'red':(255,72,112)}
    except (OSError,ValueError,TypeError):pass
    return COLORS

def enabled():
    if os.environ.get('NO_COLOR'): return False
    if os.environ.get('FORCE_COLOR') == '0': return False
    return sys.stdout.isatty() or os.environ.get('FORCE_COLOR') not in (None, '', '0')

def paint(s, tone='fg', bold=False):
    s = str(s)
    if not enabled(): return s
    palette=current_palette();r, g, b = palette.get(tone,palette['fg'])
    return f'\033[{"1;" if bold else ""}38;2;{r};{g};{b}m{s}\033[0m'

def _width():return max(40,min(104,shutil.get_terminal_size((88,24)).columns-2))

def section(label):
    print('\n'+paint('◆ ', 'purple')+paint(label.upper(),'cyan',True))
    print(paint('─'*_width(),'border'))

def header(name='MODEL VAULT'):
    w=_width()
    title='✦  A U T O T A S K   A I  ✦'
    subtitle=('CYBERPUNK' if current_palette() is not COLORS else 'TOKYO NIGHT')+'  /  '+name
    print('\n'+paint('╭'+'─'*(w-2)+'╮','violet'))
    for content,tone,bold in ((title,'purple',True),(subtitle,'cyan',False)):
        # Do not use embedded ANSI to compute content width.
        pad=max(0,w-4-len(content))
        print(paint('│ ','violet')+paint(content,tone,bold)+' '*pad+paint(' │','violet'))
    print(paint('╰'+'─'*(w-2)+'╯','violet'))
    print(paint('    ⋆｡˚  private keys / local profiles  ─  夜空','muted'))

def entry(key, value, tone='fg'):
    print(paint('  '+key[:21].ljust(23),'muted')+paint(value,tone))

def choice(key, label, description=''):
    print(paint(f'  [{key}] ','purple',True)+paint(label,'fg',True)+(paint('   '+description,'muted') if description else ''))

def notice(text,tone='cyan'):
    print(paint('  ◇ ',tone)+paint(text,'fg'))

def prompt(text):
    return input(paint('  ❯ ','purple',True)+paint(text+'  ›  ','cyan'))

def preview():
    header('MODEL VAULT')
    section('Configuration')
    entry('PROFILES','0 configured','orange')
    entry('KEY STORAGE','Windows Credential Manager','aqua')
    section('Actions')
    choice('1','Add Model','Provider / model ID / private key')
    choice('2','Set Default')
    choice('3','Remove Model')
    choice('0','Back')
    notice('Empty install: no API key or profile is included')

if __name__=='__main__':preview()
