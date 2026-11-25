"""Never accept secret material on argv; read BYOK key from OS keyring."""
import argparse
import keyring
from models_cli import SERVICE

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('profile_id')
    p=parser.parse_args()
    key=keyring.get_password(SERVICE,p.profile_id)
    if not key:raise SystemExit('Credential not found in OS keyring')
    print(key,end='')
