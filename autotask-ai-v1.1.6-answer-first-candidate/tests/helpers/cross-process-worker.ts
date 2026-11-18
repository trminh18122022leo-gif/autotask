/** Cross-Process E2E Worker Script
 * Standalone worker executed in independent child processes (Process A and Process B)
 * to verify genuine cross-process crash and recovery without memory sharing.
 */
import { chromium } from 'playwright';
import { ResumeCoordinator } from '../../src/browser/resume-coordinator.js';
import {
  saveCheckpoint,
  loadCheckpoint,
  type TaskCheckpoint
} from '../../src/task-manager.js';
import { scanQuestions } from '../../src/scanner.js';
import { fillAnswer } from '../../src/fill.js';
import { locateNext } from '../../src/interaction.js';
import type { AppConfig } from '../../src/types.js';

interface WorkerArgs {
  mode: 'initial' | 'resume';
  port: number;
  taskId: string;
  storagePath: string;
}

function parseArgs(): WorkerArgs {
  const args = process.argv.slice(2);
  let mode: 'initial' | 'resume' = 'initial';
  let port = 0;
  let taskId = 'proc-e2e-restart-task';
  let storagePath = 'storage-state.json';

  for (const arg of args) {
    if (arg.startsWith('--mode=')) {
      mode = arg.split('=')[1] as 'initial' | 'resume';
    } else if (arg.startsWith('--port=')) {
      port = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--taskId=')) {
      taskId = arg.split('=')[1];
    } else if (arg.startsWith('--storagePath=')) {
      storagePath = arg.split('=')[1];
    }
  }

  return { mode, port, taskId, storagePath };
}

const e2eConfig: AppConfig = {
  allowedHosts: ['127.0.0.1', 'localhost'],
  approvedForAIUse: true,
  parallelTabs: 1,
  authUrls: [],
  deadlinePages: [],
  tasks: [],
  provider: {
    kind: 'openai-compatible',
    model: 'gpt-4o',
    endpoint: 'https://api.openai.com/v1/chat/completions'
  }
};

