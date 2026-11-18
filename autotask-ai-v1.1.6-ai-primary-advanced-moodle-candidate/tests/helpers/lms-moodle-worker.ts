/** Phase 6 — Genuine Two-Process Moodle LMS Worker
 * Executed as independent OS Node.js child processes (Process A and Process B)
 * exercising the real `executeTask()` entrypoint in `src/main.ts`.
 */
import { chromium } from 'playwright';
import { discoverActivities } from '../../src/discovery.js';
import { detectPlatform } from '../../src/platforms.js';
import { executeTask } from '../../src/main.js';
import { loadCheckpoint } from '../../src/task-manager.js';
import { ModelRouter } from '../../src/model-center/model-router.js';
import type { AppConfig, Question } from '../../src/types.js';

interface Args {
  mode: 'processA' | 'processB';
  port: number;
  taskId: string;
  storagePath: string;
}

function parseArgs(): Args {
  let mode: 'processA' | 'processB' = 'processA';
  let port = 0;
  let taskId = 'moodle-e2e-quiz-55';
  let storagePath = '';
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--mode=')) mode = a.slice(7) as Args['mode'];
    else if (a.startsWith('--port=')) port = Number(a.slice(7));
    else if (a.startsWith('--taskId=')) taskId = a.slice(9);
    else if (a.startsWith('--storagePath=')) storagePath = a.slice(14);
  }
  return { mode, port, taskId, storagePath };
}

function buildGoldAnswerForQuestion(q: Question) {
  if (q.id === 'm1') {
    const lifo = q.options.find(o => /LIFO/i.test(o.text)) || q.options[0];
    return { id: q.id, selected: [lifo.id], confidence: 0.96 };
  }
  if (q.id === 'm2_1') {
    const stackOpt = q.options.find(o => /Stack/i.test(o.text)) || q.options[0];
    return { id: q.id, selected: [stackOpt.id], confidence: 0.94 };
  }
  if (q.id === 'm2_2') {
    const queueOpt = q.options.find(o => /Queue/i.test(o.text)) || q.options[0];
    return { id: q.id, selected: [queueOpt.id], confidence: 0.94 };
  }
  if (q.id === 'm3') {
    return { id: q.id, text: 'O(1)', confidence: 0.95 };
  }
  if (q.id === 'm4') {
    const t = q.options.find(o => /^True$/i.test(o.text)) || q.options[0];
    return { id: q.id, selected: [t.id], confidence: 0.97 };
  }
  if (q.id === 'm5') {
    return { id: q.id, text: 'Binary search requires a sorted array and runs in O(log n) time.', confidence: 0.91 };
  }
  throw new Error(`Unexpected scanned question in Moodle E2E worker: ${q.id} (${q.prompt})`);
}

