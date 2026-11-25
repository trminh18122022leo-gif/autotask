"""Secure OS Credential Vault bridge for AutoTask AI.
Handles storage of API keys and account passwords in Windows Credential Manager.
Never prints raw secret material on stdout unless explicitly requested with 'get'.
"""
import sys
import argparse
import keyring

SERVICE_MODELS = 'AutoTaskAI_v04_BYOK'
SERVICE_ACCOUNTS = 'AutoTaskAI_v06_LMS'

def main():
    parser = argparse.ArgumentParser(description='AutoTask AI OS Vault Bridge')
    subparsers = parser.add_subparsers(dest='command', required=True)

    # Model key commands
    p_get_model = subparsers.add_parser('get-model')
    p_get_model.add_argument('profile_id')

    p_set_model = subparsers.add_parser('set-model')
    p_set_model.add_argument('profile_id')

    p_del_model = subparsers.add_parser('delete-model')
    p_del_model.add_argument('profile_id')

    # Account commands
    p_get_acc = subparsers.add_parser('get-account')
    p_get_acc.add_argument('profile_field') # e.g. accId:password

    p_set_acc = subparsers.add_parser('set-account')
    p_set_acc.add_argument('profile_field')

    p_del_acc = subparsers.add_parser('delete-account')
    p_del_acc.add_argument('account_id')

    # Vault health check
    subparsers.add_parser('check')

    args = parser.parse_args()

    if args.command == 'check':
        kr = keyring.get_keyring()
        print(f"KEYRING_OK:{type(kr).__name__}")
        sys.exit(0)

    elif args.command == 'get-model':
        key = keyring.get_password(SERVICE_MODELS, args.profile_id)
        if not key:
            sys.stderr.write("Credential not found in OS keyring\n")
            sys.exit(1)
        sys.stdout.write(key)

    elif args.command == 'set-model':
        # Read key securely from stdin to avoid passing secrets in CLI argv/process list
        key = sys.stdin.read().strip()
        if not key:
            sys.stderr.write("Empty key provided\n")
            sys.exit(1)
        keyring.set_password(SERVICE_MODELS, args.profile_id, key)
        print("OK")

    elif args.command == 'delete-model':
        try:
            keyring.delete_password(SERVICE_MODELS, args.profile_id)
        except Exception:
            pass
        print("OK")

    elif args.command == 'get-account':
        ident, field = args.profile_field.split(':', 1)
        val = keyring.get_password(SERVICE_ACCOUNTS, f"{ident}:{field}")
        if val is None:
            sys.stderr.write("Account credential not found\n")
            sys.exit(1)
        sys.stdout.write(val)

    elif args.command == 'set-account':
        ident, field = args.profile_field.split(':', 1)
        val = sys.stdin.read().strip()
        keyring.set_password(SERVICE_ACCOUNTS, f"{ident}:{field}", val)
        print("OK")

    elif args.command == 'delete-account':
        for suffix in ('username', 'password'):
            try:
                keyring.delete_password(SERVICE_ACCOUNTS, f"{args.account_id}:{suffix}")
            except Exception:
                pass
        print("OK")

if __name__ == '__main__':
    main()
