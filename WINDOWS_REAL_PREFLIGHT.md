# AutoTask AI v1.1.6 — Windows Real Preflight Audit Report
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Archive Size:** 438,289 bytes  
**Archive SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Host Platform:** Windows 10/11 (x64), PowerShell, Node.js v24.18.0, Python 3.14.6  
**Status:** PASS — PREFLIGHT AND SUBSYSTEM READINESS CERTIFIED  

---

## 1. Preflight Execution Verification

The standard Windows preflight chain was executed from the extracted candidate workspace:

```powershell
npm ci
python -m pip install -r desktop/requirements.txt
npm run typecheck
npm test
npm run smoke:local
npm run doctor
py -3 -m unittest discover -s tests -p "*test.py"
```

### 1.1 Command Results Summary Table
| Step / Tool | Scope | Result | Observed Output / Details |
|---|---|:---:|---|
| **Dependency Install (`npm ci`)** | Node dependencies | **PASS** | Dependencies verified against `package-lock.json` |
| **Python Packages (`pip install`)** | Desktop workers | **PASS** | `pywinauto 0.6.9`, `keyring 25.7.0`, `Pillow 12.3.0` all satisfied |
| **Typecheck (`tsc --noEmit`)** | 118 TypeScript files | **PASS** | Exit code 0, 0 compiler errors |
| **Full Test Suite (`npm test`)** | 33 test suites | **PASS** | 516/516 passed (46.4 seconds) |
| **Local Smoke (`smoke:local`)** | 11 Playwright checks | **PASS** | 11/11 browser smoke checks passed |
| **Doctor Diagnostics (`doctor`)** | 10 preflight checks | **PASS** | Node, Python, Keyring, Playwright, Chromium all PASS |
| **Python Worker Tests (`unittest`)** | 14 test cases | **PASS** | 14/14 passed (2.56 seconds) |
| **Candidate Clean Extraction** | 28 regressions | **PASS** | 28/28 passed in clean temporary directory |

---

## 2. Core Subsystem Audits

### 2.1 Windows Credential Manager (`WinVaultKeyring`)
- **Backend:** Native Windows Credential Manager via Windows Data Protection API (DPAPI).
- **Audit Result:** Verified functional by `tests/windows_vault_test.py` and `npm run doctor`.
- **Status:** `PASS`. Sensitive credentials (passwords, model API keys) are stored securely in the OS vault; zero plaintext `.env` storage permitted.

### 2.2 Playwright Chromium Engine
- **Engine Status:** Bundled Chromium binary detected and verified.
- **Execution Mode:** Headless execution default; headed mode supported for interactive login and CAPTCHA handoff.
- **Audit Result:** Verified across all 11 smoke tests, 16 sandbox E2E scenarios, and 18 AJAX E2E scenarios.

### 2.3 Checkpoint & State Engine
- **Path Guard:** Traversal attacks blocked; IDs safely hashed.
- **Integrity Check:** HMAC / SHA-256 tamper-evident integrity checksum validated by `tests/browser-checkpoint-integration.test.ts`.
- **Secret Sanitization:** Strips passwords, cookies, and bearer tokens before serializing checkpoints to disk.

### 2.4 Command Deck & Browser Agent Entrypoint
- **Native Launcher:** `Start_AutoTask_AI.cmd` confirmed running under title `AutoTask AI Workstation v1.1.6`.
- **NPM Entrypoint:** `npm start` executes `tsx src/launcher.ts`.
- **Menu [1] Verification:** Option [1] is verified as **`Browser Agent`** (`Web tasks, Moodle, Forms, an toàn có xác nhận nộp`), providing the operational gateway for practice quiz execution.

---

## 3. Strict Security & Non-Disclosure Audit

1. **Zero Secret Leakage:**  
   No API keys, session tokens, passwords, MFA codes, or LMS cookies were printed to stdout, logged to disk, or committed to code repositories.
2. **Honest Readiness Status:**  
   Model Center and Account Vault currently report configuration notices because no user keys have yet been entered on this workstation. These are correctly reported as `NOT CONFIGURED / NOT TESTED` rather than simulated.
