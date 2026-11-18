/** Phase 3 & Phase 4 — Answer Quality Evaluation Framework
 * Separately measures extraction accuracy, option mapping accuracy, supported type coverage,
 * objective exact-match gold correctness, independent non-LLM open-ended essay rubric evaluation,
 * abstention rate, confidence calibration (ECE & Wilson 95% CI), unsupported detection,
 * low-confidence review flagging, live DOM verification, and false completion rate.
 *
 * Explicitly separates 5 distinct states per item:
 *   1. schemaValid    — structurally valid JSON answer referencing scanned IDs
 *   2. grounded       — non-empty answer grounded in extracted options/prompt (and not answering unsupported/humanOnly)
 *   3. goldCorrect    — matches tester-supplied gold practice answer key or independent essay rubric (NEVER inferred from model confidence!)
 *   4. domVerified    — verified on live browser DOM after fillAnswer()
 *   5. serverRecorded — confirmed ONLY when backed by explicit server HTTP/session persistence evidence
 */
import type { Page, Frame } from 'playwright';
import type { Question, Answer } from '../types.js';
import { checkAnswers } from '../ai.js';
import { fillAnswer } from '../fill.js';

export interface EssayConceptRule {
  conceptId: string;
  description: string;
  /** Deterministic phrases or regexes matching valid phrasings of this concept (never graded by an LLM). */
  acceptedPatterns: (string | RegExp)[];
}

export interface IndependentEssayRubric {
  rubricId: string;
  requiredConcepts: EssayConceptRule[];
  /** Defaults to `requiredConcepts.length` (all concepts required). */
  minConceptsRequired?: number;
  /** Factual contradictions / misconceptions that fail the rubric even if required keywords appear. */
  forbiddenMisconceptions?: { reason: string; pattern: string | RegExp }[];
  minWordCount?: number;
  maxWordCount?: number;
}

export interface EssayRubricEvaluationResult {
  rubricId: string;
  passed: boolean;
  matchedConceptIds: string[];
  missingConceptIds: string[];
  triggeredMisconceptions: string[];
  conceptCoverageRatio: number;
  wordCount: number;
  /** Open-ended essays ALWAYS require human learner review before submission, regardless of rubric pass. */
  requiresHumanReview: true;
}

export interface ConfidenceCalibrationSummary {
  evaluatedWithConfidenceCount: number;
  meanConfidence: number | null;
  meanConfidenceOnCorrect: number | null;
  meanConfidenceOnWrong: number | null;
  /** 5-bin Expected Calibration Error across [0.0..1.0]. */
  expectedCalibrationError: number | null;
  overconfidentWrongCount: number;
  abstentionCount: number;
  abstentionRate: number;
  objectiveWilson95CI: { lower: number; upper: number } | null;
}

export interface EssayBenchmarkSummary {
  essaySampleCount: number;
  essayExactMatchCount: number;
  essayIndependentRubricEvaluatedCount: number;
  essayIndependentRubricPassCount: number;
  essayHumanReviewRequiredCount: number;
}

export interface GoldPracticeKey {
  /** Expected selected option text(s) for radio/checkbox/select (order-independent, survives option shuffling). */
  optionTexts?: string[];
  /** Expected normalized text for text/textarea, or numeric value when numericTolerance is set. */
  text?: string;
  /** Optional numeric tolerance for numerical questions. */
  numericTolerance?: number;
  /** Optional accepted text synonyms/variants for short-answer/essay practice keys. */
  acceptedTexts?: string[];
  /** Marks open-ended free-response essay items whose quality cannot be reduced to exact string equality alone. */
  isOpenEndedEssay?: boolean;
  /** Deterministic, human-authored concept + misconception rubric (never evaluated by the model under test). */
  essayRubric?: IndependentEssayRubric;
  /** Marks items that MUST NOT be auto-answered (unsupported question type or human-only audio/speech). */
  expectUnsupportedOrHumanOnly?: boolean;
}

