# AutoTask AI v1.1.6 — English Discoveries Real Operational Results
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Target Platform:** English Discoveries (Web Edition 2024+)  
**Status:** SANDBOX_PASS (100%) — LIVE INSTITUTIONAL PILOT: NOT_TESTED / BLOCKED  

---

## 1. Platform Architecture & Access Status

- **Live Institutional Access:** Designated as **`NOT_TESTED / BLOCKED (CREDENTIALS_REQUIRED)`** because active student credentials and institution tokens are not configured in Account Vault.
- **In-Memory & Browser Smoke Baseline:** **`SANDBOX_PASS (100%)`** in `tests/english-discoveries.test.ts` and `npm run smoke:local`.

---

## 2. Question & Exercise Capability Breakdown

| Exercise Format | DOM Recognition Pattern | Input Mechanism | Verification Gate | Sandbox Status | Live Status |
|---|---|---|---|:---:|:---:|
| **Multiple Choice** | Standard radio list | Native click | `checked === true` audit | `SANDBOX_PASS` | `NOT_TESTED` |
| **Cloze Dropdown** | `<select>` gap fill | Option selection | `selectedIndex` check | `SANDBOX_PASS` | `NOT_TESTED` |
| **Short Text Entry** | `input[type="text"]` | Typing + event dispatch | `value` string check | `SANDBOX_PASS` | `NOT_TESTED` |
| **Reading Comprehension** | Text passage + prompt | Scoped prompt extraction | Schema verification | `SANDBOX_PASS` | `NOT_TESTED` |
| **Vocal / Speech Recording** | Audio player + mic button | Speech recording widget | **HALTS** (`WAITING_FOR_USER`) | `SANDBOX_PASS` | `NOT_TESTED` |

---

## 3. Human Handoff for Audio/Speech Exercises

English Discoveries practice units frequently include speech recording tasks (pronunciation grading via microphone).

AutoTask AI strictly enforces the hardware boundary:
1. When an audio recording widget or speech exercise is detected (`hasSpeechInput === true`), the agent **refuses to fabricate or bypass audio input**.
2. Execution pauses immediately with status `WAITING_FOR_USER`.
3. The operator is notified via the Command Deck to speak into the workstation microphone and complete the exercise.
4. Once the web application confirms the recorded audio, the agent resumes automated navigation.

---

## 4. FORM_FILE Immunity Guarantee

Under no circumstances will a stored form file override AI processing on English Discoveries exercises:
- Confirmed by `tests/ai-primary-routing.test.ts` (Test 4: `form file does not override English Discoveries or FAMI exercises`).
- All exercise units resolve strictly to `AI_PRIMARY` or manual human completion.
