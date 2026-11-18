# AutoTask AI v1.1.6 — Moodle / HUSTLMS Operational Results
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Target Platform:** Moodle LMS 3.9 — 4.5+ (HUSTLMS architecture, Boost & Classic themes)  
**Status:** SANDBOX VALIDATED (100%) — LIVE INSTITUTIONAL PILOT: BLOCKED / NOT TESTED  

---

## 1. Operational Scope & Access Classification

> [!IMPORTANT]
> **ACCESS CONTROL & COMPLIANCE NOTICE:**  
> In compliance with institutional policies and release guidelines:
> - **Live Institutional Production Attempts (`hust.edu.vn`):** Designated as `BLOCKED / NOT TESTED (CREDENTIALS_REQUIRED)` because student login credentials and CAS/SSO authentication are not pre-packaged into this candidate workstation.
> - **Standard Moodle 3.9 — 4.5+ Boost/Classic Architecture:** Validated with 100% pass rates across full-featured HTTP live sandboxes and Chromium DOM suites.

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
| **MCQ (Single)** | `.que.multichoice` | Radio input click | Post-click checked readback | **PASS** | `BLOCKED / NOT TESTED` |
| **MCQ (Multi)** | `.que.multichoice` | Checkbox toggle | Checked state readback | **PASS** | `BLOCKED / NOT TESTED` |
| **Short Answer** | `input[type="text"]` | Typing + `input` dispatch | Value attribute inspection | **PASS** | `BLOCKED / NOT TESTED` |
| **Essay / Rich Text** | Atto Editor, TinyMCE | Text injection + event sync | Hidden textarea sync check | **PASS** | `BLOCKED / NOT TESTED` |
| **Drag & Drop into Text** | `qtype_ddwtos` gap slots | Playwright dragTo / keyboard slot entry | Slot boundary input check | **PASS** | `BLOCKED / NOT TESTED` |
| **Drag & Drop onto Image** | `qtype_ddimageortext` drop zones | Coordinate-based dragTo | Zone boundary & item match | **PASS** | `BLOCKED / NOT TESTED` |
| **Draggable Markers** | `qtype_ddmarker` coords | Coordinate offset drop | Dropped marker coords check | **PASS** | `BLOCKED / NOT TESTED` |
| **Ordering Questions** | `qtype_ordering` sortable list | Sequential drag permutation | Exact sequence DOM readback | **PASS** | `BLOCKED / NOT TESTED` |
| **CodeRunner Draft** | Ace, CodeMirror, Textarea | Editor API bridge / textarea sync | Textarea value (no submit) | **PASS** | `BLOCKED / NOT TESTED` |
| **Moodle File Manager** | `.filemanager`, `.fp-content` | Repository AJAX upload bridge | Authoritative server readback (ACK-01..14) | **PASS** | `BLOCKED / NOT TESTED` |
| **KaTeX / MathJax** | `annotation[encoding="application/x-tex"]` | Direct raw TeX extraction | Clean LaTeX passed to AI | **PASS** | `BLOCKED / NOT TESTED` |
| **MathML Native** | `<math>` with `<mfrac>`, `<msqrt>` | Native MathML subset conversion | TeX representation to AI | **PASS** | `BLOCKED / NOT TESTED` |
| **Visual / Diagrams** | `<img>`, `<canvas>`, `<svg>` | Question screenshot cropping | Vision model grounding | **PASS** | `BLOCKED / NOT TESTED` |

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
