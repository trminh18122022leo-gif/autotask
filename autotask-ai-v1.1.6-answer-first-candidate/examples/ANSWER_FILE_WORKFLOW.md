# AutoTask AI – answer-first workflow (candidate patch)

Use only with forms and practice activities where you are permitted to automate and use AI.

## Setup

- Set `answerFilePaths` in `.private/browser-task.json`, e.g. `["]` is INVALID; example: `"answerFilePaths": ["C:/Users/Admin/Answers/answers.json"]`.
- Or run `npm run browser`: after `ACCEPT`, enter a local answer-file path in Terminal. The Setup wizard also accepts one path.
- Per-task overrides/additions: `"answerFilePaths": ["C:/Users/Admin/Answers/quiz-1.csv"]` under that task.
- Supported answer-bank formats: `.json`, `.csv`, `.tsv`, `.txt`, `.md` (UTF-8); not yet native Excel/PDF/DOCX extraction. Use CSV or JSON export.
- Rows match **exact** `stableId`, `id`, or normalized prompt. For choice questions, use full answer *text* or a current ID, not fixed letters A/B/C after shuffling.
- `filePath` can point to an explicitly chosen local document (relative to the answer-bank file or absolute). Standard `<input type=file>` upload is supported; proprietary Moodle File Manager still needs its own adapter.
- No automatic upload from a model-proposed local path. Invalid or ambiguous answers fall back to AI rather than guessing.

## Terminal flow

1. The agent reads the answer file, fills matches, and asks its configured AI model for missing items only.
2. Authentication challenge: on a visible CAPTCHA/OTP/SSO page, user manually reads the challenge in Chromium, enters it there and presses Enter in Terminal. If a task specifies unique `challengeInputSelector` and `challengeVerifySelector`, the user may enter the manually obtained text in Terminal for the agent to fill the on-page input. There is no CAPTCHA solver or MFA bypass.
3. At the end, enter `CHECK` to review in Chromium; enter `SUBMIT <taskId>` to authorize final submission without reviewing, or press Enter to keep the draft. Final submission can only be marked confirmed if a reliable site success signal exists.

This patch has offline tests; it is not a guarantee of correctness or compatibility with a live LMS, custom theme, or grading policy. Keep quiz/attempt policy, allowedHosts, origin trust, and durable consent protections enabled.
