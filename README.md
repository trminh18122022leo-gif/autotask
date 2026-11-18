# AutoTask AI v1.0 — Tokyo Night / Cyberpunk Workstation Command Center

Hệ thống AI Browser + Desktop Computer-Use Agent chạy local-first trên Windows, tích hợp bảo mật OS Credential Vault (Windows Credential Manager) cho API keys và tài khoản LMS.

Phiên bản v1.0 hoàn thiện giao diện Command Deck, First-Run Setup thông minh, Model Center toàn diện, Appearance Studio và quản lý Task UX với Checkpoint self-recovery.

---

## AI-PRIMARY (bản sửa tính năng tùy chọn dữ liệu form)

**AI_PRIMARY là mặc định:** ModelRouter xử lý toàn bộ câu hỏi được scanner hỗ trợ; đường dẫn tệp dữ liệu form (nếu đã lưu) không được dùng để ghi đè đáp án AI.

**FORM_FILE là tùy chọn:** Chọn trong Setup hoặc Terminal khi thực sự cần điền form từ tệp có sẵn. Chỉ dùng nguồn tệp trên biểu mẫu nhập liệu thông thường được nhận diện; câu hỏi quiz Moodle/English Discoveries/FAMI vẫn do AI xử lý, trong phạm vi được phép. Tệp chỉ được ghép theo định danh hoặc nội dung câu hỏi rõ ràng; trường thiếu được chuyển đến AI, không tự chọn nhầm. Tệp dữ liệu có thể ở định dạng JSON, CSV, TSV, TXT, Markdown, XLSX, DOCX hoặc PDF chứa văn bản (không OCR). DOCX/XLSX/PDF cần `python -m pip install -r desktop/requirements.txt`.

Chế độ này không mặc định gửi file sang API model; chỉ nội dung câu hỏi khi AI được phép. Tệp gắn kèm có sẵn hỗ trợ qua input upload HTML tiêu chuẩn; Moodle AJAX File Manager cần tích hợp và E2E riêng. Độ đúng của model và tương thích LMS thật chưa được kiểm chứng từ các test offline.

Xem `examples/ANSWER_FILE_WORKFLOW.md` và `examples/ai-primary.sample.json`.

## Các Tính Năng Trọng Tâm

### 1. First-Run Setup & Onboarding
- **Tự động phát hiện lần chạy đầu tiên**: Khi chạy `npm start`, hệ thống tự kiểm tra Node, Python, Chromium, OS Keyring, Model và Account.
- **Không bao giờ crash do thiếu cấu hình**: Nếu thiếu `.private/browser-task.json`, hiển thị Setup Wizard trực tiếp trong terminal thay vì thoát lỗi.
- **Hỗ trợ Multi-Site & Multi-Account**: Cấu hình nhiều domain website được phép (`allowedHosts`), chọn tài khoản đã lưu từ Account Vault, tái sử dụng session cookies Chromium mà không cần gõ lại mật khẩu.
- **Chế độ chỉnh sửa**: Cho phép cập nhật cấu hình tác vụ bất kỳ lúc nào (`npm run setup`).

### 2. Model Center — Quản Lý AI Đa Provider
- **My Models**: Quản lý danh sách model, Provider, Model ID, trạng thái kiểm thử, độ trễ phản hồi, chuyển model mặc định, CRUD.
- **Available Models**: Chọn nhà cung cấp (OpenAI, Gemini, Anthropic Claude, Groq, Custom). Lấy danh sách model thực tế từ API (OpenAI `/v1/models`, Gemini `/v1beta/models`, Groq `/v1/models`). Tìm kiếm và phân trang trực tiếp trong terminal (`[N]`, `[P]`, `[S]`).
- **Model Details**: Xem năng lực Vision (hình ảnh), Context Window (128k, 1M, 2M), Task Compatibility (DOM, Vision, Reasoning), API Endpoint và trạng thái kết nối.
- **API Key Manager**: Thêm, sửa, xóa, kiểm tra API key. Mask key an toàn (`sk-proj-...mnop`), không bao giờ in key đầy đủ ra màn hình, logs hay báo cáo lỗi.
- **Model Routing**: Thiết lập Primary Model và danh sách Fallback. Tự động chuyển model khi gặp lỗi tạm thời (408, 429, 500, 503, timeout, network); chặn lặp vô hạn và không fallback sai với lỗi xác thực (401/403).
- **Test Connection**: Gửi ping request tối thiểu (1 token), đo độ trễ (ms), phân biệt lỗi API key, Quota/Rate Limit, Model ID hoặc Network.

