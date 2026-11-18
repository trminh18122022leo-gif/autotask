# Changelog

## v1.0.0 (2026-10-27) — Master Workstation Release

### First-Run Setup & Onboarding
- Sửa triệt để lỗi thiếu file cấu hình `Missing .private/browser-task.json`: Tự động nhận diện lần chạy đầu tiên, hiển thị Setup Assistant và Wizard trực tiếp trên terminal thay vì thoát lỗi.
- Bổ sung cấu hình Multi-Website (`allowedHosts`) và Multi-Account (`accountId` từ Account Vault).
- Tích hợp kiểm tra phiên đăng nhập (Cookies session) Chromium để không phải nhập lại mật khẩu khi phiên còn hiệu lực.
- Cho phép chỉnh sửa cấu hình tác vụ bất kỳ lúc nào mà không bị lỗi `EEXIST`.

### Model Center — Giao Diện Quản Lý AI Toàn Diện
- **My Models**: Bảng quản lý toàn bộ AI model, hiển thị Provider, Model ID, trạng thái kiểm thử, độ trễ phản hồi (ms), model mặc định và danh sách fallback. Hỗ trợ CRUD đầy đủ.
- **Available Models**: Duyệt 5 nhà cung cấp (OpenAI, Gemini, Anthropic Claude, Groq, Custom). Lấy danh sách model thực tế từ API (`/v1/models`, `/v1beta/models`). Tìm kiếm và phân trang trực tiếp trong terminal (`[N]`, `[P]`, `[S]`, `[C]`).
- **Model Details**: Thẻ thông tin chi tiết về Vision Support, Context Window (128k, 1M, 2M), Task Compatibility badges (`[DOM]`, `[Vision]`, `[Reasoning]`), API Endpoint và trạng thái kết nối.
- **API Key Manager**: Quản lý API key trong Windows Credential Manager thông qua Python keyring bridge (`desktop/vault_bridge.py`). Tự động mask key (`sk-proj-...mnop`), lọc bỏ toàn bộ secret khỏi logs và thông báo lỗi.
- **Model Routing**: Thiết lập Primary Model và sắp xếp thứ tự danh sách Fallback. Tự động chuyển model khi gặp lỗi tạm thời (408/429/500/503/timeout/mạng) với cơ chế chống lặp vô hạn (visited set). Chặn fallback sai đối với lỗi xác thực (401/403).
- **Test Connection**: Gửi ping request tối thiểu (1 token), đo thời gian phản hồi (ms), phân loại chính xác các lỗi: `AUTH_INVALID_KEY`, `QUOTA_EXCEEDED`, `MODEL_NOT_FOUND`, `NETWORK_ERROR`.

### Terminal UI/UX & Appearance Studio
- Chuẩn hóa hai theme **Tokyo Night** và **Cyberpunk** theo đúng bảng màu hex yêu cầu.
- Thêm điều hướng Breadcrumbs, Status Bar, bảng màu có đường viền (`renderTable`), thanh tiến trình (`renderProgressBar`), loading spinner động (`withSpinner`), Toast notifications (`toast`) và Error cards.
- Xử lý Unicode Tiếng Việt chuẩn xác (`stringWidth`, `clip`), không bị lệch cột bảng khi có dấu thanh.
- Hỗ trợ chế độ non-TTY / non-ANSI an toàn.
- Appearance Studio: Đổi theme, xem preview trực tiếp, đổi font Windows Terminal, đổi kích thước font (8–24pt), điều chỉnh opacity (40–100%), tùy chỉnh kiểu cursor (`bar`, `vintage`, `underscore`, `filledBox`, `emptyBox`), bật/tắt intro animation, cài đặt profile Windows Terminal an toàn có backup, và reset về mặc định.
- Tự động khôi phục con trỏ terminal (`\x1b[?25h`) và trạng thái rawMode khi thoát hoặc nhấn Ctrl+C.

### Command Deck — Đầy Đủ 13 Phân Hệ Hoạt Động Thật
- Thiết kế lại Command Deck với 13 mục menu: Browser Agent, Desktop Computer Use, LMS & Course Discovery, Task Queue, Model Center, Account Vault, AI Notes, Deadline Radar, Task History & Reports, Appearance Studio, Setup Wizard, System Doctor, Exit.
- Thanh HUD trạng thái hiển thị real-time: Default Model & Provider, Số account profile, Trạng thái Browser Agent, Tác vụ đang chạy, Số tác vụ trong hàng đợi, Deadline khẩn nhất, Cảnh báo hệ thống. Mọi nút đều hoạt động thực sự.

### Task UX & Checkpoints Self-Recovery
- Checkpoint persistence tự động lưu tại `.private/checkpoints/<taskId>.json` sau mỗi bước.
- Hỗ trợ kiểm tra cảnh báo nguy cơ nộp bài trùng lặp (`checkDuplicateRisk`).
- Điều hướng trình duyệt tự phục hồi (`resilientGoto`) với cơ chế retry và exponential backoff.
- Hỗ trợ xem chi tiết checkpoint, tạm dừng (Pause), tiếp tục (Resume) và thử lại (Retry) tác vụ lỗi.

### Windows Deployment & Testing
- Sửa lỗi cú pháp PowerShell trong `scripts/first-run.ps1`.
- Cung cấp script cài đặt toàn diện `scripts/setup.ps1` có kiểm tra syntax và xử lý lỗi chặt chẽ.
- Mở rộng kiểm thử: 59 Unit Tests (100% PASS), 11 Chromium DOM Tests (100% PASS), 9 Python Tests (100% PASS), TypeScript Typecheck (0 lỗi).
- Bổ sung automated syntax regression testing cho toàn bộ file `.ps1`.

---

## v0.9.0 (2026-10-27)
- Arrow-key Command Deck, report history, fresh deadline severity and System Doctor.
- Local Chromium smoke fixture and expanded unit coverage.
- Prevent false READY when maxPages reached and more pages are visible.
- Safer dedicated Windows Terminal theme installer with settings backup.
- Windows setup bootstrap and explicit live-site acceptance checklist.
