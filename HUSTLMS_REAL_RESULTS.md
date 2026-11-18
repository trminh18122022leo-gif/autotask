# AutoTask AI v1.1.6 — Moodle / HUSTLMS Real Operational Results
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Target Platform:** Moodle LMS 3.9 — 4.5+ (HUSTLMS Architecture, Boost & Classic Themes)  
**Status:** SANDBOX_PASS (100%) — LIVE INSTITUTIONAL PILOT: BLOCKED / NOT TESTED  

---

## 1. Access & Governance Status

- **Live Production Endpoint (`hust.edu.vn`):** **`BLOCKED / NOT TESTED (CREDENTIALS_REQUIRED)`**. The agent requires active student login credentials or an established browser session in Account Vault to execute live attempts.
- **Moodle 3.9 — 4.5+ Boost/Classic Core Architecture:** **`SANDBOX_PASS (100%)`**. Validated across live Node.js HTTP servers simulating attempt pages and repository upload endpoints.

---

## 2. Five Operational States of Question Processing

AutoTask AI strictly differentiates each transition in the question fulfillment pipeline. No state is treated as automatic evidence of the subsequent state:

```
[AI_ANSWER_GENERATED] ──> [FIELD_FILLED] ──> [DOM_VERIFIED] ──> [SERVER_DRAFT_SAVED] ──> [READY_FOR_REVIEW]
```

1. **`AI_ANSWER_GENERATED`:** The BYOK AI model produces a structured answer complying with JSON schema (`AnswerSchema`).
2. **`FIELD_FILLED`:** The adapter interacts with the Playwright browser context to select radio buttons, type text, or drag items into target slots.
3. **`DOM_VERIFIED`:** Post-condition inspection checks the browser DOM (`checked === true`, `value === expected`, or marker placed) to guard against silent mutation resets.
4. **`SERVER_DRAFT_SAVED`:** Out-of-band HTTP GET readback confirms that the LMS server has persisted the draft in its database or draft storage area.
5. **`READY_FOR_REVIEW`:** All questions on the page or quiz summary are verified; the agent halts for operator inspection.

---

## 3. Question Type Capability Matrix (Moodle / HUSTLMS)

| Question Plugin | DOM Locator / Pattern | Automation Mechanism | Verification Gate | Sandbox Status | Live Status |
|---|---|---|---|:---:|:---:|
| **MCQ (Single)** | `.que.multichoice` | Radio input click | Post-click checked readback | `SANDBOX_PASS` | `NOT_TESTED` |
| **MCQ (Multi)** | `.que.multichoice` | Checkbox toggle | Checked state readback | `SANDBOX_PASS` | `NOT_TESTED` |
| **Short Answer** | `input[type="text"]` | Typing + `input` dispatch | Value attribute inspection | `SANDBOX_PASS` | `NOT_TESTED` |
| **Essay / Rich Text** | Atto Editor, TinyMCE | Text injection + event sync | Hidden textarea sync check | `SANDBOX_PASS` | `NOT_TESTED` |
| **Drag & Drop into Text** | `qtype_ddwtos` gap slots | Playwright dragTo / keyboard slot entry | Slot boundary input check | `SANDBOX_PASS` | `NOT_TESTED` |
| **Drag & Drop onto Image** | `qtype_ddimageortext` drop zones | Coordinate-based dragTo | Zone boundary & item match | `SANDBOX_PASS` | `NOT_TESTED` |
| **Draggable Markers** | `qtype_ddmarker` coords | Coordinate offset drop | Dropped marker coords check | `SANDBOX_PASS` | `NOT_TESTED` |
| **Ordering Questions** | `qtype_ordering` sortable list | Sequential drag permutation | Exact sequence DOM readback | `SANDBOX_PASS` | `NOT_TESTED` |
| **CodeRunner Draft** | Ace, CodeMirror, Textarea | Editor API bridge / textarea sync | Textarea value (no submit) | `SANDBOX_PASS` | `NOT_TESTED` |
| **Moodle File Manager** | `.filemanager`, `.fp-content` | Repository AJAX upload bridge | Authoritative server readback (ACK-01..14) | `SANDBOX_PASS` | `NOT_TESTED` |
| **KaTeX / MathJax** | `annotation[encoding="application/x-tex"]` | Direct raw TeX extraction | Clean LaTeX passed to AI | `SANDBOX_PASS` | `NOT_TESTED` |
| **MathML Native** | `<math>` with `<mfrac>`, `<msqrt>` | Native MathML subset conversion | TeX representation to AI | `SANDBOX_PASS` | `NOT_TESTED` |
| **Visual / Diagrams** | `<img>`, `<canvas>`, `<svg>` | Question screenshot cropping | Vision model grounding | `SANDBOX_PASS` | `NOT_TESTED` |

---

## 4. Explicitly Unsupported / Withheld Plugins (Fail-Closed)

The following plugins are withheld by design to protect academic integrity:
- **STACK Questions (`qtype_stack`):** Marks `UNSUPPORTED`, halts for human review.
- **Formulas Question (`qtype_formulas`):** Marks `UNSUPPORTED`.
- **WIRIS Math Editor:** Marks `UNSUPPORTED`.
- **Safe Exam Browser (SEB):** Aborts automation immediately.

---

## 5. File Manager Four-State Lifecycle

For Moodle attachment questions, AutoTask AI enforces the 4 distinct lifecycle states:
- `UPLOAD_REQUESTED` $\rightarrow$ `UPLOAD_ACKNOWLEDGED` $\rightarrow$ `UPLOAD_UNCONFIRMED` / `UPLOAD_VERIFIED`
- Server-side readback via HTTP GET to `/mod/quiz/attempt.php` is the sole authoritative proof of `UPLOAD_VERIFIED`.
