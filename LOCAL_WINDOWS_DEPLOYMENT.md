# AutoTask AI v0.9 — Triển khai, chạy và nghiệm thu trên Windows 10/11

**Hiện trạng:** Source v0.9 đã qua kiểm tra offline (TypeScript + unit tests + Chromium DOM smoke). Chưa được nghiệm thu trên Windows desktop có đăng nhập LMS thật. Không suy diễn trạng thái kiểm thử này thành tương thích thực tế.

## 1) Chuẩn bị máy

- Windows 10/11, Windows Terminal, Node.js 20+ (khuyên Node.js 22), Python 3.11–3.13.
- Cài font `Cascadia Code` (thường có sẵn) hoặc font monospace đã được cài đặt hợp pháp.
- Dung lượng trống để cài Chromium Playwright. Kết nối mạng cần thiết để tải npm, pip và trình duyệt.
- Cần API key cá nhân *nếu dùng phân tích bằng AI*. ChatGPT Plus không mặc nhiên bao gồm API credits.
- Không sử dụng tài khoản trường học, password, token, cookie hay API key trong bất cứ issue/chat công khai nào.

## 2) Cài nhanh (PowerShell)

```powershell
# Giải nén ZIP vào thư mục không chứa ký tự đặc biệt phức tạp, VD C:\Tools\AutoTaskAI
cd C:\Tools\AutoTaskAI
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\first-run.ps1
npm run doctor
npm start
```

Nếu script bị chính sách tổ chức chặn, cài thủ công:

```powershell
npm install
py -3 -m pip install -r desktop/requirements.txt
npx playwright install chromium
npm run typecheck
npm test
npm run smoke:local
py -3 -m unittest discover -s tests -p '*test.py'
npm run doctor
npm start
```

`npm run smoke:local` dùng HTML tạo trong bộ nhớ Chromium; **không truy cập hay nộp bài tới các website thực**.

## 3) UI / Tokyo Night – Cyberpunk

- Mở `npm start`, chọn `Appearance` bằng mũi tên ↑↓ và Enter (hoặc phím số).
- Chỉ có **hai colorway**: Tokyo Night hoặc Cyberpunk.
- Chọn font, font size, opacity. Màu ANSI thay đổi ngay trong ứng dụng.
- Cấu hình font/nền của *cửa sổ* do Windows Terminal quản lý. Chọn `APPLY` để thêm **profile riêng** vào Windows Terminal. Script có backup và không thay đổi profile mặc định.
- Nếu settings.json sử dụng JSONC không parse được, script **dừng an toàn**, không sửa file; áp dụng các snippet `terminal/windows-terminal-*` thủ công qua Windows Terminal Settings.
- Có thể dùng `npm run preview` để xem nhanh, không cần model/API.

## 4) API keys và tài khoản an toàn

```powershell
npm run models       # Lưu model/API key trong Windows Credential Manager
npm run accounts     # Lưu tài khoản LMS qua getpass + keyring
npm run notes        # Ghi chú cho agent, không chứa secret
npm run setup        # Khởi tạo cấu hình browser/desktop thật trong .private/
```

API key và mật khẩu không được đưa vào tệp source/ZIP. Phiên Chromium được lưu trong `.private/sessions/<account-id>/`; có thể hết hạn. MFA/SSO/CAPTCHA cần người dùng xác nhận bằng bước chính thức. Trên máy dùng chung hãy dùng `FORGET` khi kết thúc.

## 5) Bắt đầu kiểm thử LMS trên máy cá nhân

