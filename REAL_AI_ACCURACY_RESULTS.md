# AutoTask AI v1.1.6 — Real AI Model Accuracy & Evaluation Benchmark
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Runner:** `scripts/run-real-model-benchmark.ts`  
**Status:** REAL BYOK MODEL ACCURACY: NOT TESTED (OFFICIAL HONEST DISCLOSURE)  

---

## 1. Official Accuracy Declaration

> [!IMPORTANT]
> **REAL BYOK MODEL ACCURACY: NOT TESTED**  
> In accordance with strict empirical release integrity standards:
> 1. Synthetic test responder results (such as `AQB-01` to `AQB-04` in `tests/answer-quality-benchmark.test.ts`) are evaluated exclusively for DOM scraping and readback verification.
> 2. Because live production API keys (Gemini, Claude, OpenAI) are not bundled in this candidate release and must be provided by the operator via Windows Credential Manager (`WinVaultKeyring`), **no real-world AI reasoning accuracy percentage is claimed or fabricated**.
> 3. Scripted or simulated model responders are strictly prohibited in the Real-Model Practice Benchmark.

---

## 2. Official Benchmark Runner Output

The official benchmark runner was executed from the workspace root:

```powershell
npx tsx scripts/run-real-model-benchmark.ts
```

### Raw Telemetry Output:
```json
{
  "executedAt": "2026-11-01T15:19:12.748Z",
  "status": "NOT TESTED",
  "reason": "No live AI model profile / BYOK API key is configured in .private/model-profiles.json or OS Credential Vault on this workstation. Scripted responders are strictly prohibited in Real-Model Practice Benchmark.",
  "sampleCount": 20,
  "objectiveSampleCount": 18,
  "essaySampleCount": 2,
  "goldKeyProvenance": "Independent human-authored 20-item CS/Math/Science self-practice benchmark (18 objective exact-key items + 2 deterministic concept-rubric essays in src/evaluation/real-model-benchmark.ts); zero items generated or graded by any evaluated AI model.",
  "statisticalLimitations": [
    "Small benchmark sample size (total n=20: objective n=18, open-ended essay n=2); inspect Wilson 95% confidence interval rather than treating point accuracy as universal.",
    "Objective exact-match accuracy (n=18) and open-ended essay concept-rubric pass rate (n=2) are reported separately; essay responses ALWAYS require human review before LMS submission.",
    "Self-reported model confidence is uncalibrated raw model output and is audited via 5-bin Expected Calibration Error (ECE) and overconfident-error counts, never trusted as correctness."
  ],
  "models": []
}
```

---

## 3. Evaluation Categories & Methodology

When the operator configures a live BYOK key in Model Center (Menu [5]), the benchmark harness evaluates the model across 6 categories:

| Category | Item Count | Format & Target Skill | Evaluation Method | Key Metrics |
|---|:---:|---|---|---|
| **1. Multiple Choice** | 6 | Single choice, multi-select, True/False | Exact match against gold keys after option shuffle | Accuracy, shuffle resilience |
| **2. Short Answer** | 4 | Text fill, numerical, cloze-text | String normalization, numerical tolerance | Exact match, unit precision |
| **3. Mathematics & Formulas** | 3 | TeX formula generation, MathML translation | Exact LaTeX semantic equivalence | Syntax validity, TeX accuracy |
| **4. Visual & Multi-Modal** | 2 | Diagrams, graphs, geometry | Screenshot-based visual grounding | Visual comprehension |
| **5. Programming & CodeRunner** | 3 | Python, C++, SQL drafts | Syntax validation, test case execution | Code correctness (no submit clicked) |
| **6. Language & Humanities** | 2 | Reading comprehension, sentence ordering | Passage contextual reasoning | Comprehension, sequence logic |

---

## 4. Telemetry Metrics Captured During BYOK Benchmark

For each evaluated model profile, the harness captures:
- **Exact Match Accuracy:** Percentage of objective items matching human-authored keys.
- **Indeterminacy / Abstention Rate:** Questions where the model declined to answer due to uncertainty.
- **End-to-End Latency:** Round-trip response time from query to validated JSON answer.
- **API Failure Rate:** Incidence of HTTP 429 (rate limits) or 503 (transient overload).
- **Token Efficiency:** Cost and token consumption per attempt.
- **Consistency:** Determinism across multiple queries with identical temperature.
- **Wilson 95% Confidence Interval:** Statistical bounds calculated to account for sample size limitations.