async function runProcessA(args: WorkerArgs): Promise<void> {
  const baseUrl = `http://127.0.0.1:${args.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/page1`);

    const qs = await scanQuestions(page);
    if (qs.length < 2) {
      throw new Error(`Process A: Expected 2 questions on Page 1, found ${qs.length}`);
    }

    const optA = qs[1].options.find(o => o.text.includes('Lựa chọn A') || o.id === 'opt_a') || qs[1].options[0];
    await fillAnswer(page, qs[0], { id: 'q1', text: 'Nguyen Van A' });
    await fillAnswer(page, qs[1], { id: 'q2', selected: [optA.id] });

    const nextBtn = await locateNext(page, e2eConfig.allowedHosts);
    if (!nextBtn) {
      throw new Error('Process A: Could not find Next button on Page 1');
    }

    await Promise.all([
      page.waitForNavigation(),
      nextBtn.next.click()
    ]);

    if (!page.url().includes('/page2')) {
      throw new Error(`Process A: Expected navigation to /page2, got ${page.url()}`);
    }

    // Save browser context storage state to share session cookie
    await ctx.storageState({ path: args.storagePath });

    // Save checkpoint for Step 1
    const cp: TaskCheckpoint = {
      taskId: args.taskId,
      url: `${baseUrl}/page1`,
      status: 'RUNNING',
      stepsCompleted: 1,
      totalSteps: 3,
      questionsFound: 2,
      questionsFilled: 2,
      answersByStep: {
        1: { q1: { text: 'Nguyen Van A' }, q2: { selected: ['opt_a'] } }
      },
      answersRecorded: {
        q1: { text: 'Nguyen Van A' },
        q2: { selected: ['opt_a'] }
      },
      lastUpdated: new Date().toISOString()
    };
    await saveCheckpoint(cp);

    // Emit readiness event
    console.log(JSON.stringify({
      event: 'PROCESS_A_READY',
      pid: process.pid,
      stepsCompleted: 1,
      url: page.url()
    }));

    // Keep process alive to simulate running state until abrupt termination by parent
    const keepAlive = setInterval(() => {}, 1000);

    // Support termination signals
    process.on('SIGTERM', async () => {
      clearInterval(keepAlive);
      await browser.close().catch(() => {});
      process.exit(0);
    });
    process.on('SIGINT', async () => {
      clearInterval(keepAlive);
      await browser.close().catch(() => {});
      process.exit(0);
    });

    // Also support stdin signal if pipe is used
    process.stdin.on('data', async (chunk) => {
      if (chunk.toString().includes('STOP')) {
        clearInterval(keepAlive);
        await browser.close().catch(() => {});
        process.exit(0);
      }
    });
  } catch (err: any) {
    console.error(JSON.stringify({
      event: 'PROCESS_A_ERROR',
      pid: process.pid,
      error: err?.message || String(err)
    }));
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

async function runProcessB(args: WorkerArgs): Promise<void> {
  console.log(JSON.stringify({
    event: 'PROCESS_B_STARTED',
    pid: process.pid
  }));

  const checkpoint = await loadCheckpoint(args.taskId);
  if (!checkpoint) {
    console.error(JSON.stringify({
      event: 'PROCESS_B_ERROR',
      pid: process.pid,
      error: `Process B: Checkpoint not found for taskId: ${args.taskId}`
    }));
    process.exit(1);
  }

  if (checkpoint.stepsCompleted !== 1) {
    console.error(JSON.stringify({
      event: 'PROCESS_B_ERROR',
      pid: process.pid,
      error: `Process B: Expected stepsCompleted 1, got ${checkpoint.stepsCompleted}`
    }));
    process.exit(1);
  }

  console.log(JSON.stringify({
    event: 'PROCESS_B_CHECKPOINT_LOADED',
    pid: process.pid,
    stepsCompleted: checkpoint.stepsCompleted,
    checksum: checkpoint.checksum
  }));

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ storageState: args.storagePath });
    const page = await ctx.newPage();

    // Navigate to checkpoint initial URL
    await page.goto(checkpoint.url);

    // Verify live DOM values rendered by server WITHOUT test-controller DOM manipulation
    const valQ1 = await page.inputValue('#q1');
    const radioAChecked = await page.isChecked('input[value="opt_a"]');

    console.log(JSON.stringify({
      event: 'PROCESS_B_SERVER_DOM_VERIFIED',
      pid: process.pid,
      valQ1,
      radioAChecked
    }));

    if (valQ1 !== 'Nguyen Van A' || !radioAChecked) {
      throw new Error(`Process B: DOM values mismatch. Q1: ${valQ1}, RadioA: ${radioAChecked}`);
    }

    // Evaluate state using ResumeCoordinator directly from live DOM without fillAnswer
    const evalResult = await ResumeCoordinator.evaluateState(page, checkpoint, e2eConfig);
    console.log(JSON.stringify({
      event: 'PROCESS_B_EVALUATED',
      pid: process.pid,
      state: evalResult.state,
      verifiedCount: evalResult.verifiedValuesCount,
      currentStep: evalResult.currentStep,
      targetStep: evalResult.targetStep
    }));

    if (evalResult.state !== 'NAVIGATION_REQUIRED') {
      throw new Error(`Process B: Expected NAVIGATION_REQUIRED, got ${evalResult.state}`);
    }

    // Advance step to Page 2
    const advanced = await ResumeCoordinator.advanceToStep(page, checkpoint, 2, e2eConfig);
    if (!advanced || !page.url().includes('/page2')) {
      throw new Error(`Process B: advanceToStep failed. Current URL: ${page.url()}`);
    }

    // Verify Page 2 DOM
    const qs = await scanQuestions(page);
    if (qs.length === 0 || !qs[0].prompt.includes('Tải lên bài tập')) {
      throw new Error(`Process B: Expected Page 2 file upload question, got ${qs[0]?.prompt}`);
    }

    // Update checkpoint to Step 2
    const updatedCheckpoint: TaskCheckpoint = {
      ...checkpoint,
      stepsCompleted: 2,
      currentStepUrl: page.url(),
      answersByStep: {
        ...checkpoint.answersByStep,
        2: { q3: { fileName: 'assignment.docx' } }
      },
      lastUpdated: new Date().toISOString()
    };
    await saveCheckpoint(updatedCheckpoint);

    // Advance to Page 3
    const next2 = await locateNext(page, e2eConfig.allowedHosts);
    if (!next2) {
      throw new Error('Process B: Could not locate Next button on Page 2');
    }

    await Promise.all([
      page.waitForNavigation(),
      next2.next.click()
    ]);

    if (!page.url().includes('/page3')) {
      throw new Error(`Process B: Expected Page 3 URL, got ${page.url()}`);
    }

    // Submit Guard verification: Page 3 contains only "Submit all and finish"
    const nextOnSubmitPage = await locateNext(page, e2eConfig.allowedHosts);
    const submitGuardBlocked = nextOnSubmitPage === null;

    console.log(JSON.stringify({
      event: 'PROCESS_B_SUCCESS',
      pid: process.pid,
      stepsCompleted: 2,
      submitGuardBlocked,
      finalUrl: page.url()
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

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.mode === 'initial') {
    await runProcessA(args);
  } else if (args.mode === 'resume') {
    await runProcessB(args);
  } else {
    console.error(`Unknown mode: ${args.mode}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
