/** Course section study-material (HTML/PDF/DOCX/PPTX) capture & keyword-ranked RAG chunking */
import type { Page } from 'playwright';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { extractLocalDocumentText } from '../documents.js';

function stripAccentsLower(raw: string): string {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export async function captureCourseSectionContext(page: Page, activityUrl: string): Promise<string | undefined> {
  return page.evaluate((targetUrl) => {
    let targetPath = targetUrl;
    try {
      const u = new URL(targetUrl, location.href);
      targetPath = u.pathname + u.search;
    } catch {}

    const anchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find(a => {
      if (a.href === targetUrl) return true;
      try {
        const au = new URL(a.href, location.href);
        return (au.pathname + au.search) === targetPath;
      } catch {
        return false;
      }
    });
    if (!anchor) return undefined;

    const section = anchor.closest('li.section, .course-section, [data-for="section"], .section');
    if (!section) return undefined;

    const clone = section.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.accesshide, .sr-only, script, style, .activity-completion, [data-region="completion-info"]').forEach(e => e.remove());
    // Prioritize lesson summary/description notes before full activity titles
    const summaryText = Array.from(clone.querySelectorAll('.summary, .contentwithoutlink, .course-description, .section-summary'))
      .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
    const fullText = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    const combined = summaryText && !fullText.startsWith(summaryText)
      ? `${summaryText} | ${fullText}`
      : fullText;
    return combined.length > 20 ? combined.slice(0, 2800) : undefined;
  }, activityUrl).catch(() => undefined);
}

/** Captures up to 3 attached slide/document files (PDF/DOCX/PPTX/TXT/MD) or Moodle resource/page/book/lesson materials as study context (RAG). */
export async function captureCourseSectionDocuments(page: Page, activityUrl: string): Promise<string | undefined> {
  const docLinks = await page.evaluate((targetUrl) => {
    let targetPath = targetUrl;
    try {
      const u = new URL(targetUrl, location.href);
      targetPath = u.pathname + u.search;
    } catch {}
    const anchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find(a =>
      a.href === targetUrl || a.getAttribute('href') === targetPath || (targetPath && a.href.includes(targetPath))
    );
    const scope = anchor?.closest('li.section, .course-section, [data-for="section"], .section, .topics > li, .weeks > li') || document.body;
    const files: { title: string; url: string; isHtmlLesson?: boolean; isMoodleWrapper?: boolean }[] = [];
    const pages: { title: string; url: string; isHtmlLesson?: boolean; isMoodleWrapper?: boolean }[] = [];

    const scopesToScan: Element[] = [scope];
    const sec0 = document.querySelector('li.section#section-0, [data-sectionid="0"]');
    if (sec0 && sec0 !== scope) scopesToScan.push(sec0);

    for (let sIdx = 0; sIdx < scopesToScan.length; sIdx++) {
      const curScope = scopesToScan[sIdx];
      // Only fall back to General Section 0 when target section yielded < 2 docs/resources
      if (sIdx > 0 && files.length + pages.length >= 2) break;
      curScope.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(a => {
        const href = a.href || '';
        const txt = (a.textContent || a.title || '').replace(/\s+/g, ' ').trim();
        if (!href || /\/mod\/(?:quiz|assign|forum)\//i.test(href)) return;
        const isDirectDoc = /\.(?:pdf|docx|pptx|txt|md|csv)(?:[?#]|$)|\/pluginfile\.php\/[^"']+\.(?:pdf|docx|pptx|txt|md|csv)/i.test(href);
        const isHtmlModule = /\/mod\/(?:page|book|lesson)\/view\.php/i.test(href);
        const isResourceWrapper = /\/mod\/(?:resource|folder)\/view\.php/i.test(href);
        const hasStudyKeyword = /slide|tài\s*liệu|bài\s*giảng|giáo\s*trình|bài\s*học|lý\s*thuyết|tóm\s*tắt/i.test(txt);
        const isVideoWrapper = /^\s*(?:video|clip|recording)\b/i.test(txt) || /\bvideo\s+(?:chương|tuần|bài|c\d+)/i.test(txt);

        if (isHtmlModule && txt.length >= 3 && !isVideoWrapper) {
          if (!pages.some(p => p.url === href)) pages.push({ title: txt.slice(0, 80), url: href, isHtmlLesson: true });
        } else if (isResourceWrapper && (sIdx === 0 || hasStudyKeyword) && txt.length >= 3 && !isVideoWrapper) {
          if (!files.some(f => f.url === href)) {
            files.push({ title: txt.slice(0, 80), url: href, isMoodleWrapper: true, isHtmlLesson: true });
          }
        } else if (isDirectDoc || (sIdx === 0 && hasStudyKeyword)) {
          if (!files.some(f => f.url === href)) files.push({ title: txt.slice(0, 80) || 'Tài liệu', url: href });
        }
      });
    }
    return [...files.slice(0, 2), ...pages.slice(0, 2)].slice(0, 3);
  }, activityUrl).catch(() => []);

  if (!docLinks || docLinks.length === 0) return undefined;

  const chunks: string[] = [];
  for (let i = 0; i < docLinks.length; i++) {
    const doc = docLinks[i];
    let tmpFile: string | undefined;
    try {
      let fetchUrl = doc.url;
      let resp = await page.context().request.get(fetchUrl, { timeout: 10000 });
      if (!resp.ok()) continue;
      let cType = String(resp.headers()['content-type'] || '').toLowerCase();

      // Moodle /mod/resource/view.php frequently returns an HTML wrapper linking/embedding pluginfile.php PDF/DOCX
      if (cType.includes('text/html') && doc.isMoodleWrapper) {
        const wrapperHtml = await resp.text();
        const innerMatch =
          wrapperHtml.match(/(?:href|src|data)\s*=\s*["']([^"']*\/pluginfile\.php\/[^"']+\.(?:pdf|docx|pptx|txt|md|csv)(?:\?[^"']*)?)["']/i) ||
          wrapperHtml.match(/(?:href|src|data)\s*=\s*["']([^"']*\/pluginfile\.php\/[^"']+)["']/i);
        if (innerMatch?.[1]) {
          try {
            const innerUrl = new URL(innerMatch[1].replace(/&amp;/g, '&'), fetchUrl).href;
            const innerResp = await page.context().request.get(innerUrl, { timeout: 10000 });
            if (innerResp.ok()) {
              fetchUrl = innerUrl;
              resp = innerResp;
              cType = String(resp.headers()['content-type'] || '').toLowerCase();
            }
          } catch {}
        }
        if (cType.includes('text/html') && !/\.txt|\.md/i.test(fetchUrl)) {
          const mainBlock = wrapperHtml.match(/<(?:div[^>]+id="region-main"|main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i)?.[1] || wrapperHtml;
          const plain = mainBlock
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 10000);
          if (plain.length > 60) {
            chunks.push(`[Bài giảng HTML: ${doc.title}] ${plain}`);
          }
          continue;
        }
      }

      if (cType.includes('text/html') && !/\.txt|\.md/i.test(fetchUrl)) {
        if (doc.isHtmlLesson) {
          const html = await resp.text();
          const mainBlock = html.match(/<(?:div[^>]+id="region-main"|main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i)?.[1] || html;
          const plain = mainBlock
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 10000);
          if (plain.length > 40) {
            chunks.push(`[Bài giảng HTML: ${doc.title}] ${plain}`);
          }
        }
        continue;
      }
      const rawExt = extname(new URL(fetchUrl).pathname).toLowerCase();
      const ext = ['.pdf', '.docx', '.pptx', '.txt', '.md', '.csv'].includes(rawExt)
        ? rawExt
        : (cType.includes('pdf') ? '.pdf' : (cType.includes('presentationml') ? '.pptx' : (cType.includes('wordprocessingml') ? '.docx' : (cType.includes('text/plain') ? '.txt' : ''))));
      if (!ext) continue;
      const buf = await resp.body();
      if (!buf || buf.length === 0 || buf.length > 12 * 1024 * 1024) continue;
      tmpFile = join(tmpdir(), `at-rag-${Date.now()}-${i}${ext}`);
      await writeFile(tmpFile, buf);
      const text = await extractLocalDocumentText(tmpFile, 12000);
      if (text.trim()) {
        chunks.push(`[Tài liệu: ${doc.title}] ${text.trim()}`);
      }
    } catch {
      // Ignore single unreadable attachment
    } finally {
      if (tmpFile) await unlink(tmpFile).catch(() => {});
    }
  }
  return chunks.length > 0 ? chunks.join('\n\n').slice(0, 24000) : undefined;
}

const RAG_STOPWORDS = new Set([
  'cua', 'la', 'va', 'trong', 'cac', 'mot', 'nhung', 'cho', 'voi', 'tu', 'den', 've', 'theo',
  'sau', 'day', 'nay', 'khi', 'nao', 'khong', 'duoc', 'hay', 'chon', 'dap', 'an', 'cau', 'hoi',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'which', 'are', 'was', 'were',
  'how', 'why', 'not', 'into', 'have', 'has', 'had', 'can', 'will', 'all', 'any', 'but', 'you'
]);

/**
 * Splits multi-document study context into structured segments (slides, paragraphs, sections)
 * and selects the highest keyword-overlapping chunks for the active question batch.
 */
export function selectRelevantStudyChunks(
  rawStudyContext: string | undefined,
  queryText: string,
  maxChars = 5400
): string | undefined {
  if (!rawStudyContext || !rawStudyContext.trim()) return undefined;
  const trimmed = rawStudyContext.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const tokenize = (s: string): string[] =>
    stripAccentsLower(s)
      .split(/[^a-z0-9_]+/)
      .filter(tok => tok.length >= 2 && !RAG_STOPWORDS.has(tok));

  const queryTokens = tokenize(queryText);
  if (queryTokens.length === 0) return trimmed.slice(0, maxChars);

  const uniqueQTokens = Array.from(new Set(queryTokens));
  const queryBigrams = new Set<string>();
  for (let i = 0; i + 1 < queryTokens.length; i++) {
    queryBigrams.add(`${queryTokens[i]} ${queryTokens[i + 1]}`);
  }

  // Split by blank lines or explicit slide/doc markers, subdividing oversized sections cleanly
  const normalized = trimmed.replace(/\n(?=\[(?:Slide|Tài liệu|Bài giảng)[^\]]*\])/g, '\n\n');
  const rawSegments = normalized.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (seg.length <= 950) {
      segments.push(seg);
      continue;
    }
    const sentences = seg.split(/(?<=[.!?。\n])\s+/);
    let cur = '';
    for (const sent of sentences) {
      if (cur && cur.length + sent.length + 1 > 850) {
        segments.push(cur);
        cur = sent.length > 850 ? sent.slice(0, 850) : sent;
      } else {
        cur = cur ? `${cur} ${sent}` : sent;
      }
    }
    if (cur) segments.push(cur);
  }

  if (segments.length <= 1) return trimmed.slice(0, maxChars);

  const scored = segments.map((text, idx) => {
    const segTokens = tokenize(text);
    const segSet = new Set(segTokens);
    let score = idx === 0 ? 1.5 : 0; // small bonus for document header / intro
    for (const qt of uniqueQTokens) {
      if (segSet.has(qt)) {
        score += 3;
      } else if (qt.length >= 4 && segTokens.some(st => st.includes(qt) || qt.includes(st))) {
        score += 1.5;
      }
    }
    if (queryBigrams.size > 0) {
      for (let i = 0; i + 1 < segTokens.length; i++) {
        if (queryBigrams.has(`${segTokens[i]} ${segTokens[i + 1]}`)) {
          score += 5;
        }
      }
    }
    return { idx, text, score };
  });

  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));

  const selected: { idx: number; text: string }[] = [];
  let usedLen = 0;
  for (const item of scored) {
    const sep = selected.length > 0 ? 2 : 0;
    if (usedLen + sep + item.text.length <= maxChars) {
      selected.push({ idx: item.idx, text: item.text });
      usedLen += sep + item.text.length;
    } else if (selected.length === 0) {
      selected.push({ idx: item.idx, text: item.text.slice(0, maxChars) });
      usedLen = maxChars;
      break;
    }
  }

  selected.sort((a, b) => a.idx - b.idx);
  return selected.map(s => s.text).join('\n\n');
}

/** Combines section text context and extracted RAG slide/document context for the target activity. */
export async function captureCombinedCourseSectionContext(page: Page, activityUrl: string): Promise<string | undefined> {
  const [sectionContext, docContext] = await Promise.all([
    captureCourseSectionContext(page, activityUrl),
    captureCourseSectionDocuments(page, activityUrl)
  ]);
  const parts = [sectionContext, docContext].filter((s): s is string => Boolean(s && s.trim()));
  return parts.length > 0 ? parts.join('\n').slice(0, 4200) : undefined;
}
