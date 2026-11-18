# AutoTask AI v1.1.6 — Phase 8: Controlled Live Pilot Execution Report
**Execution Date:** 2026-11-05  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Candidate Size:** 438,289 bytes (164 manifest files matching byte-for-byte)  
**Host Environment:** Windows 10/11 (x64), PowerShell, Node.js v24.18.0, Python 3.14.6  
**Operational Status:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**  
**Classification Standards:** `VERIFIED`, `REPORTED_ONLY`, `NOT_TESTED`, `BLOCKED`, `FAILED`  

---

## 1. Trạng Thái Thực Tế của Source Code và Workstation

- **Thư mục làm việc:** `C:\Users\Admin\autotask` (`VERIFIED`).
- **Trạng thái Git:** Thư mục là một workspace snapshot được giải nén độc lập, không chứa `.git` nội tại (`VERIFIED`).
- **Phiên bản hệ thống:** `package.json` định danh rõ `autotask-ai-workstation` phiên bản `1.1.6` (`VERIFIED`).
- **Candidate Archive:** Tệp `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip` tồn tại nguyên vẹn, kích thước 438,289 bytes, SHA-256 tính toán thực tế bằng `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`, hoàn toàn trùng khớp với tham chiếu kiểm toán (`VERIFIED`).
- **Khớp Manifest Candidate:** Tệp manifest `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.manifest.json` ghi nhận 164 mục tệp. Đối chiếu độc lập toàn bộ 164 tệp trên ổ đĩa cho kết quả: 164/164 matched, 0 missing, 0 modified (`VERIFIED`).
- **Đối chiếu 5 báo cáo bắt buộc:**
  1. `FIRST_LIVE_SESSION_RESULT.md` — Có mặt tại root và `reports/` (`VERIFIED`).
  2. `REAL_MODEL_CONNECTION_AND_ACCURACY.md` — Có mặt tại root và `reports/` (`VERIFIED`).
  3. `REAL_PLATFORM_COMPATIBILITY_RESULTS.md` — Có mặt tại root và `reports/` (`VERIFIED`).
  4. `ACTUAL_FAILURES_AND_FIXES.md` — Có mặt tại root và `reports/` (`VERIFIED`).
  5. `NEXT_OPERATIONAL_RELEASE_GATE.md` — Có mặt tại root và `reports/` (`VERIFIED`).

---

## 2. Các Công Việc Kỹ Thuật Đã Thực Hiện trong Phase 8

1. **Xác minh môi trường & toàn vẹn tệp:** Kiểm tra cấu trúc thư mục, đối chiếu checksum manifest 164 tệp, kiểm tra các tệp test Python/Node/Playwright.
2. **Thực thi đầy đủ bộ kiểm thử hồi quy độc lập:** Chạy trực tiếp và đo lường thời gian thực thi, exit code, số lượng test case và log chi tiết cho 6 lệnh core.
3. **Thực thi kiểm tra Model Center & Benchmark AI:** Chạy trực tiếp `npx tsx scripts/run-real-model-benchmark.ts`, thu thập raw telemetry JSON.
4. **Kiểm tra trạng thái xác thực LMS:** Kiểm tra cấu hình tài khoản trong OS vault và phiên trình duyệt Chromium.
5. **Cập nhật đồng bộ bộ tài liệu kiểm toán:** Cập nhật 5 báo cáo bàn giao và lập báo cáo tổng hợp Phase 8.

---

## 3. Nhật Ký Lệnh Đã Chạy, Kết Quả và Bằng Chứng

