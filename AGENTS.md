# AutoTask AI — Agent Rules (workspace)

Khi bắt đầu phiên mới: đọc `HANDOFF_NEXT_SESSION.md` để nắm kiến trúc, lịch sử tính năng, trạng thái test và hướng phát triển.

## Giao tiếp
- Trả lời người dùng bằng **tiếng Việt**, ngắn gọn, có link file.
- Chỉ báo cáo số liệu test / kết quả thực sự quan sát được trong output công cụ.

## Môi trường
- Windows + PowerShell 5: không dùng `&&` (dùng `;`), không có `rg` (dùng `Select-String`).
- Import ESM khi chạy snippet: `npx tsx --input-type=module -e "..."`.
- Đã khởi tạo git repo (`main`, `core.autocrlf=false`, `origin`: `https://github.com/trminh18122022leo-gif/autotask.git`) → kiểm tra `git status` trước khi sửa lớn để giữ khả năng rollback.

## Bảo mật (bắt buộc)
- Không in, log hay commit API key / mật khẩu / cookie. Dữ liệu `.private/` là nhạy cảm.
- Giữ nguyên cơ chế redact (`src/security/redact.ts`), allowlist host, chặn nộp bài trái phép, fail-closed khi bài còn In progress (không bao giờ báo đã nộp khi chưa xác nhận).
- Không vượt CAPTCHA / MFA.

## Code
- Không viết named function bên trong Playwright `page.evaluate(...)`.
- Không đổi mã hex `COLORS` trong `src/ui/themes.ts`.
- Không tô `gradientText` từng ký tự lên các chuỗi mà test so khớp (`AGENT-12`, `QUOTA-01`) — xem mục 5 của handoff.
- `introAnimation()` phải bỏ qua khi không phải TTY.

## Kiểm thử sau mỗi thay đổi
```powershell
npm run typecheck
npx tsx --test --test-concurrency=2 tests/tokyo.test.ts tests/model-center-and-first-run.test.ts tests/v09-ux-and-workflow.test.ts tests/playbooks-and-quota.test.ts tests/agent-autonomous.test.ts tests/advanced-upgrades-v12.test.ts tests/assignment-writing-upload.test.ts
```
(Bộ trên ~90 giây, chạy nền. Toàn bộ: `npm test`; Python: `python -m unittest discover -s tests -p "*test.py"`.)