export interface ItemValidityTiers {
  id: string;
  stableId?: string;
  sourceType?: string;
  kind: Question['kind'];
  evaluationCategory: 'objective' | 'open_ended_essay' | 'unsupported_or_human_only';
  humanOnly: boolean;
  abstained: boolean;
  requiresHumanReview: boolean;
  selfReportedConfidence?: number;
  lowConfidenceFlagged: boolean;
  /** Tier 1: Valid JSON answer structure matching scanned question/option IDs */
  schemaValid: boolean;
  /** Tier 2: Grounded in extracted question/options without violating unsupported/humanOnly guards */
  grounded: boolean;
  /** Exact normalized gold key match (kept distinct from semantic essay rubric pass) */
  exactMatch: boolean | null;
  /** Independent deterministic essay rubric result when item is an open-ended essay with `essayRubric` */
  essayRubricResult?: EssayRubricEvaluationResult | null;
  /** Tier 3: Matches tester's gold practice key / independent rubric (independent of schemaValid and confidence) */
  goldCorrect: boolean | null;
  /** Tier 4: Live browser DOM control reflects the filled answer */
  domVerified: boolean;
  /** Tier 5: Server HTTP response/draft state confirmed persistence */
  serverRecorded: boolean;
  notes: string[];
}

export interface TaskCompletionAuditCase {
  taskId: string;
  hasUnsupportedOrHumanOnly: boolean;
  hasMissingOrUnverifiedFill: boolean;
  hasUnvisitedPages: boolean;
  reportedReadyForReview: boolean;
  autoSubmitted: boolean;
}

export interface AnswerQualityMetrics {
  /** 1. Question extraction accuracy (exact match vs expected fixture questions) */
  questionExtractionAccuracy: number;
  extractedMatchedCount: number;
  extractedExpectedCount: number;

  /** 2. Option mapping accuracy (selected option IDs resolve to intended option texts, including shuffled seeds) */
  optionMappingAccuracy: number;
  optionMappedCorrectCount: number;
  optionMappingTotalCount: number;

  /** 3. Supported question type coverage (distinct supported types / total distinct LMS types evaluated) */
  supportedQuestionTypeCoverage: number;
  supportedTypes: string[];
  unsupportedTypes: string[];

  /** 4. Answer correctness vs gold practice key (strictly independent of JSON validity & model confidence) */
  answerCorrectness: number;
  goldCorrectCount: number;
  goldTotalAnswerableCount: number;
  /** Objective-only exact-match accuracy (kept strictly separate from open-ended essay items) */
  objectiveAnswerCorrectness: number;
  objectiveCorrectCount: number;
  objectiveTotalCount: number;
  /** Open-ended essay evaluation summary (always requires human review) */
  essayEvaluation: EssayBenchmarkSummary;
  /** Confidence calibration, abstention count/rate, and Wilson 95% confidence interval */
  confidenceCalibration: ConfidenceCalibrationSummary;
  abstentionCount: number;
  abstentionRate: number;
  statisticalLimitations: string[];
  schemaValidRate: number;
  meanSelfReportedConfidence: number | null;
  overconfidentErrorCount: number;

  /** 5. Unsupported & human-only detection accuracy */
  unsupportedDetectionAccuracy: number;
  unsupportedRecall: number;
  unsupportedTruePositives: number;
  unsupportedExpectedPositives: number;

  /** 6. Low-confidence review rate (items with confidence < threshold flagged for human review) */
  lowConfidenceReviewRate: number;
  lowConfidenceFlaggedCount: number;
  lowConfidenceTotalCount: number;

  /** 7. DOM verification success rate (live DOM read-back after fillAnswer) */
  domVerificationSuccessRate: number;
  domVerifiedCount: number;
  domAttemptedCount: number;

  /** 8. False completion rate (tasks falsely reported READY_FOR_REVIEW or auto-submitted despite gaps) */
  falseCompletionRate: number;
  falseCompletionCount: number;
  incompleteTaskCaseCount: number;

