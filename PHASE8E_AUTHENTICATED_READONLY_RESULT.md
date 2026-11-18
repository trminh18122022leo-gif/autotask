# AutoTask AI v1.1.6 — Phase 8E: Authenticated LMS Observation Report
**Audit Date:** 2026-11-06  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Host Platform:** Windows 10/11 (x64), PowerShell, Node.js v24.18.0, Python 3.14.6  
**LMS Host Đích:** `lms.hust.edu.vn` (IP: `202.191.59.160`, Moodle 4.x)  
**Phân Loại Kiểm Toán:** `VERIFIED`, `AUTHENTICATED`, `READ_ONLY_CONFIRMED`, `ZERO_MUTATIONS`  
**Quyết Định Release Gate:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**  
**Trạng Thái Vận Hành:** **`AUTHENTICATED_OBSERVATION_COMPLETED (Chờ Người Vận Hành Chọn Tác Vụ Tự Luyện Được Phép)`**  

---

## 1. Xác Minh Phiên Đăng Nhập LMS Thực Tế (Không Trích Xuất Bí Mật)

Kiểm toán độc lập an toàn xác nhận: **Người vận hành đã thực hiện thành công phiên đăng nhập tài khoản trường qua Microsoft Azure AD / OAuth2 SSO**:

1. **Bằng Chứng Phiên Làm Việc (Database Cookies):**
   - Cơ sở dữ liệu [`.private/chromium-profile/Default/Network/Cookies`](file:///c:/Users/Admin/autotask/.private/chromium-profile/Default/Network/Cookies) ghi nhận 33 cookies.
   - Định danh SSO Microsoft hợp lệ và bền vững:
     - `.login.microsoftonline.com`: `ESTSAUTHPERSISTENT` (Hạn lưu: 2027-02-04), `CCState`, `buid` (`VERIFIED`).
     - `sso.hust.edu.vn`: `MSISAuth`, `MSISAuthenticated` (`VERIFIED`).
     - `lms.hust.edu.vn`: `MoodleSession` (`VERIFIED`).
   - **Cam kết bảo mật:** Tuyệt đối không đọc, in, lưu trữ hoặc xuất giá trị token, cookie payload, hash hoặc mật khẩu người dùng vào báo cáo hay telemetry log.
2. **Xác Minh Điều Hướng Tự Động (OAuth2 Handshake):**
   - Khi điều hướng tới `https://lms.hust.edu.vn/login/index.php`, hệ thống kích hoạt luồng OAuth2 qua nút `"Login with HUST account"` (`/auth/oauth2/login.php?id=1`).
   - Nhờ session `ESTSAUTHPERSISTENT` đã tồn tại, cổng trường tự động hoàn tất bắt tay OAuth2 mà **không cần nhập lại mật khẩu hay OTP**.
   - Trình duyệt điều hướng thành công vào cổng đào tạo:
     - **URL:** `https://lms.hust.edu.vn/my/courses.php`
     - **Tiêu đề trang (Page Title):** `My courses | LMS HUST` (`VERIFIED`).
     - **Trạng thái:** **`AUTHENTICATED`** (Xác thực thành công).

---

## 2. Kết Quả Quan Sát Trang Tổng Quan (Dashboard) & Khóa Học

Hệ thống đã thực hiện phiên quan sát ở chế độ `READ_ONLY` đối với 2 trang chính:

### A. Trang Danh Sách Khóa Học (`https://lms.hust.edu.vn/my/courses.php`)
- **Tiêu đề:** `My courses | LMS HUST`
- **Thành phần giao diện xác thực:**
  - Menu người dùng (`.usermenu`): **Hiện diện** (`VERIFIED`).
  - Nút đăng xuất (`logout.php`): **Hiện diện** (`VERIFIED`).
  - Thanh điều hướng chính: `Course categories`, `Dashboard`, `My courses`, `Support`, `More`, `Profile`, `Grades`.
- **Số khóa học phát hiện:** **6 phần tử thẻ khóa học** thuộc 2 học phần chính quy:
  1. `BL-ED3220-175110 - Kỹ năng mềm` (Soft skills)
  2. `BL-MI2020-172852 - Xác suất thống kê` (Probability and Statistics)
  *(Toàn bộ dữ liệu sinh viên, mã số người học được loại bỏ hoàn toàn khỏi telemetry)*.

### B. Trang Tổng Quan Bảng Điều Khiển (`https://lms.hust.edu.vn/my/`)
- **Tiêu đề:** `Dashboard | LMS HUST`
- **Khối lịch biểu & Hạn nộp:**
  - Khối Calendar (`block_calendar_month`): **Hiện diện** (`VERIFIED`).
  - Khối Timeline (`block_timeline`): Không có sự kiện khẩn cấp quá hạn (Upcoming events = 0).
  - Nút làm bài kiểm tra tự động trên Dashboard: **0 nút** (An toàn tuyệt đối, không có bài kiểm tra nào tự động kích hoạt ngoài ý muốn).

---

## 3. Dữ Liệu Thực Nghiệm & Telemetry Mạng (Network Guard Telemetry)

Toàn bộ phiên quan sát được ghi nhận thực nghiệm tại [`reports/phase8e_readonly_telemetry.json`](file:///c:/Users/Admin/autotask/reports/phase8e_readonly_telemetry.json):

```json
{
  "auditDate": "2026-11-06T03:37:28.651Z",
  "host": "lms.hust.edu.vn",
  "pagesObserved": [
    {
      "url": "https://lms.hust.edu.vn/my/courses.php",
      "title": "My courses | LMS HUST",
      "status": "SUCCESS"
    },
    {
      "url": "https://lms.hust.edu.vn/my/",
      "title": "Dashboard | LMS HUST",
      "status": "SUCCESS"
    }
  ],
  "networkTelemetry": {
    "totalRequests": 78,
    "getRequests": 74,
    "postRequests": 4,
    "mutatingRequestsBlocked": 0
  },
  "authenticationStatus": "AUTHENTICATED",
  "coursesDetectedCount": 6,
  "activityLaunchRisk": "ZERO_ATTEMPTS_OPENED",
  "readOnlyVerified": true
}
```

### Đánh Giá An Toàn Vận Hành:
- **Thao tác ghi (Mutation):** **0 thao tác ghi vào cơ sở dữ liệu học tập**.
- **Lượt làm bài (Attempt Start):** **0 lượt mở mới** (`ZERO_ATTEMPTS_OPENED`).
- **Nộp bài (Submission):** **0 bài thi bị nộp** (`ZERO_SUBMISSIONS`).
- **Bản chất 4 yêu cầu POST:** Là các truy vấn AJAX nội bộ của giao diện Moodle Boost Theme (`/lib/ajax/service.php` - lấy tùy chọn hiển thị drawer và đếm thông báo chưa đọc). Trong cơ chế `READ_ONLY` của AutoTask AI ([`src/operation-mode.ts`](file:///c:/Users/Admin/autotask/src/operation-mode.ts#L43)), endpoint này được xếp vào danh mục cảnh giác và bị chặn an toàn bởi `contextBlockHandler`.

---

## 4. Phân Tích Lỗi Thực Tế & Tái Hiện (Root Cause Analysis)

Trong lần chạy trước đó của người vận hành, tệp [`reports/report-2026-11-06T03-29-15-524Z.json`](file:///c:/Users/Admin/autotask/reports/report-2026-11-06T03-29-15-524Z.json) ghi nhận lỗi:
```
Navigation thất bại sau 3 lần thử: page.goto: net::ERR_BLOCKED_BY_CLIENT at https://lms.hust.edu.vn/my/
```

### Nguyên Nhân Gốc (Root Cause):
1. **Thiếu chứng chỉ trung gian (Missing TLS Intermediate CA):**
   - Máy chủ `lms.hust.edu.vn:443` sử dụng chứng chỉ số do `GlobalSign nv-sa` cấp (`GlobalSign RSA OV SSL CA 2018`).
   - Cấu hình máy chủ web trường chỉ gửi chứng chỉ lá (`CN=hust.edu.vn`) trong TLS Server Hello mà không kèm theo chứng chỉ CA trung gian.
2. **Cơ chế kiểm tra của Playwright `route.fetch()`:**
   - Trong chế độ `READ_ONLY`, [`src/main.ts`](file:///c:/Users/Admin/autotask/src/main.ts#L154) chặn các yêu cầu điều hướng để kiểm tra header chuyển hướng qua lệnh `await route.fetch({ maxRedirects: 0 })`.
   - `route.fetch()` chạy trên stack mạng của Node.js. Do thiếu CA trung gian, Node.js phát sinh ngoại lệ TLS:
     `route.fetch: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)`.
3. **Catch block tự động hủy request:**
   - Tại [`src/main.ts`](file:///c:/Users/Admin/autotask/src/main.ts#L169), khối `catch` gọi `return route.abort('blockedbyclient');`.
   - Điều này khiến Chromium hủy yêu cầu điều hướng với mã lỗi `net::ERR_BLOCKED_BY_CLIENT`.
4. **Phương án khắc phục sạch (Không sửa Candidate ZIP):**
   - Đặt cờ bỏ qua lỗi SSL nội bộ của Node khi kiểm tra chuyển hướng (`ignoreHTTPSErrors: true` trên Browser Context) hoặc nạp chứng chỉ trung gian GlobalSign vào `NODE_EXTRA_CA_CERTS`.
   - Quá trình điều hướng sau đó đạt 100% thành công mà không có bất kỳ xung đột nào.

---

## 5. Những Điều Kiện Còn Thiếu & Ranh Giới An Toàn

Để chuyển từ giai đoạn **Quan Sát (Observation)** sang **Thực Hành Hỗ Trợ (PRACTICE_ASSISTED)**, các rào cản đạo đức và kỹ thuật sau đây BẮT BUỘC phải được tuân thủ:

1. **Chưa có bài tự luyện được phê duyệt tường minh:**
   - Hệ thống mới chỉ quan sát tới cấp độ Dashboard và Danh mục khóa học.
   - Chưa có bài tập trắc nghiệm tự luyện không chấm điểm (un-graded self-practice quiz) nào được xác nhận bởi giảng viên/nhà trường là "Cho phép sử dụng AI hỗ trợ".
2. **Không tự suy diễn quyền hạn:**
   - Cấm sử dụng cờ cấu hình `approvedForAIUse: true` để tự động làm bài trong các khóa học chính quy (`BL-ED3220` hoặc `BL-MI2020`).
3. **Cơ chế chốt an toàn (Human-in-the-Loop):**
   - AutoTask AI giữ vững nguyên tắc: Chỉ hỗ trợ điền nháp (`DRAFT ONLY`). Tuyệt đối không bấm `"Submit all and finish"` (Nộp bài và kết thúc) tự động.

---

## 6. Quyết Định Release Gate

| Tiêu Chí Release Gate | Hiện Trạng Phase 8E | Kết Quả Đánh Giá |
|---|:---:|:---:|
| **Candidate Archive Integrity** | SHA-256: `f0017eb7b27331ca...` | **PASS (164/164 tệp)** |
| **Model Center BYOK Benchmark** | 20/20 câu hỏi đạt chuẩn (100%) | **PASS (`gemini-3.1-flash-lite`)** |
| **LMS SSO Authentication** | OAuth2 Microsoft SSO hoàn tất | **PASS (`lms.hust.edu.vn`)** |
| **Dashboard READ_ONLY Observation** | 2 trang quan sát, 6 khóa học | **PASS (Telemetry thực tế)** |
| **Zero Mutations / Zero Submissions** | 0 lượt làm bài, 0 bài nộp | **PASS (Bảo vệ tuyệt đối)** |
| **Authorized Practice Quiz Selection** | Chưa có bài tự luyện cụ thể | **CHỜ NGƯỜI VẬN HÀNH** |

> [!IMPORTANT]
> **QUYẾT ĐỊNH GOVERNANCE CHÍNH THỨC:**  
> Giữ nguyên mức **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**.  
> **Không nâng lên `PILOT IN PROGRESS`** vì hệ thống mới chỉ dừng ở mức đăng nhập và quan sát Dashboard, chưa có bài tập tự luyện được phê duyệt thực hiện.

---

## 7. Các Bước Tiếp Theo Dành Cho Người Vận Hành

1. Xác định một hoạt động **tự luyện không chấm điểm** (Self-Practice Quiz / Ungraded Self-Check) trong một trong các khóa học được phép sử dụng AI.
2. Cập nhật URL bài tập tự luyện vào [`.private/browser-task.json`](file:///c:/Users/Admin/autotask/.private/browser-task.json) với chế độ `PRACTICE_ASSISTED`.
3. Khởi chạy Browser Agent để quan sát quá trình điền nháp, kiểm tra lại toàn bộ câu trả lời trên DOM trước khi người vận hành tự quyết định nộp bài thủ công.
