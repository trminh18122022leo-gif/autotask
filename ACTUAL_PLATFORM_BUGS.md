# AutoTask AI v1.1.6 — Actual Platform Bug Register & Repro Governance
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Current Status:** **ZERO ACTIVE BLOCKERS (0 P1, 0 P2, 0 P3)**  
**Governance Directive:** Controlled Pilot Bug Intake Protocol Active  

---

## 1. Issue Governance & Controlled Pilot Triage Protocol

In accordance with Phase 6 directives, **the Advanced Moodle synthetic hotfix cycle is permanently closed**. Speculative issues (such as an unverified "ACK-15") will not be introduced into the candidate codebase.

During the Controlled Pilot, a defect may only be logged if supported by the mandatory **6-Point Evidence Dossier**:
1. **Observable Evidence:** Exact DOM dump, raw network request/response snippet, or terminal trace.
2. **Affected Component:** Specific source file, adapter class, or utility function involved.
3. **Expected vs. Actual:** Unambiguous description of expected operational behavior versus actual outcome.
4. **Standalone Minimal Reproduction:** Standalone automated test script reproducing the failure without live LMS or credential dependency.
5. **Impact Assessment:** Severity classification based on operational impact (P1 blocker, P2 functional defect, P3 cosmetic/documentation).
6. **Post-Fix Verification Plan:** Automated test asserting the permanent resolution under both mock and browser fixtures.

---

## 2. Register of Historical Defects (ACK-01 to ACK-14) — All Resolved

Every previously identified vulnerability has been thoroughly investigated, fixed in source code, and verified via dedicated standalone regression tests:

| Defect ID | Severity | Failure Mode & Root Cause | Dedicated Verification Suite | Resolution Status |
|---|:---:|---|---|:---:|
| **ACK-01** | P1 | HTTP 200 with `{ success: false, error: ... }` accepted by naive status check | `tests/lms-server-ack-regressions.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-02** | P1 | Missing server response accepted based on optimistic UI appearance | `tests/lms-server-ack-regressions.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-03** | P1 | Corrupted non-JSON response body accepted as valid upload ACK | `tests/lms-server-ack-independent-negatives.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-04** | P1 | Unrelated background GET request (`action=list`) mistaken for upload ACK | `tests/lms-server-ack-independent-negatives.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-05** | P1 | Empty JSON `{}` response treated as positive confirmation | `tests/lms-server-ack-independent-negatives.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-06** | P1 | JSON `{ status: 'ok' }` without file or draft identity payload accepted | `tests/lms-ack-correlation-followup.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-07** | P1 | Cross-origin POST response accepted for local upload verification | `tests/lms-ack-correlation-followup.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-08** | P1 | Response acknowledged `itemid` of an unrelated draft container accepted | `tests/lms-ack-correlation-followup.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-09** | P1 | Missing draft item ID correlation between request payload and response | `tests/atqa-ack-last-mile-regressions.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-10** | P1 | Transient UI reflection plus upload ACK accepted without server persistence | `tests/atqa-ack-last-mile-regressions.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-11** | P1 | Client DOM checksum echo trusted without independent server readback | `tests/ack-11-server-readback-regression.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-12** | P1 | Early return on pre-existing DOM checksum bypassed server verification | `tests/atqa-ack12-preexisting-dom-regression.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-12B** | P1 | Matching DOM checksum accepted despite contradictory file size metadata | `tests/atqa-ack12-preexisting-dom-regression.test.mjs` | **RESOLVED & VERIFIED** |
| **ACK-13** | P1 | Server readback search root fallback to `doc.body` caused cross-widget bleed | `ATQA_ACK13_DRAFT_SCOPE_CHROMIUM_REPRO.py` *(workspace root)* | **RESOLVED & VERIFIED** |
| **ACK-14** | P1 | Missing or null draft item ID caused search root fallback to `doc.body` | `tests/atqa-ack14-missing-draft-scope.py` | **RESOLVED & VERIFIED** |

---

## 3. Location and Repository Placement of Reproduction Assets

> [!NOTE]
> **REPRODUCTION SCRIPT PLACEMENT DISCLOSURE:**  
> - **`ATQA_ACK13_DRAFT_SCOPE_CHROMIUM_REPRO.py`**: Located at the workspace root (`C:\Users\Admin\autotask\ATQA_ACK13_DRAFT_SCOPE_CHROMIUM_REPRO.py`). In `package-release.ps1`, root files are strictly allowlisted by name (`package.json`, `README.md`, `Start_AutoTask_AI.cmd`), so root reproduction scripts reside outside the candidate zip archive. It is retained in the workspace as an independent verification harness.
> - **`tests/atqa-ack14-missing-draft-scope.py`**: Located within `tests/` and packaged inside the candidate zip archive.
> - **`tests/atqa-ack12-preexisting-dom-regression.test.mjs`**: Located within `tests/` and packaged inside the candidate zip archive.

### Execution Commands:
```powershell
node --test tests/atqa-ack12-preexisting-dom-regression.test.mjs
py -3 ATQA_ACK13_DRAFT_SCOPE_CHROMIUM_REPRO.py
py -3 tests/atqa-ack14-missing-draft-scope.py
```
All three reproduction suites execute cleanly and verify that vulnerabilities fail closed in baseline conditions and pass with 100% integrity in candidate build v1.1.6.

---

## 4. Current Defect Inventory Summary

| Classification | Count | Status |
|---|:---:|:---:|
| **Active P1 (Critical Blockers)** | **0** | No open blockers preventing pilot |
| **Active P2 (Functional Deficiencies)** | **0** | All functional adapters operational |
| **Active P3 (Cosmetic / Documentation)** | **0** | Runbooks and guides aligned |
| **Total Active Defects** | **0** | **APPROVED FOR CONTROLLED PILOT** |