  /** Server persistence confirmation count (kept strictly separate from DOM verification) */
  serverRecordedCount: number;
}

export interface AnswerQualityReport {
  metrics: AnswerQualityMetrics;
  items: ItemValidityTiers[];
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchesPattern(normalizedCandidate: string, rawCandidate: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') {
    return normalizedCandidate.includes(norm(pattern));
  }
  const safeFlags = pattern.flags.replace(/g/g, '');
  const re = new RegExp(pattern.source, safeFlags);
  return re.test(rawCandidate) || re.test(normalizedCandidate);
}

/** Deterministic, non-LLM evaluation of an open-ended essay against human-authored concept & misconception rules. */
export function evaluateEssayWithIndependentRubric(
  candidateText: string,
  rubric: IndependentEssayRubric
): EssayRubricEvaluationResult {
  const raw = (candidateText || '').trim();
  const normalized = norm(raw);
  const words = raw ? raw.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;

  const matchedConceptIds: string[] = [];
  const missingConceptIds: string[] = [];

  for (const concept of rubric.requiredConcepts) {
    const hit = concept.acceptedPatterns.some(p => matchesPattern(normalized, raw, p));
    if (hit) matchedConceptIds.push(concept.conceptId);
    else missingConceptIds.push(concept.conceptId);
  }

  const triggeredMisconceptions: string[] = [];
  for (const mis of rubric.forbiddenMisconceptions || []) {
    if (matchesPattern(normalized, raw, mis.pattern)) {
      triggeredMisconceptions.push(mis.reason);
    }
  }

  const minRequired = rubric.minConceptsRequired ?? rubric.requiredConcepts.length;
  const wordBoundsOk =
    (rubric.minWordCount === undefined || wordCount >= rubric.minWordCount) &&
    (rubric.maxWordCount === undefined || wordCount <= rubric.maxWordCount);

  const passed =
    raw.length > 0 &&
    wordBoundsOk &&
    matchedConceptIds.length >= minRequired &&
    triggeredMisconceptions.length === 0;

  return {
    rubricId: rubric.rubricId,
    passed,
    matchedConceptIds,
    missingConceptIds,
    triggeredMisconceptions,
    conceptCoverageRatio: rubric.requiredConcepts.length
      ? matchedConceptIds.length / rubric.requiredConcepts.length
      : 0,
    wordCount,
    requiresHumanReview: true
  };
}

/** Exact Wilson score 95% confidence interval (`z = 1.959964`) to expose small-sample uncertainty honestly. */
export function computeWilson95CI(successes: number, total: number): { lower: number; upper: number } | null {
  if (total <= 0 || successes < 0 || successes > total) return null;
  const z = 1.959964;
  const z2 = z * z;
  const p = successes / total;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return {
    lower: Math.max(0, Number((center - halfWidth).toFixed(4))),
    upper: Math.min(1, Number((center + halfWidth).toFixed(4)))
  };
}

