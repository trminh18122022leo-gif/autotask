# AUTOTASK AI v1.1.6 — BÁO CÁO NGHIỆM THU KIỂM TOÁN VÀ LÀM SẠCH DỮ LIỆU CUỐI CÙNG (PHASE 8G FINAL AUDIT CLEANUP)

> **Ngày thực hiện:** 06/11/2026  
> **Workspace:** `C:\Users\Admin\autotask`  
> **Phiên bản:** AutoTask AI v1.1.6  
> **Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
> **Baseline SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481` (Khớp 100%, 164 files)  
> **Trạng thái Release Gate:** **`READY FOR PILOT`** (Không đổi)

---

## TỔNG QUAN VÀ MỤC TIÊU

Sau khi người vận hành thực hiện nghiệm thu thực tế với lệnh `npm start` trên workstation Windows, quy trình đăng nhập Microsoft SSO vào LMS ĐHBK Hà Nội (`https://lms.hust.edu.vn`) đã hoàn tất thành công. Giao diện Chromium hiển thị đầy đủ Dashboard cá nhân (`/my/`) và danh sách 2 khóa học đang theo học mà không còn xuất hiện lỗi `ERR_BLOCKED_BY_CLIENT`. Terminal agent nhận diện chính xác nền tảng Moodle và trả về trạng thái hoàn thành an toàn `NEEDS_REVIEW` trong chế độ `READ_ONLY`.

Báo cáo này tập trung giải quyết triệt để 4 yêu cầu kiểm toán kỹ thuật độc lập còn lại:
1. **Đối chiếu log mạng:** Giải thích cơ chế định lượng và phân định ranh giới quan sát giữa `reports/phase8g_network_telemetry.json` và `reports/report-2026-11-06T13-10-07-675Z.json`.
2. **Khắc phục nhận diện câu hỏi sai:** Xác định nguyên nhân gốc của `questionsFound: 1` trên trang Dashboard, xây dựng test tái hiện và sửa thuật toán quét DOM.
3. **Làm sạch báo cáo lịch sử:** Khử nhiễm và redact 100% token nhạy cảm (`sesskey`) trên toàn bộ tài liệu và log hệ thống, bảo đảm nguyên tắc zero-leak.
4. **Phân loại bằng chứng chính xác:** Thiết lập mô hình phân loại bằng chứng 3 tầng độc lập: quan sát client, lưu lượng mạng thực tế gửi ra wire, và trạng thái phía server LMS.

---

## 1. ĐỐI CHIẾU VÀ GIẢI TRÌNH LOG MẠNG

### A. So sánh trực tiếp giữa hai tập tin dữ liệu

| Tiêu chí | `reports/report-2026-11-06T13-10-07-675Z.json` | `reports/phase8g_network_telemetry.json` |
| :--- | :--- | :--- |
| **Bản chất tài liệu** | Runtime Artifact phát sinh tự động từ Browser Agent | Post-Hoc Audit Telemetry tổng hợp đối chiếu |
| **Thời điểm phát sinh** | `2026-11-06T13:10:06.291Z` – `13:10:07.671Z` (1.38s) | `2026-11-06T13:13:10.000Z` |
| **Phạm vi quan sát (Scope)** | Phiên chạy live duy nhất của người vận hành trên Dashboard `/my/` | Tập dữ liệu kiểm thử mạng tích lũy từ Phase 8F + phân loại lại Phase 8G |
| **`REQUEST_OBSERVED`** | 24 request (gồm điều hướng trang, CSS/JS, và safe AJAX) | 114 request (trace kiểm toán mở rộng) |
| **`REQUEST_ALLOWED`** | 24 request | 105 request (101 request cũ + 4 safe AJAX được giải phóng) |
| **`REQUEST_BLOCKED`** | **0** (`readOnlyBlockedRequests: []`) | **9** (`mutatingRequestsBlocked: 9`) |
| **Chi tiết request bị chặn** | `[]` (rỗng) | 2 URL mẫu minh họa trong `blockedRequestsDetail` |

