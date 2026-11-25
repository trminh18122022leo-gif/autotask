# Windows Terminal theme integration

Run `npm run theme`. The app writes:

- `windows-terminal-scheme.json`: add this **object** into the `schemes` array in Windows Terminal Settings JSON (do not overwrite existing schemes).
- `windows-terminal-profile-settings.json`: merge these properties into the profile you use to run AutoTask AI under `profiles.list` (or into a new dedicated profile).

Restart that terminal tab. In-app ANSI colors change immediately; font, background and opacity are controlled by Windows Terminal and **cannot reliably be forced by a child CLI process**. The chosen font must be installed. Do not copy, redistribute or bundle font binaries.

Only two schemes are supported: Tokyo Night and Cyberpunk.
