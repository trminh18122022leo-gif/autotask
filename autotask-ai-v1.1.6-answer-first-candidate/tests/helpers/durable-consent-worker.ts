import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { evaluateQuizStartPolicy, inspectQuizLaunchSurface } from '../../src/quiz-start-policy.js';
import type { AppConfig, Task } from '../../src/types.js';

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('No config path provided');
    process.exit(1);
  }

  const rawJson = readFileSync(configPath, 'utf-8');
  const task: Task = JSON.parse(rawJson);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(task.url, { waitUntil: 'domcontentloaded' });
    const inspection = await inspectQuizLaunchSurface(page, ['127.0.0.1'], task.title || 'Quiz');

    const appConfig: AppConfig = {
      allowedHosts: ['127.0.0.1'],
      approvedForAIUse: true,
      operationMode: 'PRACTICE_ASSISTED',
      parallelTabs: 1,
      tasks: [task],
      provider: { kind: 'openai-compatible', model: 'test' }
    } as unknown as AppConfig;

    const decision = await evaluateQuizStartPolicy({
      page,
      task,
      config: appConfig,
      platform: 'moodle',
      inspection
    });

    let httpTriggered = false;
    if (decision.action === 'START_NEW_ATTEMPT') {
      const button = page.getByRole('button', { name: /Attempt quiz now/i });
      if (await button.count() > 0) {
        await Promise.all([
          page.waitForRequest(req => req.url().includes('startattempt.php'), { timeout: 4000 }).catch(() => null),
          button.click()
        ]);
        httpTriggered = true;
      }
    }

    console.log(JSON.stringify({
      pid: process.pid,
      action: decision.action,
      code: decision.code,
      reason: decision.reason,
      httpTriggered
    }));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
