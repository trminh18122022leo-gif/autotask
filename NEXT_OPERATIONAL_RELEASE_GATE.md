# AutoTask AI v1.1.6 — Next Operational Release Gate Decision
**Audit Date:** 2026-11-06 (Cập nhật nghiệm thu thực tế của Người Vận Hành)  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Archive Size:** 438,289 bytes (164 packaged files matching manifest)  
**Host Platform:** Windows 10/11 (x64), PowerShell, Node.js v24.18.0, Python 3.14.6  
**Formal Operational Decision:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**  
**Verification Category:** **`VERIFIED (Sandbox, Real BYOK Model, Dual Startup Paths, Operator Live Observation & Strict TLS) / PENDING (Authorized Task Selection)`**  

---

## 1. Formal Evidence-Based Release Decision

In accordance with Phase 8G release governance rules, **a release status must strictly reflect the actual empirical evidence available, and must never be prematurely elevated**:

| Operational Status Tier | Governance Definition | Current Status |
|---|---|:---:|
| **READY FOR PILOT** | Source code, sandbox suites, real BYOK AI connection & benchmark, official Browser Agent observation, strict TLS chain, dual startup paths, and live dashboard observation verified at 100% compliance; live pilot pending authorized self-practice selection. | **ACTIVE (CERTIFIED)** |
| **PILOT IN PROGRESS** | At least one authorized live practice session started, authenticated, drafted, and recorded with telemetry. | **NEXT MILESTONE** |
| **PILOT COMPLETED** | Completed empirical evidence gathered across all declared platforms and adapter workflows. | *Pending Live Trials* |
| **GENERAL RELEASE** | Production evidence demonstrating long-term stability, crash recovery, and multi-model AI quality. | *Future Production Phase* |

> [!CAUTION]
> **GOVERNANCE DIRECTIVE:**  
> AutoTask AI v1.1.6 remains formally certified as **`READY FOR PILOT`**.  
> **IT WILL NOT BE ELEVATED TO `PILOT IN PROGRESS`** simply because the operator successfully logged in or because the dashboard was observed by the official agent. Elevation strictly requires an authorized, un-graded self-practice activity where AI assistance is permitted, accompanied by live DOM draft fill telemetry.

---

## 2. Gate Verification Summary Matrix (Cập Nhật Nghiệm Thu Thực Tế)

| Verification Domain | Evaluation Harness / Command | Result | Gate Status | Category |
|---|---|:---:|:---:|:---:|
| **Dependency Integrity** | `npm ci` (Audited 9 packages in 8.57s) | 0 vulnerabilities | **PASS** | `VERIFIED` |
| **Preflight Doctor** | `npm run doctor` (10 checks) | 9 PASS / 1 CẢNH BÁO (Vault login) | **PASS** | `VERIFIED` |
| **Browser Task Config** | `.private/browser-task.json` (4 hosts, READ_ONLY) | Validated compliant | **PASS** | `VERIFIED` |
| **TypeScript Static Check** | `npm run typecheck` (120 files) | 0 errors | **PASS** | `VERIFIED` |
| **Unit Regression Suite** | `npm test` (37 test suites, 543 tests) | 543/543 PASS | **PASS** | `VERIFIED` |
| **Browser Smoke Suite** | `npm run smoke:local` (11 checks in 9.31s) | 11/11 PASS | **PASS** | `VERIFIED` |
| **Python Core Workers** | `py -3 -m unittest discover` (14 tests in 2.35s) | 14/14 PASS | **PASS** | `VERIFIED` |
| **Historical Fixes (ACK-01..14)** | Standalone regression scripts | 14/14 RESOLVED | **PASS** | `VERIFIED` |
| **Real BYOK Model Connection** | `testConnection` (`gemini-3.1-flash-lite`) | HTTP 200 OK (1667ms latency) | **PASS** | `VERIFIED` |
| **Real AI Benchmark Accuracy** | `scripts/run-real-model-benchmark.ts` | 20/20 PASS (100%, Wilson CI: [0.8241, 1.0]) | **PASS** | `VERIFIED` |
| **Dual Startup Paths Verification** | `tests/startup-verification.test.ts` (STARTUP-01..06) | `Start_AutoTask_AI.cmd` & `npm start` TLS Authorized | **PASS** | `VERIFIED` |
| **Intermediate CA Bootstrap** | `src/ca-bootstrap.ts` self-respawn engine | C++ Node process loads PEM without security bypass | **PASS** | `VERIFIED` |
| **Live Operator Observation** | `npm start` run by operator, Microsoft SSO login | Dashboard rendered, 2 courses shown, `NEEDS_REVIEW` | **PASS** | `VERIFIED` |
| **Resolution of ERR_BLOCKED_BY_CLIENT** | Live browser navigation to `https://lms.hust.edu.vn/my/` | 0 navigation aborts; TLS verified | **PASS** | `VERIFIED` |
| **Safe Read-Only AJAX Allowlist** | `SAFE_READ_ONLY_AJAX_METHODS` & `isSafeReadOnlyAjaxRequest` | Moodle metadata queries allowed, mutations fail-closed | **PASS** | `VERIFIED` |
| **Session Data Hardening** | `tests/session-data-hardening.test.ts` (HARDEN-01..16) | 16/16 PASS; zero token, sesskey, or cookie leaks | **PASS** | `VERIFIED` |
| **Zero Server State Mutation** | Live READ_ONLY execution against `lms.hust.edu.vn` | 0 attempts started, 0 drafts filled, 0 submits | **PASS** | `VERIFIED` |
| **Authorized Self-Practice Task** | Permitted un-graded quiz selection | Pending operator approval & selection | **HALTED AT GATE** | `BLOCKED` |

