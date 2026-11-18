"""Local Windows credential storage for LMS login. No passwords in JSON, stdout except get subcommand for child."""
import getpass, json, re, sys
from pathlib import Path
from urllib.parse import urlparse
import keyring
from terminal import header,section,choice,entry,notice,prompt
ROOT=Path(__file__).resolve().parents[1]
DB=ROOT/'.private'/'accounts.json'
SERVICE='AutoTaskAI_v06_LMS'
def read_accounts():
    if not DB.exists():return {'accounts':{}}
    return json.loads(DB.read_text('utf-8'))
def save_accounts(db):
    DB.parent.mkdir(parents=True,exist_ok=True)
    temp=DB.with_suffix('.tmp')
    temp.write_text(json.dumps(db,indent=2,ensure_ascii=False),'utf-8')
    temp.replace(DB)
def same_host(url):
    p=urlparse(url)
    if p.scheme not in ('https','http') or not p.hostname or p.username or p.password:raise ValueError('Invalid URL')
    if p.scheme=='http' and p.hostname not in ('localhost','127.0.0.1'):raise ValueError('Login must use HTTPS')
    return p.hostname.lower()
def add():
    db=read_accounts()
    ident=prompt('Account profile ID').strip()
    if not re.fullmatch('[A-Za-z0-9_-]{1,48}',ident):raise ValueError('Invalid ID')
    url=prompt('Your LMS login URL (HTTPS)').strip()
    host=same_host(url)
    trusted=prompt('Additional trusted SSO login hosts, comma separated (optional; exact domains)').strip()
    trusted_hosts=[s.strip().lower() for s in trusted.split(',') if s.strip()]
    if any(not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,253}',h) or h.startswith('.') or '..' in h for h in trusted_hosts):raise ValueError('Invalid exact login host')
    username=prompt('Username / email').strip()
    if not username or len(username)>256:raise ValueError('Invalid username')
    password=getpass.getpass('  ❯ Password (hidden; never saved to config file): ')
    if not password:raise ValueError('Password required')
    # Username kept in OS keyring too to avoid exposing identity in config.
    keyring.set_password(SERVICE,ident+':username',username)
    keyring.set_password(SERVICE,ident+':password',password)
    db['accounts'][ident]={'loginUrl':url,'loginHost':host,'trustedLoginHosts':trusted_hosts,'displayName':ident}
    save_accounts(db)
    notice('Saved in OS credential vault. MFA/SSO challenges still require manual input.','green')
def delete():
    db=read_accounts();ident=prompt('Account ID to delete').strip()
    if ident not in db['accounts']:raise ValueError('Unknown account')
    if prompt(f'Type DELETE {ident} to delete credentials and metadata').strip()!=f'DELETE {ident}':return
    for suffix in ('username','password'):
        try:keyring.delete_password(SERVICE,ident+':'+suffix)
        except keyring.errors.PasswordDeleteError:pass
    del db['accounts'][ident];save_accounts(db)
    notice('Credentials deleted. To clear session cookies use the Logout/Forget session action.','green')
def main():
    if len(sys.argv)==3 and sys.argv[1]=='get':
        ident,field=sys.argv[2].split(':',1)
        if field not in ('username','password'):raise SystemExit(2)
        value=keyring.get_password(SERVICE,ident+':'+field)
        if value is None:raise SystemExit('Credential not found')
        sys.stdout.write(value)
        return
    while True:
        db=read_accounts();header('ACCOUNT VAULT');section('Saved login profiles')
        for ident,item in db['accounts'].items():entry(ident,item['loginHost'])
        if not db['accounts']:notice('No accounts configured','orange')
        choice('1','Add account','OS keyring, not plaintext');choice('2','Remove account');choice('0','Back')
        command=prompt('Select').strip()
        try:
            if command=='1':add()
            elif command=='2':delete()
            elif command=='0':return
        except Exception as e:notice(str(e),'red')
if __name__=='__main__':main()
