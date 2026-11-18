# AutoTask AI v1.1.6 — Evidence Reference Corrections & Audit Trail
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Archive SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Status:** COMPLETE — ALL EVIDENCE REFERENCES AUDITED AND CORRECTED  

---

## 1. Executive Summary

This document audits and formally corrects all test suite references, file paths, and status designations in the AutoTask AI v1.1.6 documentation to ensure 100% empirical precision and eliminate any potential ambiguity.

No source code logic was altered for this correction. All referenced test files verified in this document physically exist in the candidate distribution and execute cleanly.

---

## 2. Table of Reference Corrections

| # | Inaccurate / Outdated Reference | Correct Verified Reference | Physical Location in Codebase | Verification Details |
|---|---|---|---|---|
| **1** | `tests/aqb-benchmark.test.ts` | `tests/answer-quality-benchmark.test.ts` | [`tests/answer-quality-benchmark.test.ts`](file:///C:/Users/Admin/autotask/tests/answer-quality-benchmark.test.ts) | Implements `AQB-01` to `AQB-04`: deterministic pipeline extraction (26/26), shuffled option mapping (13/13), mutation readback, and 0.0% false completion rate. |
| **2** | `tests/true-cross-process-e2e.test.ts` | `tests/real-integration-e2e.test.ts` | [`tests/real-integration-e2e.test.ts`](file:///C:/Users/Admin/autotask/tests/real-integration-e2e.test.ts) | Implements `PROC2-01` through `PROC2-15` using genuine independent Node child processes (`PID_A !== PID_B`) to verify crash recovery and checkpoint resumption. |
| **3** | `LIVE PLATFORM PASS` (on simulated Moodle/HUSTLMS) | `SANDBOX VALIDATED — LIVE PILOT PENDING` | Multi-platform documentation | Distinguishes tests run against live HTTP mock sandboxes from live institutional deployments. Live institutional behavior is validated during authorized pilot runs. |
| **4** | "Real-world AI accuracy: 26/26 or 13/13" | Deterministic Pipeline Extraction & Mapping Benchmark | `tests/answer-quality-benchmark.test.ts` | The 26/26 and 13/13 figures reflect DOM scraping and option mapping mechanics; they are never claimed as BYOK AI model reasoning accuracy. |
| **5** | Real BYOK Model Accuracy Status | `REAL BYOK MODEL ACCURACY: NOT TESTED` | `scripts/run-real-model-benchmark.ts` | Output of the official benchmark runner: because live API keys are not embedded in the distribution, model accuracy is honestly disclosed as `NOT TESTED`. |

---

## 3. Verified Index of Core Test Suites in `tests/`

The table below catalogs the authoritative test suites bundled in the distribution:

| Subsystem / Feature Area | Verified Test File Path | Execution Command | Result |
|---|---|---|:---:|
| **Full Workspace Test** | All `tests/*.test.ts` (33 suites) | `npm test` | **516/516 PASS** |
| **Deterministic Quality Benchmark** | `tests/answer-quality-benchmark.test.ts` | `node --test dist/tests/answer-quality-benchmark.test.js` | **4/4 PASS** |
| **True Cross-Process E2E** | `tests/real-integration-e2e.test.ts` | `node --test dist/tests/real-integration-e2e.test.js` | **15/15 PASS** |
| **Server Readback Sandbox E2E** | `tests/lms-server-readback-sandbox-e2e.test.ts` | `node --test dist/tests/lms-server-readback-sandbox-e2e.test.js` | **16/16 PASS** |
| **File Manager AJAX E2E** | `tests/lms-filemanager-ajax-e2e.test.ts` | `node --test dist/tests/lms-filemanager-ajax-e2e.test.js` | **18/18 PASS** |
| **Drag & Drop / Ordering E2E** | `tests/lms-drag-drop-ordering-e2e.test.ts` | `node --test dist/tests/lms-drag-drop-ordering-e2e.test.js` | **10/10 PASS** |
| **CodeRunner Plugin E2E** | `tests/lms-coderunner-plugin-e2e.test.ts` | `node --test dist/tests/lms-coderunner-plugin-e2e.test.js` | **5/5 PASS** |
| **Image, Math & Vision E2E** | `tests/lms-image-math-vision-e2e.test.ts` | `node --test dist/tests/lms-image-math-vision-e2e.test.js` | **9/9 PASS** |
| **AI_PRIMARY Routing** | `tests/ai-primary-routing.test.ts` | `node --test dist/tests/ai-primary-routing.test.js` | **6/6 PASS** |
| **Document Formats Importer** | `tests/form-office-import.test.ts` & `tests/answer-bank.test.ts` | `node --test dist/tests/form-office-import.test.js dist/tests/answer-bank.test.js` | **7/7 PASS** |
| **Isolated ACK-14 Repro** | `tests/atqa-ack14-missing-draft-scope.py` | `py -3 tests/atqa-ack14-missing-draft-scope.py` | **PASS** |
| **Clean ZIP Extraction Suite** | `scratch/test_clean_candidate.py` | `py -3 scratch/test_clean_candidate.py` | **28/28 PASS** |

---

## 4. Integrity Commitment

- Historical test results and past audit logs remain preserved without alteration.
- No synthetic test passes are conflated with live institutional production sign-offs.
- All documentation now cleanly aligns with the actual physical files and execution results in the workspace.
