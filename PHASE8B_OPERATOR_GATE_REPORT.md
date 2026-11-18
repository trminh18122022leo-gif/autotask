# AutoTask AI v1.1.6 — Phase 8B: Operator Setup & First Controlled Pilot Report
**Execution Date:** 2026-11-05  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Candidate Archive Size:** 438,289 bytes (164 manifest files matching byte-for-byte)  
**Host Environment:** Windows 10/11 (x64), PowerShell, Node.js v24.18.0, Python 3.14.6  
**Operational Release Gate:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**  
**Classification Standards:** `VERIFIED`, `REPORTED_ONLY`, `NOT_TESTED`, `BLOCKED`, `FAILED`  

---

## 1. Kiểm Tra Toàn Diện Các Điều Kiện Vận Hành (Read-Only Audit)

Một cuộc kiểm toán không làm lộ bí mật đã được thực hiện đối với 5 điều kiện vận hành cốt lõi:

| Điều Kiện Vận Hành | Trạng Thái Thực Tế | Bằng Chứng Kỹ Thuật | Phân Loại |
|---|:---:|---|:---:|
| **1. Model Profile Đã Cấu Hình?** | **CHƯA CÓ** | Tệp `.private/model-profiles.json` chưa tồn tại | `BLOCKED (MODEL_SETUP_REQUIRED)` |
| **2. Kết Nối Provider Thật Sẵn Sàng?** | **CHƯA CÓ** | Không có API key trong biến môi trường hoặc OS Vault | `BLOCKED` |
| **3. Browser Task Config Hợp Lệ?** | **ĐÃ CẤU HÌNH** | Đã tạo `.private/browser-task.json` tuân thủ 100% `validateConfig` | `VERIFIED (PASS)` |
| **4. Phiên LMS Được Xác Thực?** | **CHƯA CÓ** | Thư mục `.private/chromium-profile` và `accounts.json` chưa tồn tại | `BLOCKED (LOGIN_REQUIRED)` |
| **5. Tác Vụ Tự Luyện Không Chấm Điểm?** | **SẴN SÀNG** | Tác vụ `pilot_read_only_overview` ở chế độ `READ_ONLY` | `VERIFIED` |

---

## 2. Rà Soát Các Cảnh Báo Hệ Thống & Kiểm Toán Log

### 2.1 Cảnh Báo `esbuild@0.28.2 (postinstall: node install.js)`
- **Hiện tượng:** Khi chạy `npm ci`, npm hiển thị:
  `npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts: esbuild@0.28.2 (postinstall: node install.js)`.
- **Nguyên nhân gốc rễ:** Tính năng `allowScripts` trong các phiên bản npm mới yêu cầu khai báo danh sách gói được phép chạy script cài đặt. Gói `esbuild` sử dụng postinstall script để tải/liên kết binary tương thích với kiến trúc Windows x64. Do `package.json` của dự án không thiết lập trường `allowScripts`, npm phát ra cảnh báo thông tin.
- **Đánh giá ảnh hưởng:** `esbuild` hoàn toàn hoạt động bình thường, hỗ trợ thực thi mượt mà `npx tsx src/doctor.ts`, `npx tsx scripts/run-real-model-benchmark.ts` và 33 test suites.
- **Phân loại mức độ nghiêm trọng:** **P3 / Informational**. Không ảnh hưởng đến độ tin cậy hoặc bảo mật. Tuân thủ nguyên tắc không tự ý thay đổi tệp `package.json` hoặc khóa dependency.

### 2.2 Cảnh Báo Node.js `DEP0190` (`shell: true`)
- **Hiện tượng:** Khi một tiến trình con gọi `spawnSync` với mảng đối số và `shell: true`, Node.js v24 phát ra:
  `[DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.`
