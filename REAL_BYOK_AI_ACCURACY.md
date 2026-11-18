# AutoTask AI v1.1.6 — Real BYOK AI Model Accuracy & Evaluation Benchmark
**Date:** 2026-11-01  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Benchmark Runner:** `scripts/run-real-model-benchmark.ts`  
**Execution Status:** **REAL BYOK MODEL ACCURACY: NOT TESTED (OFFICIAL HONEST DISCLOSURE)**  

---

## 1. Official Accuracy Declaration & Release Transparency

> [!IMPORTANT]
> **REAL BYOK MODEL ACCURACY: NOT TESTED**  
> In accordance with strict empirical release integrity standards:
> 1. Synthetic test responder results (such as `AQB-01` to `AQB-04` in `tests/answer-quality-benchmark.test.ts`) evaluate DOM extraction, schema validation, and answer injection plumbing only.
> 2. Because live production API keys (Gemini, Claude, OpenAI) are **not bundled** in this candidate release and must be provided by the operator via Windows Credential Manager (`WinVaultKeyring`), **no real-world AI reasoning accuracy percentage is claimed or fabricated**.
> 3. Scripted or simulated mock responders are strictly prohibited in the Real-Model Practice Benchmark.
> 4. Synthetic test pass rates (e.g. 516/516 unit tests or 100% fixture parsing) must never be reported or interpreted as real-world AI model reasoning accuracy.

---

## 2. Official Benchmark Runner Execution & Raw Telemetry

The official evaluation harness was executed from the workspace root against the candidate source:

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

## 3. Evaluation Categories & Benchmark Methodology

When an operator configures an authorized BYOK API key in the Model Center (Menu [5]), the benchmark harness evaluates the model across 6 distinct assessment domains:

| Assessment Category | Item Count | Target Skill & Format | Evaluation Method | Key Quality Metrics |
|---|:---:|---|---|---|
| **1. Multiple Choice** | 6 | Single choice, multi-select, True/False | Exact match against gold keys after option shuffle | Accuracy, option order resilience |
| **2. Short Answer** | 4 | Text fill, numerical, cloze-text | String normalization, numerical tolerance bounds | Exact match, unit precision |
| **3. Mathematics & Formulas** | 3 | TeX formula generation, MathML translation | LaTeX semantic equivalence parser | Syntax validity, TeX accuracy |
| **4. Visual & Multi-Modal** | 2 | Diagrams, graphs, coordinate geometry | Screenshot-based visual grounding | Visual comprehension accuracy |
| **5. Programming & CodeRunner** | 3 | Python, C++, SQL drafts | Syntax validation, offline unit test execution | Code compilation and correctness |
| **6. Language & Humanities** | 2 | Reading comprehension, sentence ordering | Passage contextual reasoning & sequence check | Comprehension, sequence logic |

---

## 4. Telemetry Metrics Captured During Live Pilot Benchmark

When executed with active BYOK credentials, the harness records:
1. **Exact-Match Accuracy:** Percentage of objective items matching independent human-authored keys.
2. **Concept Rubric Pass Rate:** Essay evaluation based on required deterministic concept keywords.
3. **Indeterminacy / Abstention Rate:** Questions where the model declined to answer due to low confidence.
4. **End-to-End Latency:** Round-trip response time from query submission to structured JSON answer.
5. **API Failure Rate:** Incidence of HTTP 429 (rate limiting) or 503 (service unavailable).
6. **Token Consumption & Cost:** Total input/output tokens per question.
7. **Consistency:** Determinism across multiple queries with identical temperature.
8. **Wilson 95% Confidence Interval:** Statistical bounds calculated to account for sample size limitations ($n=20$).

---

## 5. Statistical Governance & Integrity Guardrails

- **Zero Self-Grading:** Benchmark items and answer keys are human-authored (`src/evaluation/real-model-benchmark.ts`); zero items are generated or graded by any evaluated AI model.
- **Calibration Auditing:** Model self-reported confidence is audited via 5-bin Expected Calibration Error (ECE) to detect overconfidence anomalies.
- **Mandatory Review:** Open-ended essay responses generated by AI models are flagged as requiring operator review before any LMS submission.
