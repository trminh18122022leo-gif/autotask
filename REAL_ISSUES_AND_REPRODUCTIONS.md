# AutoTask AI v1.1.6 — Real Issues, Triage Register & Standalone Reproductions
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Status:** ZERO ACTIVE BLOCKERS — GOVERNANCE PROTOCOL ACTIVE  

---

## 1. Issue Governance & Triage Protocol

In accordance with Phase 7 and Phase 8 directives, **the Advanced Moodle synthetic hotfix cycle is permanently closed**. Speculative issues (e.g. an unverified "ACK-15") will not be introduced.

During the Controlled Pilot, a defect may only be logged if supported by the mandatory 6-point evidence dossier:
1. **Observable Evidence:** Exact DOM dump, network request/response snippet, or terminal output.
2. **Relevant Component:** Specific source file, class, or adapter involved.
3. **Expected vs. Actual:** Unambiguous description of expected behavior versus actual outcome.
4. **Minimal Reproduction:** Standalone automated test script reproducing the condition without live LMS dependency.
5. **Impact Assessment:** Severity classification based on operational impact (P1 blocker, P2 functional, P3 cosmetic).
6. **Post-Fix Verification Plan:** Automated test asserting the permanent fix.

---

## 2. Register of Verified Historical Defects (ACK-01 to ACK-14)

Every previously discovered defect was verified through dedicated standalone reproduction scripts and confirmed resolved in the candidate build:

| Issue ID | Severity | Root Cause Summary | Dedicated Reproduction Script | Final Resolution Status |
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
| **ACK-13** | P1 | Server readback search root fallback to `doc.body` caused cross-widget bleed | `ATQA_ACK13_DRAFT_SCOPE_CHROMIUM_REPRO.py` | **RESOLVED & VERIFIED** |
| **ACK-14** | P1 | Missing or null draft item ID caused search root fallback to `doc.body` | `tests/atqa-ack14-missing-draft-scope.py` | **RESOLVED & VERIFIED** |

---

## 3. Standalone Reproduction Script Index

The reproduction scripts for the most critical recent vulnerabilities are preserved in the repository:
- **ACK-12 & 12B Reproduction:** [`tests/atqa-ack12-preexisting-dom-regression.test.mjs`](file:///C:/Users/Admin/autotask/tests/atqa-ack12-preexisting-dom-regression.test.mjs)
- **ACK-13 Reproduction:** [`ATQA_ACK13_DRAFT_SCOPE_CHROMIUM_REPRO.py`](file:///C:/Users/Admin/autotask/ATQA_ACK13_DRAFT_SCOPE_CHROMIUM_REPRO.py)
- **ACK-14 Reproduction:** [`tests/atqa-ack14-missing-draft-scope.py`](file:///C:/Users/Admin/autotask/tests/atqa-ack14-missing-draft-scope.py)

### Execution Command:
```powershell
node --test tests/atqa-ack12-preexisting-dom-regression.test.mjs
py -3 ATQA_ACK13_DRAFT_SCOPE_CHROMIUM_REPRO.py
py -3 tests/atqa-ack14-missing-draft-scope.py
```
All 3 reproduction scripts confirm that vulnerabilities fail closed in baseline conditions and pass cleanly under candidate v1.1.6.

---

## 4. Current Defect Status Summary

- **Active P1 (Critical Blockers):** `0`
- **Active P2 (Functional Flaws):** `0`
- **Active P3 (Cosmetic / Documentation):** `0`
- **Current Operational Status:** Fully verified and certified for Controlled Pilot execution.
