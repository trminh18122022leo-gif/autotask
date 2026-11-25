import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 palette,
 paint,
 colorEnabled,
 gradientText,
 badge,
 renderMeterBar,
 renderSparkline,
 renderProgressBar,
 renderThemeSwatches,
 renderPanelBox,
 renderTable,
 renderKeySlotDots,
 formatKeyRotationLine,
 animateKeyRotation,
 introAnimation,
 preview
} from '../src/ui/tokyo.js';
import { printReadyBanner, renderAgentResultBanner } from '../src/agent/cli.js';
import { createAgentContext } from '../src/agent/loop.js';

function captureConsole(fn: () => void): string {
 const origLog = console.log;
 const lines: string[] = [];
 console.log = (...args: any[]) => {
  lines.push(args.map(a => String(a)).join(' '));
 };
 try {
  fn();
 } finally {
  console.log = origLog;
 }
 return lines.join('\n');
}

test('Tokyo Night palette has required RGB colors',()=>{
 assert.equal(palette.purple,'#bb9af7');
 assert.equal(palette.cyan,'#7dcfff');
 assert.equal(palette.midnight,'#1a1b26');
});

test('NO_COLOR disables ANSI across gradientText, badge, meterBar, sparkline, swatches, tables & preview',()=>{
 const oldNoColor=process.env.NO_COLOR;
 const oldForceColor=process.env.FORCE_COLOR;
 try{
  process.env.NO_COLOR='1';
  delete process.env.FORCE_COLOR;
  assert.equal(colorEnabled(),false);
  assert.equal(paint('Tokyo Night','purple',true),'Tokyo Night');
  assert.equal(gradientText('AutoTask AI'), 'AutoTask AI');
  assert.equal(badge('CYBER GRID','cyber'), '[CYBER GRID]');
  assert.equal(/\x1b\[/.test(renderMeterBar(5, 10)), false);
  assert.equal(/\x1b\[/.test(renderSparkline([100, 200, 150])), false);
  assert.equal(/\x1b\[/.test(renderThemeSwatches('cyberpunk')), false);

  const out = captureConsole(() => {
   renderPanelBox('HUD', ['Line 1'], 'purple', 'TAG');
   renderProgressBar('Fill', 3, 5);
   renderTable(['Slot', 'Status'], [['prf_1', '✔ SẴN SÀNG']]);
   preview();
   printReadyBanner(createAgentContext({ targetWebUrl: 'https://lms.hust.edu.vn' }));
   renderAgentResultBanner({
    goal: 'test',
    status: 'DONE',
    steps: [],
    summary: 'Completed',
    durationMs: 1200,
    modelCalls: 2
   });
  });
  assert.equal(/\x1b\[/.test(out), false, 'NO_COLOR=1 must suppress all ANSI escape sequences');
  assert.match(out, /AGENT ĐÃ SẴN SÀNG TIẾP NHẬN YÊU CẦU LÀM BÀI/);
 }
 finally{
  if(oldNoColor===undefined)delete process.env.NO_COLOR;else process.env.NO_COLOR=oldNoColor;
  if(oldForceColor===undefined)delete process.env.FORCE_COLOR;else process.env.FORCE_COLOR=oldForceColor;
 }
});

test('FORCE_COLOR enables TrueColor 24-bit gradients while preserving AGENT-12 banner labels', () => {
 const oldNoColor = process.env.NO_COLOR;
 const oldForceColor = process.env.FORCE_COLOR;
 try {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  assert.equal(colorEnabled(), true);
  assert.match(gradientText('AUTOTASK'), /\x1b\[38;2;/);
  const bannerOut = captureConsole(() => {
   printReadyBanner(createAgentContext({ targetWebUrl: 'https://lms.hust.edu.vn' }));
  });
  assert.match(bannerOut, /AGENT ĐÃ SẴN SÀNG TIẾP NHẬN YÊU CẦU LÀM BÀI/);
  assert.match(bannerOut, /Web LMS mục tiêu/);
  assert.match(bannerOut, /Tài khoản/);
  assert.match(bannerOut, /Trạng thái phiên/);
  assert.match(bannerOut, /Model AI/);
  assert.match(bannerOut, /Phím tắt/);
 } finally {
  if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
  if (oldForceColor === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = oldForceColor;
 }
});

test('introAnimation returns immediately in non-TTY environment', async () => {
 const start = Date.now();
 await introAnimation();
 assert.ok(Date.now() - start < 500, 'introAnimation must skip cleanly without sleeping in non-TTY');
});

test('Key rotation visual helpers render slot ring dots cleanly and animateKeyRotation skips sleep in non-TTY / NO_COLOR', async () => {
 const oldNoColor = process.env.NO_COLOR;
 const oldForceColor = process.env.FORCE_COLOR;
 try {
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
  assert.equal(renderKeySlotDots(2, 3), '[○ ● ○]');
  assert.equal(renderKeySlotDots(1, 1), '');

  const line = formatKeyRotationLine({
   from: 'prf_1',
   to: 'prf_1#k2',
   slotIndex: 2,
   totalSlots: 3,
   mode: 'round-robin',
   reason: 'Xoay vòng cân bằng tải'
  });
  assert.equal(/\x1b\[/.test(line), false, 'NO_COLOR=1 must strip ANSI from key rotation line');
  assert.match(line, /KEY ROTATE/);
  assert.match(line, /prf_1 ━━▶ prf_1#k2/);
  assert.match(line, /\[○ ● ○\]/);

  const start = Date.now();
  await animateKeyRotation({
   from: 'prf_1',
   to: 'prf_1#k2',
   slotIndex: 2,
   totalSlots: 3,
   mode: 'failover',
   reason: 'HTTP 429 RPM'
  });
  assert.ok(Date.now() - start < 200, 'animateKeyRotation must resolve immediately in non-TTY');
 } finally {
  if (oldNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = oldNoColor;
  if (oldForceColor === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = oldForceColor;
 }
});
