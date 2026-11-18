# Architecture — AutoTask AI v0.6

## Modules

```text
Windows Terminal / PowerShell (Tokyo Night or Cyberpunk)
  ├─ Command Deck / Setup Wizard / Appearance
  ├─ Model Vault ── Python OS keyring ── Provider router (OpenAI / Groq / Gemini / Anthropic / Custom HTTPS)
  ├─ Account Vault ── Python OS keyring ── persistent Chromium profile per account
  ├─ Browser Agent (Playwright)
  │    ├─ LMS discovery (host-scoped bounded link crawler)
  │    ├─ Deadline scanner (visible DOM/HTML timestamp heuristics)
  │    ├─ Question scanner (HTML inputs + selected ARIA controls)
  │    ├─ AI question processor (+ screenshot when needed)
  │    ├─ Answer validator / filler / file generator
  │    └─ Submit confirmation / server result capture
  ├─ Desktop Agent (Windows UI Automation + pyautogui)
  │    ├─ screenshot -> AI vision grounding -> action policy -> UI interaction -> reobserve
  │    └─ exclusive physical input lock, checkpoints, bounded recovery
  ├─ Document Worker (docx / PDF / XLSX / plain text)
  └─ Reports (local JSON; deadlines, task state, official score if visible)
```

## Security boundaries

1. User-approved URL hosts and task list are authority; websites cannot expand the scope using page text or model instructions.
2. Login data is only loaded from credential storage into a single known trusted host's visible authentication inputs. Microsoft/Google SSO trusted host names are explicit opt-ins. Never try to bypass MFA/CAPTCHA.
3. HTML and screenshots are untrusted. AI should treat them as data, not new operating rules.
4. Submission is a separate irreversible operation: typed `SUBMIT <taskId>` after completion, not part of model output.
5. Browser profiles are stored locally in `.private/sessions/<account>` and may contain sensitive cookies. They are excluded from release packages.
6. Browser tabs run asynchronously; desktop physical input is exclusive.
7. Model fallback occurs on transient HTTP 408/429/5xx and transport errors; no silent retry on bad credentials/permissions.
8. Generated files use strict extension allowlist and safe output directory; spreadsheets escape potential formulas from untrusted cells.

## Modules added/changed vs v0.5

- Added: `src/ui/themes.ts`, `src/ui/theme-cli.ts`, `src/accounts.ts`, `desktop/accounts_cli.py`, `src/discovery.ts`, `src/discover-cli.ts`, `src/provider-fallback.ts`, `src/documents.ts`, `desktop/document_worker.py`.
- Updated: `src/main.ts`, `src/scanner.ts`, `src/fill.ts`, `src/setup.ts`, `src/launcher.ts`, `src/ai.ts`, `src/desktop.ts`, `src/calendar.ts`, `src/ui/tokyo.ts`, `desktop/terminal.py`, tests and dependencies.
- Preserved: Windows UIA + Visual Grounding and desktop queue from v0.3/v0.4.

## Further development gates

- G1: Install on Windows; run all tests and Playwright Chromium end-to-end against *owned, synthetic* LMS fixtures.
- G2: Add Moodle adapter recognizing course/course-module pages, attempt flow and result forms without accidental submission.
- G3: Add Google Forms / Microsoft Forms integration tests including ARIA, custom controls, iframe, attachments.
- G4: Benchmark navigation reliability, image/math recognition and field verification with permissioned datasets.
- G5: Security review (OS keyring protection, cookie life cycle, retries, CSP, redaction) before any wider release.

No site-specific integration is claimed complete without G1–G4 evidence.

## v0.9 — Terminal UX, preflight, report radar và workflow guards

- `src/ui/menu.ts`: menu bàn phím hướng dẫn, không có dependency ngoài; hỗ trợ TTY tương tác và nhập số qua non-TTY.
- `src/ui/dashboard.ts`: đọc báo cáo thực từ `reports/`, tính lại mức độ khẩn deadline từ đồng hồ hiện tại.
- `src/doctor.ts`: kiểm tra dependency/OS/config, không đụng mật khẩu hoặc API key.
- `src/workflow-guards.ts`: chặn trường hợp false READY khi chạm số trang tối đa nhưng vẫn còn Next.
- `tests/local-browser-smoke.mjs`: Playwright Chromium local với HTML in-memory để xác minh một phần DOM/ARIA pipeline.
- `scripts/first-run.ps1`: bootstrap Windows kèm nghiệm thu, fail-fast.
- `scripts/apply-windows-terminal-theme.ps1`: thêm profile riêng, backup, hỗ trợ PowerShell 5.1/7 với JSON parse guard.

**Ranh giới:** Logic kiểm thử tại Linux container không thể kiểm tra Windows UI Automation hoặc DOM của hệ thống LMS sau đăng nhập. Browser worker vẫn giới hạn theo `allowedHosts` và không giả lập thời gian đọc FAMI.
