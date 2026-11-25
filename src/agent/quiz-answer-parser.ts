/** Answer parsing, option ID resolution, and truncated/LaTeX JSON recovery for Quiz Solver */
import type { Question, Answer, Option } from '../types.js';
import { extractJsonPayload } from '../utils/json.js';

export interface MappedAnswerMeta {
  answer: Answer;
  reasoning?: string;
  pythonCheck?: string;
  source: 'ai' | 'fallback';
}

export interface MappedAnswersResult {
  answers: Answer[];
  metaById: Record<string, MappedAnswerMeta>;
  matchedAiCount: number;
  fallbackCount: number;
  parseError?: string;
}

function normalizeChoiceText(raw: string): string {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripChoiceLabelPrefix(normText: string): string {
  return normText
    .replace(/^(?:đáp\s*án|option|choice|lựa\s*chọn)\s+/i, '')
    .replace(/^(?:[a-z]|[0-9]{1,2})\s*[\.\)\:\-]\s+/i, '')
    .trim();
}

/** Resolves a model choice reference (exact ID, letter A/B/C, 1-based index, value, or option text) to Option.id */
export function resolveOptionId(rawSel: unknown, options: Option[]): string | undefined {
  if (rawSel === undefined || rawSel === null || options.length === 0) return undefined;
  const rawStr = String(rawSel).trim();
  if (!rawStr) return undefined;

  // 1. Exact ID match (case-sensitive then case-insensitive)
  const exactId = options.find(o => o.id === rawStr);
  if (exactId) return exactId.id;
  const lowerId = options.find(o => o.id.toLowerCase() === rawStr.toLowerCase());
  if (lowerId) return lowerId.id;

  // 2. Literal value match if present and unambiguous
  const valueMatches = options.filter(o => o.value !== undefined && o.value === rawStr);
  if (valueMatches.length === 1) return valueMatches[0].id;

  const normInput = normalizeChoiceText(rawStr);
  const strippedInput = stripChoiceLabelPrefix(normInput);

  // 3. Literal exact option text match (checked BEFORE letter/numeric positional heuristics)
  const exactTextMatch = options.find(o => normalizeChoiceText(o.text) === normInput);
  if (exactTextMatch) return exactTextMatch.id;

  if (strippedInput) {
    const strippedMatches = options.filter(o => stripChoiceLabelPrefix(normalizeChoiceText(o.text)) === strippedInput);
    if (strippedMatches.length === 1) return strippedMatches[0].id;
  }

  // 4. Letter reference like "A", "B.", "Option C", "Đáp án B"
  const letterMatch = rawStr.match(/^(?:(?:đáp\s*án|dap\s*an|option|choice)\s+)?([A-Ha-h])(?:[\.\)\:\-])?$/);
  if (letterMatch) {
    const letter = letterMatch[1].toUpperCase();
    // Prefer an option explicitly labeled with this letter if present
    const explicitLabeled = options.filter(o => new RegExp(`^${letter}[\\.\\)\\:\\s-]`, 'i').test(o.text.trim()));
    if (explicitLabeled.length === 1) return explicitLabeled[0].id;
    const idx = letter.charCodeAt(0) - 65;
    if (idx >= 0 && idx < options.length) return options[idx].id;
  }

  // 5. 1-based numeric index like "1", "2" (when not literally matched as option text above)
  if (/^[0-9]{1,2}$/.test(rawStr)) {
    const idx = Number(rawStr) - 1;
    if (idx >= 0 && idx < options.length) return options[idx].id;
  }

  // 6. Unambiguous unique substring/prefix match only for sufficiently long strings (avoids "1" matching "10")
  if (strippedInput.length >= 4) {
    const containsMatches = options.filter(o => {
      const optNorm = stripChoiceLabelPrefix(normalizeChoiceText(o.text));
      return optNorm.length >= 4 && (optNorm.includes(strippedInput) || strippedInput.includes(optNorm));
    });
    if (containsMatches.length === 1) return containsMatches[0].id;
  }

  return undefined;
}