| STT | Lệnh Thực Tế | Thời Gian Thực Thi | Exit Code | Số Lượng Test | Kết Quả Đạt / Không Đạt | Đường Dẫn Log / Bằng Chứng | Phân Loại |
|:---:|---|:---:|:---:|:---:|:---:|---|:---:|
| 1 | `npm ci` | 8.57s | `0` | 9 packages | 0 vulnerabilities (PASS) | `reports/npm_ci_run.log` | `VERIFIED` |
| 2 | `npm run doctor` | 6.37s | `0` | 10 checks | 7 PASS, 3 CẢNH BÁO cấu hình | `reports/npm_doctor_run.log` | `VERIFIED` |
| 3 | `npx tsc --noEmit` | 8.57s | `0` | 118 files | 0 syntax/type errors (PASS) | `reports/tsc_noemit_run.log` | `VERIFIED` |
| 4 | `npm test` | 81.52s | `0` | 33 suites | 516 PASS / 0 FAIL | `reports/npm_test_run.log` | `VERIFIED` |
| 5 | `npm run smoke:local` | 9.31s | `0` | 11 checks | 11 PASS / 0 FAIL | `reports/smoke_local_run.log` | `VERIFIED` |
| 6 | `py -3 -m unittest discover -s tests -p "*test.py"` | 3.845s | `0` | 14 tests | 14 PASS / 0 FAIL | `reports/python_unittest_run.log` | `VERIFIED` |
| 7 | `npx tsx scripts/run-real-model-benchmark.ts` | 4.82s | `0` | 20 items | Status: `NOT TESTED` | `reports/model_benchmark_run.log` | `VERIFIED` |

---

## 4. Các Lỗi Mới, Nguyên Nhân và Bản Sửa

- **Lỗi mới phát hiện:** `0` (Zero new defects).
- **Hồi quy mã nguồn:** Không phát hiện bất kỳ lỗi hồi quy nào. Toàn bộ 516 unit tests, 11 browser smoke checks và 14 Python unit tests đều PASS 100%.
- **Trạng thái 14 lỗi ACK lịch sử (ACK-01 đến ACK-14):** Đã được kiểm chứng bằng các suite độc lập và xác nhận giải quyết triệt để (`VERIFIED`).
- **Vị trí script tái hiện ACK-13:** `ATQA_ACK13_DRAFT_SCOPE_CHROMIUM_REPRO.py` được lưu độc lập tại thư mục gốc của workspace bên ngoài candidate ZIP do chính sách allowlist đóng gói của `package-release.ps1` (`VERIFIED`).
- **Sửa mã nguồn:** `0` thay đổi mã nguồn. Candidate ZIP giữ nguyên không thay đổi (`f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`).

---

## 5. Kết Quả Kết Nối AI Thực Tế

- **Trạng thái kết nối:** **`MODEL_SETUP_REQUIRED`** (`BLOCKED`).
- **Kiểm tra môi trường & Vault:** Không phát hiện plaintext key trong biến môi trường (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) hay tệp cấu hình không bảo mật (`VERIFIED`).
- **Kết quả Benchmark:**
  ```json
  {
    "executedAt": "2026-11-05T14:34:43.213Z",
    "status": "NOT TESTED",
    "reason": "No live AI model profile / BYOK API key is configured in .private/model-profiles.json or OS Credential Vault on this workstation. Scripted responders are strictly prohibited in Real-Model Practice Benchmark.",
    "sampleCount": 20,
    "objectiveSampleCount": 18,
    "essaySampleCount": 2,
    "goldKeyProvenance": "Independent human-authored 20-item CS/Math/Science self-practice benchmark (18 objective exact-key items + 2 deterministic concept-rubric essays in src/evaluation/real-model-benchmark.ts); zero items generated or graded by any evaluated AI model.",
    "statisticalLimitations": [
      "Small benchmark sample size (total n=20: objective n=18, open-ended essay n=2); inspect Wilson 95% confidence interval rather than treating point accuracy as universal.",
      "Objective exact-match accuracy (n=18) and open-ended essay concept-rubric pass rate (n=2) are reported separately; essay responses ALWAYS require human review before LMS submission.",
      "Self-reported model confidence is uncalibrated raw model output and is audited via 5-bin Expected Calibration Error (ECE) and overconfident-error counts, never trusted as correctness."
    ],
    "models": []
  }
  ```
- **Cam kết kiểm toán:** Tuyệt đối không tạo dữ liệu accuracy giả lập hoặc dùng responder giả để thay thế (`VERIFIED`).

---

## 6. Kết Quả LMS Pilot Thực Tế

- **Trạng thái Pilot Live:** **`LIVE_NOT_TESTED — LOGIN_REQUIRED`** (`BLOCKED`).
- **Nguyên nhân dừng:** AutoTask AI tuân thủ nguyên tắc an toàn, không sử dụng tài khoản giả lập trên môi trường trường đại học, không tự vượt cơ chế xác thực SSO/MFA/CAPTCHA và không suy diễn quyền truy cập đánh giá từ việc có tài khoản (`VERIFIED`).
- **Tình trạng adapter:** Các adapter (Radio, Checkbox, Text, Dropdown, Drag/Drop, Ordering, CodeRunner, File Manager, Vision/Math) đều đã sẵn sàng và đạt 100% PASS trong sandbox runner (`VERIFIED`).

