# Desktop worker / v0.5

- `worker.py`: Windows-only pywinauto + pyautogui bridge; receives JSON commands over stdin.
- `policy.py`: deterministic protected/sensitive action checks.
- `terminal.py`: Tokyo Night terminal color renderer, no external dependency.
- `models_cli.py`: interactive BYOK profile manager, uses keyring and hidden getpass.
- `secrets.py`: retrieves selected profile credential for runtime use. The key is never written into profile JSON.

Run the full application from the repository root using `npm start`. On Windows, `python -m pip install -r desktop/requirements.txt` is required for Computer-Use functionality. `python desktop/terminal.py` previews the Model Vault theme without a keyring dependency.
