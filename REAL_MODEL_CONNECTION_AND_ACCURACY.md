# AutoTask AI v1.1.6 — Real Model Connection & Accuracy Benchmark
**Audit Date:** 2026-11-06 (Phase 8D Update)  
**Candidate Archive:** `release/autotask-ai-v1.1.6-ai-primary-advanced-moodle-candidate.zip`  
**Candidate SHA-256:** `f0017eb7b27331ca20e5844efbc8d0b2a88e56a33d01fb3c46b21fbf16d91481`  
**Benchmark Runner:** `scripts/run-real-model-benchmark.ts`  
**Operational Status:** **`PASS — REAL MODEL BENCHMARK VERIFIED`**  
**Configured Profile ID:** `prf_1_gem_vnguyen`  
**Evaluated Model ID:** `gemini-3.1-flash-lite` (Provider: `gemini`, Official Google API Endpoint)  
**Verification Category:** **`VERIFIED`**  

---

## 1. Live Provider Connection Test

A live, unmocked connection test was executed against the Google Gemini API using the operator's securely configured key stored in the Windows DPAPI Vault (`WinVaultKeyring`):

```powershell
# Executed via Model Center tester
testConnection({ provider: 'gemini', kind: 'gemini', model: 'gemini-3.1-flash-lite', ... })
```

### Telemetry Recorded:
- **HTTP Status:** `200 OK` (`VERIFIED`)
- **Round-Trip Latency:** `1667 ms` (`VERIFIED`)
- **Connection Category:** `SUCCESS` (`VERIFIED`)
- **Credential Storage:** Windows DPAPI Vault (zero plaintext keys in JSON or logs) (`VERIFIED`)

---

## 2. Official Real Model Benchmark Execution & Raw Telemetry

The official human-authored benchmark harness was executed against the live model profile:

```powershell
npx tsx scripts/run-real-model-benchmark.ts
```

### Empirical Telemetry Output:
```json
{
  "executedAt": "2026-11-05T17:15:43.275Z",
  "status": "PASS",
  "reason": "Evaluated 1 live configured model profile(s) on 20 permitted self-practice items (18 objective + 2 open-ended essays).",
  "sampleCount": 20,
  "objectiveSampleCount": 18,
  "essaySampleCount": 2,
  "goldKeyProvenance": "Independent human-authored 20-item CS/Math/Science self-practice benchmark (18 objective exact-key items + 2 deterministic concept-rubric essays in src/evaluation/real-model-benchmark.ts); zero items generated or graded by any evaluated AI model.",
  "statisticalLimitations": [
    "Small benchmark sample size (total n=20: objective n=18, open-ended essay n=2); inspect Wilson 95% confidence interval rather than treating point accuracy as universal.",
    "Objective exact-match accuracy (n=18) and open-ended essay concept-rubric pass rate (n=2) are reported separately; essay responses ALWAYS require human review before LMS submission.",
    "Self-reported model confidence is uncalibrated raw model output and is audited via 5-bin Expected Calibration Error (ECE) and overconfident-error counts, never trusted as correctness."
  ],
  "models": [
    {
      "status": "TESTED",
      "profileId": "prf_1_gem_vnguyen",
      "provider": "gemini",
      "modelId": "gemini-3.1-flash-lite",
      "sampleCount": 20,
      "objectiveSampleCount": 18,
      "objectiveCorrectCount": 18,
      "objectiveExactMatchAccuracy": 1,
      "essayEvaluation": {
        "essaySampleCount": 2,
        "essayExactMatchCount": 0,
        "essayIndependentRubricEvaluatedCount": 2,
        "essayIndependentRubricPassCount": 2,
        "essayHumanReviewRequiredCount": 2
      },
      "correctCount": 20,
      "overallAccuracy": 1,
      "wrongCount": 0,
      "abstentionCount": 0,
      "abstentionRate": 0,
      "overconfidentWrongCount": 0,
      "confidenceCalibration": {
        "objectiveWilson95CI": {
          "lower": 0.8241,
          "upper": 1
        }
      }
    }
  ]
}
```

---

## 3. Breakdown by Question Domain & Evaluation Methodology

| Assessment Category | Item Count | Target Skill & Format | Scoring Method | Correct | Accuracy |
|---|:---:|---|---|:---:|:---:|
| **Single Choice** | 2 | Multiple choice (single selection) | Objective exact match | 2/2 | 100% |
| **Multiple Choice** | 2 | Multi-select checkboxes | Objective exact match | 2/2 | 100% |
| **True / False** | 2 | Boolean assertion | Objective exact match | 2/2 | 100% |
| **Short Answer** | 2 | Text string normalization | Objective exact match | 2/2 | 100% |
| **Numerical** | 2 | Number fill with tolerance | Objective exact match | 2/2 | 100% |
| **Mathematics & Formulas** | 2 | LaTeX TeX equivalence | Objective exact match | 2/2 | 100% |
| **Matching Questions** | 3 | Key-value pairing | Objective exact match | 3/3 | 100% |
| **Cloze Text / Select** | 3 | Embedded gap fill & select | Objective exact match | 3/3 | 100% |
| **Essay (Textarea & Atto)** | 2 | Open-ended conceptual synthesis | Independent concept rubric | 2/2 | 100%* |

*\*Note: Both essay questions passed deterministic rubric evaluation and are explicitly flagged with `essayHumanReviewRequiredCount: 2`. In accordance with release governance, AI-drafted essay responses ALWAYS require human review before LMS submission.*

---

## 4. Statistical Validity & Conclusion

- **Objective Exact Match Accuracy:** 100% (18/18 items; Wilson 95% Confidence Interval: `[0.8241, 1.0000]`).
- **Abstention Rate:** 0% (model answered all items).
- **Overconfident Errors:** 0 items.
- **Audit Verdict:** The real BYOK model requirement is officially **RESOLVED AND VERIFIED**.
