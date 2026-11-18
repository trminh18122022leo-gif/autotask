# AutoTask AI v1.1.6 — Phase 8C: Real Operator Handoff & Pilot Gate Report
**Audit Date:** 2026-11-05  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Host Environment:** Windows 10/11 (x64), PowerShell, Node.js v24.18.0, Python 3.14.6  
**Operational Release Decision:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**  
**Current Execution State:** **`WAITING_FOR_OPERATOR`**  

---

## 1. Tiếp Nhận Hiện Trạng & Cấu Hình Thực Tế (Current Configuration)

Kiểm toán độc lập xác nhận toàn bộ các thành phần cơ sở đã đạt trạng thái chuẩn bị:
- **Mã nguồn & Archive:** Candidate ZIP được bảo vệ nguyên vẹn với SHA-256 `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`. Toàn bộ 164 tệp trên ổ đĩa khớp 100% manifest.
- **Cấu hình Tác vụ Trình duyệt (`.private/browser-task.json`):**
  - Host cho phép: `ea.hust.edu.vn`, `ed.hust.edu.vn`, `fami.hust.edu.vn`.
  - Cổng đăng nhập tiền tác vụ: `https://ea.hust.edu.vn/login/index.php`.
  - Chế độ vận hành: Bắt đầu nghiêm ngặt ở **`READ_ONLY`** (không gửi request đột biến trạng thái).
  - Tác vụ ban đầu: `pilot_read_only_overview` trỏ tới `https://ea.hust.edu.vn/my/` với `mode: READ_ONLY` và `scopeAttestation: PERMITTED_SELF_PRACTICE`.
  - Kết quả kiểm định: `npm run doctor` đạt **`● PASS | Hợp lệ (3 website được phép, 1 tác vụ)`**; Command Deck hiển thị **`BROWSER AGENT: SẴN SÀNG (READY)`**.

---

## 2. Bằng Chứng Kết Nối AI Model Thật (Real Model Connection Evidence)

- **Trạng thái Model Center:** **`MODEL_SETUP_REQUIRED`** (`BLOCKED`).
- **Kiểm toán bí mật:** Không có API key plaintext nào tồn tại trong biến môi trường hoặc thư mục dự án (`VERIFIED`).
- **Telemetry Benchmark (`scripts/run-real-model-benchmark.ts`):**
  - Trạng thái: `"status": "NOT TESTED"`.
  - Lý do: `"No live AI model profile / BYOK API key is configured in .private/model-profiles.json or OS Credential Vault on this workstation."`.
  - Bộ mẫu: 20 câu hỏi do con người biên soạn độc lập (18 khách quan + 2 tự luận concept-rubric).
  - Cam kết kiểm toán: Tuyệt đối không tạo kết quả accuracy giả mạo khi chưa có model thật (`VERIFIED`).

---

## 3. Bằng Chứng Xác Thực LMS (Authentication Evidence)

- **Trạng thái Xác thực:** **`LIVE_NOT_TESTED — LOGIN_REQUIRED`** (`BLOCKED`).
- **Phân tích Luồng Đăng nhập vs `READ_ONLY` Network Guard:**
  - `contextBlockHandler` trong `src/main.ts` chặn toàn bộ request phương thức ghi (`POST/PUT/DELETE`) khi tác vụ ở chế độ `READ_ONLY`.
  - Nếu việc đăng nhập diễn ra bên trong vòng lặp tác vụ `READ_ONLY`, các request POST của form đăng nhập SSO/CAS có thể bị chặn bởi bộ bảo vệ mạng.
  - **Giải pháp thiết kế đã kiểm chứng:** Đường dẫn đăng nhập `https://ea.hust.edu.vn/login/index.php` được định tuyến qua trường `authUrls` trong `.private/browser-task.json`. Giai đoạn này diễn ra **trước khi** các tác vụ bắt đầu, do đó `contextBlockHandler` chưa được cài đặt. Người vận hành tự do thực hiện đăng nhập SSO/MFA/CAPTCHA mà không bị xung đột với `READ_ONLY` network guard, đồng thời không cần nới lỏng ngoại lệ POST làm suy yếu cơ chế bảo vệ.
- **Nguyên tắc an toàn:**
  - AutoTask AI không tự vượt cơ chế bảo vệ.
  - Không đọc hoặc xuất cookies, mật khẩu, OTP hay token vào log.
  - Dừng an toàn tại trạng thái `WAITING_FOR_AUTH` khi chưa có phiên hợp lệ.

---

## 4. Kế Hoạch Quan Sát Live READ_ONLY (Stage A) & Thực Hành Tự Luyện (Stage B)

Ngay sau khi người vận hành hoàn thành đăng nhập:

### Stage A — Quan Sát Read-Only:
1. Mở trang tổng quan khóa học `https://ea.hust.edu.vn/my/`.
2. Xác minh hostname, session hợp lệ và cấu trúc điều hướng.
3. Thu thập telemetry đã làm sạch dữ liệu cá nhân (tên sinh viên, MSSV được ẩn).
4. Tuyệt đối không click nút mở lượt làm bài, không gửi request thay đổi dữ liệu.

### Stage B — Thực Hành Tự Luyện Được Phép:
1. Chỉ thực hiện khi người vận hành chọn một bài tự luyện không chấm điểm, được phép dùng AI và xác nhận tác vụ cụ thể.
2. Kiểm tra metadata loại trừ bài thi có chấm điểm hoặc có điều kiện hạn chế.
3. Chuyển sang `PRACTICE_ASSISTED` chỉ trong phạm vi tác vụ đã được phê duyệt.
4. Đọc câu hỏi, hình ảnh, công thức và tạo bản nháp.
5. Kiểm tra readback trên DOM và server persistence.
6. Tuân thủ hàng rào kiểm soát cuối cùng: `CHECK` (kiểm tra lại), `KEEP` (lưu nháp trên server), hoặc `SUBMIT <taskId>` (chỉ khi có lệnh rõ ràng từ người vận hành).

