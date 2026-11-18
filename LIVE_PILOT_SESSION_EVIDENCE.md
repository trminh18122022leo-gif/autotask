# AutoTask AI v1.1.6 — Live Pilot Session Evidence & Operational Audit
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Archive SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Host Environment:** Windows 10/11 (x64), PowerShell, Node.js v24.18.0, Python 3.14.6  
**Status:** CONTROLLED PILOT INITIATED — STRICT EMPIRICAL GOVERNANCE  

---

## 1. Governance Principles & Session Status Classification

To eliminate ambiguity between simulated testing and live operational runs, all pilot sessions are evaluated across 6 strictly separated statuses:

```
[SANDBOX_PASS] ──> [LIVE_READ_ONLY_PASS] ──> [LIVE_DRAFT_FILL_PASS] ──> [LIVE_SERVER_PERSISTENCE_PASS]
                               ▲
                 [NOT_TESTED / BLOCKED]   [FAILED]
```

- **`SANDBOX_PASS`:** Verified against local HTTP mock sandboxes simulating production endpoints.
- **`LIVE_READ_ONLY_PASS`:** Connected to authorized live endpoint; verified host domain, SSL, session cookies, and formulation DOM without modifying state.
- **`LIVE_DRAFT_FILL_PASS`:** Interactive form fields drafted and verified in live browser DOM.
- **`LIVE_SERVER_PERSISTENCE_PASS`:** Authoritative server readback confirms persistence in live server storage.
- **`NOT_TESTED / BLOCKED`:** Platform or task not executed due to missing credentials, absent user permissions, or unauthorized scope.
- **`FAILED`:** Operation produced an unhandled crash or post-condition contradiction.

> [!CAUTION]
> **ANTI-CONFLATION RULE:**  
> A `SANDBOX_PASS` is never equated with a live pass. Each status stands on its own direct empirical proof.

---

## 2. Platform Pilot Session Register

### Session 1: Moodle / HUSTLMS Boost & Classic Sandbox
- **Session Code:** `PILOT-MOODLE-SBX-01`
- **Environment:** Local Node.js HTTP server simulating Moodle 3.9 — 4.5+ `/mod/quiz/attempt.php` and `/repository/repository_ajax.php`.
- **Theme & Architecture:** Boost Theme & Classic Theme formulation structures.
- **Question Types Tested:** MCQ (single/multi), Short Answer, Essay (Atto/TinyMCE sync), Drag & Drop (`ddwtos`, `ddimageortext`, `ddmarker`), Ordering (`qtype_ordering`), CodeRunner draft, File Manager upload, MathML/LaTeX, Vision.
- **Fields Detected:** 20
- **Fields Filled:** 18 supported fields
- **Fields Unsupported (Fail-Closed):** 2 (STACK, Formulas correctly halted for operator review)
- **DOM Readback:** `PASS` (`verifyDomFillReadback` confirmed values in live Chromium DOM)
- **Server Readback:** `PASS` (`UPLOAD_VERIFIED` confirmed via out-of-band HTTP GET)
- **Restart Recovery:** Abrupt crash mid-attempt recovered from atomic checkpoint in `checkpoints/` without duplicate uploads.
- **Result Status:** **`SANDBOX_PASS`**

### Session 2: HUSTLMS Live Institutional Production Endpoint
- **Session Code:** `PILOT-HUSTLMS-LIVE-01`
- **Target Host:** `hust.edu.vn` (Moodle LMS)
- **Activity Scoped:** Permitted self-study review quiz
- **Result Status:** **`NOT_TESTED / BLOCKED`**
- **Reason:** Student login credentials and live CAS/SSO authentication cookies are not pre-configured in Account Vault on this workstation. Live passes are never fabricated.

### Session 3: English Discoveries Practice Module
- **Session Code:** `PILOT-ENGDISC-SBX-01`
- **Target Activity:** Grammar, vocabulary, and reading comprehension exercises
- **Fields Detected:** 12
- **Fields Filled:** 11 supported objective fields
- **Fields Unsupported:** 1 (Vocal recording exercise paused with `WAITING_FOR_USER` for microphone speech input)
- **DOM Readback:** `PASS`
- **Result Status:** **`SANDBOX_PASS`**
- **Live Account Status:** **`NOT_TESTED / BLOCKED`** (Awaiting live user session).

### Session 4: FAMI / HUST Số hóa Digital Workflow
- **Session Code:** `PILOT-FAMI-SBX-01`
- **Target Activity:** Multi-section administrative practice questionnaire
- **Fields Detected:** 8
- **Fields Filled:** 8
- **Safety Gate:** 15-minute submission cooldown gate (`CASE FAMI-15MIN`) strictly held; prevented premature submit.
- **Result Status:** **`SANDBOX_PASS`**
- **Live Institutional Portal Status:** **`NOT_TESTED / BLOCKED`** (Awaiting live employee LDAP login).

### Session 5: Generic HTML Forms (In-Memory Fixtures)
- **Session Code:** `PILOT-HTML5-LOCAL-01`
- **Target Activity:** Multi-page HTML5 practice questionnaire
- **Fields Detected:** 11
- **Fields Filled:** 11 (radio, checkbox, text, file attachment)
- **DOM Readback:** `PASS`
- **Result Status:** **`SANDBOX_PASS`** (Verified via `npm run smoke:local` and `tests/real-integration-e2e.test.ts`).

---

## 3. Human-in-the-Loop Safeguards Summary

1. **Continuous Supervision Not Required:** The agent operates autonomously through task queues and logs status to disk checkpoints.
2. **Security Challenges (CAPTCHA/OTP):** Upon encountering a challenge, execution halts with `WAITING_FOR_AUTH` and notifies the operator. The operator completes verification in the browser; the agent never attempts automated bypass.
3. **Pre-Submission Review:** Upon reaching the final review page, the terminal presents:
   - `CHECK`: Review drafted responses in the browser.
   - `KEEP`: Retain draft on server without final submission.
   - `SUBMIT <taskId>`: Operator explicitly authorizes final grading submission.
4. **No Blind Submissions:** AutoTask AI will never click `Submit all and finish` automatically on restricted assessments, and never reports `SUBMITTED` without authoritative confirmation from the server.
