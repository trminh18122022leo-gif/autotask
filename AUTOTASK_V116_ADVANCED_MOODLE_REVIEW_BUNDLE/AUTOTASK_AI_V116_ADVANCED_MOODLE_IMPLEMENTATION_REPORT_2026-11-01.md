# AutoTask AI v1.1.6 — Advanced Moodle Adapters: Implementation & Independent Test Report

**Ngày:** 01/11/2026  
**Baseline:** `autotask-ai-v1.1.6-ai-primary-form-option-candidate.zip`  
**Candidate:** `autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Status:** `PARTIAL — IMPLEMENTED IN CANDIDATE; FULL WINDOWS + REAL MOODLE E2E NOT TESTED`  

## 1. Thay đổi source thực tế

- `src/lms/advanced-adapters.ts` (mới): API chọn lọc nhận diện DOM Moodle practice, chuẩn bị trường ordering/dragdrop, CodeRunner draft và File Manager; thao tác bằng UI Playwright, kiểm tra hậu điều kiện. Không chỉnh sửa trực tiếp các trường hidden của plugin hoặc gọi endpoint chấm điểm/nộp bài.
- `src/scanner.ts`: bổ sung chuyển đổi MathML giới hạn (`mfrac`, `msup`, `msub`, `msqrt`, mi/mn/mo, ...) sang TeX khi MathJax/KaTeX không có annotation; trường hợp không đọc được vẫn phải xử lý như câu hỏi có hình.
- `src/ai.ts`: hỏi AI theo cấu trúc đáp án cho ordering (`selected` là hoán vị) và dragdrop (`placements` là cặp item/zone); kiểm tra ID và không chấp nhận đường dẫn file do model bịa. Hình ảnh chỉ được chụp đúng vùng câu hỏi thay vì toàn trang LMS. Nếu chưa bật model Vision, không trả lời đoán câu bắt buộc phải xem hình.
- `src/fill.ts`: định tuyến bốn adapter mới tới các hàm fill có kiểm chứng.
- `src/main.ts`: chỉ nâng cấp question theo adapter khi task là `PRACTICE_ASSISTED` + attestation `PERMITTED_SELF_PRACTICE` + bật adapter rõ ràng. Tệp upload chỉ lấy từ task.attachmentFiles do người dùng chọn; không gửi tệp riêng tư sang model. Nếu AI không giải được một batch, ghi cảnh báo và không đánh dấu hoàn tất giả.
- `src/types.ts`: bổ sung `ordering`, `dragdrop`, `code`, `moodle-file`, danh sách drop zones và placements.
- `tests/moodle-advanced-adapters.test.ts` (mới): 8 trường hợp kiểm thử opt-in, nhận diện, validation, chặn nguồn file AI, chống plugin không cập nhật DOM.
- `tests/advanced_browser_dom_check.py` (mới): 6 fixture với Chromium thực, dùng trực tiếp JavaScript evaluate được biên dịch từ source scanner và adapter.
- `README.md`: hướng dẫn cách cấu hình opt-in theo từng task.

## 2. Ma trận tính năng mới

| Nhóm câu hỏi | Trạng thái candidate | Bằng chứng / hạn chế |
|---|---|---|
| Ảnh & công thức | `IMPROVED — PARTIAL` | MathML subset đã kiểm chứng trên Chromium. Hình được chụp riêng vùng câu hỏi; vẫn phụ thuộc Vision BYOK và hình thức plugin thực tế. |
| Ordering (sắp xếp) | `EXPERIMENTAL` | Nhận diện `.sortablelist .sortableitem`, dùng `dragTo()`, so sánh chính xác thứ tự DOM sau thao tác. Chưa có E2E trên Moodle qtype_ordering thật. |
| Drag-and-drop | `EXPERIMENTAL` | Nhận diện item/zone có nhãn/ID, dùng UI kéo thả và yêu cầu chứng cứ state/DOM thay đổi; không can thiệp hidden state trực tiếp. Chưa chứng minh với ddmarker tọa độ ảnh hoặc tất cả bản Moodle YUI/AMD. |
| Moodle File Manager | `EXPERIMENTAL` | Có adapter mở repository, chọn file thật, xác nhận Upload this file và chờ file xuất hiện trong File Manager. Chưa chứng minh draftitemid/AJAX server persisted với Moodle thật. |
| CodeRunner | `DRAFT ONLY — EXPERIMENTAL` | Có nhánh điền code vào editor nhận diện được và xác minh textarea nền; không bấm Check/Submit, không chạy testcases của máy chủ. Plugin STACK/Formulas/ACE đặc thù chưa có adapter riêng. |

**Không nên gọi toàn bộ 5 nhóm là hoàn tất, phổ quát, hoặc 100% tương thích.** Không tự động hóa bài kiểm tra có tính điểm hay vô hiệu hóa cổng quyền truy cập.

## 3. Kết quả kiểm thử trực tiếp

| Test | Độc lập | Diễn giải |
|---|---:|---|
| Targeted Node (`moodle-advanced-adapters`, `ai-primary-routing`, `answer-bank`) | **20/20 PASS** | Unit-level, không phải Moodle thực |
| Node regression subset rộng | **202/205 PASS** | 3 ca không thực thi được do thiếu Node module `playwright` trong môi trường này: `AUD-LMS-04`, `ORIGIN-06`, `ORIGIN-07` |
| Chromium DOM fixture (Python Playwright + `/usr/bin/chromium`) | **6/6 PASS** | Scanner/adapter evaluate thật trên HTML tổng hợp, không phải plugin Moodle thật |
| Offline TypeScript transpilation | **113 tệp, 0 syntax errors** | KHÔNG thay thế `npm run typecheck` |
| Python unit (non-Windows Vault) | **9 PASS** | 1 module Windows Vault không chạy vì môi trường thiếu `keyring` |
| `npm run typecheck`, `npm test` đầy đủ, Windows smoke/E2E | **NOT VERIFIED** | Không có `node_modules` Playwright / `@types/node` ở môi trường hiện tại |
| Moodle/HUSTLMS, English Discoveries, FAMI production | **NOT TESTED** | Không truy cập tài khoản thật |
| Real BYOK LLM accuracy | **NOT TESTED** | Không dùng API key người dùng |

## 4. Gating và mức độ nghiệm thu

Các adapter không bật theo mặc định; yêu cầu task có `mode: PRACTICE_ASSISTED`, `scopeAttestation: PERMITTED_SELF_PRACTICE` và `advancedLmsAdapters` cài rõ từng nhóm. Các giới hạn `READ_ONLY`, scope assessment, hostname, login, CAPTCHA/OTP và xác nhận cuối vẫn phải được kiểm chứng đầy đủ trên Windows trước khi dùng.

**Chưa đạt yêu cầu “hoàn thiện toàn bộ dạng bài”**, vì chưa có E2E Moodle thật cho drag/drop có tọa độ, AJAX File Manager draft persistence và CodeRunner plugin editor. Đây là bản source thực nghiệm có kiểm chứng subset, không phải bản production-ready.

## 5. Đầu việc AGY cần hoàn thành để nghiệm thu

1. `npm ci`, `npm run typecheck`, `npm test`, `npm run smoke:local`, Python/Windows Vault từ bản ZIP giải nén sạch.
2. Moodle HTTP sandbox Chromium E2E cho mỗi qtype: ordering, ddwtos, ddmarker, ddimageortext, filemanager AJAX và coderunner Ace/CodeMirror. Phải chứng minh trạng thái server hoặc plugin nhận bài nháp đúng; nếu không có bằng chứng, giữ `NEEDS_REVIEW`.
3. Quy trình upload phải có `draftitemid` đúng, file MIME/size hợp lệ, không lộ session và không upload trùng sau restart.
4. Kiểm chứng capture hình/math ở vùng câu hỏi và tách media phương án; benchmark Vision BYOK chỉ với bài tự luyện độc lập.
5. CodeRunner editor chỉ được điền bản nháp vào bài tự luyện được phép, giữ nút Check/Submit do người học quyết định; plugin chưa biết vẫn từ chối tự động.
6. Không tự ghi PASS nếu test chỉ là synthetic DOM hoặc chưa chạy trên Windows.

**Khuyến nghị:** chuyển cho AGY đóng E2E/compatibility gap trước, chưa ban hành prompt Full LMS Workflow Completion như thể các adapter đã hoàn thiện.