/** Computes confidence calibration (mean confidence on correct vs wrong, 5-bin ECE, overconfidence, abstentions). */
export function computeConfidenceCalibration(args: {
  observations: { confidence?: number; correct: boolean | null; abstained: boolean }[];
  objectiveCorrectCount: number;
  objectiveTotalCount: number;
}): ConfidenceCalibrationSummary {
  const { observations, objectiveCorrectCount, objectiveTotalCount } = args;
  const withConf = observations.filter(
    (o): o is { confidence: number; correct: boolean | null; abstained: boolean } =>
      typeof o.confidence === 'number' && Number.isFinite(o.confidence)
  );
  const scoredWithConf = withConf.filter(
    (o): o is { confidence: number; correct: boolean; abstained: boolean } => typeof o.correct === 'boolean'
  );

  const mean = (vals: number[]): number | null =>
    vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

  const meanConfidence = mean(withConf.map(o => o.confidence));
  const meanConfidenceOnCorrect = mean(scoredWithConf.filter(o => o.correct).map(o => o.confidence));
  const meanConfidenceOnWrong = mean(scoredWithConf.filter(o => !o.correct).map(o => o.confidence));
  const overconfidentWrongCount = scoredWithConf.filter(o => !o.correct && o.confidence >= 0.8).length;

  let expectedCalibrationError: number | null = null;
  if (scoredWithConf.length > 0) {
    const bins = 5;
    let ece = 0;
    for (let b = 0; b < bins; b++) {
      const lo = b / bins;
      const hi = (b + 1) / bins;
      const inBin = scoredWithConf.filter(o =>
        b === bins - 1 ? o.confidence >= lo && o.confidence <= hi : o.confidence >= lo && o.confidence < hi
      );
      if (!inBin.length) continue;
      const avgConf = inBin.reduce((s, o) => s + o.confidence, 0) / inBin.length;
      const avgAcc = inBin.filter(o => o.correct).length / inBin.length;
      ece += (inBin.length / scoredWithConf.length) * Math.abs(avgAcc - avgConf);
    }
    expectedCalibrationError = Number(ece.toFixed(4));
  }

  const abstentionCount = observations.filter(o => o.abstained).length;
  const abstentionRate = observations.length ? abstentionCount / observations.length : 0;

  return {
    evaluatedWithConfidenceCount: withConf.length,
    meanConfidence,
    meanConfidenceOnCorrect,
    meanConfidenceOnWrong,
    expectedCalibrationError,
    overconfidentWrongCount,
    abstentionCount,
    abstentionRate,
    objectiveWilson95CI: computeWilson95CI(objectiveCorrectCount, objectiveTotalCount)
  };
}

/** Evaluates exact match against a gold practice answer key (never reading `answer.confidence`). */
export function matchesExactGoldKey(question: Question, answer: Answer | undefined, gold: GoldPracticeKey): boolean {
  if (gold.expectUnsupportedOrHumanOnly) {
    return answer === undefined;
  }
  if (!answer) return false;

  if (question.kind === 'radio' || question.kind === 'checkbox' || question.kind === 'select') {
    if (!gold.optionTexts || !Array.isArray(answer.selected)) return false;
    const selectedTexts = answer.selected
      .map(id => question.options.find(o => o.id === id)?.text)
      .filter((t): t is string => typeof t === 'string')
      .map(norm)
      .sort();
    const expectedTexts = gold.optionTexts.map(norm).sort();
    if (selectedTexts.length !== expectedTexts.length) return false;
    return selectedTexts.every((t, i) => t === expectedTexts[i]);
  }

  const candidate = (answer.text ?? '').trim();
  if (!candidate) return false;
  if (gold.numericTolerance !== undefined && gold.text !== undefined) {
    const aNum = Number(candidate.replace(',', '.'));
    const gNum = Number(gold.text.replace(',', '.'));
    return Number.isFinite(aNum) && Number.isFinite(gNum) && Math.abs(aNum - gNum) <= gold.numericTolerance;
  }

  const accepted = [
    ...(gold.text !== undefined ? [gold.text] : []),
    ...(gold.acceptedTexts || [])
  ].map(norm);
  if (!accepted.length) return false;
  return accepted.includes(norm(candidate));
}

/** Evaluates a single candidate answer against a gold practice answer key or independent essay rubric (never reading `answer.confidence`). */
export function matchesGoldAnswer(question: Question, answer: Answer | undefined, gold: GoldPracticeKey): boolean {
  if (gold.expectUnsupportedOrHumanOnly) {
    return answer === undefined;
  }
  if (!answer) return false;
  const exact = matchesExactGoldKey(question, answer, gold);
  if (gold.essayRubric) {
    const rubricRes = evaluateEssayWithIndependentRubric(answer.text ?? '', gold.essayRubric);
    // If an independent essay rubric is configured, misconception rules also guard exact/paraphrased answers
    if (rubricRes.triggeredMisconceptions.length > 0) return false;
    return exact || rubricRes.passed;
  }
  return exact;
}

