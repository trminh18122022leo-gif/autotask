# BIÊN BẢN BÀN GIAO PHÁT HÀNH ỨNG VIÊN (RC HANDOFF)
## AutoTask AI v1.1.7-rc.2

- **Phiên bản:** `v1.1.7-rc.2`
- **Mã lưu trữ RC:** [`release/autotask-ai-v1.1.7-rc.2.zip`](file:///c:/Users/Admin/autotask/release/autotask-ai-v1.1.7-rc.2.zip)
- **SHA-256 Checksum:** `6e4a353ecf477467bdc778a0d58d4359d4ccd0f5821adef3cc7daa47efdf2918`
- **Tệp xác thực Checksum:** [`release/autotask-ai-v1.1.7-rc.2.zip.sha256`](file:///c:/Users/Admin/autotask/release/autotask-ai-v1.1.7-rc.2.zip.sha256)
- **Tệp Manifest chi tiết:** [`release/autotask-ai-v1.1.7-rc.2.manifest.json`](file:///c:/Users/Admin/autotask/release/autotask-ai-v1.1.7-rc.2.manifest.json)
- **Dung lượng:** 495,138 bytes (0.47 MB)
- **Tổng số tệp đóng gói:** 186 tệp (100% đường dẫn POSIX `/`, 0 backslash `\`, 0 tệp cấm)
- **Bản lưu trữ đối chiếu v1.1.7-rc.1:** [`release/autotask-ai-v1.1.7-rc.zip`](file:///c:/Users/Admin/autotask/release/autotask-ai-v1.1.7-rc.zip) (`54bf069178de1a57c7cae4ea5b664c0d380bf9860f67adbd6e92d70b8dae843a`)
- **Bản cơ sở v1.1.6 locked:** [`release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`](file:///c:/Users/Admin/autotask/release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip) (`f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`)
- **Operational Release Gate:** **`READY FOR PILOT`** (Tuyệt đối không tự nâng lên General Release)
- **Thời gian lập biên bản:** 2026-11-08T01:05:00+07:00

---

## 1. HƯỚNG DẪN CÀI ĐẶT TRÊN MÁY MỚI (CLEAN INSTALLATION)

### Yêu cầu hệ thống tối thiểu
- **Hệ điều hành:** Windows 10/11 (64-bit).
- **Node.js:** Phiên bản LTS $\ge$ v20 (khuyến nghị v20.x, v22.x hoặc v24.x).
- **Python:** 3.11+ (phục vụ worker desktop và quản lý khóa OS Keyring).

### Các bước cài đặt
1. **Giải nén tệp phát hành:**
   Giải nén `autotask-ai-v1.1.7-rc.2.zip` vào một thư mục làm việc mới (ví dụ `C:\AutoTask_AI`).
   Xác minh thư mục sau giải nén chứa `resources/certs/globalsign_intermediate.crt` và **không có** thư mục `.private/`.

2. **Cài đặt thư viện dependencies:**
   Mở terminal (PowerShell hoặc Command Prompt) tại thư mục giải nén và chạy:
   ```cmd
   npm ci --prefer-offline
   ```
   > **Lưu ý về cảnh báo `allowScripts` của esbuild:**
   > Quá trình cài đặt có thể xuất hiện cảnh báo `npm warn allow-scripts esbuild@0.28.2`. Đây là cơ chế cảnh báo thông tin mặc định của npm v10+ về script postinstall. `npm ci` vẫn thoát với mã `0` thành công và không ảnh hưởng đến khả năng biên dịch hay thực thi của hệ thống.

3. **Chạy kiểm tra chẩn đoán hệ thống (Preflight Doctor):**
   ```cmd
   npm run doctor
   ```
   Kết quả kỳ vọng: Mục **`TLS & Moodle HTTPS Handshake`** phải báo `● PASS | TLS_VERIFIED (HTTP 200, CA: CERTIFICATE_READY)`.

---

## 2. HƯỚNG DẪN CẤU HÌNH LẦN ĐẦU (FIRST-RUN SETUP)

Khi khởi chạy trên máy sạch, System Doctor sẽ hiển thị 3 cảnh báo màu vàng. Đây là **trạng thái bình thường và chủ định** do gói phát hành bảo mật không bao giờ đóng gói thông tin đăng nhập hoặc khóa cá nhân của nhà phát triển:

1. **Cấu hình Model AI (Menu [5] — Model Center):**
   - Chọn [5] trên giao diện dòng lệnh để thêm API Key cho model mong muốn (Gemini, OpenAI, Claude, hoặc local Ollama).
   - Khóa được lưu an toàn trong Windows Credential Manager (`WinVaultKeyring`), không bao giờ ghi plaintext vào file `.env`.

2. **Tài khoản LMS & Xác thực SSO (Menu [6] — Account Vault):**
   - Học viên có thể lưu tài khoản nếu muốn hoặc để trống để sử dụng luồng đăng nhập thủ công an toàn.
   - Khi Browser Agent mở trang LMS, nếu chưa có phiên đăng nhập, hệ thống sẽ dừng an toàn ở trạng thái **`WAITING_FOR_AUTH`** để học viên tự đăng nhập SSO qua giao diện trình duyệt.

3. **Tạo cấu hình tác vụ (Menu [11] — Setup Wizard):**
   - Chạy trình hướng dẫn để thiết lập danh sách tên miền được phép (`allowedHosts`: `lms.hust.edu.vn`, v.v.) và phạm vi học tập (`PERMITTED_SELF_PRACTICE`).

---

## 3. CÁCH KHỞI CHẠY HỆ THỐNG

Người vận hành có thể sử dụng một trong hai đường khởi chạy tương đương:
- **Đường 1 (Khuyến nghị cho Windows):**
  Nhấp đúp vào tệp [`Start_AutoTask_AI.cmd`](file:///c:/Users/Admin/autotask/Start_AutoTask_AI.cmd). Kịch bản tự động nạp chứng chỉ công khai `resources\certs\globalsign_intermediate.crt` vào biến môi trường `NODE_EXTRA_CA_CERTS` và khởi chạy Command Deck.
- **Đường 2 (Dành cho dòng lệnh):**
  Chạy lệnh:
  ```cmd
  npm start
  ```
  Hệ thống kích hoạt cơ chế `src/ca-bootstrap.ts`, tự động phát hiện chứng chỉ trong `resources/certs/` và self-respawn an toàn mà không cần cấu hình thủ công.

---

## 4. BẢO MẬT & KIỂM TRA ĐĂNG NHẬP THỰC TẾ

- **Hành vi trang đăng nhập:** Khi Browser Agent được điều hướng tới `https://lms.hust.edu.vn/login/index.php` hoặc `https://lms.hust.edu.vn/my/` trên máy sạch chưa đăng nhập, hệ thống nhận diện giao diện xác thực và dừng lại ở:
  ```
  RESULT STATUS: WAITING_FOR_AUTH
  QUESTIONS FOUND: 0
  QUESTIONS FILLED: 0
  MUTATING REQUESTS BLOCKED: 0
  ```
  Hệ thống tuyệt đối **không tự động điền mật khẩu, không gửi request đột biến và không cố gắng bypass SSO**.
- **Không có dữ liệu nhạy cảm:** Gói phát hành v1.1.7-rc.2 đã qua kiểm toán 100%: 0 API key thật, 0 session cookie, 0 private key, 0 tài khoản cá nhân.

---

## 5. GIỚI HẠN ĐÃ BIẾT & PHẠM VI ÁP DỤNG

1. **Phạm vi LMS:** Kết quả nghiệm thu điền đáp án tự động chỉ được chứng minh trên môi trường Sandbox cục bộ có cấu trúc tương đương Moodle. Chưa có chứng nhận nào cho các bài thi chính thức của nhà trường.
2. **Quyền hạn mutating:** Hệ thống không tự động mở đề thi (`startattempt.php`) và không tự động nộp bài (`processattempt.php`). Mọi thao tác này đều đòi hỏi xác nhận trực tiếp từ người học.
3. **Mạng học đường:** Nếu học viên kết nối qua mạng Wi-Fi có Captive Portal trường học, cần đăng nhập Captive Portal trên trình duyệt trước khi khởi chạy AutoTask AI.

---

## 6. KẾT LUẬN & RELEASE GATE

Bản phát hành ứng viên **AutoTask AI v1.1.7-rc.2** đã sẵn sàng bàn giao cho giai đoạn thử nghiệm có giám sát (Pilot).

**Khẳng định Release Gate: `READY FOR PILOT`**.
- Không nâng lên General Release.
- Không tự động thực hiện hay nộp bài trên LMS chính thức.
