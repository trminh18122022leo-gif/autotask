import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { scanQuestions } from '../src/scanner.js';
import { executeTask } from '../src/main.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import { clearCheckpoint } from '../src/task-manager.js';
import {
  evaluateAnswerQuality,
  mapOptionTextsToIds,
  matchesGoldAnswer,
  verifyDomFillReadback,
  type BenchmarkPageRun,
  type GoldPracticeKey,
  type TaskCompletionAuditCase
} from '../src/evaluation/answer-quality.js';
import {
  buildPermittedSelfPracticeHtml,
  runRealModelPracticeBenchmark
} from '../src/evaluation/real-model-benchmark.js';
import { SLOT, quizPage, attemptUrl } from './fixtures/moodle-fixtures.js';
import { openHtml, compareExtraction } from './fixtures/browser-harness.js';
import type { AppConfig, Question } from '../src/types.js';

let browser: Browser;

const EVALUATED_LMS_TYPE_CATALOG: { type: string; supported: boolean }[] = [
  { type: 'moodle:multichoice(single)', supported: true },
  { type: 'moodle:multichoice(multi)', supported: true },
  { type: 'moodle:truefalse', supported: true },
  { type: 'moodle:shortanswer', supported: true },
  { type: 'moodle:numerical', supported: true },
  { type: 'moodle:essay(textarea)', supported: true },
  { type: 'moodle:essay(atto-contenteditable)', supported: true },
  { type: 'moodle:match', supported: true },
  { type: 'moodle:multianswer(cloze)', supported: true },
  { type: 'moodle:gapselect(dropdown)', supported: true },
  { type: 'moodle:filemanager(attachment)', supported: false },
  { type: 'moodle:ddwtos(drag-into-text)', supported: false },
  { type: 'moodle:ddmarker(drag-onto-image)', supported: false },
  { type: 'moodle:ordering', supported: false },
  { type: 'moodle:coderunner(third-party-plugin)', supported: false }
];

function build26ItemBenchmarkDom() {
  const speechSlotHtml = `<div id="question-7001-25" class="que essay deferredfeedback notyetanswered">
    <div class="info"><h3 class="no">Question <span class="qno">25</span></h3></div>
    <div class="content"><div class="formulation clearfix">
      <div class="qtext"><p>Listen to the prompt and record your voice using the microphone.</p><audio controls src="/audio/p25.mp3"></audio></div>
      <div class="ablock"><div class="answer"><textarea id="q7001:25_answer" name="q7001:25_answer" rows="3"></textarea></div></div>
    </div></div></div>`;

  const parts = [
    SLOT.single({ slot: 1 }),
    SLOT.single({ slot: 2, shuffle: 7 }),
    SLOT.single({ slot: 3, shuffle: 42 }),
    SLOT.multi({ slot: 4, shuffle: 1 }),
    SLOT.truefalse(5),
    SLOT.shortanswer(6),
    SLOT.numerical(7),
    SLOT.essay(8),
    SLOT.essayAtto(9),
    SLOT.match(10),         // m10_1, m10_2, m10_3
    SLOT.cloze(11),         // m11_1, m11_2
    SLOT.gapselect(12),     // m12_1
    SLOT.mathRaw(13),
    SLOT.mathRendered(14),
    SLOT.imageInQuestion(15),
    SLOT.imageInOption(16),
    // 5 unsupported Moodle items + 1 speech/audio humanOnly item = 6 non-automated items
    SLOT.essayAttachment(18), // m18 (textarea) + m18_att (filemanager - unsupported)
    SLOT.ddwtos(19),
    SLOT.ddmarker(20),
    SLOT.ordering(21),
    SLOT.unknownPlugin(22)
  ];

  const expectedList = parts.flatMap(p => (Array.isArray(p.exp) ? p.exp : [p.exp]));
  const html = quizPage([...parts.map(p => p.html), speechSlotHtml], { page: 0 });

  const goldById: Record<string, GoldPracticeKey> = {
    m1: { optionTexts: ['Paris'] },
    m2: { optionTexts: ['Paris'] },
    m3: { optionTexts: ['Paris'] },
    m4: { optionTexts: ['2', '5'] },
    m5: { optionTexts: ['True'] },
    m6: { text: 'Au' },
    m7: { text: '42', numericTolerance: 0.01 },
    m8: { text: 'Plants convert light into chemical energy. They release oxygen as a by-product.' },
    m9: { text: 'Widespread food shortages and fiscal crisis.' },
    m10_1: { optionTexts: ['Amphibian'] },
    m10_2: { optionTexts: ['Bird'] },
    m10_3: { optionTexts: ['Fish'] },
    m11_1: { text: 'Rome' },
    m11_2: { optionTexts: ['one'] },
    m12_1: { optionTexts: ['100'] },
    m13: { optionTexts: ['\\(x=2,\\ x=3\\)'] },
    m14: { text: '1.5', numericTolerance: 0.001 },
    m15: { optionTexts: ['Triangle'] },
    m16: { optionTexts: ['Flag A'] },
    m18: { text: 'Executive summary of laboratory observations.' },
    m18_att: { expectUnsupportedOrHumanOnly: true },
    m19: { expectUnsupportedOrHumanOnly: true },
    m20: { expectUnsupportedOrHumanOnly: true },
    m21: { expectUnsupportedOrHumanOnly: true },
    m22: { expectUnsupportedOrHumanOnly: true },
    m25: { expectUnsupportedOrHumanOnly: true }
  };

  return { html, expectedList, goldById };
}

