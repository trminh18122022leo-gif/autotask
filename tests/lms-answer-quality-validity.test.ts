/** Phase 4 — Answer Quality Benchmark Validity, Independent Essay Rubric & Calibration Suite
 * Verifies separation of objective exact-match accuracy from open-ended essay concept-rubric scoring,
 * misconception rejection, mandatory human essay review, confidence calibration (ECE & Wilson 95% CI),
 * abstention tracking, and honest NOT TESTED reporting without BYOK keys.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanQuestions } from '../src/scanner.js';
import {
  computeConfidenceCalibration,
  computeWilson95CI,
  evaluateAnswerQuality,
  evaluateEssayWithIndependentRubric,
  type GoldPracticeKey,
  type IndependentEssayRubric
} from '../src/evaluation/answer-quality.js';
import {
  buildPermittedSelfPracticeHtml,
  runRealModelPracticeBenchmark
} from '../src/evaluation/real-model-benchmark.js';

describe('Phase 4 — Answer Quality Benchmark Validity & Independent Essay Rubric (AQV-01..04)', () => {

  const BINARY_SEARCH_RUBRIC: IndependentEssayRubric = {
    rubricId: 'binary-search-rubric',
    minWordCount: 5,
    requiredConcepts: [
      {
        conceptId: 'sorted-input',
        description: 'Requires sorted/ordered input array',
        acceptedPatterns: [/\bsorted\b/i, /\bordered\b/i, /\bmonotonic/i]
      },
      {
        conceptId: 'log-time',
        description: 'Worst-case O(log n) / logarithmic time',
        acceptedPatterns: [/o\s*\(\s*log(?:_?2)?\s*n\s*\)/i, /\blogarithmic\b/i]
      }
    ],
    forbiddenMisconceptions: [
      {
        reason: 'Falsely claims unsorted arrays are supported',
        pattern: /\bworks\s+on\s+unsorted\b|\bunsorted\s+array\s+is\s+valid\b/i
      }
    ]
  };

  test('AQV-01: Paraphrased open-ended essay passes independent non-LLM concept rubric while exactMatch=false and requiresHumanReview=true', async () => {
    const { chromium } = await import('playwright');
    const { openHtml } = await import('./fixtures/browser-harness.js');
    const browser = await chromium.launch({ headless: true });
    const html = `<!DOCTYPE html><html><head><meta name="generator" content="Moodle 4.3"></head>
      <body id="page-mod-quiz-attempt" class="path-mod-quiz moodle">
        <div id="question-1-1" class="que shortanswer"><div class="formulation">
          <div class="qtext"><p>What standard port does HTTPS use?</p></div>
          <div class="ablock"><input type="text" name="q1:1_answer"></div>
        </div></div>
        <div id="question-1-2" class="que essay"><div class="formulation">
          <div class="qtext"><p>Explain binary search precondition and worst-case complexity.</p></div>
          <div class="ablock"><textarea name="q1:2_answer" rows="3"></textarea></div>
        </div></div>
      </body></html>`;

    const page = await openHtml(browser, 'https://lms.hust.edu.vn/mod/quiz/attempt.php?attempt=1&page=0', html);
    try {
      const questions = await scanQuestions(page);
      assert.equal(questions.length, 2);

      const goldById: Record<string, GoldPracticeKey> = {
        m1: { text: '443' },
        m2: {
          isOpenEndedEssay: true,
          text: 'Binary search requires a sorted array and runs in O(log n) worst-case time.',
          essayRubric: BINARY_SEARCH_RUBRIC
        }
      };

      // Paraphrased wording: differs from exact gold string, expresses both required concepts accurately
      const paraphrasedPayload = {
        answers: [
          { id: 'm1', text: '443', confidence: 0.96 },
          {
            id: 'm2',
            text: 'The elements must already be ordered in ascending or descending sequence, yielding logarithmic worst-case complexity.',
            confidence: 0.85
          }
        ]
      };

      const report = await evaluateAnswerQuality({
        extractionMatched: 2,
        extractionExpected: 2,
        evaluatedTypeCatalog: [
          { type: 'moodle:shortanswer', supported: true },
          { type: 'moodle:essay', supported: true }
        ],
        pageRuns: [{ target: page, questions, rawModelPayload: paraphrasedPayload, goldById }],
        completionCases: []
      });

      const essayItem = report.items.find(i => i.id === 'm2')!;
      assert.equal(essayItem.evaluationCategory, 'open_ended_essay');
      assert.equal(essayItem.exactMatch, false, 'Paraphrased essay is NOT an exact string match');
      assert.equal(essayItem.essayRubricResult?.passed, true, 'Independent concept rubric recognizes valid paraphrase');
      assert.equal(essayItem.goldCorrect, true);
      assert.equal(essayItem.requiresHumanReview, true, 'Open-ended essay MUST always require human review');

      assert.equal(report.metrics.objectiveTotalCount, 1);
      assert.equal(report.metrics.objectiveCorrectCount, 1);
      assert.equal(report.metrics.objectiveAnswerCorrectness, 1.0);
      assert.equal(report.metrics.essayEvaluation.essaySampleCount, 1);
      assert.equal(report.metrics.essayEvaluation.essayExactMatchCount, 0);
      assert.equal(report.metrics.essayEvaluation.essayIndependentRubricPassCount, 1);
      assert.equal(report.metrics.essayEvaluation.essayHumanReviewRequiredCount, 1);
      assert.ok(report.metrics.statisticalLimitations.length >= 3);
    } finally {
      await page.context().close();
      await browser.close();
    }
  });

  test('AQV-02: Independent essay rubric rejects incomplete answers and factual misconceptions even when keywords appear', () => {
    const incomplete = evaluateEssayWithIndependentRubric(
      'Binary search requires a sorted array to divide the search interval.',
      BINARY_SEARCH_RUBRIC
    );
    assert.equal(incomplete.passed, false);
    assert.deepEqual(incomplete.missingConceptIds, ['log-time']);
    assert.equal(incomplete.requiresHumanReview, true);

    const misconception = evaluateEssayWithIndependentRubric(
      'Binary search requires a sorted list in theory, works on unsorted arrays too, and takes O(log n) time.',
      BINARY_SEARCH_RUBRIC
    );
    assert.equal(misconception.passed, false);
    assert.equal(misconception.triggeredMisconceptions.length, 1);
    assert.equal(misconception.requiresHumanReview, true);
  });

  test('AQV-03: Confidence calibration computes ECE, mean confidence on correct vs wrong, abstention rate, and Wilson 95% CI', () => {
    const ci = computeWilson95CI(18, 18);
    assert.ok(ci);
    assert.equal(ci.upper, 1);
    assert.ok(ci.lower > 0.78 && ci.lower < 0.86, `Expected finite-sample lower bound ~0.824 for 18/18, got ${ci.lower}`);

    const cal = computeConfidenceCalibration({
      observations: [
        { confidence: 0.95, correct: true, abstained: false },
        { confidence: 0.90, correct: false, abstained: false }, // overconfident wrong
        { confidence: 0.50, correct: false, abstained: false },
        { confidence: undefined, correct: false, abstained: true } // abstained
      ],
      objectiveCorrectCount: 1,
      objectiveTotalCount: 4
    });

    assert.equal(cal.abstentionCount, 1);
    assert.equal(cal.abstentionRate, 0.25);
    assert.equal(cal.overconfidentWrongCount, 1);
    assert.equal(cal.meanConfidenceOnCorrect, 0.95);
    assert.ok(cal.meanConfidenceOnWrong !== null && Math.abs(cal.meanConfidenceOnWrong - 0.7) < 1e-9);
    assert.ok(cal.expectedCalibrationError !== null && cal.expectedCalibrationError > 0.3);
    assert.ok(cal.objectiveWilson95CI !== null);
  });

  test('AQV-04: Real-Model Practice Benchmark separates 18 objective items + 2 concept-rubric essays and reports NOT TESTED without BYOK', async () => {
    const { specs } = buildPermittedSelfPracticeHtml();
    assert.equal(specs.length, 20);
    const essays = specs.filter(s => s.gold.isOpenEndedEssay);
    const objectives = specs.filter(s => !s.gold.isOpenEndedEssay);
    assert.equal(objectives.length, 18);
    assert.equal(essays.length, 2);
    for (const e of essays) {
      assert.ok(e.gold.essayRubric, `Essay ${e.id} must define an independent non-LLM concept rubric`);
      assert.equal(e.requiresHumanEssayReview, true);
    }

    const res = await runRealModelPracticeBenchmark(['__unconfigured_byok_profile__']);
    assert.equal(res.status, 'NOT TESTED');
    assert.equal(res.sampleCount, 20);
    assert.equal(res.objectiveSampleCount, 18);
    assert.equal(res.essaySampleCount, 2);
    assert.ok(res.statisticalLimitations.length >= 3);
    assert.deepEqual(res.models, []);
  });
});
