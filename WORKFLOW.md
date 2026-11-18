# User workflow

1. Configure a model; optionally add fallback model profiles. Each profile has an exact vendor model ID. No API key is bundled.
2. Configure a saved LMS account: login URL, account ID, username, password entered inside terminal (password hidden). If login uses a different SSO host, explicitly add it to the trusted host list; verification challenges are manual.
3. Pick Tokyo Night or Cyberpunk. UI ANSI colors change immediately; font, size and opacity are exported as Windows Terminal profile settings for user application.
4. Setup Wizard: provide LMS URL, select saved account or browser-only session, choose discovery and/or explicit activity URL, parallel tabs 1..3, fallback models.
5. Start Browser Agent, type ACCEPT. The browser uses dedicated user data directory; session is reused when valid.
6. Login and scan configured dashboard/linked course pages (max 1..50, same-host), collecting activity links and deadline timestamps.
7. Select ALL or a subset from discovery. Each task is opened in a tab up to concurrency limit; pages within the same activity are processed sequentially.
8. Read native HTML + limited custom ARIA controls, optionally screenshot content for vision. AI generates answer JSON; selected options and text fields are checked against DOM after filling. File tasks can produce DOCX/PDF/XLSX/TXT/MD/CSV then upload.
9. Tasks that cannot be recognized or verified are marked PARTIAL/ERROR. They are not silently recorded as completed.
10. After all assigned activities are prepared, each READY task requires explicit `SUBMIT <taskId>` or can remain a draft. Display official result only after the website visibly confirms it.
11. Emit terminal summary and local JSON report; user chooses KEEP, LOGOUT or FORGET session.
12. For desktop-wide tasks use Desktop Agent separately, with vision grounding, checkpointing and exclusive mouse/keyboard input.

## Concurrency

- Browser tabs: up to 3 independent activities per browser context; do not open same Chromium user-data directory in two separate processes simultaneously.
- Desktop: strict single physical input worker even when a batch contains multiple jobs; applications can still load concurrently.
- Session and account: one browser profile per saved account; use separate terminal runs for distinct login profiles.

## Decision logic

If the site does not show a legitimate login form or redirects to an untrusted SSO domain: **no credential injection**. If a form control is ambiguous or absent: **do not guess coordinates**. If a transient model error occurs: **try configured fallback profiles**. If an answer is missing: **report partial**. If a submit button has not been explicitly confirmed: **do not submit**. If the score is not published: **report unknown**, not zero or a guessed score.
