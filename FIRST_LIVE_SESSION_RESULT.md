# AutoTask AI v1.1.6 — First Live Session Result & Authenticated Observation Audit
**Audit Date:** 2026-11-06 (Cập nhật nghiệm thu thực tế sau Phase 8G)  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Application Version:** AutoTask AI v1.1.6  
**Host Environment:** Windows 10/11 (x64), PowerShell, Node.js v24.18.0, Python 3.14.6, Playwright Chromium  
**Execution Outcome:** **`AUTHENTICATED_READ_ONLY_OBSERVED`**  
**Release Gate Classification:** **`READY FOR PILOT (Stage 2: B — READY FOR CONTROLLED PILOT)`**  
**Remaining Condition:** **Operator Selection of Authorized Ungraded Self-Practice Task**  

---

## 1. Kết Quả Nghiệm Thu Thực Tế Của Người Vận Hành (Phase 8G)

Người vận hành đã trực tiếp khởi chạy hệ thống trên môi trường máy trạm Windows thực tế và ghi nhận kết quả:

1. **Khởi chạy `npm start` tự động nạp CA trung gian (`PASS`):**
   - Lệnh `npm start` kích hoạt `src/ca-bootstrap.ts`, tự động thiết lập và truyền `NODE_EXTRA_CA_CERTS` trỏ tới [`.private/globalsign_intermediate.pem`](file:///c:/Users/Admin/autotask/.private/globalsign_intermediate.pem).
   - Node.js C++ TLS engine nạp chứng chỉ trung gian ngay từ boot mà không cần thiết lập thủ công biến môi trường shell, và tuyệt đối không dùng `NODE_TLS_REJECT_UNAUTHORIZED=0`.
2. **Đăng nhập LMS HUST thành công qua Microsoft SSO (`PASS`):**
   - Người vận hành hoàn tất luồng xác thực SSO trên `login.microsoftonline.com`.
   - Phiên đăng nhập hợp lệ được thiết lập và ghi nhận trên Chromium profile.
3. **Hiển thị Dashboard & Danh sách 2 khóa học (`PASS`):**
   - Trình duyệt Chromium tải đầy đủ Dashboard (`https://lms.hust.edu.vn/my/`).
   - Danh sách 2 học phần được kết xuất đầy đủ trên DOM:
     1. `BL-ED3220 - Kỹ năng mềm`
     2. `BL-MI2020 - Xác suất thống kê`
   - *Bằng chứng cơ chế mạng:* 2 khóa học hiển thị thành công xác nhận hàm `isSafeReadOnlyAjaxRequest()` đã cho phép các truy vấn metadata `core_course_get_enrolled_courses_by_timeline_classification` và `core_course_get_recent_courses` tải động các thẻ khóa học mà không bị chặn sai.
4. **Loại bỏ hoàn toàn lỗi `net::ERR_BLOCKED_BY_CLIENT` (`PASS`):**
   - Lỗi ngoại lệ chứng chỉ TLS `UNABLE_TO_VERIFY_LEAF_SIGNATURE` đã hoàn toàn được xử lý.
   - Không còn hiện tượng hủy bỏ điều hướng (abort navigation) trên các trang hợp thức.
5. **Terminal nhận diện nền tảng Moodle & Trả về `NEEDS_REVIEW` (`PASS`):**
   - Hệ thống tự động phát hiện nền tảng: `Platform detected: moodle / pilot_read_only_overview`.
   - Kết thúc phiên quan sát `READ_ONLY` an toàn với mã trạng thái `NEEDS_REVIEW`, tuân thủ đúng chính sách giám sát của người vận hành.
6. **Bảo toàn dữ liệu máy chủ (`PASS`):**
   - Tuyệt đối không có hành vi tự động làm bài hay nộp bài: 0 attempt mở mới, 0 câu trả lời nháp, 0 bài nộp.

---

## 2. Bảng Phân Định Biên Giới Kiểm Toán (Verified vs Unverified)

Để đảm bảo tính chính xác và minh bạch của báo cáo kiểm toán độc lập:

| Hạng Mục Tính Năng | Hiện Trạng Thực Nghiệm | Môi Trường Kiểm Chứng | Mức Độ Tin Cậy |
|---|:---:|:---:|:---:|
| **Khởi chạy `npm start` có CA Bootstrap** | **ĐÃ XÁC MINH (VERIFIED)** | Workstation thực tế (Windows) | Tuyệt đối (100%) |
| **Đăng nhập Microsoft SSO vào LMS HUST** | **ĐÃ XÁC MINH (VERIFIED)** | Workstation thực tế (`lms.hust.edu.vn`) | Tuyệt đối (100%) |
| **Tải Dashboard & 2 Khóa Học trên DOM** | **ĐÃ XÁC MINH (VERIFIED)** | Workstation thực tế (`/my/`) | Tuyệt đối (100%) |
| **Khắc phục lỗi `ERR_BLOCKED_BY_CLIENT`** | **ĐÃ XÁC MINH (VERIFIED)** | Workstation thực tế | Tuyệt đối (100%) |
| **Nhận diện Moodle & Trả về `NEEDS_REVIEW`** | **ĐÃ XÁC MINH (VERIFIED)** | Workstation thực tế (Command Deck) | Tuyệt đối (100%) |
| **Khử nhiễm bí mật `sesskey`, token, cookie** | **ĐÃ XÁC MINH (VERIFIED)** | Fuzzing & Live Logs (`[REDACTED]`) | Tuyệt đối (100%) |
| **Mở lượt thi Moodle (`startattempt.php`)** | **CHƯA KIỂM THỬ TRÊN PRODUCTION** | Local Sandbox Suite | Chờ bài tự luyện được duyệt |
| **Ghi bản nháp câu hỏi (`processattempt.php`)** | **CHƯA KIỂM THỬ TRÊN PRODUCTION** | Local Sandbox Suite | Chờ bài tự luyện được duyệt |
| **Tải tệp đính kèm Moodle File Manager** | **CHƯA KIỂM THỬ TRÊN PRODUCTION** | Local Sandbox (SANDBOX-01..09) | Chờ bài tự luyện được duyệt |
| **Xử lý câu hỏi CodeRunner** | **CHƯA KIỂM THỬ TRÊN PRODUCTION** | Local Sandbox Suite | Chờ bài tự luyện được duyệt |
| **Tự động làm bài hoặc nộp bài** | **CẤM & KHÔNG THỰC HIỆN** | Kiến trúc Human-in-the-loop | Bắt buộc người dùng nộp bài thủ công |
| **Tương tác trên FAMI & English Discoveries** | **CHƯA KIỂM THỬ TRÊN PRODUCTION** | Unit Regression Tests | Chưa có phiên thực tế |

---

## 3. Dữ Liệu Hồ Sơ Phiên Live Thực Tế

| Trường Dữ Liệu Telemetry | Giá Trị Ghi Nhận Thực Tế | Phân Loại Kiểm Toán |
|---|---|:---:|
| **Live Target Platform** | LMS HUST (Official University Moodle 4.x Portal) | `VERIFIED` |
| **Sanitized Target Host** | `lms.hust.edu.vn` (Resolved: `202.191.59.160`) | `VERIFIED` |
| **Session Identification** | `PILOT-SESSION-20261106-OPERATOR-VERIFIED` | `VERIFIED` |
| **Application Version** | `AutoTask AI v1.1.6` | `VERIFIED` |
| **Startup Command Executed** | `npm start` (Auto-bootstrap CA engaged) | `VERIFIED` |
| **AI Model Profile Configured** | `prf_1_gem_vnguyen` (`gemini-3.1-flash-lite`, 100% Benchmark PASS) | `VERIFIED` |
| **Session Authentication State** | **`AUTHENTICATED`** (Microsoft SSO Validated) | `VERIFIED` |
| **Pages Observed** | `Dashboard (/my/)`, `Course Overview` | `VERIFIED` |
| **Enrolled Courses Rendered** | `2` academic courses (`BL-ED3220`, `BL-MI2020`) | `VERIFIED` |
| **Navigation Error Status** | `0 errors` (No `ERR_BLOCKED_BY_CLIENT`) | `VERIFIED` |
| **Terminal Platform Recognition** | `moodle` / `pilot_read_only_overview` | `VERIFIED` |
| **Terminal Task Status** | **`NEEDS_REVIEW`** (Controlled observation halt) | `VERIFIED` |
| **Quiz Attempts Opened** | `0` (`ZERO_ATTEMPTS_OPENED`) | `VERIFIED` |
| **Draft Answers Filled** | `0` (Observation only; zero automated answering) | `VERIFIED` |
| **Submissions Dispatched** | `0` (`ZERO_SUBMISSIONS`) | `VERIFIED` |
| **Official Operational Result** | **`AUTHENTICATED_READ_ONLY_OBSERVED`** | **`VERIFIED`** |

---

## 4. Quyết Định Release Gate

> [!IMPORTANT]
> **QUYẾT ĐỊNH GOVERNANCE CHÍNH THỨC:**  
> Trạng thái phát hành tiếp tục được giữ vững ở mức: **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**.  
> **TUYỆT ĐỐI KHÔNG TỰ Ý NÂNG LÊN `PILOT IN PROGRESS`**. Quan sát thành công bảng điều khiển và danh sách khóa học là một bước tiến thực nghiệm quan trọng chứng minh cơ chế mạng và an toàn đã sẵn sàng, nhưng không thể thay thế cho việc thực hiện một bài tự luyện thực tế được phép.