1. Mở `npm run accounts`; tạo profile riêng cho LMS HUST/FAMI; chỉ khai báo **đúng host SSO được cho phép**.
2. Trên `npm run setup`, nhập URL dashboard hoặc course, bật khám phá hoạt động. Xác nhận quyền dùng AI cho tác vụ được phép.
3. Chạy `npm run discover` để kiểm tra danh sách môn/hoạt động/deadline. Đối chiếu danh sách với website bằng mắt.
4. Chạy `npm run capture -- .private/browser-task.json <URL>` để thu thập cấu trúc giao diện cần test; **kiểm tra và che dữ liệu cá nhân trước khi chia sẻ**.
5. Bắt đầu từ một form thử nghiệm do chính bạn tạo/được phép tự động hoá. Test ô text, radio, checkbox, upload, phân trang, report, session KEEP/FORGET.
6. Chỉ sau khi bài thử qua kiểm tra mới thử các loại bài luyện tập LMS được phép dùng AI. Luôn kiểm tra trạng thái `READY_FOR_REVIEW`/`PARTIAL` và xác nhận riêng từng bước nộp.
7. Với FAMI, **đọc tài liệu đúng thời gian website yêu cầu**. Agent chỉ quan sát trạng thái, không giả lập đọc, không rút ngắn hoặc bypass 15 phút.
8. Với Moodle quiz có giới hạn thời gian, đừng khởi động lượt thi để thử nghiệm nếu việc đó sẽ tiêu hao lượt thật. Đồng hồ website vẫn chạy kể cả khi AI đang xử lý.

## 6) Checklist nghiệm thu thực tế

- [ ] Đăng nhập qua LMS HUST, phiên vẫn hợp lệ sau khi đóng/mở lại Chrome
- [ ] Microsoft SSO và MFA xử lý đúng qua giao diện chính thức
- [ ] Dashboard liệt kê chính xác danh sách môn học
- [ ] Tìm được quiz/assignment đúng với danh sách LMS thật
- [ ] Nhận diện Opened/Closed, các bài chưa mở và giới hạn thời gian
- [ ] Không gọi câu hỏi bị khóa là hoàn thành; không tự vượt giới hạn FAMI
- [ ] Đọc chính xác nội dung DOM/ARIA/hình ảnh/công thức với nguồn được phép
- [ ] Nhập thử mỗi loại trường trên **form kiểm thử riêng** và xác minh UI thay đổi
- [ ] Phân trang đầy đủ, không báo READY khi vẫn còn nút Next
- [ ] Tạo DOCX/PDF/XLSX, xem lại nội dung và upload lên form thử nghiệm
- [ ] Nhiều tab không tranh chấp cửa sổ desktop
- [ ] Khi API lỗi: chuyển model dự phòng; khi hết quota toàn bộ: báo lỗi rõ ràng
- [ ] Trước nộp: xác nhận chính xác từng task; không tuyên bố thành công nếu chưa có xác nhận
- [ ] Báo cáo điểm lấy từ trang đã công bố, không tự đoán
- [ ] KEEP/LOGOUT/FORGET hoạt động, không rò rỉ mật khẩu/cookie vào reports
- [ ] Windows Terminal theme có backup và không thay đổi profile mặc định

## 7) Khắc phục lỗi thường gặp

- **`npm install` lỗi DNS/proxy:** cài trên máy có kết nối mạng, cấu hình proxy/npm registry theo chính sách tổ chức; không nên tắt xác minh TLS.
- **Không thấy Chromium:** chạy `npx playwright install chromium`.
- **Không nhận model:** chạy `npm run models`; kiểm tra quota/thanh toán API và model ID thực tế.
- **Không thấy PowerShell 7:** lệnh theme có thể dùng Windows PowerShell 5.1 nếu settings.json là JSON chuẩn; JSONC dùng merge snippet thủ công.
- **Không bắt được câu hỏi:** chạy `npm run capture`, đối chiếu iframe/site adapter; chưa thử nghiệm xong thì không để auto-submit.
- **FAMI vẫn chưa mở:** trạng thái web là nguồn sự thật; đợi và đọc đủ thời gian được yêu cầu.
- **Tab bị đóng/lỗi:** xem `reports/` và `npm run history`, không tự động nộp bù.

## 8) Lộ trình còn cần hoàn thành trên máy local

**Ưu tiên 1:** Windows Terminal/desktop UI Automation E2E; **Ưu tiên 2:** LMS HUST/FAMI authenticated adapter tests; **Ưu tiên 3:** Google/Microsoft Forms live form owner test; **Ưu tiên 4:** English Discoveries audio/speaking adapter (cần kiểm tra phương thức bài), độ chính xác vision; **Ưu tiên 5:** deadline notification nền và benchmark reliability (số lượng bài thành công/lỗi có bằng chứng).

Không có mục nào trong lộ trình được coi là PASS chỉ vì HTML mô phỏng offline đã chạy.