---

## 3. Phân Định Biên Giới Kiểm Toán (Verified vs Unverified)

### A. Đã Xác Minh Thành Công Qua Quan Sát Thực Tế (Verified Live Observation):
1. **Khởi chạy `npm start` có CA Bootstrap:** Module `src/ca-bootstrap.ts` tự động phát hiện và nạp chứng chỉ trung gian GlobalSign vào tiến trình C++ Node mà không cần biến môi trường shell thủ công.
2. **Đăng nhập Microsoft SSO vào LMS HUST:** Xác thực SSO thành công, thiết lập phiên đăng nhập chính thức.
3. **Kết xuất Dashboard & 2 Khóa Học trên DOM:** Tải đầy đủ `https://lms.hust.edu.vn/my/` và hiển thị động 2 học phần (`BL-ED3220 - Kỹ năng mềm` và `BL-MI2020 - Xác suất thống kê`).
4. **Loại bỏ hoàn toàn lỗi `ERR_BLOCKED_BY_CLIENT`:** Không còn lỗi hủy bỏ điều hướng hay lỗi xác thực chứng chỉ lá TLS.
5. **Terminal nhận diện Moodle & Trả về `NEEDS_REVIEW`:** Nhận diện đúng nền tảng và kết thúc an toàn ở trạng thái kiểm soát của người vận hành.
6. **Bảo toàn dữ liệu máy chủ:** Xác nhận $0$ lượt làm bài mở mới, $0$ câu trả lời nháp, $0$ bài nộp tự động.

### B. Các Kiểm Tra Mạng Chưa Được Xác Minh Trên Môi Trường Thực Tế (Unverified Production Checks):
- **Khởi tạo lượt thi Moodle (`mod_quiz/startattempt.php`):** *CHƯA KIỂM THỬ TRÊN PRODUCTION* (chỉ xác minh trên sandbox cục bộ).
- **Ghi bản nháp câu hỏi (`mod_quiz/processattempt.php`):** *CHƯA KIỂM THỬ TRÊN PRODUCTION* (chờ nhiệm vụ tự luyện được chọn).
- **Tải tệp đính kèm File Manager Moodle:** *CHƯA KIỂM THỬ TRÊN PRODUCTION* (chỉ xác minh trên sandbox SANDBOX-01..09).
- **Xử lý câu hỏi CodeRunner:** *CHƯA KIỂM THỬ TRÊN PRODUCTION* (chỉ xác minh trên sandbox).
- **Tự động làm bài hoặc nộp bài:** *CẤM & KHÔNG THỰC HIỆN* (người dùng nộp bài thủ công).
- **Tương tác trên FAMI & English Discoveries:** *CHƯA KIỂM THỬ TRÊN PRODUCTION* (chỉ xác minh trên unit test).

---

## 4. Deliverables Index

