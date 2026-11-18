"""Interactive BYOK model profiles. Secrets live in OS credential storage, not JSON."""
import getpass
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

import keyring
from terminal import header, section, entry, choice as ui_choice, notice, prompt, paint

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / '.private' / 'model-profiles.json'
SERVICE = 'AutoTaskAI_v04_BYOK'
PROVIDERS = {
 'openai': ('openai-compatible','https://api.openai.com/v1/chat/completions'),
 'groq': ('openai-compatible','https://api.groq.com/openai/v1/chat/completions'),
 'gemini': ('gemini','https://generativelanguage.googleapis.com/v1beta'),
 'anthropic': ('anthropic','https://api.anthropic.com/v1/messages'),
 'custom': ('openai-compatible',''),
}

def read_profiles():
    if not DB.exists(): return {'default':None,'profiles':{}}
    return json.loads(DB.read_text(encoding='utf-8'))

def save_profiles(data):
    DB.parent.mkdir(parents=True,exist_ok=True)
    temp = DB.with_suffix('.tmp')
    temp.write_text(json.dumps(data,ensure_ascii=False,indent=2), encoding='utf-8')
    os.replace(temp,DB)

def choose(msg, items):
    section(msg)
    for i,v in enumerate(items,1):ui_choice(str(i), v)
    i=int(prompt('Select number').strip())
    if not 1<=i<=len(items):raise ValueError('Invalid selection')
    return items[i-1]

def configure():
    data=read_profiles()
    ident=prompt('Profile ID (letters / digits / - / _)').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,48}',ident):raise ValueError('Invalid profile ID')
    provider=choose('API provider:',list(PROVIDERS))
    kind,endpoint=PROVIDERS[provider]
    if provider=='custom':
        endpoint=prompt('HTTPS API endpoint URL').strip()
        parts=urlparse(endpoint)
        if parts.scheme!='https' or not parts.hostname or parts.username or parts.password:
            raise ValueError('Invalid HTTPS endpoint')
        notice('Your API key and task content will be sent to this custom endpoint.','orange')
        if prompt('Type TRUST to confirm endpoint').strip()!='TRUST':return
    model=prompt('Exact API model ID (provider dashboard)').strip()
    if not model or len(model)>100 or any(c.isspace() for c in model): raise ValueError('Invalid model ID')
    key=getpass.getpass(paint('  ❯ API key (hidden; blank = keep existing)  ›  ','cyan')).strip()
    if key: keyring.set_password(SERVICE,ident,key)
    elif not keyring.get_password(SERVICE,ident): raise ValueError('A key is required for new profiles')
    data['profiles'][ident]={'provider':provider,'kind':kind,'model':model,'endpoint':endpoint}
    if not data['default']:data['default']=ident
    if prompt('Make default? (y/N)').strip().lower()=='y':data['default']=ident
    save_profiles(data)
    notice(f'Profile {ident} saved. API key stored in your OS credential vault.','green')

def main():
    while True:
        data=read_profiles()
        header('MODEL VAULT')
        section('Private model profiles')
        entry('DEFAULT',data.get('default') or 'Not set','aqua' if data.get('default') else 'orange')
        entry('PROFILE COUNT',str(len(data['profiles'])),'cyan')
        if data['profiles']:
            section('Available profiles')
            for pid, p in data['profiles'].items():
                entry(pid, f'{p["provider"]} · {p["model"]}', 'purple' if pid==data.get('default') else 'fg')
        else:
            notice('No API keys or model profiles. Start by adding one.','orange')
        section('Navigation')
        ui_choice('1','Add model','Provider / model ID / private key')
        ui_choice('2','Set default','Select an existing profile')
        ui_choice('3','Delete model','Remove profile and credential')
        ui_choice('0','Back','Exit vault')
        cmd=prompt('Choose 0–3').strip()
        try:
            if cmd=='1':configure()
            elif cmd=='2':
                pid=prompt('Existing profile ID').strip()
                if pid not in data['profiles']:notice('Unknown profile','orange');continue
                data['default']=pid;save_profiles(data)
                notice(f'Default profile set to {pid}','green')
            elif cmd=='3':
                pid=prompt('Profile to delete').strip()
                if pid in data['profiles'] and prompt(f'Type DELETE {pid} to confirm')==f'DELETE {pid}':
                    del data['profiles'][pid]
                    try:keyring.delete_password(SERVICE,pid)
                    except keyring.errors.PasswordDeleteError:pass
                    if data['default']==pid:data['default']=next(iter(data['profiles']),None)
                    save_profiles(data)
                    notice(f'Profile {pid} deleted','green')
            elif cmd=='0':return
            else:notice('Choose one of the displayed actions','orange')
        except (ValueError, OSError, keyring.errors.KeyringError) as exc:
            notice(f'Could not complete action: {exc}','red')

if __name__=='__main__':main()
