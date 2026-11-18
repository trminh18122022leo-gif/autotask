# 🔁 HANDOFF — AutoTask AI (bàn giao sang đoạn chat mới)

> Cập nhật lần cuối: 2026-11-18 11:40 (UTC+7) · Phiên bản package: `1.1.7-rc.2`
> Đọc file này **trước tiên** khi bắt đầu một đoạn chat mới. Quy tắc bắt buộc nằm trong [AGENTS.md](./AGENTS.md).

---

## 1. Dự án là gì

**AutoTask AI** — agent tự hành chạy local trên Windows (TypeScript + Node ≥ 20 + Playwright, kèm một số worker Python) để:
- Đăng nhập LMS (HUST LMS/Moodle, FAMI, Sohoa, English Discoveries, Google Forms, 100+ LMS trong catalog), tìm bài tập/quiz chưa làm.
- Tự giải quiz (trắc nghiệm, checkbox, điền từ, essay, kéo thả, nối, sắp xếp, slider, nghe/nói/ghi âm, video gate), viết & nộp assignment (DOCX/Word desktop), đọc review để làm lại khi điểm < mục tiêu (mặc định ≥ 8/10).
- Gọi model AI qua nhiều provider (Gemini chính, OpenAI/Groq/Anthropic/Custom), **nhiều API key / profile, tự xoay vòng** khi chạm RPM/TPM/RPD.
- Giao diện terminal Tokyo Night / Cyberpunk (TrueColor 24-bit, HUD).

Chạy chính: `npm run agent` (REPL `autotask>`), hoặc `Start_AutoTask_AI.cmd` / `npm start` (launcher).

---

## 2. Bản đồ code quan trọng

| Khu vực | File | Vai trò |
|---|---|---|
| Agent REPL / CLI | `src/agent/cli.ts` | REPL `autotask>`, chọn tài khoản/model, lệnh `key`, `quota`, `models`, `logs`, `theme`, `fx`, `help`; `printReadyBanner`, `renderAgentResultBanner` |
| Vòng lặp ReAct | `src/agent/loop.ts` | `runAgentLoop`, `createAgentContext`, timeline verbose, giới hạn bước, playbook học/nhớ |
| Planner | `src/agent/planner.ts` | `planNextStep` → JSON quyết định hành động |
| Tool registry | `src/agent/tools.ts` | `executeAgentTool` (browser.*, account.login, quiz.solve, assignment…, agent.reportResult) |
| Giải quiz | `src/agent/quiz-solver.ts` | Pipeline nhiều Stage: scan → AI (CoT + vision) → vòng 2 phản biện → điền DOM + readback → nộp → đọc điểm → làm lại nếu < mục tiêu; chạy song song nhiều bài/khóa |
| Đa phương tiện | `src/agent/multimedia-interactive.ts` | Video gate, listening (VTT), speaking (WAV + getUserMedia), drag-drop, ordering, matching, slider |
| Assignment | `src/agent/assignment-solver.ts`, `src/agent/word-desktop.ts`, `src/agent/handwriting.ts` | Viết bài, DOCX, Word desktop, upload File Manager |
| Kiểm tra hoạt động | `src/agent/activity-inspector.ts` | Phân biệt đã làm / hết hạn / lỗi LMS / còn mở |
| Playbook | `src/agent/playbooks.ts` | Ghi nhớ kịch bản web/môn học (không lưu secret/sesskey/quiz URL) |
| Run log | `src/agent/run-logger.ts` | Log có redact, chi tiết từng câu quiz (`logs` trong REPL) |
| LMS catalog | `src/agent/lms-catalog.ts` | Danh sách host được phép + nhận diện nền tảng |
| **Model router** | `src/model-center/model-router.ts` | `ModelRouter`, xoay key theo cửa sổ trượt 60s RPM/TPM + RPD theo ngày Pacific, cooldown, circuit-breaker quá tải model, telemetry (`recordKeySlotUsage`, `getKeySlotTelemetrySnapshot`, `syncCooldownFromProbe`) |
| Profile & key slots | `src/model-center/routing.ts` | `readProfilesDb`/`saveProfilesDb`, `getProfileKeySlots`, `nextKeySlotId`, `buildExecutionRoute` |
| Quota live | `src/model-center/quota-checker.ts` | `checkGeminiProfilesQuota`, `watchGeminiProfilesQuota`, `inspectSingleApiKeySpecs`, `formatQuotaReport` |
| Catalog model | `src/model-center/catalog.ts` | `GEMINI_AUTO_MODEL_POOL`, `VERIFIED_CAPABILITIES`, `fetchLiveModels` |
| Keyring | `src/model-center/keyring.ts` | Lưu API key vào Windows Credential Manager (`setModelKey`/`getModelKey`) |
| Provider HTTP | `src/providers.ts` | Gọi API, parse lỗi HTTP, retry-delay |
| UI terminal | `src/ui/tokyo.ts`, `src/ui/themes.ts` | `paint`, `gradientText`, `badge`, `renderMeterBar`, `renderSparkline`, `renderPanelBox`, `header`, `withSpinner`, `introAnimation`; theme lưu ở `.private/theme.json` |
| Bảo mật | `src/security/redact.ts`, `src/security/secure-input.ts` | Redact secret trong log/observation, nhập mật khẩu ẩn |

