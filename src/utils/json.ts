/** Extracts the most plausible JSON object/array string from LLM output that may include reasoning prose or multiple fences. */
export function extractJsonPayload(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return trimmed;

  const fenceMatches = Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi));
  for (let i = fenceMatches.length - 1; i >= 0; i--) {
    const candidate = fenceMatches[i][1].trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep scanning earlier fences if this block wasn't valid JSON
    }
  }

  for (let i = fenceMatches.length - 1; i >= 0; i--) {
    const candidate = fenceMatches[i][1].trim();
    if (candidate.startsWith('{') || candidate.startsWith('[')) {
      return candidate;
    }
  }

  if (fenceMatches.length > 0) {
    return fenceMatches[fenceMatches.length - 1][1].trim();
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }

  // Fallback for unfenced CoT prose followed by a JSON object or array
  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const candidates: [number, string][] = [];
  if (firstObj !== -1) candidates.push([firstObj, '}']);
  if (firstArr !== -1) candidates.push([firstArr, ']']);
  candidates.sort((a, b) => a[0] - b[0]);

  for (const [startIdx, closeChar] of candidates) {
    const endIdx = trimmed.lastIndexOf(closeChar);
    if (endIdx > startIdx) {
      const slice = trimmed.slice(startIdx, endIdx + 1).trim();
      try {
        JSON.parse(slice);
        return slice;
      } catch {
        // Ignore non-JSON brace/bracket spans in prose
      }
    }
  }

  return trimmed;
}

/** Extracts and parses JSON from an LLM response string that may contain markdown code fences or CoT prose. */
export function parseExtractedJson<T = any>(raw: string): T {
  return JSON.parse(extractJsonPayload(raw)) as T;
}
