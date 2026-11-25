import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { detectPlatform } from '../src/platforms.js';
import { readSurfaces } from '../src/interaction.js';
import { scanQuestions, scanUnsupported } from '../src/scanner.js';
import { executeTask } from '../src/main.js';
import { ModelRouter } from '../src/model-center/model-router.js';
import { clearCheckpoint } from '../src/task-manager.js';
import type { AppConfig, Question } from '../src/types.js';

let browser: Browser;

async function createRoutedContext(routes: Record<string, string>): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (routes[url]) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: routes[url] });
    }
    if (/\.(mp3|mp4|png)$/i.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.alloc(16) });
    }
    return route.abort();
  });
  return ctx;
}

const ED_CHROME = `<header role="banner" class="navbar">
  <form role="search"><input type="search" name="edSearch" aria-label="Search lessons" placeholder="Search..."></form>
  <nav role="navigation"><a href="/dashboard">My Learning</a><a href="/unit/3">Unit 3</a></nav>
</header>`;

describe('Phase 4 — English Discoveries Compatibility & Human-Participation Guards', () => {
  const origExecute = ModelRouter.execute;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    ModelRouter.execute = (async (req: any) => {
      const parsed = JSON.parse(req.text) as { questions: Question[] };
      const answers = parsed.questions.map(q => {
        if (['radio', 'checkbox', 'select'].includes(q.kind)) {
          const best = q.options.find(o => /renewable|sustainable|has studied/i.test(o.text)) || q.options[0];
          return { id: q.id, selected: [best.id], confidence: 0.9 };
        }
        return { id: q.id, text: 'Solar and wind power reduce carbon emissions significantly.', confidence: 0.88 };
      });
      return { output: JSON.stringify({ answers }), initialProfile: 'ed-test', finalProfile: 'ed-test', attempts: 1, fallbackCount: 0, history: [] };
    }) as typeof ModelRouter.execute;
  });

  after(async () => {
    ModelRouter.execute = origExecute;
    await browser?.close();
  });

  const baseConfig = (hosts = ['ed.englishdiscoveries.net']): AppConfig => ({
    allowedHosts: hosts,
    approvedForAIUse: true,
    operationMode: 'PRACTICE_ASSISTED',
    parallelTabs: 1,
    authUrls: [],
    deadlinePages: [],
    tasks: [],
    provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' }
  });

  test('ED-01: Reading activity inside approved iframe extracts passage questions, ignores chrome, and stops at READY_FOR_REVIEW', async () => {
    const shellUrl = 'https://ed.englishdiscoveries.net/Runtime/Reading';
    const frameUrl = 'https://content.englishdiscoveries.net/frames/unit3-reading.html';
    const ctx = await createRoutedContext({
      [shellUrl]: `<!DOCTYPE html><html><head><title>ED Reading</title></head><body>${ED_CHROME}
        <iframe src="${frameUrl}" title="Reading Exercise" width="900" height="600"></iframe></body></html>`,
      [frameUrl]: `<!DOCTYPE html><html><body>
        <article class="reading-passage"><p>Clean energy sources such as solar and wind are renewable and reduce emissions.</p></article>
        <div class="exercise-question" data-question-id="r1">
          <h3 class="question-title">According to the passage, solar and wind power are:</h3>
          <label><input type="radio" name="r1" value="a">Fossil fuels</label>
          <label><input type="radio" name="r1" value="b">Renewable sources</label>
        </div>
        <button type="button">Submit</button>
      </body></html>`
    });
    const taskId = 'ed-reading-1';
    await clearCheckpoint(taskId);
    try {
      const cfg = baseConfig(['ed.englishdiscoveries.net', 'content.englishdiscoveries.net']);
      const res = await executeTask(ctx, { id: taskId, url: shellUrl, aiPermitted: true, maxPages: 1 }, cfg);
      assert.equal(await detectPlatform(res.page!, cfg.allowedHosts), 'english-discoveries');
      assert.equal(res.questionsFound, 1);
      assert.equal(res.questionsFilled, 1);
      assert.equal(res.status, 'READY_FOR_REVIEW');

      const frames = res.page!.frames();
      const child = frames.find(f => f.url() === frameUrl)!;
      assert.equal(await child.locator('input[value="b"]').isChecked(), true);
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('ED-02: Unapproved cross-origin iframe inside English Discoveries is blocked without mutating allowedHosts', async () => {
    const shellUrl = 'https://ed.englishdiscoveries.net/Runtime/ExternalEmbed';
    const unapprovedFrameUrl = 'https://unapproved-cdn.example.net/activity.html';
    const ctx = await createRoutedContext({
      [shellUrl]: `<!DOCTYPE html><html><body>${ED_CHROME}<iframe src="${unapprovedFrameUrl}"></iframe></body></html>`,
      [unapprovedFrameUrl]: `<!DOCTYPE html><html><body><div class="exercise-question"><h3>Hidden</h3><input type="text" aria-label="Hidden"></div></body></html>`
    });
    try {
      const page = await ctx.newPage();
      await page.goto(shellUrl);
      const allowed = ['ed.englishdiscoveries.net'];
      const surfaces = await readSurfaces(page, allowed);
      assert.equal(surfaces.length, 1);
      assert.equal(surfaces[0].url, shellUrl);
      assert.deepEqual(allowed, ['ed.englishdiscoveries.net']);
    } finally {
      await ctx.close();
    }
  });

  test('ED-03: Vocabulary, Grammar (ARIA radio + cloze), and Writing activities extract and verify DOM fills accurately', async () => {
    const url = 'https://ed.englishdiscoveries.net/Runtime/VocabGrammarWriting';
    const ctx = await createRoutedContext({
      [url]: `<!DOCTYPE html><html><body>${ED_CHROME}
        <div class="exercise-question" data-question-id="voc1">
          <h3 class="question-title">Choose the best vocabulary word:</h3>
          <select aria-label="Vocabulary choice">
            <option value="">Choose...</option>
            <option value="1">temporary</option>
            <option value="2">sustainable</option>
          </select>
        </div>
        <div class="exercise-question" data-question-id="gram1">
          <h3 class="question-title">She ___ English for three years.</h3>
          <div role="radiogroup">
            <div role="radio" tabindex="0" aria-checked="false" aria-label="study" onclick="this.setAttribute('aria-checked','true')">study</div>
            <div role="radio" tabindex="0" aria-checked="false" aria-label="has studied" onclick="this.setAttribute('aria-checked','true')">has studied</div>
          </div>
        </div>
        <div class="exercise-question" data-question-id="wrt1">
          <h3 class="question-title">Write two sentences about clean energy:</h3>
          <textarea name="writing_response" rows="4" required></textarea>
        </div>
      </body></html>`
    });
    const taskId = 'ed-vgw-1';
    await clearCheckpoint(taskId);
    try {
      const res = await executeTask(ctx, { id: taskId, url, aiPermitted: true, maxPages: 1 }, baseConfig());
      assert.equal(res.questionsFound, 3);
      assert.equal(res.questionsFilled, 3);
      assert.equal(res.status, 'READY_FOR_REVIEW');
      assert.equal(await res.page!.locator('select').inputValue(), '2');
      assert.equal(await res.page!.locator('[role="radio"][aria-label="has studied"]').getAttribute('aria-checked'), 'true');
      assert.ok((await res.page!.locator('textarea').inputValue()).includes('Solar and wind'));
    } finally {
      await ctx.close();
      await clearCheckpoint(taskId);
    }
  });

  test('ED-04: Listening and Audio/Video comprehension activities require learner participation (humanOnly, 0 auto-filled)', async () => {
    const listeningUrl = 'https://ed.englishdiscoveries.net/Runtime/Listening';
    const videoUrl = 'https://ed.englishdiscoveries.net/Runtime/Video';
    const ctx = await createRoutedContext({
      [listeningUrl]: `<!DOCTYPE html><html><body>${ED_CHROME}
        <div class="exercise-question" data-question-id="lis1">
          <h3 class="question-title">Listen to the conversation and choose the speaker's destination:</h3>
          <audio controls src="https://ed.englishdiscoveries.net/media/dialog.mp3"></audio>
          <label><input type="radio" name="dest" value="london">London</label>
          <label><input type="radio" name="dest" value="tokyo">Tokyo</label>
        </div></body></html>`,
      [videoUrl]: `<!DOCTYPE html><html><body>${ED_CHROME}
        <div class="exercise-question" data-question-id="vid1">
          <h3 class="question-title">Watch the video clip and summarize the main issue:</h3>
          <video controls src="https://ed.englishdiscoveries.net/media/clip.mp4" width="320" height="180"></video>
          <textarea name="vid_summary" rows="3"></textarea>
        </div></body></html>`
    });

    try {
      await clearCheckpoint('ed-listen-1');
      const resListen = await executeTask(ctx, { id: 'ed-listen-1', url: listeningUrl, aiPermitted: true }, baseConfig());
      assert.equal(resListen.questionsFound, 1);
      assert.equal(resListen.questionsFilled, 0, 'Listening item must never fake listening or auto-fill');
      assert.equal(resListen.status, 'NEEDS_REVIEW');
      assert.ok(resListen.warnings.some(w => w.includes('HUMAN_ONLY')));

      await clearCheckpoint('ed-video-1');
      const resVideo = await executeTask(ctx, { id: 'ed-video-1', url: videoUrl, aiPermitted: true }, baseConfig());
      assert.equal(resVideo.questionsFound, 1);
      assert.equal(resVideo.questionsFilled, 0, 'Video item must never fake watching or auto-fill');
      assert.equal(resVideo.status, 'NEEDS_REVIEW');
      assert.ok(resVideo.warnings.some(w => w.includes('HUMAN_ONLY')));
    } finally {
      await ctx.close();
      await clearCheckpoint('ed-listen-1');
      await clearCheckpoint('ed-video-1');
    }
  });

  test('ED-05: Speaking (voice recording) and Interactive (drag-and-drop / slider) controls are flagged UNSUPPORTED / HUMAN_ONLY and never marked complete', async () => {
    const speakUrl = 'https://ed.englishdiscoveries.net/Runtime/Speaking';
    const interUrl = 'https://ed.englishdiscoveries.net/Runtime/Interactive';
    const ctx = await createRoutedContext({
      [speakUrl]: `<!DOCTYPE html><html><body>${ED_CHROME}
        <div class="exercise-question" data-question-id="spk1">
          <h3 class="question-title">Record your voice reading the sentence aloud: "Could you repeat that, please?"</h3>
          <button type="button" aria-label="Record your voice" class="btn-microphone">Start Microphone</button>
        </div></body></html>`,
      [interUrl]: `<!DOCTYPE html><html><body>${ED_CHROME}
        <div class="exercise-question" data-question-id="dd1">
          <h3 class="question-title">Drag the words into the correct order:</h3>
          <div class="word-bank"><span draggable="true">They</span><span draggable="true">arrived</span><span draggable="true">early</span></div>
        </div>
        <div class="exercise-question" data-question-id="sl1">
          <h3 class="question-title">Slide to select the matching stress pattern:</h3>
          <input type="range" min="1" max="5" value="1">
        </div></body></html>`
    });

    try {
      await clearCheckpoint('ed-speak-1');
      const resSpeak = await executeTask(ctx, { id: 'ed-speak-1', url: speakUrl, aiPermitted: true }, baseConfig());
      assert.equal(resSpeak.questionsFilled, 0);
      assert.equal(resSpeak.status, 'NEEDS_REVIEW');
      assert.ok(resSpeak.warnings.some(w => /Speech recording detected|UNSUPPORTED|HUMAN_ONLY/i.test(w)));

      await clearCheckpoint('ed-inter-1');
      const pageCheck = await ctx.newPage();
      await pageCheck.goto(interUrl);
      const scannedInter = await scanQuestions(pageCheck);
      const notesInter = await scanUnsupported(pageCheck);
      assert.equal(scannedInter.length, 2);
      assert.ok(scannedInter.every(q => q.kind === 'unsupported'));
      assert.ok(notesInter.some(n => n.includes('Drag-and-drop')));
      assert.ok(notesInter.some(n => n.includes('slider')));
      await pageCheck.close();

      const resInter = await executeTask(ctx, { id: 'ed-inter-1', url: interUrl, aiPermitted: true }, baseConfig());
      assert.equal(resInter.questionsFilled, 0);
      assert.equal(resInter.status, 'NEEDS_REVIEW');
    } finally {
      await ctx.close();
      await clearCheckpoint('ed-speak-1');
      await clearCheckpoint('ed-inter-1');
    }
  });
});
