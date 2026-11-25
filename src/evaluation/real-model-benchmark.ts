/** Phase 3B & Phase 4 — Real-Model Practice Benchmark (Strictly Independent from Deterministic Pipeline Harness)
 *
 * Evaluates ONLY real configured AI model profiles (BYOK via Model Center + OS Credential Vault)
 * on an independent, human-authored 20-item permitted self-practice benchmark:
 *   - 18 objective items scored via exact/numeric gold keys (`objectiveExactMatchAccuracy`)
 *   - 2 open-ended essay items (`m16`, `m17`) evaluated separately via independent non-LLM concept rubrics
 *     (`essayEvaluation`) with mandatory human review (`requiresHumanReview: true`)
 *   - Confidence calibration (mean confidence on correct vs wrong, 5-bin ECE, overconfidence, Wilson 95% CI)
 *   - Abstention tracking and explicit small-sample statistical limitation disclosures.
 *
 * STRICT AUDIT GUARANTEES:
 * 1. NEVER uses a scripted or simulated responder. If no real model API profile/key is configured,
 *    returns `status: 'NOT TESTED'` honestly.
 * 2. Gold keys and essay rubrics are fixed, human-authored self-practice specifications (never LLM-self-graded).
 * 3. Never auto-submits or touches live graded LMS assessments.
 * 4. Redacts all error strings so no API key or credential can ever appear in benchmark outputs.
 */
import { scanQuestions } from '../scanner.js';
import { solveQuestions } from '../ai.js';
import { readProfilesDb } from '../model-center/routing.js';
import { isOfficialEndpoint } from '../model-center/catalog.js';
import { redactSecrets } from '../security/redact.js';
import {
  computeConfidenceCalibration,
  evaluateEssayWithIndependentRubric,
  matchesExactGoldKey,
  matchesGoldAnswer,
  type ConfidenceCalibrationSummary,
  type EssayBenchmarkSummary,
  type GoldPracticeKey
} from './answer-quality.js';
import type { AppConfig, Answer, Question } from '../types.js';

export interface PracticeBenchmarkItemSpec {
  id: string;
  questionType:
    | 'single-choice'
    | 'multiple-choice'
    | 'true/false'
    | 'short-answer'
    | 'numerical'
    | 'essay-textarea'
    | 'essay-atto'
    | 'matching'
    | 'cloze-text'
    | 'cloze-select'
    | 'gapselect'
    | 'math-tex';
  requiresHumanEssayReview?: boolean;
  gold: GoldPracticeKey;
}

export interface PerQuestionTypeAccuracy {
  questionType: string;
  scoringMethod: 'objective-exact' | 'independent-essay-rubric+human-review';
  total: number;
  correct: number;
  accuracy: number;
}

export interface RealModelEvaluationRecord {
  status: 'TESTED' | 'BLOCKED' | 'FAILED';
  profileId: string;
  provider: string;
  modelId: string;
  inferenceConfig: {
    endpointMode: 'official' | 'custom';
    maxTokens: number;
    allowVision: boolean;
    maxAttemptsPerModel: number;
  };
  sampleCount: number;
  objectiveSampleCount: number;
  objectiveCorrectCount: number;
  objectiveExactMatchAccuracy: number | null;
  essayEvaluation: EssayBenchmarkSummary;
  correctCount: number;
  overallAccuracy: number | null;
  accuracyByQuestionType: PerQuestionTypeAccuracy[];
  wrongCount: number;
  abstentionCount: number;
  abstentionRate: number;
  insufficientEvidenceCount: number;
  overconfidentWrongCount: number;
  confidenceCalibration: ConfidenceCalibrationSummary | null;
  reviewRequiredItems: { id: string; questionType: string; reason: string; confidence?: number }[];
  errorReason?: string;
}

export interface RealModelBenchmarkSuiteResult {
  executedAt: string;
  status: 'PASS' | 'PARTIAL' | 'NOT TESTED' | 'BLOCKED';
  reason: string;
  sampleCount: number;
  objectiveSampleCount: number;
  essaySampleCount: number;
  goldKeyProvenance: string;
  statisticalLimitations: string[];
  models: RealModelEvaluationRecord[];
}

