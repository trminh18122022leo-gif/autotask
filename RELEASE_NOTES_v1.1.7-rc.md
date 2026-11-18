# AutoTask AI v1.1.7-rc — Release Notes (release candidate, NOT a general release)

Operational gate: **READY FOR PILOT**. This archive is a candidate for controlled pilot use. It is not GENERAL RELEASE and nothing in it has been accepted on a production LMS.

## Changes in v1.1.7-rc.2 (Phase 9C.1: Portable TLS First-Run Acceptance)
- **Portable Intermediate CA (`resources/certs/globalsign_intermediate.crt`):** Bundles the official public intermediate CA (`CN=GlobalSign RSA OV SSL CA 2018`, SHA-256 `b676ffa3179e8812093a1b5eafee876ae7a6aaf231078dad1bfb21cd2893764a`). Zero private keys. Clean zip unzips and connects without needing manual cert copies into `.private`.
- **System Doctor TLS Handshake:** Added `checkLmsTlsConnectivity()` in preflight diagnostics. Distinguishes `CERTIFICATE_READY`, `CERTIFICATE_MISSING`, `TLS_VERIFIED`, and `TLS_FAILED` via live read-only HTTPS GET.
- **Fail-Closed CA Bootstrap:** `src/ca-bootstrap.ts` resolves portable order (`resources/certs/` -> `.private/`) and handles child process spawn errors explicitly (never masks failures with exit code 0).
- **Dual Startup Path Hardening:** `Start_AutoTask_AI.cmd` and `npm start` target `resources\certs\globalsign_intermediate.crt` out-of-the-box.
- **New Test Suite:** `tests/phase9c1-portable-tls.test.ts` (7 comprehensive test cases: TLS-01..07).

## What changed since v1.1.6 (v1.1.7-rc.1)
- **Startup / TLS (Phase 8G):** `src/ca-bootstrap.ts` makes `npm start`, `npm run browser` and `Start_AutoTask_AI.cmd` all load intermediate CA through `NODE_EXTRA_CA_CERTS` (one self-respawn). TLS verification is never disabled.
- **READ_ONLY network guard (Phase 8G):** safe Moodle metadata AJAX allowlist; session keys and tokens are redacted from logs and reports (`src/security/redact.ts`).
- **Scanner fix:** Moodle Dashboard / course pages with no `div.que` block return 0 questions (previously a course filter box was reported as a question).
- **Failed-save detection (Phase 9A):** a failed or unauthorised write after filling reports `[SAVE_NOT_CONFIRMED]` (HTTP 401/403 → `WAITING_FOR_AUTH`, other failures → `PARTIAL`).
- **DOM drift protection (Phase 9B):** every filled radio/checkbox/select/text field is re-read after a settle delay; a value that changed afterwards reports `[DOM_DRIFT]` and the run is not `READY_FOR_REVIEW`.
- **`TaskResult.persistence`:** `{domFilled, domVerified, serverWriteAcks, serverWriteFailures, serverReadbackVerified}`.
- **No shell on any spawn path (Phase 9C):** the Command Deck runs `node npm-cli.js run <script>` for an allowlist of scripts (`src/npm-runner.ts`) instead of `shell: true`; this removes the Node `DEP0190` warning source.
- New regression suites: `phase9a-sandbox-practice`, `phase9b-verification-levels`, `phase9c-rc-guards`, `moodle-dashboard-false-positive`, `session-data-hardening`, `startup-verification`, `lms-readonly-reconciliation`.

## How to read the status and persistence fields
| Value | Meaning |
|---|---|
| `READY_FOR_REVIEW` | Fields were filled and re-read from the DOM. **Not** saved-on-server, **not** completed, **not** submitted. The learner reviews and decides. |
| `SUBMITTED` | Only after the learner types `SUBMIT <task id>` and the single, uniquely-identified submit control is clicked. Never automatic. |
| `serverWriteAcks = WRITE_ACK_RECEIVED` | A 2xx response arrived for a write after filling. **An HTTP 200 is not proof the backend stored anything.** |
| `serverWriteAcks = WRITE_FAILED` | A write after filling returned ≥ 400 or failed. |
| `serverWriteAcks = NONE_OBSERVED` | No write response seen. |
| `serverReadbackVerified = NOT_PERFORMED` | The generic path never reads the stored draft back. Only dedicated adapters (e.g. Moodle File Manager) do. The warning `[PERSISTENCE_UNVERIFIED]` is therefore always attached when fields were filled. |

## Retry policy actually shipped (unchanged from v1.1.6, now covered by tests)
- Model calls: `maxAttemptsPerModel` defaults to **1** (no retry); no fallback models unless the operator configures them; an explicit value is capped at 3. One model call is made per batch of questions on a page (one per image question).
- Writes, submissions and creation of quiz attempts are **never retried or replayed** automatically. State-changing URLs are refused before any request is sent. A checkpoint with unconfirmed server state is never auto-replayed.
- Page navigation (GET) uses at most 3 attempts for timeouts; it never targets state-changing URLs.
- Restarts and errors never widen permissions: the operating mode is never raised automatically.

## Known limitations
- Production LMS (HUSTLMS, FAMI, English Discoveries) behaviour is **not** accepted by this release; sandbox results do not transfer.
- A server that answers 200 but silently drops data cannot be detected by the generic path.
- Real-model accuracy has only been measured on a tiny team-written sandbox set.
- Python-side tooling requires the packages listed in `desktop/` (`keyring`, `python-docx`, `openpyxl`, `reportlab`).
