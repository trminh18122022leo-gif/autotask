import type { Page, Frame, Locator } from 'playwright';
import { ensureAllowed, type OriginTrustOptions } from './config.js';
import { hintsForPlatform, platformForUrl } from './platforms.js';
import { scanQuestions } from './scanner.js';

export interface RevealStartOptions extends OriginTrustOptions {
  /** Must be explicitly `true` (after passing `evaluateQuizStartPolicy`) to click controls that create a NEW attempt. */
  allowNewAttempt?: boolean;
}

/** One task may contain multiple same-origin or explicitly approved cross-origin frames. */
export function readableFrames(
  page: Page,
  hosts: readonly string[],
  originOptions?: OriginTrustOptions
): Frame[] {
  return page.frames().filter(f => {
    try {
      ensureAllowed(f.url(), hosts, originOptions);
      return true;
    } catch {
      return false;
    }
  });
}

/** Render non-destructive dropdown options before the one-time DOM scan. */
export async function exposeDropdowns(frame: Frame): Promise<void> {
  const dropdowns = frame.locator('[role="combobox"],[role="listbox"]');
  for (let i = 0; i < Math.min(await dropdowns.count(), 20); i++) {
    const box = dropdowns.nth(i);
    try {
      if (!(await box.isVisible())) continue;
      await box.click({ timeout: 1500 });
      await frame.waitForTimeout(100);
      await box.press('Escape', { timeout: 1200 }).catch(() => {});
    } catch {}
  }
}

export async function readSurfaces(
  page: Page,
  hosts: readonly string[],
  originOptions?: OriginTrustOptions
): Promise<{ frame: Frame; url: string }[]> {
  const frames = readableFrames(page, hosts, originOptions);
  for (const frame of frames) await exposeDropdowns(frame);
  return frames.map(frame => ({ frame, url: frame.url() }));
}

/** Find a precisely named Next, never clicking Submit/Finish during pagination. */
export async function locateNext(
  page: Page,
  hosts: readonly string[],
  exactName?: string,
  originOptions?: OriginTrustOptions
): Promise<{ next: Locator; frame: Frame } | null> {
  const frames = readableFrames(page, hosts, originOptions);
  for (const frame of frames) {
    const pattern = exactName || hintsForPlatform(platformForUrl(frame.url())).nextLabels;
    for (const kind of ['button', 'link'] as const) {
      const next = frame.getByRole(kind, { name: pattern, exact: typeof pattern === 'string' });
      if ((await next.count()) === 1) {
        const label =
          (await next.innerText().catch(() => '')) +
          ' ' +
          (await next.getAttribute('aria-label').catch(() => '')) +
          ' ' +
          (await next.getAttribute('value').catch(() => ''));
        if (/submit|finish|turn in|nộp bài|hoàn thành/i.test(label)) continue;
        return { next, frame };
      }
    }
  }
  return null;
}

export async function hasQuestions(
  page: Page,
  hosts: readonly string[],
  originOptions?: OriginTrustOptions
): Promise<boolean> {
  for (const frame of readableFrames(page, hosts, originOptions)) {
    if ((await scanQuestions(frame)).length) return true;
  }
  return false;
}

/** Resume-only helper: continues an already-open attempt without ever starting a new attempt. */
export async function revealContinue(
  page: Page,
  hosts: readonly string[],
  originOptions?: OriginTrustOptions
): Promise<boolean> {
  for (const frame of readableFrames(page, hosts, originOptions)) {
    const match = /^(Continue the last attempt|Continue your attempt|Continue attempt|Tiếp tục lần làm bài(?: cuối)?)$/i;
    const button = frame.getByRole('button', { name: match });
    const link = frame.getByRole('link', { name: match });
    const control = (await button.count()) === 1 ? button : (await link.count()) === 1 ? link : null;
    if (control) {
      await control.click();
      await page.waitForTimeout(650);
      return true;
    }
  }
  return false;
}

/** Safe start helper (`AUD-LMS-04`):
 * By default (`allowNewAttempt` omitted/false), ONLY continues an already-open attempt (`revealContinue`)
 * and NEVER auto-clicks "Attempt quiz now" / `startattempt.php`.
 * New-attempt controls are clicked ONLY when `{ allowNewAttempt: true }` is explicitly passed after `evaluateQuizStartPolicy()`.
 */
export async function revealStart(
  page: Page,
  hosts: readonly string[],
  options?: RevealStartOptions
): Promise<boolean> {
  if (await revealContinue(page, hosts, options)) {
    return true;
  }
  if (!options?.allowNewAttempt) {
    return false;
  }
  for (const frame of readableFrames(page, hosts, options)) {
    const match =
      /^(Attempt quiz now|Start attempt|Re-attempt quiz|Bắt đầu làm bài|Làm bài|Làm lại bài|Start quiz|Start exercise|Begin practice)$/i;
    const button = frame.getByRole('button', { name: match });
    const link = frame.getByRole('link', { name: match });
    const control = (await button.count()) === 1 ? button : (await link.count()) === 1 ? link : null;
    if (control) {
      await control.click();
      await page.waitForTimeout(650);
      return true;
    }
  }
  return false;
}
