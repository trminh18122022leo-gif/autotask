/** Previous quiz attempt review scraper & snapshot merger for Moodle re-attempt intelligence */
import type { Page } from 'playwright';

export interface PreviousAttemptReviewItem {
  prompt: string;
  status: 'correct' | 'incorrect' | 'partial' | 'unknown';
  chosenAnswer?: string;
  chosenAnswers?: string[];
  rightAnswer?: string;
  feedback?: string;
  markText?: string;
  priorChosenSets?: string[];
}

export interface PriorQuizAttemptSnapshot {
  gradeText?: string;
  gradeNum?: number;
  answers: Array<{
    prompt: string;
    kind: string;
    chosen: string[];
    confidence?: number;
  }>;
}

export interface PreviousAttemptCaptureResult {
  items: PreviousAttemptReviewItem[];
  attemptScore?: string;
  reviewAttemptsChecked: number;
}

export function mergePriorAttemptSnapshotsIntoReview(
  domItems: PreviousAttemptReviewItem[],
  inMemoryPrior?: PriorQuizAttemptSnapshot[],
  domAttemptScore?: string
): PreviousAttemptCaptureResult | undefined {
  const map = new Map<string, PreviousAttemptReviewItem>();
  const normKey = (p: string) => p.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 140);

  for (const item of domItems) {
    const k = normKey(item.prompt);
    if (!k) continue;
    map.set(k, { ...item });
  }

  if (inMemoryPrior && inMemoryPrior.length > 0) {
    for (let sIdx = inMemoryPrior.length - 1; sIdx >= 0; sIdx--) {
      const snap = inMemoryPrior[sIdx];
      for (const a of snap.answers) {
        const k = normKey(a.prompt);
        if (!k || a.chosen.length === 0) continue;
        const chosenStr = a.chosen.join(' | ');
        let existing = Array.from(map.values()).find(it => {
          const ik = normKey(it.prompt);
          return ik === k || (k.length >= 24 && (ik.includes(k.slice(0, 40)) || k.includes(ik.slice(0, 40))));
        });
        if (!existing) {
          existing = {
            prompt: a.prompt,
            status: 'unknown',
            chosenAnswer: chosenStr,
            chosenAnswers: [...a.chosen],
            priorChosenSets: []
          };
          map.set(k, existing);
        }
        if (!existing.chosenAnswer) {
          existing.chosenAnswer = chosenStr;
          existing.chosenAnswers = [...a.chosen];
        }
        existing.priorChosenSets = existing.priorChosenSets || [];
        const label = snap.gradeText ? `[${snap.gradeText}] ${chosenStr}` : chosenStr;
        if (!existing.priorChosenSets.includes(label)) {
          existing.priorChosenSets.push(label);
        }
      }
    }
  }

  const items = Array.from(map.values());
  if (items.length === 0) return undefined;
  const fallbackScore = inMemoryPrior && inMemoryPrior.length > 0 ? inMemoryPrior[inMemoryPrior.length - 1].gradeText : undefined;
  return {
    items,
    attemptScore: domAttemptScore || fallbackScore,
    reviewAttemptsChecked: Math.max(domItems.length > 0 ? 1 : 0, inMemoryPrior?.length || 0)
  };
}

