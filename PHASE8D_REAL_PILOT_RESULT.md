# AutoTask AI v1.1.6 — Phase 8D: Validate Actual Operator Results
**Audit Date:** 2026-11-06  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Host Platform:** Windows 10/11 (x64), PowerShell, Node.js v24.18.0, Python 3.14.6  
**Operational Release Gate:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**  
**Current Execution State:** **`WAITING_FOR_OPERATOR (LMS Authentication Pending)`**  
**Classification Taxonomy:** `VERIFIED`, `REPORTED_ONLY`, `NOT_TESTED`, `BLOCKED`, `FAILED`  

---

## 1. Kết Quả Kiểm Tra Thực Tế Cấu Hình Model Center & Provider

Kiểm toán độc lập không trích xuất bí mật xác nhận người vận hành **đã thực hiện thao tác lưu key thành công**:

1. **Model Profiles File ([`.private/model-profiles.json`](file:///c:/Users/Admin/autotask/.private/model-profiles.json)):**
   - Profile ID: `prf_1_gem_vnguyen` (`VERIFIED`).
   - Provider: `gemini` (`VERIFIED`).
   - Endpoint: `https://generativelanguage.googleapis.com/v1beta` (`VERIFIED`).
   - Bảo mật tệp: Hoàn toàn không có plaintext key trong file JSON; khóa được lưu trữ an toàn trong Windows DPAPI Vault (`WinVaultKeyring`) (`VERIFIED`).
2. **Khảo Sát Tính Tương Thích Model ID:**
   - Ban đầu profile được lưu với tên `"gemini flash"` (có dấu cách), khiến Google API phản hồi `HTTP 400: unexpected model name format`.
   - Tiến hành khảo sát trực tiếp từ Google API (`ListModels` trả về 50 model): Các model thế hệ cũ (`gemini-2.0-flash`, `gemini-2.5-flash`) đã bị Google cho nghỉ hưu trên endpoint v1beta.
   - Các model đang hoạt động thực tế với HTTP 200: `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemma-4-26b-a4b-it`.
   - Hệ thống đã đồng bộ model sang **`gemini-3.1-flash-lite`** và profile ID `prf_1_gem_vnguyen` trên cả `model-profiles.json` và `browser-task.json`.
3. **Kết Quả Kết Nối Thật (Live Connection Test):**
   - Lệnh kiểm tra: `testConnection` với prompt ping tối thiểu.
   - HTTP Status: **`200 OK`** (`VERIFIED`).
   - Thời gian đáp ứng (Latency): **`1667 ms`** (`VERIFIED`).
   - Trạng thái: **`VERIFIED — LIVE CONNECTION SUCCESSFUL`**.

---

## 2. Kết Quả Chạy Benchmark AI Thật (Real Model Benchmark Telemetry)

Lệnh thực thi chính thức:
```powershell
npx tsx scripts/run-real-model-benchmark.ts
```

### Dữ Liệu Thực Nghiệm (Ghi Nhận Thực Tế):
- **Trạng thái:** **`PASS`** (`VERIFIED`).
- **Profile ID:** `prf_1_gem_vnguyen` (`gemini-3.1-flash-lite`).
- **Số mẫu đánh giá:** 20 câu hỏi tự luyện do con người biên soạn độc lập (18 câu khách quan + 2 bài luận độc lập).
- **Độ chính xác câu hỏi khách quan:** **18/18 đạt chuẩn (100%)** (`VERIFIED`).
  - Khoảng tin cậy Wilson 95% CI: `[0.8241, 1.0000]`.
- **Đánh giá câu hỏi tự luận (Essay):**
  - Đạt tiêu chí concept-rubric độc lập: 2/2 (100%).
  - Cảnh báo bắt buộc: `essayHumanReviewRequiredCount: 2` (Luôn yêu cầu người học kiểm tra câu trả lời tự luận trước khi nộp).
- **Tỷ lệ từ chối trả lời (Abstention rate):** `0%`.
- **Lỗi tự tin thái quá (Overconfident wrong):** `0`.
- **Log chi tiết:** Lưu tại [`reports/model_benchmark_run.log`](file:///c:/Users/Admin/autotask/reports/model_benchmark_run.log).

---

## 3. Kết Quả Kiểm Tra Đăng Nhập Trình Duyệt & Trạng Thái LMS

1. **Thư Mục Profile Trình Duyệt ([`.private/chromium-profile/`](file:///c:/Users/Admin/autotask/.private/chromium-profile/)):**
   - Thư mục đã được tạo thực tế trên ổ đĩa (`VERIFIED`).
   - Tệp cơ sở dữ liệu `Cookies` và subfolder `Network` đã hiện diện (`VERIFIED`).
2. **Khảo Sát DNS & Điểm Kết Nối Máy Chủ HUST:**
   - Host `ea.hust.edu.vn` (từ cấu hình cũ) trả về `DNS ERROR: ENOTFOUND` (không tồn tại trên DNS công cộng, có thể là domain nội bộ cũ).
   - Host đại học chính thức hoạt động: **`lms.hust.edu.vn`** (Phân giải DNS thành công: `202.191.59.160`, HTTP 200) và **`fami.hust.edu.vn`** (`103.98.152.12`, HTTP 200).
   - Đã cập nhật `allowedHosts` và `allowedOrigins` bao gồm cả `lms.hust.edu.vn` và `fami.hust.edu.vn`.
3. **Kiểm Tra Trạng Thái Đăng Nhập Thực Tế:**
   - Điều hướng tới `https://lms.hust.edu.vn/my/` bằng Chromium profile hiện tại.
   - Máy chủ chuyển hướng về: `https://lms.hust.edu.vn/login/index.php` (Tiêu đề: `Log in to the site | LMS HUST`).
   - Nút đăng nhập chính thức: `"Login with HUST account"` trỏ tới cổng OAuth2 Microsoft SSO của trường:
     `https://lms.hust.edu.vn/auth/oauth2/login.php?id=1...`
   - **Kết luận:** Người vận hành đã mở trình duyệt nhưng **chưa hoàn tất bước bấm đăng nhập SSO** ("Login with HUST account"). Phiên làm việc thực tế hiện tại là **`CHƯA XÁC THỰC`** (`BLOCKED — LOGIN_REQUIRED`).

---

## 4. Xác Minh Luồng `authUrls` và An Toàn `READ_ONLY`

1. **Tính Hợp Lệ Của Cấu Hình:**
   - Cổng đăng nhập được thiết lập: `"authUrls": ["https://lms.hust.edu.vn/login/index.php"]`.
   - `npm run doctor` xác nhận: **`● PASS | Hợp lệ (4 website được phép, 1 tác vụ)`**.
2. **Nguyên Tắc Bảo Vệ Mạng:**
   - Giai đoạn tiền tác vụ `authUrls` thực thi độc lập trước khi `contextBlockHandler` được cài đặt.
   - Thao tác đăng nhập OAuth2/SSO của người vận hành hoàn toàn không bị xung đột với `READ_ONLY` network guard.
   - Không cần thêm ngoại lệ POST rộng làm yếu cơ chế bảo vệ của `READ_ONLY`.
3. **Phân Định Quyền Hạn Tác Vụ:**
   - Hệ thống **tuyệt đối không** sử dụng `approvedForAIUse: true` toàn cục hay `scopeAttestation: PERMITTED_SELF_PRACTICE` để tự suy diễn quyền làm một bài kiểm tra cụ thể.
   - Chế độ `PRACTICE_ASSISTED` chỉ được kích hoạt khi người vận hành chỉ định đích danh bài tự luyện không chấm điểm và phê duyệt tường minh.

---

## 5. Đối Chiếu Kết Quả Mới với Phase 8C

| Hạng Mục Kiểm Toán | Trạng Thái Phase 8C | Trạng Thái Mới (Phase 8D) | Bằng Chứng Kỹ Thuật | Phân Loại |
|---|:---:|:---:|---|:---:|
| **Model Center Profiles** | `0 profile` | **1 profile đã cấu hình** | `model-profiles.json` & DPAPI Keyring | `VERIFIED` |
| **Live Model Ping** | `Chưa chạy` | **HTTP 200 OK (1667ms)** | Model: `gemini-3.1-flash-lite` | `VERIFIED` |
| **Real Benchmark Accuracy** | `NOT TESTED` | **PASS (18/18 khách quan, 2/2 luận)** | Wilson 95% CI: `[0.8241, 1.0000]` | `VERIFIED` |
| **Chromium Profile** | `Chưa có` | **Đã khởi tạo thư mục profile** | `.private/chromium-profile` | `VERIFIED` |
| **LMS Authentication** | `LOGIN_REQUIRED` | **Vẫn chờ đăng nhập SSO** | `lms.hust.edu.vn/my/` redirect về `login` | `BLOCKED` |
| **Live Task Execution** | `NOT TESTED` | **Tạm dừng an toàn ở gate** | Không tự động làm bài khi chưa login | `NOT_TESTED` |

---

## 6. Lỗi Phát Hiện & Phương Án Xử Lý

1. **Lỗi Model Name Format (`HTTP 400`):**
   - *Bằng chứng:* Gửi `"gemini flash"` tới Google API gây lỗi `unexpected model name format`.
   - *Nguyên nhân:* Tên model có dấu cách thay vì định dạng gạch nối chuẩn.
   - *Xử lý:* Chuẩn hóa sang model đang phục vụ `gemini-3.1-flash-lite`, kết nối đạt 200 OK ngay lập tức.
2. **Lỗi DNS `ea.hust.edu.vn` (`ENOTFOUND`):**
   - *Bằng chứng:* `dns.lookup('ea.hust.edu.vn')` trả về `ENOTFOUND`.
   - *Nguyên nhân:* Domain cũ không còn tồn tại trên DNS public.
   - *Xử lý:* Cập nhật cấu hình sang host chính thức đang hoạt động `lms.hust.edu.vn`.

---

## 7. Các Thao Tác Còn Lại Dành Cho Người Vận Hành

Tiến trình đã giải quyết thành công phần AI Model, hiện chỉ còn dừng tại điều kiện xác thực:

```
╔════════════════════════════════════════════════════════════════════════════════════╗
║                   THAO TÁC DUY NHẤT CẦN THỰC HIỆN ĐỂ MỞ PILOT                      ║
╠════════════════════════════════════════════════════════════════════════════════════╣
║ 1. Chạy lệnh: npm start (hoặc chạy tệp Start_AutoTask_AI.cmd)                      ║
║ 2. Chọn [1] Browser Agent                                                          ║
║ 3. Cửa sổ Chromium sẽ mở ra trang: https://lms.hust.edu.vn/login/index.php         ║
║ 4. Nhấp nút "Login with HUST account" và đăng nhập tài khoản trường (SSO/MFA)     ║
║ 5. Sau khi vào được trang cá nhân (Dashboard), quay lại Terminal và nhấn Enter     ║
║ 6. Browser Agent sẽ ghi nhận telemetry READ_ONLY đầu tiên và báo cáo kết quả        ║
╚════════════════════════════════════════════════════════════════════════════════════╝
```

---

## 8. Quyết Định Release Gate

- **Quyết định Hiện Tại:** **`READY FOR PILOT` (Stage 2: B — READY FOR CONTROLLED PILOT)**.
- **Trạng Thái Điểm Dừng:** **`WAITING_FOR_OPERATOR (LMS Authentication Pending)`**.
- **Đánh Giá Tiến Độ:**
  - AI Model Connection & Accuracy Benchmark: **ĐÃ HOÀN THÀNH (PASS)**.
  - LMS Authentication & Live Observation: **Đang chờ thao tác đăng nhập SSO từ người vận hành**.
- **Nguyên Tắc Governance:** Tuyệt đối không tự ý nâng lên `PILOT IN PROGRESS` khi phiên đăng nhập LMS thực tế chưa hoàn tất. Hệ thống sẵn sàng chuyển trạng thái ngay khi có telemetry của phiên đăng nhập thành công.
