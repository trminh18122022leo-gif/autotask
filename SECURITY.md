# Security and account handling

- Type credentials on your own Windows terminal, not into ChatGPT messages. `getpass` hides the password as you type. `keyring` delegates to the OS credential provider. Exact keyring behavior depends on Windows/system configuration.
- The session directory may contain privileged cookies. Protect the local Windows account, enable disk encryption if available, and do not sync `.private/` to public cloud storage.
- Configs keep only account profile ID and trusted login hosts, never the username/password or API key.
- `FORGET` deletes browser session but retains account credentials. Remove credentials separately using Account Vault. `LOGOUT` clears cookies; sites may also use localStorage; `FORGET` is the stronger local reset.
- HTML form answers and screenshots may leave the machine when an external AI provider is selected. Only configure trusted providers.
- Discovery uses host equality, not suffix matching; does not interpret website content as new instructions.
- No bypass of CAPTCHA, MFA, SSO checks, age gates, access controls or quiz restrictions.
- Each user must have permission for AI-assisted completion, uploading and submission. Submitted academic work remains the user's responsibility.
- Use rate limits, audit trails and official LMS APIs where available before deployment to multiple users.
