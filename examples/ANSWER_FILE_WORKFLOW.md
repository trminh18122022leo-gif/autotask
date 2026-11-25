# AutoTask AI — AI-first workflow, optional form files

**Default:** `answerSourceMode: "AI_PRIMARY"`. The configured AI (ModelRouter) is the primary resolver for *every supported question*. If the user has previously saved a form-data file, it is **ignored** in this mode. No answer from the file silently overrides AI.

## Optional form data mode

Choose `answerSourceMode: "FORM_FILE"` **only when filling a general form using pre-existing form data**. The application uses exact field/prompt matching from the selected file, with AI for unmatched fields. For Moodle quizzes, English Discoveries activities and FAMI activities, the AI solver remains primary even if a form file was selected.

Example in `.private/browser-task.json`:

```json
{
  "answerSourceMode": "FORM_FILE",
  "answerFilePaths": ["C:/Users/Admin/Documents/form-data.xlsx"]
}
```

Or set `"answerSourceMode": "FORM_FILE"` within one task only. Task-level `AI_PRIMARY` can override the global setting.

Supported optional form-data files: JSON, CSV, TSV, TXT, MD, XLSX, DOCX, and text-based PDF. XLSX/DOCX/PDF import requires Python libraries `openpyxl`, `python-docx`, `pypdf` and a configured Python interpreter. The importer does not execute macros or spreadsheet formulas and does not OCR scanned PDFs. These inputs should have Question/Answer or field/value columns, Q:/A: pairs, or two-column Word tables. Image PDFs require manual conversion to text first.

The form data file is **not** an accuracy guarantee. Duplicate or ambiguous matches are never guessed. Choice fields are matched to current choice text rather than shuffled A/B/C position. Local files are only uploaded from paths explicitly provided in a form-data file, where an ordinary HTML file input is supported.

## Run and submission

- In Terminal choose `AI_PRIMARY` (default) or `FORM_FILE` for the run. No form-data file is needed in `AI_PRIMARY`.
- Authentication challenges: user supplies a CAPTCHA/OTP through the website or through a site-configured terminal input; no bypass and no storage of codes.
- `CHECK` to review, `SUBMIT <taskId>` for a final authorized action, or Enter to keep a draft. Completion or accuracy is not implied solely by a successful DOM fill.

**Limitations:** Proprietary Moodle AJAX File Manager upload, web-research agent with citations, full Windows E2E, and live LMS/model quality measurements are not completed by this source patch. Only run on permitted practice/form workflows and respect access policies.