/** Independently reads back live DOM state to verify a filled answer without trusting fillAnswer's return value alone. */
export async function verifyDomFillReadback(target: Page | Frame, question: Question, answer: Answer): Promise<boolean> {
  if (question.kind === 'unsupported' || question.humanOnly) return false;

  if (question.kind === 'radio' || question.kind === 'checkbox') {
    const expected = new Set(answer.selected || []);
    if (!expected.size) return false;
    for (const opt of question.options) {
      const loc = target.locator(`[data-atqa-choice="${opt.id}"]`);
      if (await loc.count() !== 1) return false;
      const checked = await loc.evaluate(el =>
        el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true'
      );
      if (expected.has(opt.id) !== checked) return false;
    }
    return true;
  }

  if (question.kind === 'select') {
    const chosenId = answer.selected?.[0];
    const opt = question.options.find(o => o.id === chosenId);
    if (!opt) return false;
    const loc = target.locator(`[data-atqa-id="${question.id}"]`).first();
    if (await loc.count() !== 1) return false;
    return loc.evaluate((el, expectedText) => {
      if (el instanceof HTMLSelectElement) {
        const s = el.options[el.selectedIndex];
        return Boolean(s && s.value !== '' && (s.text.replace(/\s+/g, ' ').trim() === expectedText));
      }
      return (el.textContent || '').includes(expectedText);
    }, opt.text);
  }

  if (question.kind === 'text' || question.kind === 'textarea') {
    const loc = target.locator(`[data-atqa-id="${question.id}"]`).first();
    if (await loc.count() !== 1) return false;
    const actual = await loc.evaluate(el =>
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent || '')
    );
    return actual === (answer.text || '');
  }

  return false;
}

/** Maps an intended option text selection onto the current scanned Question's option IDs (survives option shuffling). */
export function mapOptionTextsToIds(question: Question, desiredTexts: string[]): { ids: string[]; allMapped: boolean } {
  const ids: string[] = [];
  for (const desired of desiredTexts) {
    const found = question.options.find(o => norm(o.text) === norm(desired));
    if (found) ids.push(found.id);
  }
  return { ids, allMapped: ids.length === desiredTexts.length && desiredTexts.length > 0 };
}

export interface BenchmarkPageRun {
  target: Page | Frame;
  questions: Question[];
  rawModelPayload: unknown;
  goldById: Record<string, GoldPracticeKey>;
  /** Intended option texts the responder aimed to select (to measure option-ID mapping accuracy separately). */
  intendedOptionTextsById?: Record<string, string[]>;
  /** Question IDs confirmed persisted by an actual HTTP server response (default empty on static fixtures). */
  serverConfirmedIds?: Set<string>;
}