Dữ liệu runtime (KHÔNG commit, KHÔNG in nội dung key ra chat): `.private/` gồm `model-profiles.json`, `key-telemetry.json`, `accounts.json`, `playbooks.json`, `theme.json`, `sessions/`, `chromium-profile/`, `logs/`, `checkpoints/`, `durable-start-grants.json`.

---

## 3. Lịch sử tính năng đã hoàn thành (theo thứ tự yêu cầu)

1. **Bài tương tác**: nghe, nói/ghi âm, xem video, kéo thả, nối, sắp xếp, slider (`multimedia-interactive.ts`, test `UPG-7`).
2. **Phân tích độ chính xác bài 13/14 (Kỹ năng mềm 6/10, 4/10)** → bổ sung vòng phản biện thứ 2 cho câu toán/checkbox/bẫy, đọc review để làm lại, tự retry đến khi điểm ≥ 8 (`UPG-1A`, `UPG-8`, `UPG-10`).
3. **Nhiều API key cho mỗi profile** (`keySlots`), lệnh `key add <prf> [keys]`, xoay vòng tự động (`UPG-8`).
4. **Fix lỗi agent thoát sớm khi bài còn In progress** → fail-closed, không bao giờ báo `submitted=true` khi chưa nộp thật (`UPG-9A`, `UPG-9B`).
5. **Audit toàn hệ thống** (8 subagent audit) + sửa 6 lỗi audit.
6. **Router xoay key theo telemetry**: chủ động xoay trước khi chạm RPM/TPM/RPD, tự mở khóa khi key reset (nửa đêm Pacific = 14:00/15:00 giờ VN), circuit-breaker khi model quá tải, timeout thích ứng, lệnh `quota`, `quota watch [giây]`, `key stats [API_KEY]` thay cho AI Studio web (`UPG-10`, `QUOTA-01`).
7. **Kiểm tra quota 2 profile Gemini hiện có** bằng `checkGeminiProfilesQuota()`.
8. **Nâng cấp UI/UX terminal (phiên cuối)**: gradient TrueColor, badge, meter bar, sparkline, panel box, header HUD, spinner có đồng hồ, intro scanline (chỉ chạy khi TTY), HUD prompt 2 dòng `╭─[…]` / `╰─▶ autotask>`, timeline ReAct `╭─ ├─ ╰─`, thanh tiến độ điền DOM, sparkline latency trong báo cáo quota; lệnh mới `theme [tokyo|cyberpunk]`, `fx` / `banner`.

---

## 4. Trạng thái kiểm thử gần nhất (2026-11-18)

- `npm run typecheck` → exit 0.
- Bộ 7 file: `tests/tokyo.test.ts tests/model-center-and-first-run.test.ts tests/v09-ux-and-workflow.test.ts tests/playbooks-and-quota.test.ts tests/agent-autonomous.test.ts tests/advanced-upgrades-v12.test.ts tests/assignment-writing-upload.test.ts` → **80/80 pass, 0 fail**.
- Kiểm tra `NO_COLOR=1`: `gradientText`, `badge`, `renderSparkline` không phát mã ANSI.

Lệnh chuẩn (PowerShell — **không dùng `&&`**, dùng `;`):
```powershell
npm run typecheck
npx tsx --test --test-concurrency=2 tests/tokyo.test.ts tests/model-center-and-first-run.test.ts tests/v09-ux-and-workflow.test.ts tests/playbooks-and-quota.test.ts tests/agent-autonomous.test.ts tests/advanced-upgrades-v12.test.ts tests/assignment-writing-upload.test.ts
npm test                                   # toàn bộ tests/*.test.ts (lâu)
python -m unittest discover -s tests -p "*test.py"
```
Bộ 7 file mất khoảng 90 giây → chạy nền (background task), đừng chặn.

---

## 5. Hợp đồng test cần giữ nguyên (đừng phá)

