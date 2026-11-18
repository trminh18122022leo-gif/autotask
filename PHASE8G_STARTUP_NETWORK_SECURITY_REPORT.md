# AutoTask AI v1.1.6 — Phase 8G: Startup, Network Audit & Session Data Hardening Report
**Audit Date:** 2026-11-06 (Cập nhật nghiệm thu thực tế của Người Vận Hành)  
**Auditor:** Principal Software Engineer, Independent QA Auditor & Security Lead  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481` (164/164 tệp, khóa nguyên vẹn)  
**Host Platform:** Windows 10/11 (x64), PowerShell, Node.js v24.18.0, Python 3.14.6  
**LMS Host Đích:** `lms.hust.edu.vn` (IP: `202.191.59.160`, Moodle 4.x Boost Theme)  
**Quyết Định Release Gate:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**  
**Phân Loại Kiểm Toán:** **`OPERATOR_AUTHENTICATED_OBSERVED` / `STARTUP_CERTIFIED` / `NETWORK_RECONCILED`**  

---

## 1. Xác Minh Hai Đường Khởi Chạy (Dual Startup Paths & Strict TLS)

Hệ thống đã kiểm tra độc lập và chứng minh cả hai cơ chế khởi động đều nạp chứng chỉ CA trung gian hợp lệ, đảm bảo kết nối an toàn với máy chủ trường mà **tuyệt đối không tắt kiểm tra HTTPS** và **không sử dụng `NODE_TLS_REJECT_UNAUTHORIZED=0`**:

### A. Đường Khởi Chạy 1 — [`Start_AutoTask_AI.cmd`](file:///c:/Users/Admin/autotask/Start_AutoTask_AI.cmd)
- **Cơ chế:** Script cmd tự động kiểm tra sự tồn tại của tệp CA trung gian và thiết lập biến môi trường trước khi khởi động tiến trình Node:
  ```cmd
  if exist "%~dp0.private\globalsign_intermediate.pem" (
      set "NODE_EXTRA_CA_CERTS=%~dp0.private\globalsign_intermediate.pem"
  )
  npm start
  ```
- **Kết quả kiểm toán thực nghiệm:**
  - `Path A NODE_EXTRA_CA_CERTS`: `C:\Users\Admin\autotask\.private\globalsign_intermediate.pem`
  - `Path A TLS Verification`: `Authorized = true` (Exit code: 0).

### B. Đường Khởi Chạy 2 — Trực Tiếp `npm start` / `npm run browser` (CLI Naked Terminal)
- **Vấn đề kỹ thuật:** Khi người vận hành chạy `npm start` hoặc `npm run browser` trực tiếp từ PowerShell hoặc Command Prompt mà không qua file `.cmd`, biến môi trường `NODE_EXTRA_CA_CERTS` trong shell chưa được thiết lập. Vì Node.js chỉ đọc biến này một lần duy nhất tại thời điểm khởi tạo tiến trình C++, việc gán `process.env.NODE_EXTRA_CA_CERTS` trong JavaScript runtime không có tác dụng với TLS engine của Node.
- **Giải pháp Bootstrap Tự Khởi Tạo ([`src/ca-bootstrap.ts`](file:///c:/Users/Admin/autotask/src/ca-bootstrap.ts)):**
  Hệ thống bổ sung module tự điều hướng an toàn tại điểm nhập lệnh:
  ```typescript
  export function bootstrapIntermediateCa(): void {
    const caCertPath = resolve('.private', 'globalsign_intermediate.pem');
    if (!process.env.NODE_EXTRA_CA_CERTS && existsSync(caCertPath) && !process.env._AUTOTASK_CA_RESPAWNED) {
      const child = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: caCertPath,
          _AUTOTASK_CA_RESPAWNED: '1'
        }
      });
      process.exit(child.status ?? 0);
    }
  }
  ```
- **Tích hợp:** Module được kích hoạt tại dòng đầu tiên của [`src/launcher.ts`](file:///c:/Users/Admin/autotask/src/launcher.ts) và tại khối thực thi trực tiếp CLI của [`src/main.ts`](file:///c:/Users/Admin/autotask/src/main.ts). Khi được import dưới dạng thư viện trong bộ test unit (`tests/*.test.ts`), module hoàn toàn không tự respawn, bảo toàn 100% môi trường test runner.
- **Kết quả kiểm toán thực nghiệm:** Tiến trình khởi chạy không có biến môi trường tự động respawn với chứng chỉ CA được nạp đầy đủ vào engine C++:
  - `Path B active NODE_EXTRA_CA_CERTS`: `C:\Users\Admin\autotask\.private\globalsign_intermediate.pem`
  - `Path B TLS Verification`: `Authorized = true` (Exit code: 0).
- **Cam kết an toàn:** Toàn bộ codebase đạt chuẩn kiểm toán `STARTUP-03`, không chứa bất kỳ chỉ thị `NODE_TLS_REJECT_UNAUTHORIZED=0` hay `rejectUnauthorized: false` nào.

---

## 2. Giải Thích & Sửa Chữa Mâu Thuẫn Telemetry (Telemetry Accounting Reconciliation)

### A. Phân Tích Mã Nguồn Gốc Rễ Mâu Thuẫn Phase 8F:
Trong báo cáo Phase 8F và [`reports/phase8f_official_agent_telemetry.json`](file:///c:/Users/Admin/autotask/reports/phase8f_official_agent_telemetry.json), các chỉ số được ghi nhận:
```
REQUEST_OBSERVED = 112
REQUEST_ALLOWED = 101
REQUEST_BLOCKED = 13
```
Tuy nhiên: $101 + 13 = 114 \neq 112$.

**Nguyên nhân mã nguồn chính xác:**
1. Trong [`scripts/run-official-readonly-audit.ts`](file:///c:/Users/Admin/autotask/scripts/run-official-readonly-audit.ts#L131-L149), tổng số request quan sát được từ sự kiện `context.on('request')` là 112 (gồm 101 GET và 11 POST).
2. Tác giả script đã gán:
   ```typescript
   REQUEST_ALLOWED: getRequests.length // 101
   ```
3. Trong khi đó, tại [`src/main.ts`](file:///c:/Users/Admin/autotask/src/main.ts), bộ lọc `contextBlockHandler` đã chặn 13 request (9 POST tới `service.php` và 4 GET tới `/lib/ajax/service-nologin.php`).
4. **4 request GET tới `service-nologin.php` đã bị đếm trùng hai lần (double-counted):**
   - Lần 1: Nằm trong tập hợp `getRequests` (101 request GET) và bị coi là `REQUEST_ALLOWED`.
   - Lần 2: Nằm trong danh sách `taskResult.readOnlyBlockedRequests` (13 request bị chặn) và bị coi là `REQUEST_BLOCKED`.
5. Thực tế chính xác của phiên Phase 8F là:
   - $101 - 4 = 97$ request GET thực sự được phép.
   - $11 - 9 = 2$ request POST thực sự được phép (hoặc 112 - 13 = 99 request được gửi tới máy chủ).
   - 13 request bị hủy tại máy khách (`blockedbyclient`).
   - Tổng: $99 + 13 = 112$ (Đúng định luật bảo toàn request).

### B. Cơ Chế Đếm Rời Rạc Độc Lập (Mutually Exclusive Accounting Invariant):
Hệ thống thiết lập nguyên lý kiểm toán toán học bất biến:
$$\text{REQUEST\_OBSERVED} = \text{REQUEST\_ALLOWED} + \text{REQUEST\_BLOCKED}$$
Mọi request khi được xử lý bởi Playwright routing chỉ thuộc đúng một trong hai trạng thái:
- **`REQUEST_ALLOWED`:** Request vượt qua bộ kiểm tra an toàn và được phát đi mạng (`route.continue()` hoặc `route.fulfill()`).
- **`REQUEST_BLOCKED`:** Request bị xác định là hành vi thay đổi trạng thái hoặc không an toàn và bị hủy bỏ lập tức (`route.abort('blockedbyclient')`).
- Giao của hai tập hợp: $\text{ALLOWED} \cap \text{BLOCKED} = \emptyset$.

### C. Mở Khóa AJAX Đọc An Toàn Cho Moodle (Safe Read-Only AJAX):
1. **Loại bỏ chặn nhầm `service-nologin.php`:**
   - Trong Moodle, `/lib/ajax/service-nologin.php` là dịch vụ công khai chỉ phục vụ đọc template Mustache (`core_output_load_template_with_dependencies`) và chuỗi đa ngôn ngữ.
   - Đã loại bỏ `service-nologin.php` khỏi `MUTATING_PATH_REGEX` trong [`src/operation-mode.ts`](file:///c:/Users/Admin/autotask/src/operation-mode.ts). Các yêu cầu GET tải giao diện qua endpoint này hiện được cho phép an toàn.
2. **Danh mục trắng các phương thức metadata Moodle được phép (`SAFE_READ_ONLY_AJAX_METHODS`):**
   - `core_course_get_enrolled_courses_by_timeline_classification`: Tải danh sách khóa học theo phân loại thời gian trên Dashboard.
   - `core_course_get_recent_courses`: Tải danh sách khóa học truy cập gần đây.
   - `core_calendar_get_action_events_by_timesort`: Lấy lịch sự kiện và deadline theo mốc thời gian.
   - `media_videojs_get_language`: Tải gói ngôn ngữ cho video player giao diện.
   - `core_output_load_template_with_dependencies`: Tải khuôn mẫu hiển thị giao diện.
3. **Cơ chế Fail-Closed:**
   - Hàm [`isSafeReadOnlyAjaxRequest()`](file:///c:/Users/Admin/autotask/src/operation-mode.ts#L63) phân tích URL query parameter `info` và POST body JSON.
   - Mọi phương thức chứa từ khóa thay đổi trạng thái (`quiz`, `attempt`, `submit`, `save`, `delete`, `unenrol`, `grade`, `edit`, `post`, `update`, `create`, `mutate`) hoặc bất kỳ phương thức lạ nào ngoài danh mục trắng đều bị từ chối (`return false`) và bị chặn đứng tại tầng mạng.

---

## 3. Tăng Cường Bảo Mật Dữ Liệu Phiên (Session Data Hardening)

### A. Khắc Phục Rò Rỉ `sesskey` và Token:
Trong báo cáo Phase 8F, tham số `sesskey=[REDACTED]` đã xuất hiện trong danh sách chi tiết các URL bị chặn do biểu thức chính quy của bộ lọc sanitization chưa bao gồm `sesskey`.

Hệ thống đã nâng cấp toàn diện module [`src/security/redact.ts`](file:///c:/Users/Admin/autotask/src/security/redact.ts):
1. **Mở rộng tham số URL nhạy cảm:**
   - Bổ sung `sesskey`, `MoodleSession`, `sessionid`, `sid`, `ticket`, `code`, `access_token`, `refresh_token`, `auth`, `state`, `wantsurl`.
2. **Khử nhiễm URL-encoded query parameters:**
   - Xử lý triệt để các tham số được mã hóa URL lồng nhau (thường gặp trong luồng SSO CAS / OAuth2):
     ```
     /(?:%26|%3F|%26amp%3B)(?:sesskey|key|api_?key|token|access_token|refresh_token|secret|password|passwd|auth|session|sessionid|sid|ticket|code|state|wantsurl)(?:%3D|%3d)[^%&#"'\s]+/gi
     ```
3. **Khử nhiễm Cookie & Set-Cookie:**
   - Khử nhiễm tự động các cookie phiên: `MoodleSession`, `ESTSAUTH`, `ESTSAUTHPERSISTENT`, `connect.sid`.
4. **Sanitize URL chuyển hướng trong `src/main.ts`:**
   - Sửa dòng 161 của [`src/main.ts`](file:///c:/Users/Admin/autotask/src/main.ts#L161) để bọc `redactSecrets(absLoc)` trước khi lưu vào `readOnlyBlockedRequests`.
5. **Loại bỏ `sesskey` khỏi `MUTATING_QUERY_REGEX`:**
   - `sesskey` là CSRF token phiên làm việc, không phải là hành vi thay đổi dữ liệu. Việc loại bỏ `sesskey=` khỏi `MUTATING_QUERY_REGEX` trong [`src/operation-mode.ts`](file:///c:/Users/Admin/autotask/src/operation-mode.ts) ngăn chặn việc gán nhãn sai các liên kết đọc có chứa session key.

---

## 4. Nghiệm Thu Thực Tế Của Người Vận Hành & Phân Định Biên Giới Kiểm Toán

Người vận hành đã trực tiếp thực thi lệnh `npm start` trên workstation thực tế và xác nhận chuỗi sự kiện thành công:

### A. Bằng Chứng Thực Nghiệm Được Xác Minh Thành Công (Verified Live Observation):
1. **Khởi chạy `npm start` thành công:** Module `src/ca-bootstrap.ts` đã tự động nạp CA trung gian GlobalSign vào tiến trình Node mà người vận hành không cần thao tác thủ công với biến môi trường shell.
2. **Đăng nhập LMS HUST thành công:** Quá trình xác thực SSO Microsoft hoàn tất trọn vẹn, thiết lập phiên đăng nhập chính thức trên `lms.hust.edu.vn`.
3. **Hiển thị Dashboard & Danh sách 2 khóa học:** Trình duyệt Chromium tải đầy đủ Dashboard (`https://lms.hust.edu.vn/my/`) và hiển thị động danh sách 2 học phần đã đăng ký:
   - `BL-ED3220 - Kỹ năng mềm`
   - `BL-MI2020 - Xác suất thống kê`  
   *Minh chứng kỹ thuật:* Việc 2 khóa học hiển thị đầy đủ trên DOM xác nhận trực tiếp rằng hàm `isSafeReadOnlyAjaxRequest()` đã hoạt động chính xác, cho phép các truy vấn metadata `core_course_get_enrolled_courses_by_timeline_classification` và `core_course_get_recent_courses` tải thẻ khóa học mà không bị chặn sai như ở Phase 8F.
4. **Khắc phục hoàn toàn `ERR_BLOCKED_BY_CLIENT`:** Không còn xuất hiện lỗi chặn mạng điều hướng hay lỗi chứng chỉ TLS (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`).
5. **Terminal nhận diện nền tảng Moodle:** Command Deck nhận diện chính xác:  
   `Platform detected: moodle / pilot_read_only_overview`.
6. **Kết quả tác vụ READ_ONLY là `NEEDS_REVIEW`:** Trong chế độ `READ_ONLY`, Browser Agent hoàn thành quan sát an toàn và trả về trạng thái `NEEDS_REVIEW` theo đúng thiết kế an toàn của AutoTask AI (yêu cầu người vận hành xác nhận và giám sát trước khi thực hiện bất kỳ bước tiếp theo nào).
7. **Bảo toàn dữ liệu máy chủ:** Xác nhận $0$ lượt làm bài mở mới, $0$ câu trả lời nháp, $0$ bài nộp tự động (`SERVER_MUTATION_CONFIRMED = 0`).
8. **Khử nhiễm bí mật:** Không có token, session key, password hay cookie nào bị lộ trong terminal hay báo cáo (`zeroSecretsLeaked: true`).

### B. Các Kiểm Tra Mạng Chưa Được Xác Minh Trên Môi Trường Thực Tế (Unverified Production Checks):
Để đảm bảo tính trung thực và minh bạch tuyệt đối theo chuẩn kiểm toán độc lập, các hạng mục sau được phân loại rõ ràng là **CHƯA ĐƯỢC KIỂM THỬ TRÊN PRODUCTION LMS**:

| Hạng Mục Tương Tác | Trạng Thái Trên Production LMS | Môi Trường Đã Xác Minh | Ghi Chú An Toàn |
|---|:---:|:---:|---|
| **Quan Sát Dashboard & Khóa Học** | **ĐÃ XÁC MINH (VERIFIED)** | Live LMS (`lms.hust.edu.vn`) | Hoàn tất trong phiên thực tế của Operator |
| **Mở Lượt Thi Moodle (`startattempt.php`)** | **CHƯA KIỂM THỬ (NOT TESTED)** | Local Sandbox E2E Suite | Cần nhiệm vụ tự luyện cụ thể được phê duyệt |
| **Ghi Bản Nháp Câu Hỏi (`processattempt.php`)** | **CHƯA KIỂM THỬ (NOT TESTED)** | Local Sandbox E2E Suite | Chưa cấp quyền ghi trên tài khoản thực tế |
| **Tải Tệp Lên File Manager Moodle** | **CHƯA KIỂM THỬ (NOT TESTED)** | Local Sandbox (SANDBOX-01..09) | Chỉ thử nghiệm trên sandbox cô lập |
| **Xử Lý Câu Hỏi CodeRunner** | **CHƯA KIỂM THỬ (NOT TESTED)** | Local Sandbox E2E Suite | Chưa chạy trên bài thi thực tế |
| **Tự Động Nộp Bài (Auto Submit)** | **CẤM & KHÔNG THỰC HIỆN** | Kiến trúc Human-in-the-loop | Bắt buộc người dùng nộp bài thủ công |
| **Tương Tác FAMI & English Discoveries** | **CHƯA KIỂM THỬ (NOT TESTED)** | Unit Regression Tests (SSO/Radar) | Chưa có phiên thực tế trên hai cổng này |

---

## 5. Danh Mục Kiểm Thử Toàn Diện (Full Test Suite Verification)

Hệ thống đã thực thi toàn bộ các bộ kiểm thử tự động, tất cả đều đạt tỷ lệ vượt qua 100%:

| Bộ Kiểm Thử (Test Suite) | Lệnh Thực Thi | Kết Quả | Phân Loại |
|---|---|:---:|:---:|
| **TypeScript Static Check** | `npm run typecheck` | **0 errors** (120 files) | `PASS` |
| **Session Data Hardening Suite** | `npx tsx --test tests/session-data-hardening.test.ts` | **16/16 PASS** | `PASS` |
| **Startup & TLS Verification Suite** | `npx tsx --test tests/startup-verification.test.ts` | **6/6 PASS** | `PASS` |
| **Full Unit Regression Suite** | `npm test` | **543/543 PASS** (37 suites, tăng từ 521) | `PASS` |
| **Python Core Workers Suite** | `python -m unittest discover -s tests -p "*test.py"` | **14/14 PASS** | `PASS` |
| **Local Browser Smoke Checks** | `npm run smoke:local` | **11/11 PASS** | `PASS` |
| **System Doctor Diagnostics** | `npm run doctor` | **9 PASS / 1 CẢNH BÁO** (Account Vault unpopulated) | `PASS` |
| **Candidate ZIP Integrity** | `Get-FileHash ... -Algorithm SHA256` | **Khớp 100% SHA-256 (`f0017eb7...`)** | `PASS` |

---

## 6. Danh Mục Tệp Đã Sửa Đổi & Trạng Thái Candidate Archive

| Tệp Tin | Loại Thay Đổi | Mục Đích |
|---|:---:|---|
| [`src/ca-bootstrap.ts`](file:///c:/Users/Admin/autotask/src/ca-bootstrap.ts) | Tạo mới | Cơ chế tự nạp `NODE_EXTRA_CA_CERTS` cho `npm start` và naked terminal. |
| [`src/launcher.ts`](file:///c:/Users/Admin/autotask/src/launcher.ts) | Cập nhật | Kích hoạt CA bootstrap tại điểm nhập lệnh Command Deck. |
| [`src/main.ts`](file:///c:/Users/Admin/autotask/src/main.ts) | Cập nhật | Kích hoạt CA bootstrap khi chạy trực tiếp; tích hợp `isSafeReadOnlyAjaxRequest`; sanitize redirect URL. |
| [`src/operation-mode.ts`](file:///c:/Users/Admin/autotask/src/operation-mode.ts) | Cập nhật | Mở khóa `service-nologin.php`; loại bỏ `sesskey` khỏi mutation regex; thêm `SAFE_READ_ONLY_AJAX_METHODS` & `isSafeReadOnlyAjaxRequest`. |
| [`src/security/redact.ts`](file:///c:/Users/Admin/autotask/src/security/redact.ts) | Cập nhật | Khử nhiễm toàn diện `sesskey`, OAuth codes, tokens, cookies, và URL-encoded parameters. |
| [`tests/session-data-hardening.test.ts`](file:///c:/Users/Admin/autotask/tests/session-data-hardening.test.ts) | Tạo mới | 16 test kiểm thử khử nhiễm bí mật và phân loại an toàn AJAX Moodle. |
| [`tests/startup-verification.test.ts`](file:///c:/Users/Admin/autotask/tests/startup-verification.test.ts) | Tạo mới | 6 test kiểm thử hai đường khởi chạy và định luật bảo toàn telemetry. |
| [`reports/phase8g_network_telemetry.json`](file:///c:/Users/Admin/autotask/reports/phase8g_network_telemetry.json) | Cập nhật | Telemetry mạng thực nghiệm của Phase 8G tích hợp kết quả Operator. |
| [`release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`](file:///c:/Users/Admin/autotask/release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip) | **KHÔNG ĐỔI** | **Khóa nguyên vẹn. SHA-256: `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`** |

---

## 7. Quyết Định Release Gate Chính Thức

| Tiêu Chí Đánh Giá | Hiện Trạng Sau Nghiệm Thu Operator | Phân Loại Kiểm Toán |
|---|:---:|:---:|
| **Candidate Archive Integrity** | Khớp 100% SHA-256 (`f0017eb7...`), 164 tệp | `VERIFIED` |
| **Dual Startup Paths** | `Start_AutoTask_AI.cmd` & `npm start` đều nạp CA trung gian | `VERIFIED` |
| **Strict TLS Certificate Chain** | GlobalSign intermediate CA hợp lệ, không tắt bảo mật HTTPS | `VERIFIED` |
| **Live Operator SSO Authentication** | Đăng nhập SSO Microsoft thành công vào `lms.hust.edu.vn` | `VERIFIED` |
| **Resolution of ERR_BLOCKED_BY_CLIENT** | Không còn lỗi chặn điều hướng trang thực tế | `VERIFIED` |
| **Dynamic Course Cards Rendering** | Hiển thị 2 khóa học trên DOM nhờ AJAX whitelist an toàn | `VERIFIED` |
| **Mathematical Telemetry** | $\text{OBSERVED} = \text{ALLOWED} + \text{BLOCKED}$ với 0 mâu thuẫn | `VERIFIED` |
| **Session Data Hardening** | Khử nhiễm 100% `sesskey`, OAuth codes, cookies, zero secrets leak | `VERIFIED` |
| **Terminal Platform & Mode Behavior** | Nhận diện Moodle, kết thúc `NEEDS_REVIEW` cho `READ_ONLY` | `VERIFIED` |
| **Zero Server State Mutation** | 0 attempt mở mới, 0 draft ghi, 0 submit | `VERIFIED` |
| **Authorized Live Practice Task** | Chưa có bài tự luyện không chấm điểm được chọn cụ thể | **CHỜ NGƯỜI VẬN HÀNH** |

> [!IMPORTANT]
> **QUYẾT ĐỊNH GOVERNANCE CHÍNH THỨC:**  
> Release Gate tiếp tục được giữ vững ở mức: **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**.  
> **TUYỆT ĐỐI KHÔNG TỰ Ý NÂNG LÊN `PILOT IN PROGRESS`**. Quan sát thành công bảng điều khiển và danh sách khóa học là một bước tiến thực nghiệm quan trọng chứng minh cơ chế mạng và an toàn đã sẵn sàng, nhưng không thể thay thế cho việc thực hiện một bài tự luyện thực tế được phép.