- **Nguyên nhân gốc rễ:** Trong `src/launcher.ts` (dòng 113), hàm `execute` sử dụng `shell: process.platform === 'win32' && args[0] === 'npm'`. Trong Node.js v24+, việc truyền một mảng đối số cùng với `shell: true` kích hoạt cảnh báo cảnh giác deprecation của Node.js.
- **Đánh giá ảnh hưởng:** Mọi lệnh gọi trong `src/launcher.ts` đều là các chuỗi hằng số cố định (`['npm', 'run', 'browser']`, `['npm', 'run', 'desktop']`, `['npm', 'run', 'discover']`), hoàn toàn không nhận input từ người dùng hay internet. Do đó không tồn tại nguy cơ command injection.
- **Phân loại mức độ nghiêm trọng:** **P3 / Deprecation Warning**. An toàn trong phạm vi vận hành hiện tại.

### 2.3 Xác Minh Tính Đầy Đủ của `reports/tsc_noemit_run.log`
- Đã kiểm tra lại lệnh `npx tsc --noEmit`: Trình biên dịch TypeScript chạy hoàn tất với exit code `0`.
- Theo thiết kế của TypeScript CLI, khi 0 có lỗi nào xảy ra trên toàn bộ 118 tệp nguồn, đầu ra stdout/stderr hoàn toàn rỗng. Đã bổ sung ghi chú xác nhận kết quả `0 errors` vào `reports/tsc_noemit_run.log`.

---

## 3. Thiết Lập Cấu Hình Browser Task (`.private/browser-task.json`)

Để hoàn thiện điều kiện số 3 và chuẩn bị sẵn sàng cho phiên đăng nhập live của người vận hành, cấu hình đã được thiết lập nghiêm ngặt:

```json
{
  "allowedHosts": [
    "ea.hust.edu.vn",
    "ed.hust.edu.vn",
    "fami.hust.edu.vn"
  ],
  "allowedOrigins": [
    "https://ea.hust.edu.vn",
    "https://ed.hust.edu.vn",
    "https://fami.hust.edu.vn"
  ],
  "approvedForAIUse": true,
  "operationMode": "READ_ONLY",
  "answerSourceMode": "AI_PRIMARY",
  "parallelTabs": 1,
  "authUrls": [],
  "deadlinePages": [],
  "provider": {
    "profileId": "byok-pilot-model",
    "model": "gemini-2.5-pro"
  },
  "tasks": [
    {
      "id": "pilot_read_only_overview",
      "title": "HUSTLMS Permitted Course Overview",
      "url": "https://ea.hust.edu.vn/my/",
      "aiPermitted": true,
      "mode": "READ_ONLY",
      "scopeAttestation": "PERMITTED_SELF_PRACTICE"
    }
  ]
}
```

### Các Tiêu Chí Bảo Vệ Được Đảm Bảo:
1. **Chỉ truy cập domain được phép:** Giới hạn chặt chẽ ở 3 domain đại học đã khai báo (`AUD-LMS-02`, `AUD-LMS-03`).
2. **Khởi tạo ở chế độ `READ_ONLY`:** Tuyệt đối không gửi request đột biến trạng thái (POST/PUT/DELETE) hoặc submit bài (`AUD-LMS-01`).
3. **Không chứa URL có nhúng credentials:** Đạt chuẩn `ensureAllowed` (không chứa username/password trong URL).
4. **Không tự tạo attempt:** Không click nút mở lượt làm bài khi chưa có xác nhận rõ ràng từ người vận hành.
5. **Đạt chuẩn kiểm định:** Chạy `npm run doctor` đạt **`● PASS | Hợp lệ (3 website được phép, 1 tác vụ)`**; Command Deck hiển thị **`BROWSER AGENT: SẴN SÀNG (READY)`**.

---

## 4. Trạng Thái Kết Nối Model AI & Benchmark Thực Tế

- **Lệnh thực thi:**
  ```powershell
  npx tsx scripts/run-real-model-benchmark.ts
  ```
- **Kết quả thu thập (Telemetry):**
  - Trạng thái: **`NOT TESTED`**
  - Lý do: `"No live AI model profile / BYOK API key is configured in .private/model-profiles.json or OS Credential Vault on this workstation."`
  - Số mẫu kiểm định: 20 câu hỏi do chuyên gia biên soạn độc lập (18 câu trắc nghiệm khách quan + 2 câu tự luận concept-rubric).
  - Không tạo kết quả accuracy giả mạo (`VERIFIED`).
