# FAMI HUST / LMS HUST: Dữ liệu cần để xây adapter sau đăng nhập

**Không gửi mật khẩu, OTP, cookie, token, request headers hay toàn bộ browser profile vào cuộc trò chuyện.**

Bạn có thể chạy agent trên Windows thật với tài khoản tự nhập vào menu **Account Vault**; mật khẩu được lưu vào OS keyring. Nếu đã đăng nhập, phiên browser riêng của tài khoản có thể được tái sử dụng tới khi hết hạn.

## Tối thiểu, cần từ mỗi nền tảng

1. URL trang sau khi đăng nhập thành công (ví dụ đường dẫn dashboard, bỏ tham số token nếu có).
2. Ảnh hoặc video trang danh sách môn học.
3. Ảnh hoặc video một khóa học với bài quiz và bài assignment.
4. Ảnh một câu trắc nghiệm, một câu điền văn bản, một màn hình upload và nút chuyển trang (nếu có).
5. Ảnh trang deadline, lịch học, kết quả được công bố.
6. Loại đăng nhập: form username/password trực tiếp, Microsoft SSO, hoặc phương thức khác; **không cần gửi thông tin đăng nhập**.

## Cách xuất cấu trúc giao diện (ưu tiên)

Sau khi tạo `.private/browser-task.json` và đăng nhập trên máy Windows của bạn:

```powershell
npm run capture -- .private/browser-task.json https://lms.hust.edu.vn/...
```

Với FAMI thay URL bằng trang FAMI đã được duyệt trong `allowedHosts`. Lệnh sử dụng browser context có phiên đăng nhập, xuất bản mô tả **read-only** chứa loại câu hỏi, số lựa chọn, nhãn nút, nhãn link và URL không có query token. Mọi dữ liệu chỉ lưu dưới `.private/inspections/`; không tự upload lên mạng. **Phải tự xem lại, xóa thông tin cá nhân trong JSON trước khi chia sẻ** vì tên môn học hay nhãn nút có thể chứa thông tin riêng.

Nếu LMS chuyển sang domain Microsoft SSO, bổ sung chính xác các host đăng nhập được tin cậy trong Account Vault. Không tự động vượt qua CAPTCHA/MFA, không chia sẻ token.

## Trạng thái

Không có quyền truy cập phiên đã xác thực trong môi trường kiểm thử này; adapter HUST/FAMI cần kết quả capture và chạy thử trên một tài khoản được phép để triển khai và nghiệm thu từng màn hình.