### 3. Terminal UI/UX — Tokyo Night & Cyberpunk
- **Hai Theme chuẩn**:
  - **Tokyo Night**: Background `#1a1b26`, Purple `#bb9af7`, Cyan `#7dcfff`, Blue `#7aa2f7`, Green `#73daca`, Text `#c0caf5`.
  - **Cyberpunk**: Background `#0b0614`, Neon Pink `#ff2bd6`, Neon Cyan `#00f5ff`, Purple `#a855f7`, Yellow `#fcee0a`.
- Điều hướng mượt mà: Phím mũi tên ↑↓, Enter chọn, Esc quay lại, số/phím tắt nhanh, breadcrumbs, status bar, bảng có màu, progress bar, loading spinner, toast notifications, error cards.
- Hỗ trợ Unicode Tiếng Việt chuẩn xác (tính toán visual width cho dấu thanh và ký tự rộng).
- Hỗ trợ chế độ non-TTY / non-ANSI an toàn.
- Khôi phục con trỏ terminal (`\x1b[?25h`) và trạng thái rawMode khi thoát hoặc nhấn Ctrl+C.

### 4. Appearance Studio
- Đổi Theme trực quan, live preview toàn màn hình.
- Đổi font Windows Terminal (Cascadia Code, JetBrains Mono, Fira Code, Consolas...).
- Tùy chỉnh kích thước font (8–24pt), opacity (40–100%), kiểu con trỏ (`bar`, `vintage`, `underscore`, `filledBox`, `emptyBox`).
- Bật/tắt intro animation.
- Tự động cài đặt profile vào Windows Terminal kèm sao lưu backup an toàn, hoặc xuất snippet JSON để cài thủ công.
- Reset về cấu hình mặc định ban đầu.

### 5. Command Deck — 13 Phân Hệ Độc Lập
1. **Browser Agent** (`npm run browser`): Thực thi tác vụ web an toàn, quét câu hỏi, điền form, xác nhận trước khi nộp.
2. **Desktop Computer Use** (`npm run desktop`): Tự động hóa giao diện Windows qua UI Automation & Vision.
3. **LMS & Course Discovery** (`npm run discover`): Quét khóa học, môn học, bài tập, deadline trong phạm vi allowlist.
4. **Task Queue** (`npm run queue`): Bảng quản lý tiến độ tác vụ, số bước hoàn thành, model sử dụng, tạm dừng, thử lại.
5. **Model Center** (`npm run models`): Bảng điều khiển quản lý toàn bộ AI models.
6. **Account Vault** (`npm run accounts`): Quản lý tài khoản LMS trong Windows Credential Manager, session cookies.
7. **AI Notes** (`npm run notes`): Ghi chú chỉ dẫn riêng cho AI (Global, Host, Task).
8. **Deadline Radar** (`npm run radar`): Ra-đa tính toán hạn chót bài tập theo thời gian thực (≤24h, ≤72h, quá hạn).
9. **Task History & Reports** (`npm run history`): Xem báo cáo kết quả, câu hỏi đã giải, điểm số đã công bố.
10. **Appearance Studio** (`npm run theme` / `npm run appearance`): Tùy biến ngoại hình terminal.
11. **Setup Wizard** (`npm run setup`): Thiết lập multi-site & multi-account.
12. **System Doctor** (`npm run doctor`): Chẩn đoán toàn diện môi trường Node, Python, Chromium, Keyring, Configs.
13. **Exit**: Đóng workstation an toàn.

### 6. Task UX & Checkpoint Self-Recovery
- Checkpoint tự động lưu tại `.private/checkpoints/<taskId>.json` sau mỗi bước.
- Cho phép tiếp tục (Resume) tác vụ bị ngắt quãng giữa chừng thay vì thực hiện lại từ đầu.
- Cảnh báo nộp bài trùng lặp (`checkDuplicateRisk`) nếu bài đã có điểm hoặc đã nộp trong các session trước.
- Không bao giờ báo thành công khi chưa có bằng chứng DOM xác nhận từ máy chủ.

---

## Hướng Dẫn Bắt Đầu Trên Windows