describe('Phase 3 — Answer Quality Evaluation Benchmark (Deterministic Pipeline vs Synthetic Calibration)', () => {
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('AQB-01: Deterministic pipeline benchmark verifies extraction (26/26), shuffled option mapping (13/13), coverage (10/15), Atto hidden-textarea sync, and unsupported withholding', async () => {
    const { html, expectedList, goldById } = build26ItemBenchmarkDom();
    const page = await openHtml(browser, attemptUrl(0), html);

    try {
      const scanned = await scanQuestions(page);
      assert.equal(scanned.length, 26, `Expected 26 items (20 answerable + 6 unsupported/humanOnly), got ${scanned.length}`);

      const cmp = compareExtraction(expectedList, scanned.slice(0, 25));
      assert.deepEqual(cmp.mismatches, []);
      assert.deepEqual(cmp.extraQuestions, []);
      assert.ok(scanned[25].humanOnly, 'Slot 25 audio/microphone item must be marked humanOnly');

      // Deterministic gold responder (tests the PIPELINE end-to-end, NOT claiming real LLM accuracy)
      const byId = new Map<string, Question>(scanned.map(q => [q.id, q]));
      const pick = (id: string, texts: string[]) => mapOptionTextsToIds(byId.get(id)!, texts).ids;
      const intendedOptionTextsById: Record<string, string[]> = {
        m1: ['Paris'],
        m2: ['Paris'],
        m3: ['Paris'],
        m4: ['2', '5'],
        m5: ['True'],
        m10_1: ['Amphibian'],
        m10_2: ['Bird'],
        m10_3: ['Fish'],
        m11_2: ['one'],
        m12_1: ['100'],
        m13: ['\\(x=2,\\ x=3\\)'],
        m15: ['Triangle'],
        m16: ['Flag A']
      };

      const deterministicGoldPayload = {
        answers: [
          { id: 'm1', selected: pick('m1', ['Paris']), confidence: 0.99 },
          { id: 'm2', selected: pick('m2', ['Paris']), confidence: 0.99 },
          { id: 'm3', selected: pick('m3', ['Paris']), confidence: 0.99 },
          { id: 'm4', selected: pick('m4', ['2', '5']), confidence: 0.99 },
          { id: 'm5', selected: pick('m5', ['True']), confidence: 0.99 },
          { id: 'm6', text: 'Au', confidence: 0.99 },
          { id: 'm7', text: '42', confidence: 0.99 },
          { id: 'm8', text: 'Plants convert light into chemical energy. They release oxygen as a by-product.', confidence: 0.95 },
          { id: 'm9', text: 'Widespread food shortages and fiscal crisis.', confidence: 0.95 },
          { id: 'm10_1', selected: pick('m10_1', ['Amphibian']), confidence: 0.99 },
          { id: 'm10_2', selected: pick('m10_2', ['Bird']), confidence: 0.99 },
          { id: 'm10_3', selected: pick('m10_3', ['Fish']), confidence: 0.99 },
          { id: 'm11_1', text: 'Rome', confidence: 0.99 },
          { id: 'm11_2', selected: pick('m11_2', ['one']), confidence: 0.99 },
          { id: 'm12_1', selected: pick('m12_1', ['100']), confidence: 0.99 },
          { id: 'm13', selected: pick('m13', ['\\(x=2,\\ x=3\\)']), confidence: 0.99 },
          { id: 'm14', text: '1.5', confidence: 0.99 },
          { id: 'm15', selected: pick('m15', ['Triangle']), confidence: 0.95 },
          { id: 'm16', selected: pick('m16', ['Flag A']), confidence: 0.95 },
          { id: 'm18', text: 'Executive summary of laboratory observations.', confidence: 0.95 }
        ]
      };

      const report = await evaluateAnswerQuality({
        extractionMatched: 26,
        extractionExpected: 26,
        evaluatedTypeCatalog: EVALUATED_LMS_TYPE_CATALOG,
        pageRuns: [{
          target: page,
          questions: scanned,
          rawModelPayload: deterministicGoldPayload,
          goldById,
          intendedOptionTextsById,
          serverConfirmedIds: new Set()
        }],
        completionCases: []
      });

      const m = report.metrics;
      assert.equal(m.questionExtractionAccuracy, 1.0);
      assert.equal(m.optionMappingAccuracy, 1.0);
      assert.equal(m.optionMappedCorrectCount, 13);
      assert.ok(Math.abs(m.supportedQuestionTypeCoverage - 10 / 15) < 1e-9, 'Coverage is 10/15 (66.7%), never inflated to 100%');
      assert.equal(m.unsupportedDetectionAccuracy, 1.0);
      assert.equal(m.unsupportedTruePositives, 6);
      assert.equal(m.domVerificationSuccessRate, 1.0);
      assert.equal(m.domVerifiedCount, 20);
      assert.equal(m.serverRecordedCount, 0, 'Static DOM fill is never counted as server-recorded');

      // Verify Moodle Atto hidden <textarea> dynamic form sync on Slot 9 (no inline oninput attribute in fixture!)
      const hiddenAttoValue = await page.locator('#q7001\\:9_answer').inputValue();
      assert.equal(hiddenAttoValue, 'Widespread food shortages and fiscal crisis.');

      // Also verify the 20-item independent Real-Model Self-Practice DOM scans cleanly
      const practice = buildPermittedSelfPracticeHtml();
      const practicePage = await openHtml(browser, 'https://lms.hust.edu.vn/mod/quiz/attempt.php?attempt=9100&page=0', practice.html);
      try {
        const practiceQs = await scanQuestions(practicePage);
        assert.equal(practiceQs.length, 20);
        assert.deepEqual(practiceQs.map(q => q.id), practice.specs.map(s => s.id));
      } finally {
        await practicePage.context().close();
      }
    } finally {
      await page.context().close();
    }
  });

  test('AQB-02: Synthetic error-injection harness proves evaluator separates JSON validity (100%) & self-reported confidence (0.858) from gold correctness (not a real model claim)', async () => {
    const { html, goldById } = build26ItemBenchmarkDom();
    const page = await openHtml(browser, attemptUrl(0), html);

    try {
      const scanned = await scanQuestions(page);
      const byId = new Map<string, Question>(scanned.map(q => [q.id, q]));
      const pick = (id: string, texts: string[]) => mapOptionTextsToIds(byId.get(id)!, texts).ids;

      const intendedOptionTextsById: Record<string, string[]> = {
        m1: ['Paris'],
        m2: ['Paris'],
        m3: ['Lyon'], // Synthetic injected wrong choice with high confidence 0.94
        m4: ['2', '5'],
        m5: ['True'],
        m10_1: ['Amphibian'],
        m10_2: ['Bird'],
        m10_3: ['Fish'],
        m11_2: ['two'], // Synthetic injected wrong choice with high confidence 0.91
        m12_1: ['100'],
        m13: ['\\(x=2,\\ x=3\\)'],
        m15: ['Triangle'],
        m16: ['Flag B'] // Synthetic injected wrong choice with low confidence 0.41
      };

      // SYNTHETIC CALIBRATION PAYLOAD (4 deliberate errors injected to test evaluator scoring & overconfidence traps)
      const syntheticInjectedPayload = {
        answers: [
          { id: 'm1', selected: pick('m1', ['Paris']), confidence: 0.98 },
          { id: 'm2', selected: pick('m2', ['Paris']), confidence: 0.95 },
          { id: 'm3', selected: pick('m3', ['Lyon']), confidence: 0.94 }, // Injected error #1 (overconfident)
          { id: 'm4', selected: pick('m4', ['2', '5']), confidence: 0.92 },
          { id: 'm5', selected: pick('m5', ['True']), confidence: 0.99 },
          { id: 'm6', text: 'Au', confidence: 0.97 },
          { id: 'm7', text: '48', confidence: 0.96 }, // Injected error #2 (overconfident)
          { id: 'm8', text: 'Plants convert light into chemical energy. They release oxygen as a by-product.', confidence: 0.52 },
          { id: 'm9', text: 'Widespread food shortages and fiscal crisis.', confidence: 0.88 },
          { id: 'm10_1', selected: pick('m10_1', ['Amphibian']), confidence: 0.93 },
          { id: 'm10_2', selected: pick('m10_2', ['Bird']), confidence: 0.93 },
          { id: 'm10_3', selected: pick('m10_3', ['Fish']), confidence: 0.93 },
          { id: 'm11_1', text: 'Rome', confidence: 0.95 },
          { id: 'm11_2', selected: pick('m11_2', ['two']), confidence: 0.91 }, // Injected error #3 (overconfident)
          { id: 'm12_1', selected: pick('m12_1', ['100']), confidence: 0.97 },
          { id: 'm13', selected: pick('m13', ['\\(x=2,\\ x=3\\)']), confidence: 0.89 },
          { id: 'm14', text: '1.5', confidence: 0.90 },
          { id: 'm15', selected: pick('m15', ['Triangle']), confidence: 0.48 },
          { id: 'm16', selected: pick('m16', ['Flag B']), confidence: 0.41 }, // Injected error #4 (low-confidence)
          { id: 'm18', text: 'Executive summary of laboratory observations.', confidence: 0.84 }
        ]
      };

      const pageRun: BenchmarkPageRun = {
        target: page,
        questions: scanned,
        rawModelPayload: syntheticInjectedPayload,
        goldById,
        intendedOptionTextsById,
        serverConfirmedIds: new Set()
      };

      const report = await evaluateAnswerQuality({
        extractionMatched: 26,
        extractionExpected: 26,
        evaluatedTypeCatalog: EVALUATED_LMS_TYPE_CATALOG,
        pageRuns: [pageRun],
        completionCases: [],
        lowConfidenceThreshold: 0.6
      });

      const m = report.metrics;
      assert.equal(m.schemaValidRate, 1.0, 'All 20 synthetic payloads are valid JSON');
      assert.equal(m.goldCorrectCount, 16, 'Evaluator detects exactly 16/20 correct against gold key');
      assert.equal(m.answerCorrectness, 0.8);
      assert.ok(m.meanSelfReportedConfidence !== null && m.meanSelfReportedConfidence > 0.84);
      assert.equal(m.overconfidentErrorCount, 3, 'Evaluator catches all 3 overconfident wrong answers');
      assert.equal(m.lowConfidenceTotalCount, 3);
      assert.equal(m.lowConfidenceFlaggedCount, 3);
      assert.equal(m.lowConfidenceReviewRate, 1.0);

      const itemM3 = report.items.find(i => i.id === 'm3')!;
      assert.equal(itemM3.schemaValid, true);
      assert.equal(itemM3.grounded, true);
      assert.equal(itemM3.goldCorrect, false);
      assert.equal(itemM3.domVerified, true);
      assert.equal(itemM3.serverRecorded, false);

      // Verify Real-Model Practice Benchmark refuses scripted fallback when given non-existent profile IDs
      const unconfiguredRealBench = await runRealModelPracticeBenchmark(['__nonexistent_profile_id__']);
      assert.equal(unconfiguredRealBench.status, 'NOT TESTED');
      assert.deepEqual(unconfiguredRealBench.models, []);
    } finally {
      await page.context().close();
    }
  });

  test('AQB-03: verifyDomFillReadback catches silent DOM mutation resets instead of trusting fill call blindly', async () => {
    const trapHtml = `<!DOCTYPE html><html><body>
      <div class="question">
        <h3>Write answer</h3>
        <input type="text" id="trap" aria-label="Write answer" oninput="this.value=''">
      </div></body></html>`;
    const page = await openHtml(browser, 'https://lms.hust.edu.vn/practice/trap', trapHtml);
    try {
      const [q] = await scanQuestions(page);
      assert.ok(q);
      const verified = await verifyDomFillReadback(page, q, { id: q.id, text: 'Expected text' });
      assert.equal(verified, false);
      assert.equal(matchesGoldAnswer(q, { id: q.id, text: 'Expected text' }, { text: 'Expected text' }), true);
    } finally {
      await page.context().close();
    }
  });

  test('AQB-04: False completion rate is 0.0% across unsupported, human-only, low-confidence, and truncated-page tasks via executeTask()', async () => {
    const origExecute = ModelRouter.execute;
    const baseConfig: AppConfig = {
      allowedHosts: ['lms.hust.edu.vn'],
      approvedForAIUse: true,
      parallelTabs: 1,
      authUrls: [],
      deadlinePages: [],
      tasks: [],
      provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' },
      operationMode: 'PRACTICE_ASSISTED'
    };

    try {
      ModelRouter.execute = (async (req: any) => {
        const parsed = JSON.parse(req.text) as { questions: Question[] };
        const answers = parsed.questions.map(q => {
          if (['radio', 'checkbox', 'select'].includes(q.kind)) {
            return { id: q.id, selected: [q.options[0].id], confidence: 0.45 };
          }
          return { id: q.id, text: 'Practice answer', confidence: 0.45 };
        });
        return {
          output: JSON.stringify({ answers }),
          initialProfile: 'test',
          finalProfile: 'test',
          attempts: 1,
          fallbackCount: 0,
          history: []
        };
      }) as typeof ModelRouter.execute;

      const auditCases: TaskCompletionAuditCase[] = [];
      const isReady = (s: string) => s === 'READY_FOR_REVIEW';
      const isSubmitted = (s: string) => s === 'SUBMITTED';

      // Case 1: Mixed supported + unsupported (ddwtos) on same Moodle page -> PARTIAL
      {
        const taskId = 'aqb-false-comp-1';
        await clearCheckpoint(taskId);
        const html = quizPage([SLOT.single({ slot: 1 }).html, SLOT.ddwtos(2).html]);
        const ctx = await browser.newContext();
        await ctx.route('https://lms.hust.edu.vn/**', route =>
          route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
        );
        try {
          const res = await executeTask(ctx, { id: taskId, url: attemptUrl(0), aiPermitted: true, maxPages: 2, scopeAttestation: 'PERMITTED_SELF_PRACTICE' }, baseConfig);
          assert.equal(res.questionsFound, 2);
          assert.equal(res.questionsFilled, 1);
          assert.equal(res.status, 'PARTIAL');
          assert.ok(res.warnings.some(w => w.includes('UNSUPPORTED [m2/moodle:ddwtos]')));
          assert.ok(res.warnings.some(w => w.includes('LOW_CONFIDENCE [m1]')));
          auditCases.push({
            taskId,
            hasUnsupportedOrHumanOnly: true,
            hasMissingOrUnverifiedFill: false,
            hasUnvisitedPages: false,
            reportedReadyForReview: isReady(res.status),
            autoSubmitted: isSubmitted(res.status)
          });
        } finally {
          await ctx.close();
          await clearCheckpoint(taskId);
        }
      }

      // Case 2: Pure unsupported third-party plugin (coderunner textarea) -> NEEDS_REVIEW, 0 filled
      {
        const taskId = 'aqb-false-comp-2';
        await clearCheckpoint(taskId);
        const html = quizPage([SLOT.unknownPlugin(1).html]);
        const ctx = await browser.newContext();
        await ctx.route('https://lms.hust.edu.vn/**', route =>
          route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
        );
        try {
          const res = await executeTask(ctx, { id: taskId, url: attemptUrl(0), aiPermitted: true, maxPages: 1, scopeAttestation: 'PERMITTED_SELF_PRACTICE' }, baseConfig);
          assert.equal(res.questionsFound, 1);
          assert.equal(res.questionsFilled, 0);
          assert.equal(res.status, 'NEEDS_REVIEW');
          assert.ok(res.warnings.some(w => w.includes('CodeRunner')));
          auditCases.push({
            taskId,
            hasUnsupportedOrHumanOnly: true,
            hasMissingOrUnverifiedFill: true,
            hasUnvisitedPages: false,
            reportedReadyForReview: isReady(res.status),
            autoSubmitted: isSubmitted(res.status)
          });
        } finally {
          await ctx.close();
          await clearCheckpoint(taskId);
        }
      }

      // Case 3: Human-only speech/audio item -> NEEDS_REVIEW, 0 filled
      {
        const taskId = 'aqb-false-comp-3';
        await clearCheckpoint(taskId);
        const html = `<!DOCTYPE html><html><body>
          <div class="que essay" id="question-7001-1"><div class="formulation">
            <div class="qtext"><p>Listen and record your voice.</p><audio src="/a.mp3" controls></audio></div>
            <div class="answer"><textarea name="q7001:1_answer" rows="3"></textarea></div>
          </div></div></body></html>`;
        const ctx = await browser.newContext();
        await ctx.route('https://lms.hust.edu.vn/**', route =>
          route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
        );
        try {
          const res = await executeTask(ctx, { id: taskId, url: attemptUrl(0), aiPermitted: true, maxPages: 1, scopeAttestation: 'PERMITTED_SELF_PRACTICE' }, baseConfig);
          assert.equal(res.questionsFilled, 0);
          assert.equal(res.status, 'NEEDS_REVIEW');
          assert.ok(res.warnings.some(w => w.includes('HUMAN_ONLY')));
          auditCases.push({
            taskId,
            hasUnsupportedOrHumanOnly: true,
            hasMissingOrUnverifiedFill: true,
            hasUnvisitedPages: false,
            reportedReadyForReview: isReady(res.status),
            autoSubmitted: isSubmitted(res.status)
          });
        } finally {
          await ctx.close();
          await clearCheckpoint(taskId);
        }
      }

      // Case 4: Multi-page quiz truncated by maxPages=1 while "Next page" button exists -> PARTIAL
      {
        const taskId = 'aqb-false-comp-4';
        await clearCheckpoint(taskId);
        const html = quizPage([SLOT.single({ slot: 1 }).html], { page: 0, next: true });
        const ctx = await browser.newContext();
        await ctx.route('https://lms.hust.edu.vn/**', route =>
          route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
        );
        try {
          const res = await executeTask(ctx, { id: taskId, url: attemptUrl(0), aiPermitted: true, maxPages: 1, scopeAttestation: 'PERMITTED_SELF_PRACTICE' }, baseConfig);
          assert.equal(res.questionsFilled, 1);
          assert.equal(res.status, 'PARTIAL');
          assert.ok(res.warnings.some(w => w.includes('Reached maxPages=1')));
          auditCases.push({
            taskId,
            hasUnsupportedOrHumanOnly: false,
            hasMissingOrUnverifiedFill: false,
            hasUnvisitedPages: true,
            reportedReadyForReview: isReady(res.status),
            autoSubmitted: isSubmitted(res.status)
          });
        } finally {
          await ctx.close();
          await clearCheckpoint(taskId);
        }
      }

      const falseCompletions = auditCases.filter(c => c.reportedReadyForReview || c.autoSubmitted);
      assert.equal(falseCompletions.length, 0, 'False completion rate MUST be 0.0%');
    } finally {
      ModelRouter.execute = origExecute;
    }
  });
});
