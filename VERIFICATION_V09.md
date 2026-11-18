# Verification v0.9 — log và phạm vi nghiệm thu

**Môi trường kiểm tra:** Linux container, Node.js v22.16.0, TypeScript 5.8.3 global, Chromium hệ thống, gói JS Playwright CORE đi kèm thư viện Python Playwright. Mã ZIP *không* chứa Node modules hay Chromium. Phiên bản driver local có thể khác phiên bản sẽ cài từ npm theo `package.json`.

| Bài kiểm tra | Kết quả | Phạm vi bằng chứng |
|---|---|---|
| Offline TS syntax/transpile | PASS | 43 tệp nguồn + test không lỗi cú pháp |
| TypeScript `tsc --noEmit` | PASS | Đầy đủ khi tạm liên kết Playwright core và @types/node sẵn trên môi trường; không thay thế cài npm chính thức |
| Node unit tests | **43/43 PASS** | Parser/guard/queue/providers/theme/menu/deadline/UI logic |
| Python policy + document tests | **9/9 PASS** | Desktop safety policy (5) + DOCX/PDF/XLSX generation and XLSX formula neutralization (4) |
| Playwright Chromium local smoke | **11/11 PASS** | Real Chromium chạy `page.setContent` với form trong bộ nhớ (radio, checkbox, text, ARIA radio, Next, audio detect, local file attach, deadline, gate 15m, score) |
| Launcher no-color CLI | PASS | Menu khởi động, nhận `0`, thoát đúng, không cần API key |
| Doctor CLI | PASS | Nêu đúng thiếu Python keyring/local config/Windows khi chạy Linux |
| Windows Terminal profile apply | NOT TESTED ON WINDOWS | Script có backup + parse-guard; cần chạy trên Windows Terminal thật |
| npm install | UNAVAILABLE HERE | Không truy cập npm registry trong môi trường hiện tại, nhưng TypeScript typecheck đã thực hiện với module có sẵn |
| Windows Desktop UIA | NOT TESTED | Không có interactive Windows desktop |
| Microsoft SSO / FAMI / LMS HUST real | NOT TESTED | Không có session xác thực hoặc quyền truy cập nội bộ |
| Live model API | NOT TESTED | Không có user-supplied API key, quota hoặc endpoint test |
| English Discoveries / Microsoft Forms / Google Forms live | NOT TESTED | Fixture local không chứng minh tương thích site thật |
| Correctness score/benchmark | NOT TESTED | Không có tập bài được phép và nhãn kiểm chứng độc lập |

**Lưu ý:** 11 bài Chromium smoke mô phỏng cấu trúc điều khiển, không truy cập Google, Moodle hay FAMI thực tế. Chúng đánh giá đúng hàm scan/fill/status chứ không đánh giá toàn bộ AI reasoning pipeline, đăng nhập, submission hoặc độ chính xác chuyên môn.

## Quy trình chạy lại đầy đủ trên Windows

```powershell
npm install
py -3 -m pip install -r desktop/requirements.txt
npx playwright install chromium
npm run typecheck
npm test
npm run smoke:local
py -3 -m unittest discover -s tests -p '*test.py'
npm run doctor
```

Nếu một bài fail ở máy bạn, lưu báo cáo lỗi đã xóa token/mật khẩu, không đăng log chứa session hoặc thông tin riêng tư.