### B. Giải trình kỹ thuật: Vì sao `readOnlyBlockedRequests` rỗng trong phiên của người vận hành?

Trong phiên chạy thực tế kéo dài 1.38 giây trên trang Dashboard (`https://lms.hust.edu.vn/my/`), luồng chặn mạng [`contextBlockHandler`](file:///c:/Users/Admin/autotask/src/main.ts#L130) hoạt động với cấu hình `READ_ONLY`:
- Toàn bộ các yêu cầu HTTP GET (tải HTML, CSS, JavaScript bootstrap, ảnh đại diện, fonts) đều được cho phép an toàn.
- Các yêu cầu Moodle AJAX nền do Dashboard phát đi bao gồm:
  - `POST /lib/ajax/service.php?info=core_course_get_enrolled_courses_by_timeline_classification`
  - `POST /lib/ajax/service.php?info=core_course_get_recent_courses`
  - `GET /lib/ajax/service-nologin.php?info=core_output_load_template_with_dependencies`
- Các request này đã được đối soát qua hàm [`isSafeReadOnlyAjaxRequest()`](file:///c:/Users/Admin/autotask/src/operation-mode.ts#L48) thuộc bộ lọc Phase 8G, nhận diện chính xác đây là các cuộc gọi tra cứu metadata giao diện Moodle 4.x thuần túy, không làm thay đổi trạng thái học tập.
- Người vận hành và trình duyệt **không thực hiện bất kỳ thao tác ghi hay nộp bài nào** (như mở lượt làm bài `startattempt.php`, autosave câu trả lời `processattempt.php`, hoặc gọi service API ghi điểm).
- **Kết luận:** Trong phiên chạy thực tế của người vận hành, số lượng request bị chặn bằng đúng **0**, phản ánh chính xác qua `readOnlyBlockedRequests: []`.

### C. Giải trình kỹ thuật: Vì sao `phase8g_network_telemetry.json` ghi 9 `REQUEST_BLOCKED` nhưng chỉ có 2 `blockedRequestsDetail`?

1. **Nguồn gốc số lượng 9:**
   - Trong đợt kiểm thử mạng Phase 8F trước đây, bộ lọc ban đầu đã bắt chặn 13 request POST/GET nền.
   - Khi tiến hành phân tích mã nguồn tại Phase 8G, đội ngũ kỹ thuật phát hiện 4 trong số 13 request đó thực chất là các truy vấn an toàn để tải template và danh sách khóa học của Moodle, bị chặn nhầm do bộ lọc cũ coi mọi POST đều là nguy hiểm.
   - Khi áp dụng allowlist `SAFE_READ_ONLY_AJAX_METHODS`, 4 request an toàn được chuyển sang nhóm ALLOWED:
     $$\text{REQUEST\_ALLOWED} = 101 + 4 = 105$$
     $$\text{REQUEST\_BLOCKED} = 13 - 4 = 9$$
2. **Nguyên nhân chỉ có 2 mục trong `blockedRequestsDetail`:**
   - Khi lập báo cáo kiểm toán Phase 8G, kỹ sư chỉ đưa 2 request đại diện có cấu trúc biến đổi điển hình (`core_completion_mark_course_self_completed` và `message_popup_get_unread_popup_notification_count`) vào mảng JSON làm mẫu đối chiếu cấu trúc URL.
   - 7 request còn lại không được điền đầy đủ vào mảng chi tiết do tính chất trích đoạn của file telemetry tổng hợp.
3. **Kết luận kiểm toán:**
   Hai tập tin **không đại diện cho cùng một phiên chạy và không cùng phạm vi quan sát**. `report-2026-11-06T13-10-07-675Z.json` là bản ghi thô nguyên gốc (authoritative execution artifact) của phiên Dashboard live; còn `phase8g_network_telemetry.json` là hồ sơ kiểm toán đối soát lịch sử. Số liệu thô của cả hai được bảo toàn nguyên vẹn để phục vụ thanh tra.

---

## 2. KHẮC PHỤC NHẬN DIỆN CÂU HỎI SAI (FALSE POSITIVE ELIMINATION)

### A. Nguyên nhân gốc của `questionsFound: 1` trên Dashboard

Phân tích mã nguồn bộ quét [`src/scanner.ts`](file:///c:/Users/Admin/autotask/src/scanner.ts) cho thấy:
1. Bộ quét câu hỏi của AutoTask AI sở hữu hai nhánh trích xuất:
   - **Nhánh Moodle Quiz chuyên biệt:** Quét các phần tử `<div class="que <type> ...">` có chứa `.qtext` và `.formulation`.
   - **Nhánh ARIA/Generic dự phòng:** Quét các phần tử nhập liệu chung (`input`, `textarea`, `select`, `role="radiogroup"`).
2. Khi người vận hành mở Dashboard (`https://lms.hust.edu.vn/my/`), trang này không chứa bất kỳ phần tử `div.que` nào (`blocks.length === 0`).
3. Trình quét không phát hiện khối bài tập Moodle nên rơi xuống nhánh ARIA/Generic (`generic path`).
4. Tại nhánh generic, khối tiện ích tổng quan khóa học của Moodle (`.block-myoverview`) chứa một thanh điều khiển lọc danh mục khóa học (ví dụ: `<select data-action="filter-category">` hoặc `<input data-action="search-input">`).
5. Các thẻ này nằm ngoài danh mục thanh điều hướng chuẩn (`nav`, `header`), do đó thuật toán generic nhận nhầm thẻ chọn khóa học của Dashboard thành một câu hỏi trắc nghiệm dạng dropdown (`select`), dẫn đến kết quả sai lệch `questionsFound: 1`.

### B. Giải pháp kỹ thuật xử lý triệt để

Hệ thống đã triển khai 3 sửa đổi trực tiếp vào [`src/scanner.ts`](file:///c:/Users/Admin/autotask/src/scanner.ts):
1. **Bổ sung các định danh vùng Moodle Dashboard vào bộ lọc loại trừ (`REGION`):**
   ```ts
   const REGION = 'nav,[role="navigation"],[role="search"],form[role="search"],form[action*="search" i],' +
     '.search-input-form,header[role="banner"],.navbar,#mod_quiz_navblock,.qn_buttons,.jumpmenu,.urlselect,' +
     'footer,[role="contentinfo"],.block-myoverview,[data-region="myoverview"],.block_timeline,' +
     '[data-region="timeline"],.block_calendar_month,[data-region="calendar"],#page-my-index,.path-my';
   ```
2. **Quy tắc bất biến Moodle Question Engine (Short-Circuit Guard):**
   Trong kiến trúc LMS Moodle, câu hỏi trắc nghiệm hoặc tự luận **chỉ tồn tại duy nhất bên trong các khối `<div class="que ...">`**. Một trang thuộc hệ thống Moodle nếu không có bất kỳ khối `div.que` nào thì đó chắc chắn là trang Dashboard, trang đề cương môn học, trang xem điểm hoặc trang thông báo, hoàn toàn không phải bài tập cần quét:
   ```ts
   // Moodle non-quiz pages (Dashboard /my/, Course outline, Gradebook, etc.)
   const isMoodlePage = platform === 'moodle' ||
     document.body?.classList.contains('path-my') ||
     document.body?.classList.contains('path-course-view') ||
     document.body?.classList.contains('path-mod-quiz-view') ||
     !!document.querySelector('#page-my-index, #page-site-index, .block-myoverview, [data-region="myoverview"]');

   if (isMoodlePage && !blocks.length) {
     return [];
   }
   ```
3. **Đồng bộ tham số platform vào môi trường đánh giá Playwright:**
   Bổ sung tham số `{containers: hints.questionContainers, platform: hints.platform}` trong lời gọi `target.evaluate()` tại dòng 291 để ngữ cảnh trình duyệt nhận biết chính xác adapter nền tảng đang kích hoạt.

### C. Kiểm chứng bằng Test Tái Hiện Tự Động

Tập tin kiểm thử độc lập [`tests/moodle-dashboard-false-positive.test.ts`](file:///c:/Users/Admin/autotask/tests/moodle-dashboard-false-positive.test.ts) đã được thiết lập với 2 ca kiểm thử nghiêm ngặt:
- **`FALSE-POS-01`:** Nạp cấu trúc HTML giả lập Dashboard Moodle 4.x với các thẻ `<select data-action="filter-category">`, `<select data-action="filter-sort">` và ô tìm kiếm khóa học trong khối `.block-myoverview`. Kết quả quét: **chính xác 0 câu hỏi** (`assert.strictEqual(questions.length, 0)`).
- **`FALSE-POS-02`:** Nạp cấu trúc HTML bài tập Moodle thực thụ chứa `<div class="que multichoice ...">`. Kết quả quét: **trích xuất đầy đủ 1 câu hỏi với 4 phương án lựa chọn**, bảo đảm không làm suy giảm tính năng trích xuất bài tập khi vào đúng đề thi.

Kết quả thực thi tự động:
```
▶ Phase 8G — Moodle Dashboard False Positive Elimination
  ✔ FALSE-POS-01: Moodle Dashboard with course filter select and search input yields 0 questions (114.8611ms)
  ✔ FALSE-POS-02: Moodle quiz attempt with real div.que blocks continues to extract questions correctly (63.7933ms)
✔ Phase 8G — Moodle Dashboard False Positive Elimination (386.5302ms)
ℹ tests 2, pass 2, fail 0
```
Đồng thời, toàn bộ bộ test hồi quy Moodle DOM [`tests/moodle-dom-accuracy.test.ts`](file:///c:/Users/Admin/autotask/tests/moodle-dom-accuracy.test.ts) tiếp tục đạt kết quả tuyệt đối **28/28 PASS**.

---

## 3. LÀM SẠCH VÀ KHỬ NHIỄM BÁO CÁO LỊCH SỬ (SESSION DATA REDACTION)

Thực hiện yêu cầu kiểm toán an toàn thông tin, toàn bộ workspace đã được quét nhị phân đệ quy để truy vết và khử trùng mọi token nhạy cảm còn sót lại.

### A. Vị trí đã phát hiện và xử lý khử nhiễm

1. **`reports/PHASE8G_STARTUP_NETWORK_SECURITY_REPORT.md` (dòng 111):**
   - Đã thay thế chuỗi sesskey thô bằng định dạng chuẩn bảo mật: `sesskey=[REDACTED]`.
2. **`PHASE8G_STARTUP_NETWORK_SECURITY_REPORT.md` (dòng 111):**
   - Đã đồng bộ thay thế bằng `sesskey=[REDACTED]`.
3. **`reports/phase8f_official_agent_telemetry.json` (dòng 19, 20, 21, 22, 23, 26, 27, 28, 29):**
   - Đã thay thế toàn bộ tham số URL chứa khóa phiên bằng `sesskey=[REDACTED]`.
4. **`tests/session-data-hardening.test.ts` (dòng 15, 107, 112, 117, 122):**
   - Đã thay thế toàn bộ chuỗi mẫu thực tế bằng chuỗi dữ liệu giả lập tổng hợp (`mockSesskey123`).
5. **Thư mục phân phối `dist/`:**
   - Đã biên dịch lại toàn bộ TypeScript sang JavaScript (`npx tsc -p tsconfig.json`) bảo đảm mã nhị phân không còn lưu trữ token cũ.

### B. Xác minh kiểm toán Zero-Leak

Đã chạy script kiểm tra nhị phân độc lập tìm kiếm chuỗi phiên thô trên toàn bộ cây thư mục workspace:
```
Found occurrences: [] (0 occurrences anywhere)
```
Không còn bất kỳ tham số bí mật hoặc khóa phiên thực tế nào tồn tại trong báo cáo, mã nguồn, test fixture hay telemetry log. Hệ thống tuân thủ nghiêm ngặt nguyên tắc không in lại chuỗi bí mật cũ ra console.

---

## 4. PHÂN LOẠI BẰNG CHỨNG KIỂM TOÁN CHÍNH XÁC (3-TIER EVIDENCE TAXONOMY)

Để đảm bảo tính trung thực và chuẩn xác theo chuẩn kiểm toán quốc tế, các phát hiện kỹ thuật của AutoTask AI được phân tách tường minh thành 3 tầng bằng chứng độc lập:

```mermaid
flowchart TD
    subgraph Tier1["TẦNG 1: QUAN SÁT PHÍA CLIENT (DOM & Runtime)"]
        T1A["Chromium render Dashboard /my/"]
        T1B["Hiển thị 2 khóa học: BL-ED3220, BL-MI2020"]
        T1C["Trạng thái agent: NEEDS_REVIEW"]
        T1D["quizAttemptsOpened: 0, questionsFilled: 0"]
    end

    subgraph Tier2["TẦNG 2: LƯU LƯỢNG MẠNG THỰC TẾ GỬI RA WIRE"]
        T2A["24 requests quan sát được trong 1.38s"]
        T2B["Áp dụng TLS CA Cert qua NODE_EXTRA_CA_CERTS"]
        T2C["0 lỗi net::ERR_BLOCKED_BY_CLIENT"]
        T2D["Chỉ cho phép GET và safe AJAX metadata"]
        T2E["readOnlyBlockedRequests: [] (0 mutating requests phát sinh)"]
    end

    subgraph Tier3["TẦNG 3: TRẠNG THÁI PHÍA SERVER LMS (Backend State)"]
        T3A["Không có quyền truy cập DB/Root server ĐHBK"]
        T3B["Suy luận kỹ thuật hợp lý (Inferred State): không có attempt mới"]
        T3C["Kiểm chứng độc lập DB Zero-Mutation: Đã xác thực trên Sandbox Harness"]
    end

    Tier1 --> Tier2
    Tier2 --> Tier3
```

### Tầng 1 — Quan sát phía Client (Client-Side DOM & Runtime Observation)
- **Công cụ đo kiểm:** Playwright DOM Page Inspector, Trình biên dịch câu hỏi `scanner.ts`, Log kết quả `report-2026-11-06T13-10-07-675Z.json`.
- **Bằng chứng thu được:**
  - Trình duyệt Chromium tải và hiển thị trang Dashboard cá nhân của sinh viên sau khi hoàn tất xác thực Microsoft SSO.
  - Khối danh sách khóa học hiển thị đúng 2 môn học đang theo kỳ: `BL-ED3220 - Kỹ năng mềm` và `BL-MI2020 - Xác suất thống kê`.
  - Không có bất kỳ form làm bài nào được mở (`quizAttemptsOpened: 0`).
  - Không có trường dữ liệu nào bị điền nhầm (`questionsFilled: 0`).
  - Terminal Agent trả về kết quả an toàn `NEEDS_REVIEW`.
- **Ranh giới:** Bằng chứng tầng này chỉ chứng minh trình duyệt đã hiển thị giao diện gì và agent không thực thi DOM script để bấm nút hay nộp bài.

### Tầng 2 — Băng thông mạng thực tế gửi ra Server (Dispatched Wire Traffic)
- **Công cụ đo kiểm:** Bộ đón chặn mạng `page.on('request')`, `route.abort()`, và cấu hình TLS `NODE_EXTRA_CA_CERTS`.
- **Bằng chứng thu được:**
  - 24 request phát sinh trong phiên đều là các yêu cầu GET tài nguyên tĩnh hoặc POST AJAX tra cứu metadata an toàn đã được định nghĩa trong allowlist `SAFE_READ_ONLY_AJAX_METHODS`.
  - Khắc phục triệt để lỗi `net::ERR_BLOCKED_BY_CLIENT` nhờ cấp chứng chỉ trung gian GlobalSign hợp lệ cho cả hai đường khởi động (`npm start` và `Start_AutoTask_AI.cmd`).
  - Mảng `readOnlyBlockedRequests` ghi nhận giá trị rỗng `[]`, chứng minh trong suốt phiên người dùng không có bất kỳ request HTTP mutating nào (như `action=submit`, `processattempt.php`, hay service ghi điểm) được phát đi từ trình duyệt.
- **Ranh giới:** Bằng chứng này xác nhận gói tin ở tầng giao vận HTTP/HTTPS gửi từ máy trạm của sinh viên tới máy chủ HUST, không chứng minh cấu trúc nội tại trong cơ sở dữ liệu của nhà trường.

### Tầng 3 — Trạng thái phía Server LMS (Server-Side Database & Mutation Invariant)
- **Đánh giá ranh giới thẩm quyền:** AutoTask AI hoạt động như một công cụ máy trạm của người học, **hoàn toàn không có quyền root, không có SSH access và không có quyền truy cập trực tiếp vào hệ quản trị cơ sở dữ liệu PostgreSQL/MySQL của trường ĐHBK Hà Nội** (`lms.hust.edu.vn`).
- **Phân loại kết luận:**
  - Việc tuyên bố "Không gây biến đổi dữ liệu server" trên môi trường production của HUST là một **kết luận suy luận kỹ thuật hợp lý (Inferred State)** dựa trên sự phối hợp của Tầng 1 (không có hành động người dùng) và Tầng 2 (không có request ghi nào được gửi lên server), kết hợp với việc kiểm tra trạng thái tài khoản không xuất hiện bài thi đang làm dở.
  - **Không khẳng định đây là bằng chứng kiểm toán trực tiếp từ cơ sở dữ liệu server trên production.**
  - Tính bất biến của dữ liệu máy chủ (Server-side zero-write và database rollback) đã được kiểm chứng độc lập và xác nhận 100% trong bộ test harness sandbox cục bộ ([`tests/lms-readonly-reconciliation.test.ts`](file:///c:/Users/Admin/autotask/tests/lms-readonly-reconciliation.test.ts) và [`tests/session-data-hardening.test.ts`](file:///c:/Users/Admin/autotask/tests/session-data-hardening.test.ts)).

---

## 5. TỔNG KẾT VÀ BẢO TOÀN TRẠNG THÁI RELEASE GATE

### A. Tình trạng kiểm thử và mã nguồn hiện tại

- **TypeScript Compilation:** `npm run typecheck` $\rightarrow$ **0 lỗi** (Clean).
- **Moodle False Positive Elimination:** `tests/moodle-dashboard-false-positive.test.ts` $\rightarrow$ **2/2 PASS**.
- **Moodle DOM Extraction Accuracy:** `tests/moodle-dom-accuracy.test.ts` $\rightarrow$ **28/28 PASS**.
- **Session Data Hardening & Secret Redaction:** `tests/session-data-hardening.test.ts` $\rightarrow$ **16/16 PASS**.
- **READ_ONLY Telemetry Reconciliation:** `tests/lms-readonly-reconciliation.test.ts` $\rightarrow$ **5/5 PASS**.
- **Candidate Archive Integrity:**
  - File: `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`
  - SHA-256: `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`
  - **Khớp 100% với baseline ban đầu. File ZIP hoàn toàn không bị chỉnh sửa hay nén lại.**

### B. Quyết định Release Gate

> [!IMPORTANT]
> **RELEASE GATE INVARIANT:**
> Trạng thái phát hành của hệ thống tiếp tục được giữ nguyên nghiêm ngặt ở mức:
> $$\mathbf{READY\ FOR\ PILOT}$$
> **Không nâng lên `PILOT IN PROGRESS` và không tự ý nâng lên `RELEASED`.**  
> Tuyệt đối chưa cho phép hệ thống thực hiện bất kỳ thao tác mở đề thi thật, tự động trả lời câu hỏi, hay nộp bài trực tiếp nào trên môi trường LMS production khi chưa có văn bản phê duyệt nghiệm thu thực nghiệm từ người vận hành.