### Cách 1: Khởi Chạy Nhanh Bằng PowerShell Script
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
npm run doctor
npm start
```

### Cách 2: Cài Đặt Thủ Công
```powershell
npm install
python -m pip install -r desktop/requirements.txt
npx playwright install chromium
npm run typecheck
npm test
npm run smoke:local
npm start
```

### Cách 3: Click Trực Tiếp File CMD
Chạy file `Start_AutoTask_AI.cmd` trong thư mục gốc.

---

## Bảng Lệnh NPM Thường Dùng

| Lệnh | Mô tả |
|---|---|
| `npm start` | Khởi chạy Command Deck chính |
| `npm run models` | Mở Model Center (My Models, Catalog, Key Manager, Routing, Ping Test) |
| `npm run appearance` | Mở Appearance Studio (Theme, Font, Opacity, Cursor, Animations) |
| `npm run queue` | Mở Task Queue (Tiến độ tác vụ, Checkpoints, Resume, Retry) |
| `npm run radar` | Mở Deadline Radar theo dõi hạn chót bài tập |
| `npm run doctor` | Chẩn đoán môi trường Node, Python, Keyring, Playwright, Configs |
| `npm run setup` | Setup Wizard tạo hoặc sửa cấu hình tác vụ Multi-site |
| `npm run accounts` | Quản lý tài khoản LMS và session cookies |
| `npm run browser` | Khởi chạy Browser Agent thực thi web tasks |
| `npm run desktop` | Khởi chạy Windows Desktop Computer Use |
| `npm run discover` | Quét khóa học và bài tập trên LMS |
| `npm run notes` | Quản lý ghi chú chỉ dẫn cho AI |
| `npm run history` | Xem lịch sử các phiên báo cáo |
| `npm run typecheck` | Kiểm tra kiểu TypeScript (`tsc --noEmit`) |
| `npm test` | Chạy toàn bộ 59 unit tests |
| `npm run smoke:local` | Chạy 11 bài kiểm thử DOM/ARIA trên Chromium local |
| `npm run check:full` | Kiểm tra toàn diện (Typecheck + Unit + Smoke + Python) |

---

## Bảo Mật & An Toàn

1. **Kho Credential**: Mật khẩu tài khoản và API keys được lưu trực tiếp trong **Windows Credential Manager** (thông qua Python `keyring`), không lưu trong JSON hoặc plaintext.
2. **Không Rò Rỉ Secret**: API keys luôn được mask dạng `sk-proj-...mnop` và hàm `sanitizeError` lọc bỏ toàn bộ token khỏi logs và lỗi hiển thị.
3. **Phạm Vi Cho Phép (Allowlist Scope)**: Browser Agent chỉ hoạt động trong danh sách `allowedHosts` do người dùng duyệt; không điều hướng sang website lạ.
4. **Xác Nhận Nộp Bài (Human-in-the-Loop)**: Mọi thao tác nộp bài đều yêu cầu người dùng gõ xác nhận `SUBMIT <taskId>` rõ ràng.

## Experimental Moodle adapters (opt-in, ungraded self-practice ONLY)

This candidate adds *experimental* UI adapters for visual questions, ordering, drag-and-drop, CodeRunner **draft editor only**, and Moodle File Manager **user-chosen attachments only**. They have unit tests, but **do not yet have full real-Moodle or Windows Playwright acceptance**. A recognized widget is not proof the answer is correct or saved to the server. Unknown plugins fail closed to `UNSUPPORTED`.

For a particular **permitted, ungraded self-practice** task, explicitly configure:

```json
{
  "id": "practice-example",
  "url": "https://your-approved-moodle-host/mod/quiz/view.php?id=123",
  "aiPermitted": true,
  "mode": "PRACTICE_ASSISTED",
  "scopeAttestation": "PERMITTED_SELF_PRACTICE",
  "advancedLmsAdapters": {
    "ordering": true,
    "dragdrop": true,
    "codeDraft": true,
    "fileManager": true
  },
  "attachmentFiles": {
    "m7_att": "C:/Users/You/Documents/your-own-report.pdf"
  }
}
```

Global `operationMode` must not be `READ_ONLY` or `ASSESSMENT_RESTRICTED`. All existing policy gates, human challenges, permitted host checks, and final-submit confirmations remain in force. The `answerSourceMode` remains `AI_PRIMARY` by default; `FORM_FILE` stays a separate opt-in mode for generic form entry. `attachmentFiles` is **only** an explicit user-chosen local file mapping, not an AI answer file. On CodeRunner, the adapter only enters a code draft; it never clicks `Check` or submits the code.

Adapter limits: ordering must have a unique `.sortablelist .sortableitem` set; drag/drop must expose unique `.draghome` items and labelled `.drop` zones; CodeRunner requires a textarea/Ace/CodeMirror bridge with verified readback; Moodle File Manager requires a visible repository `Upload a file` flow and UI confirmation. Unsupported sites remain manual. For media/math, visual questions are cropped to their question container rather than sending a full LMS page screenshot. Do not represent the adapters as compatible with all Moodle versions without live sandbox acceptance.