---

## 7. Những Bước Bị Chặn và Lý Do Kỹ Thuật

| Bước Thử Nghiệm | Tình Trạng | Lý Do Kỹ Thuật & Điều Kiện Bị Chặn |
|---|:---:|---|
| **LMS Live Pilot (HUSTLMS / ED / FAMI)** | `BLOCKED` | `LOGIN_REQUIRED` — Người vận hành chưa tự thực hiện đăng nhập SSO/MFA chính thức trên trình duyệt Chromium. |
| **Real BYOK AI Model Benchmark** | `BLOCKED` | `MODEL_SETUP_REQUIRED` — Người vận hành chưa nhập API key vào Model Center (Menu [5] / Windows DPAPI vault). |
| **Live Form Submission** | `NOT_TESTED` | Bị chặn có chủ đích bởi cơ chế an toàn human-in-the-loop (`CHECK` / `KEEP` / `SUBMIT`). |

---

## 8. Những Thao Tác Người Vận Hành Cần Thực Hiện

Để chuyển tiếp từ `READY FOR PILOT` sang `PILOT IN PROGRESS`:

1. **Cấu hình Model AI (BYOK):**
   - Chạy lệnh: `npm run models` (hoặc mở Command Deck `npm start` -> chọn `[5] Model Center`).
   - Chọn `[2] Thêm model profile mới`.
   - Chọn nhà cung cấp (Gemini, Claude, OpenAI, Custom), nhập model ID và nhập API key (khóa được mã hóa tự động vào Windows DPAPI vault, không lưu plaintext).
   - Chọn `[6] Test kết nối model` để kiểm tra kết nối với prompt thử nghiệm tối thiểu (`"Ping"`).
   - Chạy kiểm chuẩn: `npx tsx scripts/run-real-model-benchmark.ts` để ghi nhận telemetry accuracy thật.

2. **Đăng nhập LMS chính thức:**
   - Chạy lệnh: `Start_AutoTask_AI.cmd` (hoặc `npm start`).
   - Chọn `[1] Browser Agent` (hoặc cấu hình qua `[6] Account Vault`).
   - Hoàn thành quy trình SSO/MFA/CAPTCHA của nhà trường trực tiếp trên cửa sổ trình duyệt Chromium mở ra.

3. **Thực hiện một tác vụ tự luyện được phép:**
   - Điều hướng tới một bài tập tự luyện tập / form khảo sát được phép sử dụng AI.
   - Để `AI_PRIMARY` phân tích và điền bản nháp ở chế độ `PRACTICE_ASSISTED`.
   - Kiểm tra giá trị trên DOM và xác nhận lưu nháp.

---

## 9. Đánh Giá Release Gate Hiện Tại

- **Quyết định Release Gate:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**.
- **Tuân thủ quy tắc chuyển trạng thái:**
  - Chưa đủ 4 điều kiện tiên quyết (đăng nhập chính thức, kết nối BYOK thật, 1 tác vụ tự luyện live có telemetry).
  - Do đó, **giữ nguyên `READY FOR PILOT`**, không tự ý nâng lên `PILOT IN PROGRESS`, `PILOT COMPLETED` hay `GENERAL RELEASE`.

---

## 10. Nhiệm Vụ Kỹ Thuật Tiếp Theo Có Thể Thực Thi

1. **Sẵn sàng đón nhận phiên live đầu tiên:** Hệ thống tự động kích hoạt `PRACTICE_ASSISTED` ngay khi session cookie được ghi nhận trong `context`.
2. **Theo dõi Telemetry độc lập:** Khi người vận hành hoàn tất 2 bước cấu hình, thu thập ngay `FIRST_LIVE_SESSION_RESULT.md` và `REAL_MODEL_CONNECTION_AND_ACCURACY.md` với dữ liệu thực tế.
3. **Bảo tồn Candidate Release:** Giữ nguyên archive SHA-256 `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`.