export async function evaluateAnswerQuality(args: {
  extractionMatched: number;
  extractionExpected: number;
  evaluatedTypeCatalog: { type: string; supported: boolean }[];
  pageRuns: BenchmarkPageRun[];
  completionCases: TaskCompletionAuditCase[];
  lowConfidenceThreshold?: number;
}): Promise<AnswerQualityReport> {
  const threshold = args.lowConfidenceThreshold ?? 0.6;
  const items: ItemValidityTiers[] = [];

  let optionMappedCorrectCount = 0;
  let optionMappingTotalCount = 0;
  let schemaValidCount = 0;
  let schemaEligibleCount = 0;
  let goldCorrectCount = 0;
  let goldTotalAnswerableCount = 0;
  let objectiveCorrectCount = 0;
  let objectiveTotalCount = 0;
  let essaySampleCount = 0;
  let essayExactMatchCount = 0;
  let essayIndependentRubricEvaluatedCount = 0;
  let essayIndependentRubricPassCount = 0;
  let essayHumanReviewRequiredCount = 0;
  let overconfidentErrorCount = 0;
  const confidences: number[] = [];
  const calibrationObs: { confidence?: number; correct: boolean | null; abstained: boolean }[] = [];

  let unsupportedTruePositives = 0;
  let unsupportedTrueNegatives = 0;
  let unsupportedExpectedPositives = 0;
  let totalClassificationItems = 0;

  let lowConfidenceFlaggedCount = 0;
  let lowConfidenceTotalCount = 0;

  let domVerifiedCount = 0;
  let domAttemptedCount = 0;
  let serverRecordedCount = 0;

  for (const run of args.pageRuns) {
    const actionable = run.questions.filter(q => q.kind !== 'unsupported' && !q.humanOnly);
    let validatedAnswers: Answer[] = [];
    try {
      validatedAnswers = checkAnswers(run.rawModelPayload, actionable);
    } catch {
      const rawArr = Array.isArray((run.rawModelPayload as { answers?: unknown[] })?.answers)
        ? ((run.rawModelPayload as { answers: unknown[] }).answers)
        : [];
      for (const q of actionable) {
        const candidate = rawArr.find((x: any) => x && typeof x === 'object' && x.id === q.id);
        if (!candidate) continue;
        try {
          validatedAnswers.push(...checkAnswers({ answers: [candidate] }, [q]));
        } catch {}
      }
    }
    const byId = new Map(validatedAnswers.map(a => [a.id, a]));
    const rawArr = Array.isArray((run.rawModelPayload as { answers?: unknown[] })?.answers)
      ? ((run.rawModelPayload as { answers: any[] }).answers)
      : [];

    for (const q of run.questions) {
      const gold = run.goldById[q.id];
      const isDetectedUnsupportedOrHuman = q.kind === 'unsupported' || Boolean(q.humanOnly);
      const expectUnsupported = Boolean(gold?.expectUnsupportedOrHumanOnly);
      const notes: string[] = [];

      totalClassificationItems++;
      if (expectUnsupported) {
        unsupportedExpectedPositives++;
        if (isDetectedUnsupportedOrHuman) unsupportedTruePositives++;
        else notes.push('Missed unsupported/human-only detection');
      } else if (!isDetectedUnsupportedOrHuman) {
        unsupportedTrueNegatives++;
      } else {
        notes.push('False-positive unsupported classification on supported item');
      }

      const rawCandidate = rawArr.find(x => x && typeof x === 'object' && x.id === q.id);
      const validated = byId.get(q.id);

      if (isDetectedUnsupportedOrHuman) {
        const leakedAnswer = Boolean(validated);
        items.push({
          id: q.id,
          stableId: q.stableId,
          sourceType: q.sourceType,
          kind: q.kind,
          evaluationCategory: 'unsupported_or_human_only',
          humanOnly: Boolean(q.humanOnly),
          abstained: !leakedAnswer,
          requiresHumanReview: true,
          lowConfidenceFlagged: false,
          schemaValid: !leakedAnswer,
          grounded: !leakedAnswer,
          exactMatch: null,
          essayRubricResult: null,
          goldCorrect: expectUnsupported ? !leakedAnswer : false,
          domVerified: false,
          serverRecorded: false,
          notes: leakedAnswer ? ['ERROR: Model answer accepted for unsupported/human-only item'] : ['Correctly withheld from AI auto-fill']
        });
        continue;
      }

      schemaEligibleCount++;
      const schemaValid = Boolean(validated);
      if (schemaValid) schemaValidCount++;

      const conf = validated?.confidence ?? (typeof rawCandidate?.confidence === 'number' ? rawCandidate.confidence : undefined);
      if (typeof conf === 'number') confidences.push(conf);

      const isLowConf = typeof conf === 'number' && conf < threshold;
      const lowConfidenceFlagged = Boolean(validated && typeof validated.confidence === 'number' && validated.confidence < threshold);
      if (isLowConf) {
        lowConfidenceTotalCount++;
        if (lowConfidenceFlagged) lowConfidenceFlaggedCount++;
      }

      const grounded = Boolean(
        validated &&
        ((['radio', 'checkbox', 'select'].includes(q.kind) &&
          validated.selected?.length &&
          validated.selected.every(id => q.options.some(o => o.id === id))) ||
         (['text', 'textarea'].includes(q.kind) && typeof validated.text === 'string' && validated.text.trim().length > 0))
      );

      const abstained = !validated || !grounded;

      const intendedTexts = run.intendedOptionTextsById?.[q.id];
      if (intendedTexts && ['radio', 'checkbox', 'select'].includes(q.kind)) {
        optionMappingTotalCount++;
        const actualTexts = (validated?.selected || [])
          .map(id => q.options.find(o => o.id === id)?.text)
          .filter((t): t is string => typeof t === 'string')
          .map(norm)
          .sort();
        const expTexts = intendedTexts.map(norm).sort();
        if (actualTexts.length === expTexts.length && actualTexts.every((t, i) => t === expTexts[i])) {
          optionMappedCorrectCount++;
        } else {
          notes.push(`Option mapping mismatch: intended ${JSON.stringify(intendedTexts)}, got ${JSON.stringify(actualTexts)}`);
        }
      }

      const isEssayItem = Boolean(
        gold?.isOpenEndedEssay ||
        gold?.essayRubric ||
        q.sourceType === 'moodle:essay' ||
        q.kind === 'textarea'
      );
      const evaluationCategory: 'objective' | 'open_ended_essay' = isEssayItem ? 'open_ended_essay' : 'objective';

      let exactMatch: boolean | null = null;
      let essayRubricResult: EssayRubricEvaluationResult | null = null;
      let goldCorrect: boolean | null = null;

      if (gold && !gold.expectUnsupportedOrHumanOnly) {
        goldTotalAnswerableCount++;
        exactMatch = matchesExactGoldKey(q, validated, gold);
        if (gold.essayRubric) {
          essayIndependentRubricEvaluatedCount++;
          essayRubricResult = evaluateEssayWithIndependentRubric(validated?.text ?? '', gold.essayRubric);
          if (essayRubricResult.passed) essayIndependentRubricPassCount++;
          if (essayRubricResult.triggeredMisconceptions.length > 0) {
            notes.push(`Essay rubric misconception: ${essayRubricResult.triggeredMisconceptions.join('; ')}`);
          }
          if (!exactMatch && essayRubricResult.passed) {
            notes.push('Paraphrased essay passed independent concept rubric (non-exact string match; human review mandatory)');
          }
        }
        goldCorrect = matchesGoldAnswer(q, validated, gold);

        if (isEssayItem) {
          essaySampleCount++;
          essayHumanReviewRequiredCount++;
          if (exactMatch) essayExactMatchCount++;
        } else {
          objectiveTotalCount++;
          if (goldCorrect) objectiveCorrectCount++;
        }

        if (goldCorrect) {
          goldCorrectCount++;
        } else if (typeof conf === 'number' && conf >= 0.8) {
          overconfidentErrorCount++;
          notes.push(`Overconfident wrong answer (self-reported confidence=${conf.toFixed(2)})`);
        }
      }

      calibrationObs.push({ confidence: conf, correct: goldCorrect, abstained });

      let domVerified = false;
      if (validated) {
        domAttemptedCount++;
        try {
          await fillAnswer(run.target, q, validated);
          domVerified = await verifyDomFillReadback(run.target, q, validated);
          if (domVerified) domVerifiedCount++;
          else notes.push('DOM readback did not match filled answer');
        } catch (err) {
          notes.push(`fillAnswer threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const serverRecorded = Boolean(domVerified && run.serverConfirmedIds?.has(q.id));
      if (serverRecorded) serverRecordedCount++;

      items.push({
        id: q.id,
        stableId: q.stableId,
        sourceType: q.sourceType,
        kind: q.kind,
        evaluationCategory,
        humanOnly: false,
        abstained,
        requiresHumanReview: isEssayItem || lowConfidenceFlagged || abstained,
        selfReportedConfidence: conf,
        lowConfidenceFlagged,
        schemaValid,
        grounded,
        exactMatch,
        essayRubricResult,
        goldCorrect,
        domVerified,
        serverRecorded,
        notes
      });
    }
  }

  const supportedTypes = args.evaluatedTypeCatalog.filter(t => t.supported).map(t => t.type);
  const unsupportedTypes = args.evaluatedTypeCatalog.filter(t => !t.supported).map(t => t.type);

  const incompleteCases = args.completionCases.filter(
    c => c.hasUnsupportedOrHumanOnly || c.hasMissingOrUnverifiedFill || c.hasUnvisitedPages
  );
  const falseCompletionCount = incompleteCases.filter(
    c => c.reportedReadyForReview || c.autoSubmitted
  ).length;

  const confidenceCalibration = computeConfidenceCalibration({
    observations: calibrationObs,
    objectiveCorrectCount,
    objectiveTotalCount
  });

  const statisticalLimitations: string[] = [
    `Answerable sample size is n=${goldTotalAnswerableCount} (objective n=${objectiveTotalCount}, open-ended essay n=${essaySampleCount}); Wilson 95% CI shows finite-sample uncertainty and must not be extrapolated to all courses.`,
    'Deterministic pipeline harness uses a fixed test payload to verify DOM extraction/mapping/fill guards and does NOT measure real LLM reasoning accuracy.',
    'Open-ended essay items cannot be fully validated by exact string equality; even when an independent concept rubric passes, human learner review before submission remains mandatory.'
  ];

  return {
    metrics: {
      questionExtractionAccuracy: args.extractionExpected ? args.extractionMatched / args.extractionExpected : 0,
      extractedMatchedCount: args.extractionMatched,
      extractedExpectedCount: args.extractionExpected,

      optionMappingAccuracy: optionMappingTotalCount ? optionMappedCorrectCount / optionMappingTotalCount : 0,
      optionMappedCorrectCount,
      optionMappingTotalCount,

      supportedQuestionTypeCoverage: args.evaluatedTypeCatalog.length
        ? supportedTypes.length / args.evaluatedTypeCatalog.length
        : 0,
      supportedTypes,
      unsupportedTypes,

      answerCorrectness: goldTotalAnswerableCount ? goldCorrectCount / goldTotalAnswerableCount : 0,
      goldCorrectCount,
      goldTotalAnswerableCount,
      objectiveAnswerCorrectness: objectiveTotalCount ? objectiveCorrectCount / objectiveTotalCount : 0,
      objectiveCorrectCount,
      objectiveTotalCount,
      essayEvaluation: {
        essaySampleCount,
        essayExactMatchCount,
        essayIndependentRubricEvaluatedCount,
        essayIndependentRubricPassCount,
        essayHumanReviewRequiredCount
      },
      confidenceCalibration,
      abstentionCount: confidenceCalibration.abstentionCount,
      abstentionRate: confidenceCalibration.abstentionRate,
      statisticalLimitations,
      schemaValidRate: schemaEligibleCount ? schemaValidCount / schemaEligibleCount : 0,
      meanSelfReportedConfidence: confidences.length
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : null,
      overconfidentErrorCount,

      unsupportedDetectionAccuracy: totalClassificationItems
        ? (unsupportedTruePositives + unsupportedTrueNegatives) / totalClassificationItems
        : 0,
      unsupportedRecall: unsupportedExpectedPositives
        ? unsupportedTruePositives / unsupportedExpectedPositives
        : 0,
      unsupportedTruePositives,
      unsupportedExpectedPositives,

      lowConfidenceReviewRate: lowConfidenceTotalCount
        ? lowConfidenceFlaggedCount / lowConfidenceTotalCount
        : 0,
      lowConfidenceFlaggedCount,
      lowConfidenceTotalCount,

      domVerificationSuccessRate: domAttemptedCount ? domVerifiedCount / domAttemptedCount : 0,
      domVerifiedCount,
      domAttemptedCount,

      falseCompletionRate: incompleteCases.length ? falseCompletionCount / incompleteCases.length : 0,
      falseCompletionCount,
      incompleteTaskCaseCount: incompleteCases.length,

      serverRecordedCount
    },
    items
  };
}