---

## 5. Rà Soát Chi Tiết Các Vấn Đề Kỹ Thuật (Deep Technical Review)

| Hạng Mục | Hiện Tượng Kỹ Thuật | Phân Tích Nguyên Nhân Gốc Rễ | Đánh Giá An Toàn & Rủi Ro | Phân Loại Severity |
|---|---|---|---|:---:|
| **1. `esbuild` allowScripts** | Cảnh báo npm warn allowScripts trong `npm ci` | npm v10+ quét postinstall scripts; `package.json` chưa cấu hình allowScripts | Binary `@esbuild/win32-x64` liên kết nội bộ hoạt động bình thường; không ảnh hưởng runtime | **P3 / Informational** |
| **2. Node.js `DEP0190`** | Deprecation warning khi gọi `spawnSync` với `shell: true` | `src/launcher.ts` (dòng 113) truyền mảng đối số kèm `shell: true` | Mọi đối số trong `src/launcher.ts` đều là chuỗi hằng số cố định (`npm run browser`, `npm run doctor`), không nhận input từ người dùng | **P3 / Deprecation Warning** |
| **3. Rủi ro Command Injection** | Tiềm ẩn nếu đối số thay đổi động trong tương lai | `shell: true` có thể nối chuỗi tham số nguy hiểm nếu có input bên ngoài | Hiện tại đối số hoàn toàn là static tuple; đề xuất nâng cấp dài hạn dùng `npm.cmd` với `shell: false` | **Khuyến nghị kiến trúc (P3)** |
| **4. Log `tsc_noemit_run.log`** | Tệp log ban đầu có kích thước 0 bytes | `tsc --noEmit` khi đạt 0 lỗi sẽ trả về stdout/stderr rỗng theo chuẩn TypeScript | Đã bổ sung ghi chú xác nhận kết quả exit code `0` trên 118 tệp nguồn | **Đã hoàn thiện bằng chứng** |
| **5. Nhất quán Model Profile** | `browser-task.json` trỏ `byok-pilot-model` | Model Center chưa có profile nào được lưu | Khi người vận hành tạo profile trong Model Center, đặt tên profile ID trùng khớp để `ModelRouter` kích hoạt mượt mà | **Đã hướng dẫn chi tiết** |

---

## 6. Danh Mục Tệp Thay Đổi & Kiểm Thử Hồi Quy

- **Tệp mã nguồn (`src/`, `dist/`):** **0 tệp thay đổi**. Không có mã nguồn nào bị chỉnh sửa.
- **Candidate ZIP:** Giữ nguyên trạng thái khóa với SHA-256 `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`.
- **Tệp cấu hình được cập nhật:** [`.private/browser-task.json`](file:///c:/Users/Admin/autotask/.private/browser-task.json) (đã cấu hình an toàn ở chế độ `READ_ONLY`, bổ sung cổng đăng nhập `authUrls`).
- **Lỗi mới phát sinh:** `0` (Zero active blockers; ACK-01 đến ACK-14 giữ nguyên trạng thái RESOLVED).

---

## 7. Các Rào Cản Còn Lại (Remaining Blockers) & Hướng Dẫn Thao Tác

Tiến trình tạm dừng an toàn tại **`WAITING_FOR_OPERATOR`** do 2 điều kiện bắt buộc từ phía người dùng:

### Thao Tác 1: Nhập API Key Model trong Model Center
1. Mở terminal, chạy lệnh:
   ```powershell
   npm run models
   ```
2. Chọn **`[2] Thêm model profile mới`**.
3. Chọn Provider (Google Gemini, OpenAI, Anthropic Claude, hoặc Custom OpenAI-compatible).
4. Nhập Model ID (ví dụ: `gemini-2.5-pro` hoặc `gpt-4o`).
5. Đặt Profile ID là: `byok-pilot-model` (khớp với `browser-task.json`).
6. Nhập API Key của bạn trực tiếp tại màn hình bảo mật (khóa được mã hóa tự động vào Windows DPAPI Vault qua `WinVaultKeyring`, không lưu plaintext).
7. Chọn **`[6] Test kết nối model`** để xác nhận phản hồi với prompt ping tối thiểu.
8. Chạy benchmark đo lường:
   ```powershell
   npx tsx scripts/run-real-model-benchmark.ts
   ```

### Thao Tác 2: Khởi Chạy Browser Agent & Đăng Nhập Cổng LMS
1. Chạy lệnh:
   ```powershell
   npm start
   ```
   *(hoặc chạy tệp `Start_AutoTask_AI.cmd`)*
2. Chọn **`[1] Browser Agent`**.
3. Cửa sổ trình duyệt Chromium sẽ tự động mở trang `https://ea.hust.edu.vn/login/index.php`.
4. Người vận hành **tự đăng nhập tài khoản chính thức bằng SSO / MFA / CAPTCHA**.
5. Nhấn Enter tại Terminal sau khi hoàn thành đăng nhập.
6. Browser Agent tự động quan sát tổng quan khóa học ở chế độ `READ_ONLY` và sẵn sàng nhận diện bài tự luyện được phép để tạo bản nháp.

---

## 8. Quyết Định Release Gate

- **Quyết định Hiện Tại:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**.
- **Trạng thái Vận Hành:** **`WAITING_FOR_OPERATOR`**.
- **Quy tắc Chuyển Trạng Thái:** Chỉ chuyển sang `PILOT IN PROGRESS` sau khi người vận hành hoàn thành Thao tác 1 và Thao tác 2, và phiên pilot live thu thập được telemetry thực tế đầu tiên.
