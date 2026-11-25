# AutoTask

Công cụ hỗ trợ tự động hóa thao tác trình duyệt và tác vụ Windows trên nền Node.js, Playwright và Python.

## Yêu cầu môi trường

- Node.js >= 20
- Python 3 (cài gói trong `desktop/requirements.txt`)
- Chromium của Playwright

## Cài đặt

```powershell
npm install
python -m pip install -r desktop/requirements.txt
npx playwright install chromium
```

## Sử dụng

```powershell
npm start          # Mở giao diện terminal chính
npm run agent      # Chạy chế độ agent theo phiên tương tác
npm run setup      # Thiết lập cấu hình ban đầu
npm run doctor     # Kiểm tra môi trường
```

## Kiểm tra mã nguồn

```powershell
npm run typecheck
npm test
python -m unittest discover -s tests -p "*test.py"
```

## Cấu trúc thư mục

- `src/` — Mã nguồn TypeScript (CLI, agent trình duyệt, quản lý model và giao diện terminal)
- `desktop/` — Script Python hỗ trợ Windows Credential Manager, đọc tài liệu và tính toán kiểm chứng
- `tests/` — Bộ kiểm thử TypeScript và Python
- `scripts/`, `resources/`, `terminal/`, `examples/` — Script khởi tạo, chứng chỉ trung gian, cấu hình terminal và tệp mẫu

## Lưu ý bảo mật

- Thông tin đăng nhập và API key được lưu cục bộ trong Windows Credential Manager, không commit `.private/` hoặc `.env`.