async function run(): Promise<void> {
  const args = parseArgs();
  const baseUrl = `http://127.0.0.1:${args.port}`;
  const courseUrl = `${baseUrl}/course/view.php?id=10`;
  const quizViewUrl = `${baseUrl}/mod/quiz/view.php?id=55`;

  const config: AppConfig = {
    allowedHosts: ['127.0.0.1'],
    approvedForAIUse: true,
    parallelTabs: 1,
    authUrls: [],
    deadlinePages: [],
    tasks: [],
    provider: { kind: 'openai-compatible', model: 'gpt-4o-mini' },
    operationMode: 'PRACTICE_ASSISTED'
  };

  if (args.mode === 'processA') {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    let modelBatchCalls = 0;
    const solvedQuestionIds: string[] = [];

    ModelRouter.execute = (async (req: any) => {
      modelBatchCalls++;
      const parsed = JSON.parse(req.text) as { questions: Question[] };

      // When executeTask() reaches Page 2 (second model call), Step 1 has ALREADY been filled,
      // checkpointed to disk, and navigated via POST /mod/quiz/processattempt.php to Page 2!
      if (modelBatchCalls === 2) {
        await ctx.storageState({ path: args.storagePath });
        const cp = await loadCheckpoint(args.taskId);
        console.log(JSON.stringify({
          event: 'PROCESS_A_CRASH_POINT_REACHED',
          pid: process.pid,
          modelBatchCalls,
          solvedQuestionIds,
          checkpointStepsCompleted: cp?.stepsCompleted ?? null,
          checkpointDomFilledSteps: cp?.domFilledSteps ?? null,
          checkpointServerSavedSteps: cp?.serverSavedSteps ?? null,
          checkpointChecksum: cp?.checksum ?? null,
          page2QuestionIds: parsed.questions.map(q => q.id)
        }));
        // Block forever until parent test harness kills Process A abruptly
        await new Promise(() => {});
      }

      for (const q of parsed.questions) solvedQuestionIds.push(q.id);
      const answers = parsed.questions.map(buildGoldAnswerForQuestion);
      return {
        output: JSON.stringify({ answers }),
        initialProfile: 'moodle-e2e',
        finalProfile: 'moodle-e2e',
        attempts: 1,
        fallbackCount: 0,
        history: []
      };
    }) as typeof ModelRouter.execute;

    // Step 1-2 of Phase 6: Platform detection & non-destructive activity discovery from course page
    const probePage = await ctx.newPage();
    await probePage.goto(courseUrl);
    const detectedCoursePlatform = await detectPlatform(probePage, config.allowedHosts);
    await probePage.close();

    const discovered = await discoverActivities(ctx, [courseUrl], config.allowedHosts, 5, '+07:00');
    console.log(JSON.stringify({
      event: 'PROCESS_A_DISCOVERED',
      pid: process.pid,
      detectedCoursePlatform,
      activities: discovered.activities.map(a => ({ title: a.title, url: a.url, kind: a.kind })),
      deadlines: discovered.deadlines.map(d => d.dueAt)
    }));

    // Execute real task loop starting at /mod/quiz/view.php?id=55 (will pause at Page 2 for crash simulation)
    const unexpectedReturn = await executeTask(
      ctx,
      {
        id: args.taskId,
        url: quizViewUrl,
        title: 'Practice Quiz: Data Structures',
        aiPermitted: true,
        mode: 'PRACTICE_ASSISTED',
        confirmStartNewAttempt: true,
        maxPages: 5
      },
      config
    );
    console.error(JSON.stringify({
      event: 'PROCESS_A_UNEXPECTED_RETURN',
      pid: process.pid,
      status: unexpectedReturn.status,
      url: unexpectedReturn.page?.url(),
      questionsFound: unexpectedReturn.questionsFound,
      questionsFilled: unexpectedReturn.questionsFilled,
      warnings: unexpectedReturn.warnings
    }));
    await browser.close().catch(() => {});
    process.exit(1);
  }

  // Process B: Independent OS Node process resuming from disk checkpoint + persisted browser session
  const browser = await chromium.launch({ headless: true });
  try {
    const cpBefore = await loadCheckpoint(args.taskId);
    if (!cpBefore) {
      throw new Error(`Process B could not load checkpoint for ${args.taskId}`);
    }

    const ctx = await browser.newContext({ storageState: args.storagePath });
    const solvedInProcessB: string[] = [];

    ModelRouter.execute = (async (req: any) => {
      const parsed = JSON.parse(req.text) as { questions: Question[] };
      for (const q of parsed.questions) solvedInProcessB.push(q.id);
      const answers = parsed.questions.map(buildGoldAnswerForQuestion);
      return {
        output: JSON.stringify({ answers }),
        initialProfile: 'moodle-e2e',
        finalProfile: 'moodle-e2e',
        attempts: 1,
        fallbackCount: 0,
        history: []
      };
    }) as typeof ModelRouter.execute;

    const result = await executeTask(
      ctx,
      { id: args.taskId, url: quizViewUrl, title: 'Practice Quiz: Data Structures', aiPermitted: true, maxPages: 5 },
      config
    );

    const page = result.page!;
    const finalUrl = page.url();
    const detectedAttemptPlatform = await detectPlatform(page, config.allowedHosts);
    const m4Checked = await page.locator('input[name="q7001:4_answer"][value="1"]').isChecked();
    const m5Text = await page.locator('#q7001\\:5_answereditable').innerText();
    const m5HiddenValue = await page.locator('#q7001\\:5_answer').inputValue();
    const finishBtnVisible = (await page.locator('input[type="submit"][value="Finish attempt ..."]').count()) === 1;
    const cpAfter = await loadCheckpoint(args.taskId);

    console.log(JSON.stringify({
      event: 'PROCESS_B_COMPLETED_TO_REVIEW',
      pid: process.pid,
      detectedAttemptPlatform,
      status: result.status,
      questionsFound: result.questionsFound,
      questionsFilled: result.questionsFilled,
      solvedInProcessB,
      finalUrl,
      m4Checked,
      m5Text: m5Text.trim(),
      m5HiddenValue: m5HiddenValue.trim(),
      finishBtnVisible,
      checkpointStepsCompleted: cpAfter?.stepsCompleted ?? null,
      checkpointDomFilledSteps: cpAfter?.domFilledSteps ?? null,
      checkpointServerSavedSteps: cpAfter?.serverSavedSteps ?? null,
      warnings: result.warnings
    }));

    await browser.close();
    process.exit(0);
  } catch (err: any) {
    console.error(JSON.stringify({
      event: 'PROCESS_B_ERROR',
      pid: process.pid,
      error: err?.message || String(err)
    }));
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

run().catch(err => {
  console.error(JSON.stringify({ event: 'WORKER_FATAL', pid: process.pid, error: err?.message || String(err) }));
  process.exit(1);
});