/** Extracts prior attempt feedback/answers across all pages of Moodle review.php before starting a re-attempt. */
export async function capturePreviousAttemptReview(
  page: Page,
  quizViewUrl: string,
  inMemoryPrior?: PriorQuizAttemptSnapshot[]
): Promise<PreviousAttemptCaptureResult | undefined> {
  const viewInfo = await page.evaluate(() => {
    const rawLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/mod/quiz/review.php"]')).map(a => a.href);
    const uniqueLinks: string[] = [];
    for (let i = 0; i < rawLinks.length; i++) {
      if (rawLinks[i] && !uniqueLinks.includes(rawLinks[i])) uniqueLinks.push(rawLinks[i]);
    }
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const gm = body.match(/(?:điểm\s*cao\s*nhất(?:\s*của\s*bạn)?|highest\s*grade|final\s*grade(?:\s*for\s*this\s*quiz)?|điểm\s*của\s*bạn|your\s*final\s*grade)\s*(?:is|là|:|=)?\s*([0-9]+(?:[.,][0-9]+)?\s*(?:\/|out\s*of|trên)\s*[0-9]+(?:[.,][0-9]+)?(?:\s*\([0-9.,]+%\))?)/i);
    return {
      reviewLinks: uniqueLinks.slice(-2).reverse(),
      viewGrade: gm ? gm[1].trim() : undefined
    };
  }).catch(() => ({ reviewLinks: [] as string[], viewGrade: undefined }));

  const scrapeCurrentReviewPage = async () => page.evaluate(() => {
    const showallAnchor = document.querySelector<HTMLAnchorElement>('a[href*="/mod/quiz/review.php"][href*="showall=1"]');
    const navPageLinks = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('.qn_buttons a.qnbutton[href*="page="], .quiznav a[href*="page="], .othernav a[href*="page="]')
    ).map(a => a.href).filter(Boolean);
    const uniquePages: string[] = [];
    for (let i = 0; i < navPageLinks.length; i++) {
      if (!uniquePages.includes(navPageLinks[i])) uniquePages.push(navPageLinks[i]);
    }

    let reviewGrade: string | undefined;
    const sumCells = document.querySelectorAll('table.quizreviewsummary tr, .quizreviewsummary tr');
    sumCells.forEach(tr => {
      const t = (tr.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(?:grade|điểm|marks|điểm\s*số)\b/i.test(t) && !reviewGrade) {
        reviewGrade = t.slice(0, 120);
      }
    });

    const blocks = Array.from(document.querySelectorAll('div.que'));
    const out: {
      prompt: string;
      status: 'correct' | 'incorrect' | 'partial' | 'unknown';
      chosenParts: string[];
      rightAnswer?: string;
      feedback?: string;
      markText?: string;
    }[] = [];

    for (let bi = 0; bi < blocks.length && bi < 35; bi++) {
      const b = blocks[bi];
      const qtextEl = b.querySelector('.qtext');
      let qText = '';
      if (qtextEl) {
        const qClone = qtextEl.cloneNode(true) as HTMLElement;
        qClone.querySelectorAll('.accesshide, .sr-only, script, style').forEach(el => el.remove());
        qText = (qClone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      }
      if (!qText) continue;

      const cls = (b.className || '').toLowerCase();
      const stateTxt = (b.querySelector('.state')?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const gradeTxt = (b.querySelector('.grade')?.textContent || '').replace(/\s+/g, ' ').trim();
      const statusSrc = `${cls} ${stateTxt}`;

      let status: 'correct' | 'incorrect' | 'partial' | 'unknown' = 'unknown';
      if (/\bpartiallycorrect\b|\bgradedpartial\b|\bpartial\b|đúng\s*một\s*phần|chính\s*xác\s*một\s*phần/i.test(statusSrc)) {
        status = 'partial';
      } else if (/\bincorrect\b|\bgradedwrong\b|không\s*chính\s*xác|chưa\s*đúng|\bsai\b|not\s*answered|chưa\s*trả\s*lời/i.test(statusSrc)) {
        status = 'incorrect';
      } else if (/\bcorrect\b|\bgradedright\b|chính\s*xác|\bđúng\b/i.test(statusSrc)) {
        status = 'correct';
      } else if (gradeTxt) {
        const gm = gradeTxt.match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:out\s*of|\/|trên)\s*([0-9]+(?:[.,][0-9]+)?)/i);
        if (gm) {
          const earned = parseFloat(gm[1].replace(',', '.'));
          const maxMark = parseFloat(gm[2].replace(',', '.'));
          if (Number.isFinite(earned) && Number.isFinite(maxMark) && maxMark > 0) {
            if (earned <= 0) status = 'incorrect';
            else if (earned >= maxMark - 1e-4) status = 'correct';
            else status = 'partial';
          }
        }
      }

      const chosenParts: string[] = [];
      b.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked, input[type="checkbox"]:checked').forEach(inp => {
        let lblEl: Element | null = null;
        const ariaIds = (inp.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
        let text = '';
        if (ariaIds.length > 0) {
          text = ariaIds.map(id => {
            const target = document.getElementById(id);
            if (!target) return '';
            const c = target.cloneNode(true) as HTMLElement;
            c.querySelectorAll('.accesshide, .sr-only').forEach(n => n.remove());
            return (c.textContent || '').replace(/\s+/g, ' ').trim();
          }).filter(Boolean).join(' ');
        }
        if (!text) {
          lblEl = inp.id ? b.querySelector(`label[for="${CSS.escape(inp.id)}"]`) : null;
          if (!lblEl) lblEl = inp.closest('label');
          if (!lblEl && inp.parentElement) {
            lblEl = inp.parentElement.querySelector('[data-region="answer-label"], .flex-fill, .ml-1') || inp.parentElement;
          }
          if (lblEl) {
            const c = lblEl.cloneNode(true) as HTMLElement;
            c.querySelectorAll('.accesshide, .sr-only, input, i.fa, span[role="img"]').forEach(n => n.remove());
            text = (c.textContent || '').replace(/\s+/g, ' ').trim();
          }
        }
        if (!text && inp.value && !/^(?:0|1|on)$/i.test(inp.value.trim())) {
          text = inp.value.trim();
        }
        if (text) chosenParts.push(text.slice(0, 220));
      });
      b.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[type="text"], textarea').forEach(inp => {
        if (inp.value && inp.value.trim()) chosenParts.push(inp.value.trim().slice(0, 200));
      });
      b.querySelectorAll<HTMLSelectElement>('select').forEach(sel => {
        const opt = sel.options[sel.selectedIndex];
        if (opt && opt.textContent?.trim()) chosenParts.push(opt.textContent.trim().slice(0, 150));
      });

      const rightRaw = (b.querySelector('.rightanswer')?.textContent || '').replace(/\s+/g, ' ').trim();
      const rightClean = rightRaw
        .replace(/^(?:the\s*correct\s*answers?\s*(?:is|are)|câu\s*trả\s*lời\s*đúng\s*là|đáp\s*án\s*đúng\s*là)\s*[:：]?\s*/i, '')
        .trim()
        .slice(0, 300);

      const fbRaw = (b.querySelector('.specificfeedback, .generalfeedback')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);

      out.push({
        prompt: qText,
        status,
        chosenParts,
        ...(rightClean ? { rightAnswer: rightClean } : {}),
        ...(fbRaw ? { feedback: fbRaw } : {}),
        ...(gradeTxt ? { markText: gradeTxt.slice(0, 60) } : {})
      });
    }

    return {
      showallHref: !/showall=1/i.test(location.href) ? (showallAnchor?.href || null) : null,
      pageUrls: uniquePages,
      reviewGrade,
      blocks: out
    };
  }).catch(() => ({ showallHref: null, pageUrls: [] as string[], reviewGrade: undefined, blocks: [] }));

  const domItemsMap = new Map<string, PreviousAttemptReviewItem>();
  let observedReviewGrade: string | undefined = viewInfo.viewGrade;

  if (viewInfo.reviewLinks.length > 0) {
    try {
      for (let rIdx = 0; rIdx < viewInfo.reviewLinks.length; rIdx++) {
        const revHref = viewInfo.reviewLinks[rIdx];
        await page.goto(revHref, { waitUntil: 'domcontentloaded', timeout: 15000 });
        let firstPage = await scrapeCurrentReviewPage();
        if (rIdx === 0 && firstPage.reviewGrade) {
          observedReviewGrade = firstPage.reviewGrade;
        }
        if (firstPage.showallHref) {
          await page.goto(firstPage.showallHref, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          firstPage = await scrapeCurrentReviewPage();
        }

        const collectedBlocks = [...firstPage.blocks];
        if (!firstPage.showallHref && firstPage.pageUrls.length > 0) {
          const visitedReviewUrls = new Set<string>([page.url()]);
          for (const pUrl of firstPage.pageUrls.slice(0, 14)) {
            if (visitedReviewUrls.has(pUrl)) continue;
            visitedReviewUrls.add(pUrl);
            try {
              await page.goto(pUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
              const pData = await scrapeCurrentReviewPage();
              collectedBlocks.push(...pData.blocks);
            } catch {}
          }
        }

        for (const blk of collectedBlocks) {
          const normKey = blk.prompt.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 140);
          if (!normKey) continue;
          const chosenJoined = blk.chosenParts.length > 0 ? blk.chosenParts.join(' | ') : undefined;
          if (rIdx === 0) {
            if (!domItemsMap.has(normKey)) {
              domItemsMap.set(normKey, {
                prompt: blk.prompt,
                status: blk.status,
                ...(chosenJoined ? { chosenAnswer: chosenJoined, chosenAnswers: blk.chosenParts } : {}),
                ...(blk.rightAnswer ? { rightAnswer: blk.rightAnswer } : {}),
                ...(blk.feedback ? { feedback: blk.feedback } : {}),
                ...(blk.markText ? { markText: blk.markText } : {}),
                ...(chosenJoined ? { priorChosenSets: [chosenJoined] } : {})
              });
            }
          } else if (chosenJoined) {
            const targetItem = domItemsMap.get(normKey);
            if (targetItem) {
              targetItem.priorChosenSets = targetItem.priorChosenSets || [];
              if (!targetItem.priorChosenSets.includes(chosenJoined)) {
                targetItem.priorChosenSets.push(chosenJoined);
              }
            }
          }
        }
      }
    } catch {
      // Proceed cleanly with whatever review/in-memory data was captured
    } finally {
      await page.goto(quizViewUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    }
  }

  return mergePriorAttemptSnapshotsIntoReview(Array.from(domItemsMap.values()), inMemoryPrior, observedReviewGrade);
}