- **Phân loại trạng thái:** **`MODEL_SETUP_REQUIRED`** (`BLOCKED`).

---

## 5. Trạng Thái Thử Nghiệm LMS Live & An Toàn Xác Thực

- **Lệnh chuẩn bị:**
  ```cmd
  Start_AutoTask_AI.cmd
  ```
  *(hoặc `npm start` -> Menu [1] Browser Agent)*
- **Kết quả hiện tại:** **`LIVE_NOT_TESTED — LOGIN_REQUIRED`** (`BLOCKED`).
- **Quy tắc an toàn bất di bất dịch:**
  - AutoTask AI **tuyệt đối không tự động vượt rào xác thực SSO, MFA hoặc CAPTCHA**.
  - Việc có tài khoản hợp lệ **không đồng nghĩa với việc được phép thực hiện mọi bài kiểm tra**.
  - Trước khi chuyển từ `READ_ONLY` sang `PRACTICE_ASSISTED`, người vận hành bắt buộc phải xác nhận phạm vi bài tự luyện được phép sử dụng AI.
  - Mọi thao tác đều tuân thủ nguyên tắc `CHECK` / `KEEP` / `SUBMIT`; cấm tự động submit bài đánh giá hạn chế.

---

## 6. Hướng Dẫn Thao Tác Dành Cho Người Vận Hành (Operator Actions)

Để chính thức bắt đầu phiên pilot live đầu tiên, người vận hành cần thực hiện 2 bước sau trên máy tính Windows:

### Bước 1: Nhập API Key Model Thật vào Model Center
1. Mở terminal, chạy lệnh:
   ```powershell
   npm run models
   ```
2. Chọn **`[2] Thêm model profile mới`**.
3. Chọn Provider mong muốn (Google Gemini, OpenAI, Anthropic Claude, hoặc Custom).
4. Nhập Model ID (ví dụ: `gemini-2.5-pro` hoặc `gpt-4o`).
5. Nhập API Key của bạn trực tiếp tại màn hình bảo mật (khóa được mã hóa tự động vào Windows DPAPI Vault qua `WinVaultKeyring`, không lưu plaintext).
6. Chọn **`[6] Test kết nối model`** để kiểm tra phản hồi với prompt ping tối thiểu.
7. Chạy benchmark đo lường:
   ```powershell
   npx tsx scripts/run-real-model-benchmark.ts
   ```

### Bước 2: Đăng Nhập Cổng LMS Chính Thức Qua Trình Duyệt
1. Chạy lệnh:
   ```powershell
   npm start
   ```
2. Chọn **`[1] Browser Agent`**.
3. Khi cửa sổ Chromium mở ra, người vận hành **tự đăng nhập tài khoản nhà trường bằng SSO / MFA / CAPTCHA**.
4. Sau khi đăng nhập thành công, Browser Agent sẽ nhận diện phiên làm việc và hiển thị tổng quan khóa học ở chế độ `READ_ONLY`.
5. Người vận hành chỉ định một bài tập tự luyện được phép, duyệt bản nháp và quyết định `CHECK` (kiểm tra lại), `KEEP` (lưu nháp) hoặc `SUBMIT <taskId>` (nếu muốn nộp).

---

## 7. Quyết Định Release Gate

- **Trạng thái hiện tại:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**.
- **Đánh giá tiêu chí nâng trạng thái:**
  - Tiêu chí 1: Đăng nhập LMS chính thức thành công (`Chờ người vận hành`).
  - Tiêu chí 2: Kết nối BYOK model thật thành công (`Chờ người vận hành`).
  - Tiêu chí 3: Ít nhất 1 phiên tự luyện được phép có telemetry (`Chờ người vận hành`).
  - Tiêu chí 4: Bằng chứng kiểm tra bản nháp và trạng thái tác vụ (`Chờ người vận hành`).
- **Kết luận:** **Giữ nguyên trạng thái `READY FOR PILOT`**. Tuyệt đối không tự ý nâng lên `PILOT IN PROGRESS`, `PILOT COMPLETED` hay `GENERAL RELEASE` khi chưa có dữ liệu thực nghiệm live.