/** Human-authored permitted self-practice HTML page (18 objective items + 2 open-ended concept-rubric essays across 10 Moodle question types). */
export function buildPermittedSelfPracticeHtml(): {
  html: string;
  specs: PracticeBenchmarkItemSpec[];
} {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="generator" content="Moodle 4.3">
  <title>Permitted Self-Practice Benchmark</title></head>
  <body id="page-mod-quiz-attempt" class="path-mod path-mod-quiz moodle">
    <form id="responseform" method="post" action="/mod/quiz/processattempt.php">
      <!-- m1: single-choice -->
      <div id="question-9100-1" class="que multichoice"><div class="formulation">
        <div class="qtext"><p>Which HTTP status code indicates that a resource was not found?</p></div>
        <div class="ablock"><div class="answer">
          <div><input type="radio" name="q9100:1_answer" id="q1a" value="0"><label for="q1a">200</label></div>
          <div><input type="radio" name="q9100:1_answer" id="q1b" value="1"><label for="q1b">301</label></div>
          <div><input type="radio" name="q9100:1_answer" id="q1c" value="2"><label for="q1c">404</label></div>
          <div><input type="radio" name="q9100:1_answer" id="q1d" value="3"><label for="q1d">500</label></div>
        </div></div>
      </div></div>

      <!-- m2: single-choice -->
      <div id="question-9100-2" class="que multichoice"><div class="formulation">
        <div class="qtext"><p>Which data structure operates in First-In, First-Out (FIFO) order?</p></div>
        <div class="ablock"><div class="answer">
          <div><input type="radio" name="q9100:2_answer" id="q2a" value="0"><label for="q2a">Stack</label></div>
          <div><input type="radio" name="q9100:2_answer" id="q2b" value="1"><label for="q2b">Queue</label></div>
          <div><input type="radio" name="q9100:2_answer" id="q2c" value="2"><label for="q2c">Binary Heap</label></div>
        </div></div>
      </div></div>

      <!-- m3: multiple-choice -->
      <div id="question-9100-3" class="que multichoice"><div class="formulation">
        <div class="qtext"><p>Select all prime numbers from the list below.</p></div>
        <div class="ablock"><div class="answer">
          <div><input type="checkbox" name="q9100:3_c0" id="q3a" value="1"><label for="q3a">11</label></div>
          <div><input type="checkbox" name="q9100:3_c1" id="q3b" value="1"><label for="q3b">15</label></div>
          <div><input type="checkbox" name="q9100:3_c2" id="q3c" value="1"><label for="q3c">17</label></div>
          <div><input type="checkbox" name="q9100:3_c3" id="q3d" value="1"><label for="q3d">21</label></div>
        </div></div>
      </div></div>

      <!-- m4: multiple-choice -->
      <div id="question-9100-4" class="que multichoice"><div class="formulation">
        <div class="qtext"><p>Select all transport-layer protocols in the TCP/IP suite.</p></div>
        <div class="ablock"><div class="answer">
          <div><input type="checkbox" name="q9100:4_c0" id="q4a" value="1"><label for="q4a">TCP</label></div>
          <div><input type="checkbox" name="q9100:4_c1" id="q4b" value="1"><label for="q4b">UDP</label></div>
          <div><input type="checkbox" name="q9100:4_c2" id="q4c" value="1"><label for="q4c">HTTP</label></div>
          <div><input type="checkbox" name="q9100:4_c3" id="q4d" value="1"><label for="q4d">ARP</label></div>
        </div></div>
      </div></div>

      <!-- m5: true/false -->
      <div id="question-9100-5" class="que truefalse"><div class="formulation">
        <div class="qtext"><p>In binary search on a sorted array of n elements, worst-case time complexity is O(log n).</p></div>
        <div class="ablock"><div class="answer">
          <div><input type="radio" name="q9100:5_answer" id="q5t" value="1"><label for="q5t">True</label></div>
          <div><input type="radio" name="q9100:5_answer" id="q5f" value="0"><label for="q5f">False</label></div>
        </div></div>
      </div></div>

      <!-- m6: true/false -->
      <div id="question-9100-6" class="que truefalse"><div class="formulation">
        <div class="qtext"><p>An HTTP GET request is intended to have idempotent read semantics.</p></div>
        <div class="ablock"><div class="answer">
          <div><input type="radio" name="q9100:6_answer" id="q6t" value="1"><label for="q6t">True</label></div>
          <div><input type="radio" name="q9100:6_answer" id="q6f" value="0"><label for="q6f">False</label></div>
        </div></div>
      </div></div>

      <!-- m7: short-answer -->
      <div id="question-9100-7" class="que shortanswer"><div class="formulation">
        <div class="qtext"><p>What is the chemical symbol for Iron?</p></div>
        <div class="ablock"><input type="text" name="q9100:7_answer" aria-label="Answer"></div>
      </div></div>

      <!-- m8: short-answer -->
      <div id="question-9100-8" class="que shortanswer"><div class="formulation">
        <div class="qtext"><p>What standard port number does HTTPS use by default?</p></div>
        <div class="ablock"><input type="text" name="q9100:8_answer" aria-label="Answer"></div>
      </div></div>

      <!-- m9: numerical -->
      <div id="question-9100-9" class="que numerical"><div class="formulation">
        <div class="qtext"><p>Compute 15 * 12.</p></div>
        <div class="ablock"><input type="text" name="q9100:9_answer" aria-label="Answer"></div>
      </div></div>

      <!-- m10: numerical -->
      <div id="question-9100-10" class="que numerical"><div class="formulation">
        <div class="qtext"><p>Evaluate the derivative of f(x) = 3x^2 + 4x - 5 at x = 2.</p></div>
        <div class="ablock"><input type="text" name="q9100:10_answer" aria-label="Answer"></div>
      </div></div>

      <!-- m11: math-tex (radio) -->
      <div id="question-9100-11" class="que multichoice"><div class="formulation">
        <div class="qtext"><p>Find the positive root of <span class="filter_mathjaxloader_equation">\\(x^2 - 9 = 0\\)</span>.</p></div>
        <div class="ablock"><div class="answer">
          <div><input type="radio" name="q9100:11_answer" id="q11a" value="0"><label for="q11a">\\(x = 3\\)</label></div>
          <div><input type="radio" name="q9100:11_answer" id="q11b" value="1"><label for="q11b">\\(x = 9\\)</label></div>
        </div></div>
      </div></div>

      <!-- m12: math-tex (numerical/shortanswer) -->
      <div id="question-9100-12" class="que shortanswer"><div class="formulation">
        <div class="qtext"><p>Compute <mjx-container class="MathJax"><math><semantics><annotation encoding="application/x-tex">\\int_0^2 2x\\,dx</annotation></semantics></math></mjx-container> as an integer.</p></div>
        <div class="ablock"><input type="text" name="q9100:12_answer" aria-label="Answer"></div>
      </div></div>

      <!-- m13: matching (3 sub-items: m13_1, m13_2, m13_3) -->
      <div id="question-9100-13" class="que match"><div class="formulation">
        <div class="qtext"><p>Match each SQL keyword with its primary purpose.</p></div>
        <div class="ablock"><table class="answer"><tbody>
          <tr><td class="text">SELECT</td><td class="control"><select name="q9100:13_sub0"><option value="">Choose...</option><option value="1">Query rows</option><option value="2">Remove table</option><option value="3">Filter groups</option></select></td></tr>
          <tr><td class="text">DROP</td><td class="control"><select name="q9100:13_sub1"><option value="">Choose...</option><option value="1">Query rows</option><option value="2">Remove table</option><option value="3">Filter groups</option></select></td></tr>
          <tr><td class="text">HAVING</td><td class="control"><select name="q9100:13_sub2"><option value="">Choose...</option><option value="1">Query rows</option><option value="2">Remove table</option><option value="3">Filter groups</option></select></td></tr>
        </tbody></table></div>
      </div></div>

      <!-- m14: cloze (2 sub-items: m14_1 text, m14_2 select) -->
      <div id="question-9100-14" class="que multianswer"><div class="formulation">
        <div class="qtext"><p>In Git, the command to create a new commit is <span class="subquestion"><input type="text" name="q9100:14_s1"></span> and branches are merged with <span class="subquestion"><select name="q9100:14_s2"><option value=""></option><option value="1">git merge</option><option value="2">git clean</option></select></span>.</p></div>
      </div></div>

      <!-- m15: gapselect (1 sub-item: m15_1) -->
      <div id="question-9100-15" class="que gapselect"><div class="formulation">
        <div class="qtext"><p>A byte consists of <span class="control"><select name="q9100:15_p1"><option value=""></option><option value="1">8</option><option value="2">16</option></select></span> bits.</p></div>
      </div></div>

      <!-- m16: open-ended essay (textarea) -->
      <div id="question-9100-16" class="que essay"><div class="formulation">
        <div class="qtext"><p>In 1-3 sentences, state the input precondition required by binary search on an array and its worst-case time complexity.</p></div>
        <div class="ablock"><textarea name="q9100:16_answer" rows="3"></textarea></div>
      </div></div>

      <!-- m17: open-ended essay (Atto contenteditable) -->
      <div id="question-9100-17" class="que essay"><div class="formulation">
        <div class="qtext"><p>In 1-3 sentences, explain why HTTPS protects credentials in transit compared with plaintext HTTP.</p></div>
        <div class="ablock"><div class="editor_atto_wrap">
          <textarea id="q9100:17_answer" name="q9100:17_answer" style="display:none"></textarea>
          <div class="editor_atto"><div id="q9100:17_answereditable" contenteditable="true" role="textbox" aria-multiline="true" style="min-height:60px"></div></div>
        </div></div>
      </div></div>
    </form>
  </body></html>`;

  const specs: PracticeBenchmarkItemSpec[] = [
    { id: 'm1', questionType: 'single-choice', gold: { optionTexts: ['404'] } },
    { id: 'm2', questionType: 'single-choice', gold: { optionTexts: ['Queue'] } },
    { id: 'm3', questionType: 'multiple-choice', gold: { optionTexts: ['11', '17'] } },
    { id: 'm4', questionType: 'multiple-choice', gold: { optionTexts: ['TCP', 'UDP'] } },
    { id: 'm5', questionType: 'true/false', gold: { optionTexts: ['True'] } },
    { id: 'm6', questionType: 'true/false', gold: { optionTexts: ['True'] } },
    { id: 'm7', questionType: 'short-answer', gold: { text: 'Fe' } },
    { id: 'm8', questionType: 'short-answer', gold: { text: '443' } },
    { id: 'm9', questionType: 'numerical', gold: { text: '180', numericTolerance: 0.001 } },
    { id: 'm10', questionType: 'numerical', gold: { text: '16', numericTolerance: 0.001 } },
    { id: 'm11', questionType: 'math-tex', gold: { optionTexts: ['\\(x = 3\\)'] } },
    { id: 'm12', questionType: 'math-tex', gold: { text: '4', numericTolerance: 0.001 } },
    { id: 'm13_1', questionType: 'matching', gold: { optionTexts: ['Query rows'] } },
    { id: 'm13_2', questionType: 'matching', gold: { optionTexts: ['Remove table'] } },
    { id: 'm13_3', questionType: 'matching', gold: { optionTexts: ['Filter groups'] } },
    { id: 'm14_1', questionType: 'cloze-text', gold: { text: 'git commit', acceptedTexts: ['commit'] } },
    { id: 'm14_2', questionType: 'cloze-select', gold: { optionTexts: ['git merge'] } },
    { id: 'm15_1', questionType: 'gapselect', gold: { optionTexts: ['8'] } },
    {
      id: 'm16',
      questionType: 'essay-textarea',
      requiresHumanEssayReview: true,
      gold: {
        isOpenEndedEssay: true,
        text: 'Binary search requires a sorted array and has O(log n) worst-case time complexity.',
        essayRubric: {
          rubricId: 'rubric-binary-search-precondition-complexity',
          minWordCount: 5,
          requiredConcepts: [
            {
              conceptId: 'sorted-precondition',
              description: 'Array/sequence must be sorted (ordered / monotonic)',
              acceptedPatterns: [/\bsorted\b/i, /\bordered\b/i, /\bmonotonic/i, /\bsắp xếp\b/i]
            },
            {
              conceptId: 'logarithmic-complexity',
              description: 'Worst-case time complexity is O(log n) / logarithmic',
              acceptedPatterns: [/o\s*\(\s*log(?:_?2)?\s*n\s*\)/i, /\blogarithmic\b/i, /\blog\s*n\b/i]
            }
          ],
          forbiddenMisconceptions: [
            { reason: 'Claims binary search works on unsorted arrays', pattern: /\bworks\s+on\s+unsorted\b|\bunsorted\s+array\s+is\s+(?:fine|valid|allowed)\b/i },
            { reason: 'States worst-case complexity is O(1) or O(n^2)', pattern: /worst[- ]case[^.]{0,30}\bo\s*\(\s*(?:1|n\^2)\s*\)/i }
          ]
        }
      }
    },
    {
      id: 'm17',
      questionType: 'essay-atto',
      requiresHumanEssayReview: true,
      gold: {
        isOpenEndedEssay: true,
        text: 'HTTPS encrypts traffic using TLS and authenticates the server certificate so credentials are not sent in cleartext.',
        essayRubric: {
          rubricId: 'rubric-https-tls-confidentiality',
          minWordCount: 5,
          requiredConcepts: [
            {
              conceptId: 'tls-encryption',
              description: 'Traffic/credentials are encrypted in transit (TLS/SSL/encryption)',
              acceptedPatterns: [/\bencrypt/i, /\btls\b/i, /\bssl\b/i, /\bcipher/i, /\bmã hóa\b/i]
            },
            {
              conceptId: 'anti-eavesdropping-or-auth',
              description: 'Prevents plaintext eavesdropping/tampering or verifies server identity/certificate',
              acceptedPatterns: [
                /\bcertificate/i,
                /\bauthenticat/i,
                /\beavesdrop/i,
                /\bman[- ]in[- ]the[- ]middle\b|\bmitm\b/i,
                /\bcleartext\b|\bplaintext\b/i,
                /\btamper/i,
                /\bintegrity\b/i
              ]
            }
          ],
          forbiddenMisconceptions: [
            { reason: 'Claims HTTPS sends passwords in plaintext', pattern: /\bhttps\s+sends\s+[^.]{0,25}\bplaintext\b/i }
          ]
        }
      }
    }
  ];

  return { html, specs };
}

/** Runs the Real-Model Practice Benchmark against configured BYOK profiles, or returns NOT TESTED if none exist. */
export async function runRealModelPracticeBenchmark(profileIds?: string[]): Promise<RealModelBenchmarkSuiteResult> {
  const executedAt = new Date().toISOString();
  const { html, specs } = buildPermittedSelfPracticeHtml();
  const objectiveSpecs = specs.filter(s => !s.gold.isOpenEndedEssay && !s.requiresHumanEssayReview);
  const essaySpecs = specs.filter(s => Boolean(s.gold.isOpenEndedEssay || s.requiresHumanEssayReview));
  const goldKeyProvenance =
    'Independent human-authored 20-item CS/Math/Science self-practice benchmark (18 objective exact-key items + 2 deterministic concept-rubric essays in src/evaluation/real-model-benchmark.ts); zero items generated or graded by any evaluated AI model.';
  const statisticalLimitations = [
    `Small benchmark sample size (total n=${specs.length}: objective n=${objectiveSpecs.length}, open-ended essay n=${essaySpecs.length}); inspect Wilson 95% confidence interval rather than treating point accuracy as universal.`,
    'Objective exact-match accuracy (n=18) and open-ended essay concept-rubric pass rate (n=2) are reported separately; essay responses ALWAYS require human review before LMS submission.',
    'Self-reported model confidence is uncalibrated raw model output and is audited via 5-bin Expected Calibration Error (ECE) and overconfident-error counts, never trusted as correctness.'
  ];

  const db = await readProfilesDb();
  const allConfiguredIds = Object.keys(db.profiles || {});
  const targetIds = profileIds?.length
    ? profileIds.filter(id => Boolean(db.profiles?.[id]))
    : allConfiguredIds;

  if (targetIds.length === 0) {
    return {
      executedAt,
      status: 'NOT TESTED',
      reason:
        'No live AI model profile / BYOK API key is configured in .private/model-profiles.json or OS Credential Vault on this workstation. Scripted responders are strictly prohibited in Real-Model Practice Benchmark.',
      sampleCount: specs.length,
      objectiveSampleCount: objectiveSpecs.length,
      essaySampleCount: essaySpecs.length,
      goldKeyProvenance,
      statisticalLimitations,
      models: []
    };
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const models: RealModelEvaluationRecord[] = [];

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route('**/*', route =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    );
    await page.goto('https://lms.hust.edu.vn/mod/quiz/attempt.php?attempt=9100&cmid=1&page=0');
    const questions = await scanQuestions(page);
    const qById = new Map<string, Question>(questions.map(q => [q.id, q]));

    for (const profileId of targetIds) {
      const prof = db.profiles[profileId];
      const endpointMode = isOfficialEndpoint(prof.provider, prof.endpoint) ? 'official' : 'custom';
      const config: AppConfig = {
        allowedHosts: ['lms.hust.edu.vn'],
        approvedForAIUse: true,
        parallelTabs: 1,
        authUrls: [],
        deadlinePages: [],
        tasks: [],
        maxAttemptsPerModel: 1,
        provider: {
          kind: prof.provider as AppConfig['provider']['kind'],
          profileId,
          model: prof.model,
          allowVision: false
        }
      };

      try {
        const answers = await solveQuestions(page, questions, config, page.mainFrame());
        const aById = new Map<string, Answer>(answers.map(a => [a.id, a]));

        let correctCount = 0;
        let objectiveCorrectCount = 0;
        let essayExactMatchCount = 0;
        let essayRubricEvaluatedCount = 0;
        let essayRubricPassCount = 0;
        let wrongCount = 0;
        let abstentionCount = 0;
        let insufficientEvidenceCount = 0;
        let overconfidentWrongCount = 0;
        const calibrationObs: { confidence?: number; correct: boolean | null; abstained: boolean }[] = [];
        const reviewRequiredItems: RealModelEvaluationRecord['reviewRequiredItems'] = [];
        const byType = new Map<
          string,
          { total: number; correct: number; scoringMethod: PerQuestionTypeAccuracy['scoringMethod'] }
        >();

        for (const spec of specs) {
          const q = qById.get(spec.id);
          const ans = aById.get(spec.id);
          const isEssay = Boolean(spec.gold.isOpenEndedEssay || spec.requiresHumanEssayReview);
          const scoringMethod: PerQuestionTypeAccuracy['scoringMethod'] = isEssay
            ? 'independent-essay-rubric+human-review'
            : 'objective-exact';
          const typeStat = byType.get(spec.questionType) || { total: 0, correct: 0, scoringMethod };
          typeStat.total++;

          if (!q || !ans) {
            abstentionCount++;
            insufficientEvidenceCount++;
            wrongCount++;
            calibrationObs.push({ confidence: undefined, correct: false, abstained: true });
            reviewRequiredItems.push({
              id: spec.id,
              questionType: spec.questionType,
              reason: 'Abstained / missing or ungrounded model answer'
            });
            byType.set(spec.questionType, typeStat);
            continue;
          }

          const exactOk = matchesExactGoldKey(q, ans, spec.gold);
          if (isEssay) {
            if (exactOk) essayExactMatchCount++;
            if (spec.gold.essayRubric) {
              essayRubricEvaluatedCount++;
              const r = evaluateEssayWithIndependentRubric(ans.text ?? '', spec.gold.essayRubric);
              if (r.passed) essayRubricPassCount++;
            }
          }

          const isCorrect = matchesGoldAnswer(q, ans, spec.gold);
          if (isCorrect) {
            correctCount++;
            typeStat.correct++;
            if (!isEssay) objectiveCorrectCount++;
          } else {
            wrongCount++;
            if (typeof ans.confidence === 'number' && ans.confidence >= 0.8) {
              overconfidentWrongCount++;
            }
          }

          const lowConf = typeof ans.confidence === 'number' && ans.confidence < 0.6;
          if (lowConf) {
            insufficientEvidenceCount++;
            reviewRequiredItems.push({
              id: spec.id,
              questionType: spec.questionType,
              reason: `Low self-reported confidence (${ans.confidence!.toFixed(2)} < 0.60)`,
              confidence: ans.confidence
            });
          } else if (isEssay) {
            reviewRequiredItems.push({
              id: spec.id,
              questionType: spec.questionType,
              reason: 'Open-ended essay/free-text response always requires learner review before submission',
              confidence: ans.confidence
            });
          }

          calibrationObs.push({ confidence: ans.confidence, correct: isCorrect, abstained: false });
          byType.set(spec.questionType, typeStat);
        }

        const accuracyByQuestionType: PerQuestionTypeAccuracy[] = [...byType.entries()].map(
          ([questionType, s]) => ({
            questionType,
            scoringMethod: s.scoringMethod,
            total: s.total,
            correct: s.correct,
            accuracy: s.total ? s.correct / s.total : 0
          })
        );

        const confidenceCalibration = computeConfidenceCalibration({
          observations: calibrationObs,
          objectiveCorrectCount,
          objectiveTotalCount: objectiveSpecs.length
        });

        models.push({
          status: 'TESTED',
          profileId,
          provider: prof.provider,
          modelId: prof.model,
          inferenceConfig: {
            endpointMode,
            maxTokens: 3500,
            allowVision: false,
            maxAttemptsPerModel: 1
          },
          sampleCount: specs.length,
          objectiveSampleCount: objectiveSpecs.length,
          objectiveCorrectCount,
          objectiveExactMatchAccuracy: objectiveSpecs.length ? objectiveCorrectCount / objectiveSpecs.length : 0,
          essayEvaluation: {
            essaySampleCount: essaySpecs.length,
            essayExactMatchCount,
            essayIndependentRubricEvaluatedCount: essayRubricEvaluatedCount,
            essayIndependentRubricPassCount: essayRubricPassCount,
            essayHumanReviewRequiredCount: essaySpecs.length
          },
          correctCount,
          overallAccuracy: specs.length ? correctCount / specs.length : 0,
          accuracyByQuestionType,
          wrongCount,
          abstentionCount,
          abstentionRate: specs.length ? abstentionCount / specs.length : 0,
          insufficientEvidenceCount,
          overconfidentWrongCount,
          confidenceCalibration,
          reviewRequiredItems
        });
      } catch (err) {
        models.push({
          status: 'BLOCKED',
          profileId,
          provider: prof.provider,
          modelId: prof.model,
          inferenceConfig: {
            endpointMode,
            maxTokens: 3500,
            allowVision: false,
            maxAttemptsPerModel: 1
          },
          sampleCount: specs.length,
          objectiveSampleCount: objectiveSpecs.length,
          objectiveCorrectCount: 0,
          objectiveExactMatchAccuracy: null,
          essayEvaluation: {
            essaySampleCount: essaySpecs.length,
            essayExactMatchCount: 0,
            essayIndependentRubricEvaluatedCount: 0,
            essayIndependentRubricPassCount: 0,
            essayHumanReviewRequiredCount: essaySpecs.length
          },
          correctCount: 0,
          overallAccuracy: null,
          accuracyByQuestionType: [],
          wrongCount: 0,
          abstentionCount: specs.length,
          abstentionRate: 1,
          insufficientEvidenceCount: specs.length,
          overconfidentWrongCount: 0,
          confidenceCalibration: null,
          reviewRequiredItems: [],
          errorReason: redactSecrets(err instanceof Error ? err.message : String(err))
        });
      }
    }

    await ctx.close();
  } finally {
    await browser.close();
  }

  const anyTested = models.some(m => m.status === 'TESTED');
  const allTested = models.length > 0 && models.every(m => m.status === 'TESTED');

  return {
    executedAt,
    status: allTested ? 'PASS' : anyTested ? 'PARTIAL' : 'BLOCKED',
    reason: allTested
      ? `Evaluated ${models.length} live configured model profile(s) on ${specs.length} permitted self-practice items (${objectiveSpecs.length} objective + ${essaySpecs.length} open-ended essays).`
      : 'One or more configured model profiles could not complete live API inference (check redacted errorReason).',
    sampleCount: specs.length,
    objectiveSampleCount: objectiveSpecs.length,
    essaySampleCount: essaySpecs.length,
    goldKeyProvenance,
    statisticalLimitations,
    models
  };
}