All canonical deliverables for Phase 8 through Phase 8G are available in the workspace root and mirrored in `reports/`:
1. [`reports/PHASE8G_STARTUP_NETWORK_SECURITY_REPORT.md`](file:///c:/Users/Admin/autotask/reports/PHASE8G_STARTUP_NETWORK_SECURITY_REPORT.md) / [`PHASE8G_STARTUP_NETWORK_SECURITY_REPORT.md`](file:///c:/Users/Admin/autotask/PHASE8G_STARTUP_NETWORK_SECURITY_REPORT.md)
2. [`reports/phase8g_network_telemetry.json`](file:///c:/Users/Admin/autotask/reports/phase8g_network_telemetry.json)
3. [`FIRST_LIVE_SESSION_RESULT.md`](file:///c:/Users/Admin/autotask/FIRST_LIVE_SESSION_RESULT.md) / [`reports/FIRST_LIVE_SESSION_RESULT.md`](file:///c:/Users/Admin/autotask/reports/FIRST_LIVE_SESSION_RESULT.md)
4. [`reports/PHASE8F_READONLY_EVIDENCE_RECONCILIATION.md`](file:///c:/Users/Admin/autotask/reports/PHASE8F_READONLY_EVIDENCE_RECONCILIATION.md) / [`PHASE8F_READONLY_EVIDENCE_RECONCILIATION.md`](file:///c:/Users/Admin/autotask/PHASE8F_READONLY_EVIDENCE_RECONCILIATION.md)
5. [`reports/PHASE8E_AUTHENTICATED_READONLY_RESULT.md`](file:///c:/Users/Admin/autotask/reports/PHASE8E_AUTHENTICATED_READONLY_RESULT.md) / [`PHASE8E_AUTHENTICATED_READONLY_RESULT.md`](file:///c:/Users/Admin/autotask/PHASE8E_AUTHENTICATED_READONLY_RESULT.md)
6. [`reports/PHASE8D_REAL_PILOT_RESULT.md`](file:///c:/Users/Admin/autotask/reports/PHASE8D_REAL_PILOT_RESULT.md) / [`PHASE8D_REAL_PILOT_RESULT.md`](file:///c:/Users/Admin/autotask/PHASE8D_REAL_PILOT_RESULT.md)
7. [`reports/PHASE8C_REAL_OPERATOR_HANDOFF.md`](file:///c:/Users/Admin/autotask/reports/PHASE8C_REAL_OPERATOR_HANDOFF.md) / [`PHASE8C_REAL_OPERATOR_HANDOFF.md`](file:///c:/Users/Admin/autotask/PHASE8C_REAL_OPERATOR_HANDOFF.md)
8. [`reports/PHASE8B_OPERATOR_GATE_REPORT.md`](file:///c:/Users/Admin/autotask/reports/PHASE8B_OPERATOR_GATE_REPORT.md) / [`PHASE8B_OPERATOR_GATE_REPORT.md`](file:///c:/Users/Admin/autotask/PHASE8B_OPERATOR_GATE_REPORT.md)
9. [`reports/PHASE8_EXECUTION_REPORT.md`](file:///c:/Users/Admin/autotask/reports/PHASE8_EXECUTION_REPORT.md) / [`PHASE8_EXECUTION_REPORT.md`](file:///c:/Users/Admin/autotask/PHASE8_EXECUTION_REPORT.md)
10. [`REAL_MODEL_CONNECTION_AND_ACCURACY.md`](file:///c:/Users/Admin/autotask/REAL_MODEL_CONNECTION_AND_ACCURACY.md) / [`reports/REAL_MODEL_CONNECTION_AND_ACCURACY.md`](file:///c:/Users/Admin/autotask/reports/REAL_MODEL_CONNECTION_AND_ACCURACY.md)
11. [`REAL_PLATFORM_COMPATIBILITY_RESULTS.md`](file:///c:/Users/Admin/autotask/REAL_PLATFORM_COMPATIBILITY_RESULTS.md) / [`reports/REAL_PLATFORM_COMPATIBILITY_RESULTS.md`](file:///c:/Users/Admin/autotask/reports/REAL_PLATFORM_COMPATIBILITY_RESULTS.md)
12. [`ACTUAL_FAILURES_AND_FIXES.md`](file:///c:/Users/Admin/autotask/ACTUAL_FAILURES_AND_FIXES.md) / [`reports/ACTUAL_FAILURES_AND_FIXES.md`](file:///c:/Users/Admin/autotask/reports/ACTUAL_FAILURES_AND_FIXES.md)
13. [`NEXT_OPERATIONAL_RELEASE_GATE.md`](file:///c:/Users/Admin/autotask/NEXT_OPERATIONAL_RELEASE_GATE.md) / [`reports/NEXT_OPERATIONAL_RELEASE_GATE.md`](file:///c:/Users/Admin/autotask/reports/NEXT_OPERATIONAL_RELEASE_GATE.md)

- **Candidate Archive:** [`release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`](file:///c:/Users/Admin/autotask/release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip)
- **Manifest:** [`release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.manifest.json`](file:///c:/Users/Admin/autotask/release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.manifest.json)
- **SHA-256 Checksum:** [`release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip.sha256`](file:///c:/Users/Admin/autotask/release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip.sha256)
