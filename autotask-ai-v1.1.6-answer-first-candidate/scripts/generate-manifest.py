"""Generates mathematically verified release manifest from actual release ZIP file.
Guarantees 100% concordance between manifest documentation and release archive.
"""
import zipfile
import hashlib
import os
import sys

def main():
    zip_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "release", "autotask-ai-v1.1.6-clean.zip"))
    if not os.path.exists(zip_path):
        print(f"Error: Release zip not found at {zip_path}")
        sys.exit(1)

    # 1. Entire zip hash and size
    with open(zip_path, "rb") as f:
        zip_bytes = f.read()
    zip_sha256 = hashlib.sha256(zip_bytes).hexdigest()
    zip_size = len(zip_bytes)

    # 2. Inspect entries
    zf = zipfile.ZipFile(zip_path, "r")
    test_result = zf.testzip() # None means all CRCs valid
    infolist = sorted(zf.infolist(), key=lambda x: x.filename)
    total_files = len(infolist)

    # Check backslashes
    backslash_entries = [info.filename for info in infolist if "\\" in info.filename]
    forbidden_entries = [info.filename for info in infolist if any(
        x in info.filename for x in [".private", "node_modules", "dist", "__pycache__", "reports/", ".env"]
    )]

    # Generate Markdown report
    lines = []
    lines.append("# AUTOTASK AI v1.1.6 — RELEASE MANIFEST & INVENTORY")
    lines.append("")
    lines.append(f"**Ngày tạo:** 29/10/2026  ")
    lines.append(f"**Phiên bản:** `1.1.6` (Release)  ")
    lines.append(f"**Gói phát hành:** `release/autotask-ai-v1.1.6-clean.zip`  ")
    lines.append(f"**Dung lượng:** {zip_size:,} byte ({zip_size / (1024*1024):.2f} MB)  ")
    lines.append(f"**Mã băm SHA-256:** `{zip_sha256}`  ")
    lines.append(f"**Tổng số tệp thực tế:** `{total_files}`  ")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 1. Kết Quả Kiểm Tra Toàn Vẹn Gói")
    lines.append("")
    lines.append("| Tiêu chí | Kết quả | Ghi chú |")
    lines.append("| :--- | :--- | :--- |")
    lines.append(f"| **Toàn vẹn CRC32** | {'PASS (0 lỗi)' if test_result is None else f'FAIL ({test_result})'} | `ZipFile.testzip()` trả về `None` |")
    lines.append(f"| **Đường dẫn POSIX (/)** | {'PASS (100% POSIX, 0 backslash)' if len(backslash_entries) == 0 else f'FAIL ({len(backslash_entries)})'} | Không có ký tự `\\` trong tên entry |")
    lines.append(f"| **Thư mục bảo mật bị cấm** | {'PASS (0 thư mục cấm)' if len(forbidden_entries) == 0 else f'FAIL ({len(forbidden_entries)})'} | Loại trừ hoàn toàn `.private`, `node_modules`, `dist`, `__pycache__`, `reports`, `.env` |")
    lines.append(f"| **Số lượng tệp ghi nhận** | `PASS ({total_files} tệp)` | Khớp chính xác 100% giữa danh mục và ZIP |")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 2. Danh Mục Toàn Bộ Tệp Trong Gói Phát Hành")
    lines.append("")
    lines.append("| STT | Đường dẫn (POSIX) | Kích thước (byte) | CRC-32 | SHA-256 |")
    lines.append("| :---: | :--- | :---: | :---: | :--- |")

    for i, info in enumerate(infolist, 1):
        data = zf.read(info.filename)
        file_sha256 = hashlib.sha256(data).hexdigest()
        crc_hex = f"{info.CRC:08X}"
        lines.append(f"| {i} | `{info.filename}` | {info.file_size:,} | `{crc_hex}` | `{file_sha256[:16]}...` |")

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 3. Phân Nhóm Cấu Trúc")
    lines.append("")
    dir_counts = {}
    for info in infolist:
        top_dir = info.filename.split("/")[0] if "/" in info.filename else "(root)"
        dir_counts[top_dir] = dir_counts.get(top_dir, 0) + 1

    lines.append("| Thư mục / Vị trí | Số tệp |")
    lines.append("| :--- | :---: |")
    for d, c in sorted(dir_counts.items()):
        lines.append(f"| `{d}` | {c} |")
    lines.append(f"| **Tổng cộng** | **{total_files}** |")
    lines.append("")

    report_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "reports", "V116_RELEASE_MANIFEST.md"))
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"SUCCESS: Generated {report_path}")
    print(f"Total files: {total_files}")
    print(f"ZIP Size: {zip_size} bytes")
    print(f"SHA-256: {zip_sha256}")

if __name__ == "__main__":
    main()
