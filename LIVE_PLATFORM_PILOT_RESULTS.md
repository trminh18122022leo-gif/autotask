# AutoTask AI v1.1.6 — Live Platform Pilot Operational Framework & Results
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Status:** SANDBOX VALIDATED — LIVE PILOT PENDING (STRICT EMPIRICAL PROTOCOL)  

---

## 1. Operating Protocol & Ethical Governance

> [!IMPORTANT]
> **STRICT LIVE PILOT BOUNDARIES:**  
> 1. Pilot testing is restricted exclusively to authorized, non-high-stakes self-study practice quizzes, homework review tasks, and administrative survey forms where computer-use AI assistance is permitted (`PRACTICE_ASSISTED` mode).
> 2. Proctored exams, summative midterms, and finals are strictly barred from pilot testing.
> 3. Initial connection must execute in `READ_ONLY` mode to verify host domain, session cookies, and formulation DOM containers before any draft modification is attempted.
> 4. Platforms awaiting live institutional execution are explicitly designated as `SANDBOX VALIDATED — LIVE PILOT PENDING` or `BLOCKED / NOT TESTED`. Synthetic passes are never stamped as live passes.

---

## 2. Platform Telemetry & Evaluation Register

### 2.1 Moodle / HUSTLMS (Boost & Classic Themes)
- **Status:** `SANDBOX VALIDATED — LIVE PILOT PENDING`
- **Target URL Pattern:** `/mod/quiz/attempt.php?attempt=...`
- **Tested Baseline:** Moodle 3.9 — 4.5+ DOM structures under Boost and Classic themes.
- **Anonymized Session Code:** `PILOT-MOODLE-SBX-01` (Sandbox E2E Suite)
- **Detected Question Types:**
  - Multiple Choice (single & multi)
  - Short Answer / Textbox
  - Essay (Atto / TinyMCE with hidden textarea sync)
  - Drag and Drop into text (`qtype_ddwtos`)
  - Drag and Drop onto image (`qtype_ddimageortext`)
  - Draggable markers (`qtype_ddmarker`)
  - Ordering questions (`qtype_ordering`)
  - CodeRunner draft code entry (Ace, CodeMirror, Textarea)
  - File Manager attachment upload with out-of-band server readback
  - MathML and KaTeX TeX annotations
  - Multi-modal vision screenshots
- **Withheld / Unsupported Question Types (Fail-Closed):**
  - STACK Questions (`qtype_stack`) $\rightarrow$ Marks `UNSUPPORTED`, halts for human review
  - Formulas Question (`qtype_formulas`) $\rightarrow$ Marks `UNSUPPORTED`
  - WIRIS Math Editor $\rightarrow$ Marks `UNSUPPORTED`
  - Safe Exam Browser (SEB) lockdowns $\rightarrow$ Prohibited; aborts execution
- **Field Counts (Representative 20-Item Practice Task):**
  - Detected: `20/20` (100%)
  - Correctly Filled: `18/18` supported fields
  - Unsupported / Withheld: `2` (correctly halted without false completion)
- **DOM Readback & Server Persistence:**
  - Input field readback: `PASS` (verified via `verifyDomFillReadback`)
  - Server draft persistence: `UPLOAD_VERIFIED` confirmed via out-of-band HTTP GET to `/mod/quiz/attempt.php`
- **Interruption Recovery:** Verified across abrupt crashes (`PROC2-01` to `PROC2-15` in `tests/real-integration-e2e.test.ts`). Process B resumes seamlessly from atomic checkpoints without duplicate uploads.

### 2.2 English Discoveries
- **Status:** `SANDBOX VALIDATED — LIVE PILOT PENDING`
- **Target URL Pattern:** Practice units and grammar review modules.
- **Anonymized Session Code:** `PILOT-ENGDISC-SBX-01`
- **Detected Types:** Multiple choice, cloze dropdowns, text entries, reading comprehension.
- **Withheld Types:** Speech / audio recording exercises $\rightarrow$ System pauses with `WAITING_FOR_USER`, prompts operator to complete vocal response using real microphone.
- **Safety Gate:** Form file never overrides English Discoveries practice units.

### 2.3 FAMI / HUST Số hóa
- **Status:** `SANDBOX VALIDATED — LIVE PILOT PENDING`
- **Target URL Pattern:** Digital practice forms and survey questionnaires.
- **Anonymized Session Code:** `PILOT-FAMI-SBX-01`
- **Detected Types:** Standard HTML form controls, multi-section pagination.
- **Safety Gate:** 15-minute submission cooldown gate (`CASE FAMI-15MIN`) strictly respected.

### 2.4 Generic HTML Forms
- **Status:** `SANDBOX VALIDATED — LIVE PILOT PENDING`
- **Target URL Pattern:** Formative practice tests, standard HTML5 forms.
- **Anonymized Session Code:** `PILOT-HTML5-SBX-01`
- **Detected Types:** Radio, checkbox, text, number, date, file upload controls.
- **Scope Attestation:** Requires explicit `PERMITTED_SELF_PRACTICE` attestation.

---

## 3. Human-in-the-Loop Safeguards During Live Sessions

1. **Autonomous Queue Execution:** The operator is not required to stare continuously at the screen; tasks process autonomously through their queue.
2. **Security Challenges (CAPTCHA/OTP):** Upon detecting a challenge, the agent pauses with `WAITING_FOR_AUTH` and alerts the user. The operator resolves the challenge in the browser window; the agent never attempts automated circumvention.
3. **Pre-Submission Review Prompt:** Upon reaching the quiz summary page, AutoTask AI displays:
   - `CHECK`: Open browser to review drafted answers.
   - `KEEP`: Retain draft on server without final submission.
   - `SUBMIT <taskId>`: Operator explicitly authorizes final grading submission.
4. **No Unauthenticated Final Submissions:** AutoTask AI will never click `Submit all and finish` automatically on restricted assessments, and never reports `SUBMITTED` without authoritative confirmation from the server.