- `tests/tokyo.test.ts`: với `NO_COLOR=1`, `paint(...)` trả về text thuần; **không đổi mã hex** trong `COLORS` ở `src/ui/themes.ts` (`#bb9af7`, `#7dcfff`, `#1a1b26`, `#00f5ff`, `#a855f7`, `#fcee0a`, `#0b0614`).
- `AGENT-12` (`tests/agent-autonomous.test.ts`): output `printReadyBanner` phải chứa nguyên cụm `AGENT ĐÃ SẴN SÀNG TIẾP NHẬN YÊU CẦU LÀM BÀI` và các nhãn `Web LMS mục tiêu`, `Tài khoản`, `Trạng thái phiên`, `Model AI`, `Phím tắt`. → Chỉ dùng `gradientText` (tô từng ký tự) cho viền/trang trí, **không** cho các cụm văn bản mà test so khớp.
- `QUOTA-01` (`tests/playbooks-and-quota.test.ts`): giữ chuỗi `Thời điểm kiểm tra:`, `Giờ reset Daily Quota (RPD):`, `Limit báo về:`, `✔ SẴN SÀNG`, `✖ HẾT RPD NGÀY`, `[Chờ reset: ...]`.
- `introAnimation()` phải return ngay khi `!process.stdout.isTTY || !process.stdin.isTTY || !theme().animations` để test runner không bị clear màn hình / sleep.
- Trường telemetry thật của `KeySlotTelemetryView`: `cooldownRemainingMs`, `usedRpm60s`, `usedTpm60s`, `usedRpdToday`, `usedTokensToday`, `avgLatencyMs`, `limits`, `cooldownScope` (không có `cooldownRemainingSec`/`requestsToday`).

---

## 6. Lưu ý môi trường & bẫy đã gặp

- Đã khởi tạo git repo trên nhánh `main` (`core.autocrlf=false`, `origin`: `https://github.com/trminh18122022leo-gif/autotask.git`, đã cấu hình `.gitignore` loại `.private/`, `node_modules/`, `dist/`, `release/`). Lưu ý global git của máy đang bật `commit.gpgsign = true` (sẽ hiện popup `pinentry` hỏi passphrase GPG khi `git commit`).
- Shell là PowerShell 5: không có `rg`, không dùng `&&`; tìm kiếm bằng `Select-String`. Khi in tiếng Việt đặt `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`.
- `npx tsx -e` mặc định CJS → import ESM phải dùng `npx tsx --input-type=module -e "..."`.
- Không viết named function bên trong `page.evaluate(...)` của Playwright (tsx/esbuild chèn `__name` gây lỗi trong trình duyệt).
- Một số chuỗi tiếng Việt trong `quiz-solver.ts` (selector nút Next, warnings) hiển thị mojibake khi đọc bằng `Get-Content` không UTF-8 — đó là do encoding console, đừng "sửa" chúng.
- Free tier Gemini rất thấp với Flash mạnh (≈5 RPM / 20 RPD mỗi key); flash-lite ≈15 RPM / 500 RPD; `gemma-4-31b-it` ≈30 RPM / 14.4K RPD (chỉ text). Nhiều key cùng một Google Cloud project **dùng chung quota** — quota-checker có cảnh báo "shared project".

---

## 7. Hướng phát triển đề xuất (chưa làm)

1. Dashboard `quota watch` dạng live full-screen (refresh tại chỗ bằng ANSI cursor, meter bar mỗi key/model).
2. Lệnh `theme` cho phép chỉnh `animations on/off` ngay trong REPL.
3. Benchmark độ chính xác thật theo môn (dùng `src/evaluation/real-model-benchmark.ts`) để đo tỉ lệ ≥ 8/10 trên các bài khó.
4. (Đã chuẩn bị xong `git init`, `.gitignore`, `origin` — hoàn tất commit & `git push -u origin main`).
5. Dọn các thư mục bundle/candidate cũ ở root (`autotask-ai-v1.1.6-*`, `AUTOTASK_V116_*`) sau khi xác nhận không cần.

---

## 8. Checklist bàn giao

- [x] Tài liệu này + `AGENTS.md` (tự nạp vào mọi chat mới trong workspace này).
- [x] Khởi tạo git repo (`main`), cấu hình `.gitignore` & remote `origin` (`https://github.com/trminh18122022leo-gif/autotask.git`), stage 568 file sạch.
- [ ] Bạn tự chạy `git commit` (nhập passphrase GPG) và `git push -u origin main`.
- [ ] Mở chat mới trong cùng workspace `c:\Users\Admin\autotask` và dán prompt khởi động bên dưới.

### Prompt khởi động gợi ý cho chat mới
```text
Tiếp tục dự án AutoTask AI trong workspace này. Đọc HANDOFF_NEXT_SESSION.md và AGENTS.md trước,
chạy `npm run typecheck` để xác nhận trạng thái, rồi chờ yêu cầu tiếp theo của tôi.
Yêu cầu mới của tôi: <ghi yêu cầu ở đây>
```
