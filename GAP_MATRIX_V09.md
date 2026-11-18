# AutoTask AI v0.9 — Ma trận nghiệm thu so với yêu cầu

**Ngày:** 27/10/2026. **Quy ước:** 🟢 Kiểm thử offline đã qua hoặc chức năng CLI hoạt động local; 🟠 Có triển khai nhưng chưa nghiệm thu E2E trên Windows/website đăng nhập thật; 🔴 Chưa triển khai đầy đủ. Không đánh đồng “có source” với “website thật hoạt động”.

| Yêu cầu | Đã triển khai và kiểm chứng | Trạng thái |
|---|---|---|
| Terminal UI Tokyo Night / Cyberpunk | Hai theme ANSI, menu mũi tên/Enter, fallback nhập số, live status | 🟢 CLI local PASS; màu Windows chưa E2E |
| Font, màu nền terminal | Theme CLI xuất JSON, script thêm profile riêng và backup; hỗ trợ PS5.1/7 | 🟠 Chưa thử trên Windows Terminal thật |
| API key cá nhân | Model Vault + hệ điều hành keyring; không kèm key trong ZIP | 🟠 Chưa thử Credential Manager Windows |
| Chọn model AI | OpenAI, Gemini, Anthropic, Groq, custom endpoint theo cấu hình | 🟠 Chưa gọi API thật |
| Tự chuyển model khi lỗi | Fallback timeout/429/5xx + unit tests | 🟢 Logic PASS; 🟠 API live chưa thử |
| Nhập tài khoản/mật khẩu LMS | Account Vault dùng getpass/keyring; host đăng nhập chính xác | 🟠 Chưa thử tài khoản LMS thật |
| Lưu tài khoản không cần đăng nhập lại | Chromium persistent context theo accountId | 🟠 Chưa thử cookie hết hạn/SSO |
| Microsoft SSO | Nhận diện username/password trên trusted hosts; MFA thủ công | 🟠 Chưa đăng nhập SSO E2E |
| Tự mở, điều hướng website | Playwright + URL allowlist + kiểm tra navigation; browser smoke local | 🟢 UI local PASS; 🟠 website thật chưa thử |
| Tự tìm môn học | Link crawler theo host, giới hạn 50 trang | 🟠 Heuristic, chưa nghiệm thu dashboard động |
| Tự tìm quiz/assignment | URL/tên hoạt động + phân loại platform | 🟠 Chưa nghiệm thu LMS thật |
| Tự đọc nội dung câu hỏi | DOM, ARIA, iframe allowlist, cảnh báo unsupported | 🟢 Scanner local PASS; 🟠 LMS thật chưa thử |
| Phân tích câu hỏi bằng AI | Provider adapter, JSON schema validation, notes | 🟠 Chưa benchmark model real |
| Điền trắc nghiệm | Native radio/checkbox và ARIA radio, xác minh UI | 🟢 Chromium local PASS; 🟠 LMS thật chưa thử |
| Điền từ, đoạn văn | Input/textarea/contenteditable & post-fill checks | 🟢 Input local PASS; 🟠 LMS thật chưa thử |
| Nhận diện ảnh, công thức | Vision screenshot flow, hasVisual detection | 🟠 Chưa đo độ chính xác/MathJax E2E |
| Tạo DOCX/PDF/XLSX | Python Document Worker | 🟢 Offline PASS v0.9 (tạo và đọc lại), cần thử trên Windows |
| Tạo/upload file | setInputFiles + kiểm tra file input | 🟢 Local Chromium upload PASS; 🟠 chưa trang thật |
| Xử lý nhiều bài, tab | max 3 Browser workers; desktop jobs tuần tự | 🟠 Có mã, chưa stress test E2E |
| Nhiều trang trong một bài | Next detector và kiểm tra không đánh dấu READY nếu chạm maxPages còn Next | 🟢 Guard unit PASS; 🟠 LMS E2E chưa thử |
| Điều khiển desktop chuột/bàn phím | Windows UIA + visual grounding + worker queue | 🟠 Chưa có Windows GUI trong môi trường kiểm thử |
| Quét deadline khi đăng nhập | Moodle Closed parser và calendar scanner | 🟢 Chromium local PASS; 🟠 site thật chưa thử |
| Thông báo bài sắp đến | Radar trên Command Deck, xem report cũ và tính lại hạn theo đồng hồ hiện tại | 🟢 Logic PASS; 🟠 chưa có OS push khi app tắt |
| Báo cáo điểm thực tế | Read-only score observation + JSON reports | 🟢 Chromium local PASS; 🟠 đa nền tảng chưa thử |
| Xác nhận trước khi nộp | Prompt SUBMIT từng task, từ chối trạng thái PARTIAL | 🟢 Có mã, chưa submit live thử nghiệm |
| Tiếp tục/đăng xuất/lưu phiên | KEEP/LOGOUT/FORGET | 🟠 Chưa nghiệm thu SSO thực tế |
| Google Forms | DOM/ARIA adapter, local form fixture | 🟢 Mô phỏng PASS; 🟠 site thực chưa thử |
| Microsoft Forms | DOM/ARIA role + container selectors | 🟠 Chưa MS Forms live E2E |
| English Discoveries | Link/unit/iframe/nhận diện audio/speech | 🟠 Chưa media/interactive E2E |
| FAMI HUST | Nhận diện gate đọc tài liệu 15 phút + exam topic parse | 🟢 Logic+browser fixture PASS; 🟠 FAMI thật chưa thử |
| LMS HUST | Moodle URL/Opened/Closed/quizzes/timers/scores | 🟢 Logic+browser fixture PASS; 🟠 LMS thật chưa thử |
| AI Notes | Vault global/host/task | 🟢 Unit PASS; 🟠 cloud API E2E chưa thử |
| Giữ nguyên thời gian FAMI | WAITING_FOR_ACCESS, recheck, không mô phỏng đọc/bypass | 🟢 Logic PASS; 🟠 FAMI live chưa thử |
| Tự kiểm tra môi trường | `npm run doctor` kiểm tra Node/Python/Playwright/config/OS, deadline radar | 🟢 Local CLI PASS |
| Kiểm thử Chromium không dùng tài khoản | `npm run smoke:local` với fixture trong bộ nhớ, không nộp bài | 🟢 11/11 local PASS |
| Installer EXE / Windows GUI | Chưa phát hành installer chính thức | 🔴 Chưa có |
| Nhắc deadline khi app đã đóng | Chưa tích hợp Windows Task Scheduler / push | 🔴 Chưa có |
| Benchmark tự hoàn thành mọi bài LMS | Cần bài/adapter môi trường được phép và E2E đầy đủ | 🔴 Chưa có bằng chứng |

**Điều đã cải thiện so với v0.8:** UI menu phím mũi tên + tình trạng thực, báo cáo lưu sẵn, phân loại deadline theo thời gian hiện tại, Windows Terminal theme script cross-PowerShell, preflight `doctor`, giữ trạng thái PARTIAL khi vẫn còn trang sau, 11 kiểm tra Chromium DOM thật trên HTML thử nghiệm, full TypeScript typecheck offline.

**Tồn tại không thể giải quyết chỉ ở môi trường này:** login Microsoft/FAMI/Moodle thật (không có phiên đăng nhập/SSO), tương thích English Discoveries audio/speaking, tải/phát hành trên Windows thật, tỷ lệ chính xác câu hỏi thực, sự thay đổi DOM/iframe sống, phần mềm antivirus/chính sách máy trường học. Việc đánh dấu xanh cho các mục đó chỉ được thực hiện sau nghiệm thu local.