function extractCompleteAnswerObjectsFromTruncated(raw: string): any[] {
  const ansKeyMatch = raw.match(/"answers"\s*:\s*\[/);
  const startIdx = ansKeyMatch && ansKeyMatch.index !== undefined
    ? ansKeyMatch.index + ansKeyMatch[0].length
    : (raw.trimStart().startsWith('[') ? raw.indexOf('[') + 1 : 0);

  const items: any[] = [];
  let depth = 0;
  let objStart = -1;
  let lastConsumedEnd = startIdx;
  let inStr = false;
  let escaped = false;

  for (let i = startIdx; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && objStart >= 0) {
        const slice = raw.slice(objStart, i + 1);
        let parsed: any;
        try {
          parsed = JSON.parse(slice);
        } catch {
          try {
            parsed = JSON.parse(slice.replace(/\\(?!["\\/bfnrtu])/g, '\\\\'));
          } catch {}
        }
        if (parsed && typeof parsed === 'object' && (typeof parsed.id === 'string' || typeof parsed.questionId === 'string')) {
          items.push(parsed);
        }
        lastConsumedEnd = i + 1;
        objStart = -1;
      }
    }
  }

  // Also salvage a trailing partially-truncated item whose id + answer (or long essay text) already closed/started
  const tail = raw.slice(lastConsumedEnd);
  const idMatch = tail.match(/"(?:id|questionId)"\s*:\s*"([^"]+)"/);
  const selMatch = tail.match(/"selected"\s*:\s*(\[\s*"(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*\s*\])/);
  const txtMatch = tail.match(/"text"\s*:\s*"((?:[^"\\]|\\.)+)"/);
  const unclosedTxtMatch = !txtMatch ? tail.match(/"text"\s*:\s*"((?:[^"\\]|\\.)+)$/) : null;
  if (idMatch && (selMatch || txtMatch || (unclosedTxtMatch && unclosedTxtMatch[1].trim().length >= 60))) {
    try {
      const item: Record<string, any> = { id: idMatch[1] };
      if (selMatch) {
        let parsedSel: any;
        try {
          parsedSel = JSON.parse(selMatch[1]);
        } catch {
          parsedSel = JSON.parse(selMatch[1].replace(/\\(?!["\\/bfnrtu])/g, '\\\\'));
        }
        if (Array.isArray(parsedSel) && parsedSel.length > 0) item.selected = parsedSel;
      }
      if (txtMatch && txtMatch[1].trim()) {
        item.text = JSON.parse(`"${txtMatch[1]}"`);
      } else if (unclosedTxtMatch && unclosedTxtMatch[1].trim().length >= 60) {
        const rawBody = unclosedTxtMatch[1].replace(/\\+$/, '');
        try {
          item.text = JSON.parse(`"${rawBody}"`);
        } catch {
          item.text = rawBody.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
      }
      if (item.selected || item.text) {
        const pyMatch = tail.match(/"pythonCheck"\s*:\s*"((?:[^"\\]|\\.)+)"/);
        if (pyMatch) {
          try { item.pythonCheck = JSON.parse(`"${pyMatch[1]}"`); } catch {}
        }
        const confMatch = tail.match(/"confidence"\s*:\s*(0(?:\.\d+)?|1(?:\.0+)?)/);
        if (confMatch) item.confidence = Number(confMatch[1]);
        items.push(item);
      }
    } catch {}
  }

  const seen = new Set<string>();
  const unique: any[] = [];
  for (const it of items) {
    const key = String(it.id ?? it.questionId ?? '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(it);
  }
  return unique;
}

function repairLatexControlChars(raw: string): string {
  return raw
    .replace(/\f/g, '\\f')
    .replace(/\u0008/g, '\\b')
    .replace(/\t(?=(?:imes\b|heta\b|o(?:\s|$|[0-9\\])|ext\{|au\b|riangle|ilde))/gi, '\\t')
    .replace(/\r(?=(?:ho\b|ight\b|angle\b))/gi, '\\r')
    .replace(/\n(?=(?:eq(?![a-z])|abla\b|otin\b|leq\b|geq\b|approx\b))/gi, '\\n');
}

export function parseAnswersListFromRaw(rawOutput: string): { parsedList: any[]; parseError?: string } {
  const cleaned = extractJsonPayload(rawOutput);
  if (!cleaned) {
    return { parsedList: [], parseError: 'Empty AI response' };
  }

  try {
    const obj = JSON.parse(cleaned);
    const list = Array.isArray(obj) ? obj : (Array.isArray(obj?.answers) ? obj.answers : []);
    return { parsedList: list };
  } catch (err: any) {
    // Recovery A: Fix unescaped LaTeX backslashes inside JSON strings (e.g. \frac, \le, \infty)
    try {
      const escapedLatex = cleaned.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
      const obj = JSON.parse(escapedLatex);
      const list = Array.isArray(obj) ? obj : (Array.isArray(obj?.answers) ? obj.answers : []);
      if (list.length > 0) return { parsedList: list };
    } catch {}

    const match = cleaned.match(/\{[\s\S]*"answers"\s*:\s*(\[[\s\S]*?\])[\s\S]*\}/);
    if (match) {
      try {
        const list = JSON.parse(match[1]);
        if (Array.isArray(list)) return { parsedList: list };
      } catch {}
    }

    // Recovery B: Salvage complete objects + closed trailing item from truncated JSON batches
    const salvaged = extractCompleteAnswerObjectsFromTruncated(cleaned);
    if (salvaged.length > 0) {
      return { parsedList: salvaged };
    }

    return { parsedList: [], parseError: err?.message || 'JSON parse error' };
  }
}

function findMatchingModelEntry(parsedList: any[], q: Question, totalQuestions: number): any {
  const exact = parsedList.find((p: any) =>
    p && (
      p.id === q.id ||
      p.questionId === q.id ||
      (q.stableId && (p.id === q.stableId || p.questionId === q.stableId))
    )
  );
  if (exact) return exact;

  const qDigits = String(q.id).replace(/\D+/g, '');
  if (qDigits) {
    const digitMatches = parsedList.filter((p: any) => p && String(p.id ?? p.questionId ?? '').replace(/\D+/g, '') === qDigits);
    if (digitMatches.length === 1) return digitMatches[0];
  }

  if (totalQuestions === 1 && parsedList.length === 1 && parsedList[0] && typeof parsedList[0] === 'object') {
    return parsedList[0];
  }

  return undefined;
}

/** Parses model output and maps answers + reasoning cleanly onto scanned questions with explicit fallback tracking */
export function mapModelAnswersToQuestions(rawOutput: string, questions: Question[]): MappedAnswersResult {
  const { parsedList, parseError } = parseAnswersListFromRaw(rawOutput);
  const answers: Answer[] = [];
  const metaById: Record<string, MappedAnswerMeta> = {};
  let matchedAiCount = 0;
  let fallbackCount = 0;

  for (const q of questions) {
    const found = findMatchingModelEntry(parsedList, q, questions.length);
    const rawReasoning = found?.reasoning ?? found?.explanation ?? found?.reason ?? found?.thought;
    const reasoning = typeof rawReasoning === 'string' && rawReasoning.trim()
      ? repairLatexControlChars(rawReasoning).trim()
      : undefined;
    const pythonCheck = typeof found?.pythonCheck === 'string' && found.pythonCheck.trim()
      ? repairLatexControlChars(found.pythonCheck).trim().slice(0, 4000)
      : undefined;
    const rawConf = typeof found?.confidence === 'number' && Number.isFinite(found.confidence)
      ? Math.max(0, Math.min(1, found.confidence))
      : undefined;

    if (q.kind === 'radio' || q.kind === 'select') {
      const candidateRaw = found?.selected !== undefined
        ? (Array.isArray(found.selected) ? found.selected[0] : found.selected)
        : (found?.answer ?? found?.choice ?? found?.text);
      const selectedId = resolveOptionId(candidateRaw, q.options);
      const isAi = Boolean(found && selectedId);
      const finalId = selectedId || q.options[0]?.id;

      const ans: Answer = {
        id: q.id,
        selected: finalId ? [finalId] : undefined,
        confidence: isAi ? (rawConf ?? 0.85) : 0
      };
      answers.push(ans);
      metaById[q.id] = { answer: ans, reasoning, ...(pythonCheck ? { pythonCheck } : {}), source: isAi ? 'ai' : 'fallback' };
      if (isAi) matchedAiCount++;
      else fallbackCount++;
    } else if (q.kind === 'checkbox') {
      const rawArr: unknown[] = Array.isArray(found?.selected)
        ? found.selected
        : (Array.isArray(found?.answers) ? found.answers : (found?.selected ? [found.selected] : []));
      const mappedIds = rawArr
        .map((item: unknown) => resolveOptionId(item, q.options))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const selectedIds: string[] = Array.from(new Set<string>(mappedIds));
      const isAi = Boolean(found && selectedIds.length > 0);
      const finalIds: string[] = selectedIds.length > 0 ? selectedIds : (q.options.length > 0 ? [q.options[0].id] : []);

      const ans: Answer = {
        id: q.id,
        selected: finalIds,
        confidence: isAi ? (rawConf ?? 0.85) : 0
      };
      answers.push(ans);
      metaById[q.id] = { answer: ans, reasoning, ...(pythonCheck ? { pythonCheck } : {}), source: isAi ? 'ai' : 'fallback' };
      if (isAi) matchedAiCount++;
      else fallbackCount++;
    } else if (q.kind === 'ordering') {
      let order: string[] = [];
      let isAi = false;
      if (found && Array.isArray(found.selected)) {
        const rawOrder: unknown[] = found.selected;
        const mappedIds = rawOrder
          .map((item: unknown) => resolveOptionId(item, q.options))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const mapped: string[] = Array.from(new Set<string>(mappedIds));
        if (mapped.length === q.options.length) {
          order = mapped;
          isAi = true;
        }
      }
      if (!isAi) {
        order = q.options.map(o => o.id);
      }
      const ans: Answer = {
        id: q.id,
        selected: order,
        confidence: isAi ? (rawConf ?? 0.8) : 0
      };
      answers.push(ans);
      metaById[q.id] = { answer: ans, reasoning, ...(pythonCheck ? { pythonCheck } : {}), source: isAi ? 'ai' : 'fallback' };
      if (isAi) matchedAiCount++;
      else fallbackCount++;
    } else if (q.kind === 'dragdrop') {
      let placements: { itemId: string; zoneId: string }[] = [];
      let isAi = false;
      if (found && Array.isArray(found.placements) && q.zones?.length) {
        const resolved = found.placements
          .map((p: any) => ({
            itemId: resolveOptionId(p?.itemId, q.options),
            zoneId: resolveOptionId(p?.zoneId, q.zones || [])
          }))
          .filter((p: any): p is { itemId: string; zoneId: string } => Boolean(p.itemId && p.zoneId));
        if (resolved.length > 0) {
          placements = resolved;
          isAi = true;
        }
      }
      if (!isAi && q.zones && q.zones.length > 0 && q.options.length > 0) {
        placements = q.options.slice(0, q.zones.length).map((o, idx) => ({ itemId: o.id, zoneId: q.zones![idx].id }));
      }
      const ans: Answer = {
        id: q.id,
        placements,
        confidence: isAi ? (rawConf ?? 0.8) : 0
      };
      answers.push(ans);
      metaById[q.id] = { answer: ans, reasoning, ...(pythonCheck ? { pythonCheck } : {}), source: isAi ? 'ai' : 'fallback' };
      if (isAi) matchedAiCount++;
      else fallbackCount++;
    } else {
      const rawText = found?.code ?? found?.text ?? found?.answer ?? (typeof found?.selected === 'string' ? found.selected : undefined);
      const isAi = typeof rawText === 'string' && rawText.trim().length > 0;
      const textVal = isAi ? repairLatexControlChars(rawText).trim() : 'Câu trả lời tự động';
      const ans: Answer = {
        id: q.id,
        text: textVal,
        confidence: isAi ? (rawConf ?? 0.8) : 0
      };
      answers.push(ans);
      metaById[q.id] = { answer: ans, reasoning, ...(pythonCheck ? { pythonCheck } : {}), source: isAi ? 'ai' : 'fallback' };
      if (isAi) matchedAiCount++;
      else fallbackCount++;
    }
  }

  return { answers, metaById, matchedAiCount, fallbackCount, parseError };
}

/** Backwards-compatible wrapper returning sanitized Answer[] */
export function sanitizeAnswersForQuestions(rawOutput: string, questions: Question[]): Answer[] {
  return mapModelAnswersToQuestions(rawOutput, questions).answers;
}
