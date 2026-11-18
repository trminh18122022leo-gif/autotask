# AUTOTASK AI v1.1.6 — Answer-First Workflow Implementation and Source Audit

**Date:** 2026-11-01  
**Scope:** User-requested workflow: answer file takes priority, AI fallback only for missing items, standard file upload, human-entered CAPTCHA/OTP, unattended processing between checkpoints, final CHECK/SUBMIT choice.  
**Base source:** `autotask-ai-v1.1.6-lms-failclosed-clean.zip`, 134 entries, 362,037 bytes, SHA-256 `7f420f3bf0a4ee16b625a9efa9d0e688c9942993a7ba1ffc985abe611151638f`. Manifest entry hashes and CRC checked against actual ZIP (134/134 match).  
**Output:** `autotask-ai-v1.1.6-answer-first-candidate.zip`, **139 source entries**, SHA-256 `6995c6ecb1c41f5a5b670abbcf2f15cecf8e95e4d8dbb00a9cc5f107f3adfd79`. The base release was **not modified**.

## Evidence and key conclusions

The existing production source contained an AI-only `solveQuestions(...)` call for all supported scanned questions, a document generator for upload fields, an explicit `SUBMIT <taskId>` gate and visible Chromium, but **no existing-answer-file priority**. Its report says live LMS accounts and live BYOK model benchmarking were NOT TESTED. This is a verifiable testing limitation, not proof of an academic violation or requirement for an operator to stare at the browser throughout each task.

**Changes implemented in the candidate:**

1. Added `src/answer-bank.ts` and `AppConfig.answerFilePaths` / `Task.answerFilePaths`. Support explicit UTF-8 JSON/CSV/TSV/TXT/MD answer banks, parse without running macros/formulas, match exact `stableId`, `id`, or normalized question text. Reject ambiguous keys, and resolve radio/checkbox/select answers by exact current option text or explicitly selected option ID.
2. `src/main.ts` now uses **answer file first; ModelRouter only for remaining supported questions**. Missing/invalid answer files fail only the affected task and do not silently fall back for the entire workload. AI is still generative inference; an agentic web search with evidence-based retrieval is **not yet built**.
3. For a standard HTML `<input type="file">`, an answer-bank row's explicit local `filePath` may upload an existing supported document (up to 30 MB, no symlinks or `.private`/`.ssh` paths). AI-proposed `localFilePath` is rejected. Moodle AJAX File Manager (`.filemanager`) is **still unsupported**.
4. Setup prompts for `READ_ONLY` or `PRACTICE_ASSISTED` mode and an answer-file path. The CLI also accepts an optional file path on each run without changing the stored config.
5. Authentication challenges now display an explanatory terminal message and URL; user can manually solve CAPTCHA/OTP via the browser, or enter the manually obtained text through Terminal when unique `challengeInputSelector` and optional `challengeVerifySelector` are explicitly configured. No CAPTCHA-solving service, OTP interception, MFA bypass, or unauthorized site interaction is added. Concurrent challenge prompts are queued.
6. After completing the permitted work, the operator can type `CHECK`, `SUBMIT <taskId>`, or Enter to keep the draft. The browser may run without continuous observation between these checkpoints. Final submission remains explicit and may be `UNCONFIRMED` until the site provides reliable success evidence. The Moodle `Finish attempt ...` intermediate navigation is handled after confirmation, with a conservative dialog check.
7. Added `tests/answer-bank.test.ts`, `examples/answer-bank.sample.json`, `examples/answer-bank.sample.csv`, and `examples/ANSWER_FILE_WORKFLOW.md`.

**Independent offline checks:**

- Original archive SHA-256, entry CRC, per-entry SHA-256: PASS.
- TypeScript syntax-only transpilation: **108 TS files, 0 syntax errors** (not a full `tsc --noEmit` typecheck).
- Available Node test subset including new answer bank tests and core/model-security regression: **130/130 PASS**.
- Python: 9 functional tests PASS; full suite BLOCKED due missing Linux `keyring` dependency used by Windows Vault tests.
- `npm ci --offline --ignore-scripts` BLOCKED: `undici-types@6.21.0` absent from offline npm cache. No independent Windows Playwright/full 437-test run was possible here.
- The AGY report's 437/437 Node PASS and 22/22 fresh Windows install are **self-reported**, not independently reproduced in this Linux runtime.

**Not yet complete / mandatory AGY acceptance:**

- End-to-end Chromium test of mixed bank/AI fill on Moodle + English Discoveries + FAMI sandbox.
- Full answer-bank support for XLSX/DOCX/PDF (current candidate accepts JSON/CSV/TSV/TXT/MD; export Excel as CSV).
- Moodle AJAX File Manager upload.
- Evidence-based, web-enabled AI Agents with source citations, and real BYOK model-accuracy benchmarking.
- Site-specific challenge selectors and successful CAPTCHA/OTP reentry after SSO redirect during a task.
- Full typecheck and Windows clean-ZIP E2E on a computer with dependencies and a Playwright browser installed.
- Live LMS testing on a real permitted practice environment; no unconditional guarantee of answer correctness.

**Release decision:** **FUNCTIONAL CANDIDATE — NOT PRODUCTION CERTIFIED.** Preserve origin and authorization checks and the single-use start grant. Avoid claiming that live LMS accuracy is proven when it has not been measured. For permitted practice, continuous browser watching is not inherently required; human input only at authentication, exceptions, and explicit final submission approval.
