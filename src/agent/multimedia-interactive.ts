import type { Page, Frame } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Answer, Option, Question } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_SCRIPT_CANDIDATES = [
  resolve(__dirname, '../../desktop/speech_audio_worker.py'),
  resolve(process.cwd(), 'desktop/speech_audio_worker.py')
];

function resolveSpeechWorkerPath(): string | undefined {
  return WORKER_SCRIPT_CANDIDATES.find(p => existsSync(p));
}

/**
 * Strips WebVTT / SRT headers, timestamps, sequence numbers and inline tags
 * into clean dialogue text usable as LLM context for listening/video questions.
 */
export function parseSubtitleTranscript(raw: string): string {
  if (!raw || !raw.trim()) return '';
  const lines = raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)\b/i.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}/.test(trimmed)) continue;
    const cleaned = trimmed
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned && kept[kept.length - 1] !== cleaned) {
      kept.push(cleaned);
    }
  }
  return kept.join(' ').slice(0, 3000);
}

/**
 * Completes video lesson gates and standalone audio barriers on the current page:
 * - Mutes HTML5 `<video>` and standalone lesson `<audio>` elements (outside active quiz inputs unless gated),
 * - Starts playback, seeks near/to duration, and dispatches `play`, `timeupdate`, and `ended` events,
 * - Clicks newly enabled unlock/continue buttons when zero quiz questions are visible.
 */
export async function completePageVideoAndAudioGates(page: Page): Promise<{
  videosCompleted: number;
  audiosCompleted: number;
  unlockedClicked: boolean;
}> {
  const mediaSummary = await page.evaluate(() => {
    let videosCompleted = 0;
    let audiosCompleted = 0;

    const videos = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
    for (const v of videos) {
      try {
        v.muted = true;
        v.playbackRate = 16;
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        v.dispatchEvent(new Event('play', { bubbles: true }));
        v.dispatchEvent(new Event('playing', { bubbles: true }));
        if (Number.isFinite(v.duration) && v.duration > 0) {
          v.currentTime = v.duration;
        }
        v.dispatchEvent(new Event('timeupdate', { bubbles: true }));
        if (!v.ended) {
          try {
            Object.defineProperty(v, 'ended', { configurable: true, get: () => true });
          } catch {}
        }
        v.dispatchEvent(new Event('ended', { bubbles: true }));
        v.setAttribute('data-atqa-video-completed', 'true');
        videosCompleted++;
      } catch {}
    }

    // Complete standalone lesson <audio> players (ones outside quiz question blocks with existing answer inputs)
    const audios = Array.from(document.querySelectorAll<HTMLAudioElement>('audio'));
    for (const a of audios) {
      const qWrap = a.closest('div.que, .exercise-question, [data-question], [data-question-id]');
      const isQuizQuestionAudio = Boolean(
        qWrap && qWrap.querySelector('input[type="radio"], input[type="checkbox"], select, textarea, input[type="text"]')
      );
      if (isQuizQuestionAudio) continue;
      try {
        a.muted = true;
        a.playbackRate = 16;
        const p = a.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        a.dispatchEvent(new Event('play', { bubbles: true }));
        if (Number.isFinite(a.duration) && a.duration > 0) {
          a.currentTime = a.duration;
        }
        a.dispatchEvent(new Event('timeupdate', { bubbles: true }));
        if (!a.ended) {
          try {
            Object.defineProperty(a, 'ended', { configurable: true, get: () => true });
          } catch {}
        }
        a.dispatchEvent(new Event('ended', { bubbles: true }));
        a.setAttribute('data-atqa-audio-completed', 'true');
        audiosCompleted++;
      } catch {}
    }

    return { videosCompleted, audiosCompleted };
  }).catch(() => ({ videosCompleted: 0, audiosCompleted: 0 }));

  let unlockedClicked = false;
  if (mediaSummary.videosCompleted > 0 || mediaSummary.audiosCompleted > 0) {
    await page.waitForTimeout(220);
    // If a video gate unlocked a Continue / Unlock Quiz button and no questions/inputs are yet visible, click it cleanly
    const hasQuestionsYet = await page.evaluate(() => {
      return document.querySelectorAll('div.que, .exercise-question, input[type="radio"], input[type="checkbox"], [draggable="true"]').length > 0;
    }).catch(() => true);

    if (!hasQuestionsYet) {
      const unlockSelectors = [
        'button:enabled:has-text("Tiếp tục")',
        'button:enabled:has-text("Continue")',
        'button:enabled:has-text("Hoàn thành")',
        'button:enabled:has-text("Bắt đầu làm bài")',
        'button:enabled:has-text("Start")',
        'a.btn:has-text("Tiếp tục")',
        'a.btn:has-text("Continue")'
      ];
      for (const sel of unlockSelectors) {
        const btn = page.locator(sel).first();
        if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
          const disabled = await btn.isDisabled().catch(() => false);
          if (!disabled) {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}),
              btn.click().catch(() => {})
            ]);
            await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
            unlockedClicked = true;
            break;
          }
        }
      }
    }
  }

  return {
    videosCompleted: mediaSummary.videosCompleted,
    audiosCompleted: mediaSummary.audiosCompleted,
    unlockedClicked
  };
}

/**
 * Generates a pure TypeScript PCM WAV buffer fallback when Python is unavailable.
 */
function buildFallbackWavBuffer(text: string): { buffer: Buffer; durationSeconds: number } {
  const sampleRate = 16000;
  const words = String(text || 'Hello').trim().split(/\s+/).filter(Boolean);
  const wordCount = Math.max(1, words.length);
  const wordDur = 0.26;
  const pauseDur = 0.06;
  const step = wordDur + pauseDur;
  const durationSeconds = Math.max(1.2, Math.min(6.0, wordCount * step));
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  // Standard 44-byte RIFF/WAVE header (PCM 16-bit mono 16kHz)
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const wIdx = Math.min(wordCount - 1, Math.floor(t / step));
    const localT = t - wIdx * step;
    let sampleVal = 0;
    if (localT <= wordDur && t <= wordCount * step) {
      const env = Math.pow(Math.sin((Math.PI * localT) / wordDur), 1.3);
      const f0 = 145 + ((wIdx * 17) % 45);
      const sig = 0.65 * Math.sin(2 * Math.PI * f0 * t) + 0.35 * Math.sin(2 * Math.PI * f0 * 2.1 * t);
      sampleVal = Math.max(-32000, Math.min(32000, Math.round(12000 * env * sig)));
    }
    buf.writeInt16LE(sampleVal, 44 + i * 2);
  }

  return { buffer: buf, durationSeconds: Number(durationSeconds.toFixed(2)) };
}

/**
 * Synthesizes spoken `.wav` audio via `desktop/speech_audio_worker.py` (Windows SAPI + PCM fallback),
 * falling back to pure TypeScript WAV generation if Python is unavailable.
 */
export async function synthesizeSpeechWav(
  text: string,
  outPath?: string,
  preferFastWave = false
): Promise<{
  ok: boolean;
  wavPath: string;
  base64Wav: string;
  durationSeconds: number;
  engine: string;
}> {
  const cleanText = String(text || 'Could you repeat that, please?').replace(/\s+/g, ' ').trim();
  const targetPath = outPath
    ? resolve(outPath)
    : join(tmpdir(), `autotask-speech-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
  await mkdir(dirname(targetPath), { recursive: true });

  const workerPath = resolveSpeechWorkerPath();
  if (workerPath) {
    try {
      const pyRes = await new Promise<any>((resPromise, rejPromise) => {
        const proc = spawn('python', [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          try { proc.kill(); } catch {}
          rejPromise(new Error('speech_audio_worker timeout'));
        }, 8000);

        proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
        proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
        proc.on('error', err => {
          clearTimeout(timer);
          rejPromise(err);
        });
        proc.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) {
            rejPromise(new Error(stderr || `worker exited with ${code}`));
            return;
          }
          try {
            resPromise(JSON.parse(stdout.trim()));
          } catch (e) {
            rejPromise(e);
          }
        });

        proc.stdin.write(JSON.stringify({
          action: 'synthesize_speech',
          text: cleanText,
          outputPath: targetPath,
          preferFastWave
        }));
        proc.stdin.end();
      });

      if (pyRes?.ok && pyRes?.outputPath && existsSync(pyRes.outputPath)) {
        const bytes = await readFile(pyRes.outputPath);
        return {
          ok: true,
          wavPath: pyRes.outputPath,
          base64Wav: bytes.toString('base64'),
          durationSeconds: Number(pyRes.durationSeconds) || 1.5,
          engine: String(pyRes.engine || 'python')
        };
      }
    } catch {
      // Fall through to pure-TS WAV generator
    }
  }

  const fb = buildFallbackWavBuffer(cleanText);
  await writeFile(targetPath, fb.buffer);
  return {
    ok: true,
    wavPath: targetPath,
    base64Wav: fb.buffer.toString('base64'),
    durationSeconds: fb.durationSeconds,
    engine: 'ts-pcm-fallback'
  };
}

/**
 * Automates a speaking / voice-recording question (`sourceType === 'interactive:speech'`):
 * 1. Synthesizes spoken WAV from `answer.text` (or quoted prompt phrase),
 * 2. Injects a Web Audio mock `MediaStream` into `navigator.mediaDevices.getUserMedia`,
 * 3. Uploads the `.wav` if an `<input type="file" accept*="audio">` is present,
 * 4. Clicks Record -> waits -> clicks Stop/Save, and fills any paired transcript input.
 */
export async function performSpeechRecordingFill(
  target: Page | Frame,
  question: Question,
  answer: Answer
): Promise<void> {
  const root = target.locator(`[data-atqa-id="${question.id}"]`).first();
  if ((await root.count()) !== 1) {
    throw new Error(`Speech question container not found or ambiguous: ${question.id}`);
  }

  const spokenText = (
    (answer.text && answer.text.trim() && answer.text.trim() !== 'Câu trả lời tự động')
      ? answer.text.trim()
      : (question.prompt.match(/["“]([^"”]{4,240})["”]/)?.[1] || 'I have completed this speaking response clearly.')
  ).slice(0, 800);

  const synth = await synthesizeSpeechWav(spokenText);

  // Inject Web Audio MediaStream interceptor on the page/frame so any RecordRTC / MediaRecorder gets real audio
  await target.evaluate(async (b64Wav: string) => {
    const raw = atob(b64Wav);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    (window as any).__atqaLastSynthesizedWav = bytes.buffer.slice(0);
    if (!navigator.mediaDevices) {
      try {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {}
        });
      } catch {}
    }

    if (navigator.mediaDevices) {
      (navigator.mediaDevices as any).getUserMedia = async (_constraints: any) => {
        const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) {
          throw new Error('AudioContext unavailable');
        }
        const audioCtx = new AudioCtx();
        if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
          await audioCtx.resume().catch(() => {});
        }
        const dest = audioCtx.createMediaStreamDestination();
        try {
          const decoded = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
          const src = audioCtx.createBufferSource();
          src.buffer = decoded;
          src.loop = true;
          src.connect(dest);
          src.start(0);
        } catch {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          gain.gain.value = 0.15;
          osc.frequency.value = 220;
          osc.connect(gain);
          gain.connect(dest);
          osc.start();
        }
        return dest.stream;
      };
    }
  }, synth.base64Wav).catch(() => {});

  // If the block exposes an <input type="file"> for audio upload, upload the synthesized WAV directly
  const fileInput = root.locator('input[type="file"]').first();
  let uploadedAudioFile = false;
  if ((await fileInput.count().catch(() => 0)) === 1) {
    await fileInput.setInputFiles(synth.wavPath);
    const len = await fileInput.evaluate((el: Element) => (el as HTMLInputElement).files?.length || 0).catch(() => 0);
    if (len >= 1) uploadedAudioFile = true;
  }

  // Click Start / Microphone / Record button if visible
  const recordBtn = root.locator([
    '.btn-microphone',
    '.recordrtc-record-button',
    'button[aria-label*="record" i]',
    'button[data-action="record"]',
    'button:has-text("Start Microphone")',
    'button:has-text("Start recording")',
    'button:has-text("Record")',
    'button:has-text("Ghi âm")',
    'button:has-text("Bắt đầu nói")'
  ].join(', ')).first();

  let clickedRecord = false;
  if ((await recordBtn.count().catch(() => 0)) > 0 && (await recordBtn.isVisible().catch(() => false))) {
    await recordBtn.click().catch(() => {});
    clickedRecord = true;
    await new Promise(r => setTimeout(r, 420));

    // Check if an explicit Stop / Save button appeared or is visible (avoid re-clicking a toggle if only 1 button existed & stopped)
    const stopBtn = root.locator([
      '.recordrtc-stop-button',
      'button[aria-label*="stop" i]',
      'button[data-action="stop"]',
      'button:has-text("Stop recording")',
      'button:has-text("Stop")',
      'button:has-text("Dừng ghi âm")',
      'button:has-text("Dừng")',
      'button:has-text("Save recording")',
      'button:has-text("Lưu ghi âm")'
    ].join(', ')).first();
    if ((await stopBtn.count().catch(() => 0)) > 0 && (await stopBtn.isVisible().catch(() => false))) {
      await stopBtn.click().catch(() => {});
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // If there is also a visible text/textarea inside the speech widget, sync spokenText into it
  const textField = root.locator('textarea:visible, input[type="text"]:visible').first();
  if ((await textField.count().catch(() => 0)) === 1) {
    await textField.fill(spokenText).catch(() => {});
    await textField.evaluate(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }).catch(() => {});
  }

  if (!clickedRecord && !uploadedAudioFile && (await textField.count().catch(() => 0)) === 0) {
    throw new Error('Speech recording control not interactive');
  }

  await root.evaluate((el, txt) => {
    el.setAttribute('data-atqa-speech-recorded', 'true');
    el.setAttribute('data-atqa-speech-text', txt);
  }, spokenText);
}

interface RawDomQuestionInspection {
  idx: number;
  id: string;
  foundDom: boolean;
  scopeTitle?: string;
  hasTranscript: boolean;
  transcriptText: string;
  trackUrls: string[];
  mediaHints: string[];
  hasAudioOnlyNoVisual: boolean;
  promoteMode: 'none' | 'listening' | 'speech' | 'dragdrop' | 'ordering' | 'matching' | 'slider';
  options?: Option[];
  zones?: Option[];
  sliderMeta?: { min: string; max: string; step: string; value: string };
}

interface DiscoveredExtraInteractive {
  id: string;
  kind: Question['kind'];
  sourceType: string;
  prompt: string;
  options: Option[];
  zones?: Option[];
}

/**
 * Autonomous-agent interactive & multimedia enhancer:
 * Runs strictly inside the autonomous agent (`quiz.solve`) without altering `scanQuestions`
 * legacy safety flags used by manual-review tests.
 *
 * Promotes & prepares:
 * - Listening/video questions (extracts `<track>` VTT/SRT captions + `.transcript` DOM text + unblocks `humanOnly`)
 * - Speaking/voice recording questions (promotes to `interactive:speech`)
 * - Generic Drag-and-Drop (`[draggable="true"]` + `.dropzone`) -> `dragdrop`
 * - Generic Word Ordering (`.word-bank`, `.sortablelist`) -> `ordering`
 * - Matching / Connecting Pairs (left column + right column) -> `interactive:matching`
 * - Sliders (`input[type="range"]`) -> `interactive:slider`
 */
export async function promoteAndPrepareMultimediaQuestions(
  page: Page,
  questions: Question[]
): Promise<Question[]> {
  const promoted: Question[] = questions.map(q => ({
    ...q,
    options: [...(q.options || [])],
    ...(q.zones ? { zones: [...q.zones] } : {}),
    ...(q.media ? { media: [...q.media] } : {})
  }));

  // 1. Inspect DOM for each scanned question & promote supported multimedia/interactive shapes
  const inspections: RawDomQuestionInspection[] = await page.evaluate((qs) => {
    const out: RawDomQuestionInspection[] = [];
    const regionSel = 'nav,header,footer,aside,[role="navigation"]';
    const unsupportedBlocks = Array.from(
      document.querySelectorAll<HTMLElement>('.exercise-question,[data-question],[data-question-id]')
    ).filter(el => !el.closest(regionSel));

    for (let idx = 0; idx < qs.length; idx++) {
      const q = qs[idx];
      let scope: HTMLElement | null = null;

      if (q.stableId) {
        const blockId = String(q.stableId).split('#')[0];
        const byStable = document.getElementById(blockId);
        if (byStable) scope = byStable;
      }
      if (!scope) {
        const tagged = document.querySelector<HTMLElement>(`[data-atqa-id="${CSS.escape(q.id)}"]`);
        if (tagged) {
          scope = tagged.closest<HTMLElement>('div.que, .exercise-question, [data-question], [data-question-id], .quiz-question, .question') || tagged;
        }
      }
      if (!scope && q.kind === 'unsupported') {
        const snippet = (q.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        for (const blk of unsupportedBlocks) {
          if (blk.hasAttribute('data-atqa-id')) continue;
          const blkText = (blk.textContent || '').replace(/\s+/g, ' ').trim();
          if (snippet && blkText.includes(snippet)) {
            scope = blk;
            break;
          }
        }
      }

      if (!scope) {
        out.push({
          idx,
          id: q.id,
          foundDom: false,
          hasTranscript: false,
          transcriptText: '',
          trackUrls: [],
          mediaHints: [],
          hasAudioOnlyNoVisual: false,
          promoteMode: 'none'
        });
        continue;
      }

      // Collect <track> captions / live textTracks cues + DOM transcript text + media hints
      const trackUrls: string[] = [];
      const cueTexts: string[] = [];
      scope.querySelectorAll('track').forEach(tr => {
        const src = (tr as HTMLTrackElement).src || tr.getAttribute('src') || '';
        if (src) trackUrls.push(src);
        try {
          const tt = (tr as HTMLTrackElement).track;
          if (tt && tt.cues) {
            for (let ci = 0; ci < tt.cues.length; ci++) {
              const cue = tt.cues[ci] as any;
              if (cue && typeof cue.text === 'string' && cue.text.trim()) {
                cueTexts.push(cue.text.trim());
              }
            }
          }
        } catch {}
      });

      const transcriptParts: string[] = [];
      if (cueTexts.length > 0) transcriptParts.push(cueTexts.join(' '));
      scope.querySelectorAll<HTMLElement>(
        '.transcript, .audio-transcript, .video-transcript, [data-transcript], .captions, figcaption, [aria-description]'
      ).forEach(el => {
        const dt = el.getAttribute('data-transcript') || el.getAttribute('aria-description') || el.textContent || '';
        const norm = dt.replace(/\s+/g, ' ').trim();
        if (norm && !transcriptParts.includes(norm)) transcriptParts.push(norm);
      });

      const rootTranscript = scope.getAttribute('data-transcript') || '';
      if (rootTranscript.trim()) transcriptParts.push(rootTranscript.trim());

      const mediaHints: string[] = [];
      scope.querySelectorAll('audio, video, audio source, video source').forEach(m => {
        const src = (m as HTMLMediaElement).currentSrc || m.getAttribute('src') || '';
        const lbl = m.getAttribute('aria-label') || m.getAttribute('title') || '';
        if (lbl.trim()) mediaHints.push(lbl.trim());
        if (src && !src.startsWith('blob:')) mediaHints.push(src.split('/').pop() || src);
      });

      const hasAudioEl = !!scope.querySelector('audio');
      const hasVisualNonAudio = !!scope.querySelector('img, canvas, svg, math, .katex, .MathJax, video');
      const hasAudioOnlyNoVisual = hasAudioEl && !hasVisualNonAudio;

      const bodyLower = (scope.textContent || '').toLowerCase();
      const hasSpeechWidget =
        /speech\/recording/i.test(String(q.humanOnly || '') + ' ' + String(q.unsupportedReason || '')) ||
        !!scope.querySelector('.btn-microphone, .recordrtc, [class*="recordrtc" i], [aria-label*="record" i], input[type="file"][accept*="audio" i]') ||
        /record your voice|ghi âm|nói vào mic|start microphone/i.test(bodyLower);

      const titleNode = scope.querySelector('h1, h2, h3, h4, .question-title, .qtext, .prompt, legend, [data-question-title]');
      const scopeTitle = (titleNode?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);

      const isActionableControlKind = ['radio', 'checkbox', 'select', 'text', 'textarea'].includes(q.kind);

      // Priority 1: Existing actionable question with audio/video humanOnly OR enclosing audio/track/transcript
      if (
        isActionableControlKind &&
        !hasSpeechWidget &&
        (Boolean(q.humanOnly) || hasAudioEl || transcriptParts.length > 0 || trackUrls.length > 0)
      ) {
        out.push({
          idx,
          id: q.id,
          foundDom: true,
          scopeTitle,
          hasTranscript: transcriptParts.length > 0,
          transcriptText: transcriptParts.join(' | ').slice(0, 2400),
          trackUrls,
          mediaHints,
          hasAudioOnlyNoVisual,
          promoteMode: 'listening'
        });
        continue;
      }

      // Priority 2: Speech/recording (either unsupported speech-only OR flagged humanOnly)
      if (hasSpeechWidget && (q.kind === 'unsupported' || Boolean(q.humanOnly))) {
        scope.setAttribute('data-atqa-id', q.id);
        scope.setAttribute('data-atqa-speech', 'true');
        out.push({
          idx,
          id: q.id,
          foundDom: true,
          hasTranscript: transcriptParts.length > 0,
          transcriptText: transcriptParts.join(' | ').slice(0, 2400),
          trackUrls,
          mediaHints,
          hasAudioOnlyNoVisual: true,
          promoteMode: 'speech'
        });
        continue;
      }

      // Priority 3: Generic unsupported block -> check matching, drag-drop, ordering, slider
      if (q.kind === 'unsupported') {
        const leftNodes = Array.from(
          scope.querySelectorAll<HTMLElement>('.match-left, [data-match-left], .left-item, .pair-left, .matching-left > *, .column-left > *')
        ).filter(el => getComputedStyle(el).display !== 'none');
        const rightNodes = Array.from(
          scope.querySelectorAll<HTMLElement>('.match-right, [data-match-right], .right-item, .pair-right, .matching-right > *, .column-right > *')
        ).filter(el => getComputedStyle(el).display !== 'none');

        if (leftNodes.length >= 2 && rightNodes.length >= 2) {
          scope.setAttribute('data-atqa-id', q.id);
          const options: Option[] = leftNodes.map((n, i) => {
            const oid = `${q.id}_o${i}`;
            n.setAttribute('data-atqa-choice', oid);
            return { id: oid, text: (n.textContent || n.getAttribute('aria-label') || `Item ${i + 1}`).replace(/\s+/g, ' ').trim() };
          });
          const zones: Option[] = rightNodes.map((n, i) => {
            const zid = `${q.id}_z${i}`;
            n.setAttribute('data-atqa-zone', zid);
            return { id: zid, text: (n.textContent || n.getAttribute('aria-label') || `Target ${i + 1}`).replace(/\s+/g, ' ').trim() };
          });
          out.push({
            idx,
            id: q.id,
            foundDom: true,
            hasTranscript: false,
            transcriptText: '',
            trackUrls,
            mediaHints,
            hasAudioOnlyNoVisual: false,
            promoteMode: 'matching',
            options,
            zones
          });
          continue;
        }

        const dragNodes = Array.from(
          scope.querySelectorAll<HTMLElement>('[draggable="true"], .drag-item, [class*="drag-item" i], .word-bank > span, .word-bank > div, .word-bank > button, .sortableitem')
        ).filter(el => getComputedStyle(el).display !== 'none' && !el.closest('.dropzone, [data-dropzone], .drop-target'));
        const zoneNodes = Array.from(
          scope.querySelectorAll<HTMLElement>('.dropzone, .drop-target, [data-dropzone], [data-zone], .drop-slot, .blank-slot, .target-slot')
        ).filter(el => getComputedStyle(el).display !== 'none');

        if (dragNodes.length >= 1 && zoneNodes.length >= 1) {
          scope.setAttribute('data-atqa-id', q.id);
          const options: Option[] = dragNodes.map((n, i) => {
            const oid = `${q.id}_o${i}`;
            n.setAttribute('data-atqa-choice', oid);
            return { id: oid, text: (n.textContent || n.getAttribute('aria-label') || `Drag ${i + 1}`).replace(/\s+/g, ' ').trim() };
          });
          const zones: Option[] = zoneNodes.map((n, i) => {
            const zid = `${q.id}_z${i}`;
            n.setAttribute('data-atqa-zone', zid);
            const zLabel = n.getAttribute('aria-label') || n.getAttribute('data-place') || n.getAttribute('data-dropzone') || n.getAttribute('data-zone') || (n.textContent || '').replace(/\s+/g, ' ').trim() || `Drop zone ${i + 1}`;
            return { id: zid, text: zLabel };
          });
          out.push({
            idx,
            id: q.id,
            foundDom: true,
            hasTranscript: false,
            transcriptText: '',
            trackUrls,
            mediaHints,
            hasAudioOnlyNoVisual: false,
            promoteMode: 'dragdrop',
            options,
            zones
          });
          continue;
        }

        if (dragNodes.length >= 2 && zoneNodes.length === 0) {
          scope.setAttribute('data-atqa-id', q.id);
          const orderTarget = scope.querySelector<HTMLElement>('.answer-area, .sentence-box, .ordered-words, .drop-area');
          if (orderTarget) orderTarget.setAttribute('data-atqa-order-target', q.id);
          const options: Option[] = dragNodes.map((n, i) => {
            const oid = `${q.id}_o${i}`;
            n.setAttribute('data-atqa-choice', oid);
            return { id: oid, text: (n.textContent || n.getAttribute('aria-label') || `Word ${i + 1}`).replace(/\s+/g, ' ').trim() };
          });
          out.push({
            idx,
            id: q.id,
            foundDom: true,
            hasTranscript: false,
            transcriptText: '',
            trackUrls,
            mediaHints,
            hasAudioOnlyNoVisual: false,
            promoteMode: 'ordering',
            options
          });
          continue;
        }

        const slider = scope.querySelector<HTMLInputElement>('input[type="range"]');
        if (slider) {
          slider.setAttribute('data-atqa-id', q.id);
          out.push({
            idx,
            id: q.id,
            foundDom: true,
            hasTranscript: false,
            transcriptText: '',
            trackUrls,
            mediaHints,
            hasAudioOnlyNoVisual: false,
            promoteMode: 'slider',
            sliderMeta: {
              min: slider.min || '0',
              max: slider.max || '100',
              step: slider.step || '1',
              value: slider.value || '0'
            }
          });
          continue;
        }
      }

      out.push({
        idx,
        id: q.id,
        foundDom: true,
        hasTranscript: transcriptParts.length > 0,
        transcriptText: transcriptParts.join(' | ').slice(0, 2400),
        trackUrls,
        mediaHints,
        hasAudioOnlyNoVisual,
        promoteMode: 'none'
      });
    }

    return out;
  }, promoted as any).catch(() => [] as RawDomQuestionInspection[]);

  // Fetch <track> subtitle/transcript files in Node when present on the page
  const trackTextCache = new Map<string, string>();
  for (const ins of inspections) {
    for (const trackUrl of ins.trackUrls) {
      if (!trackUrl || trackTextCache.has(trackUrl)) continue;
      try {
        if (trackUrl.startsWith('data:')) {
          const commaIdx = trackUrl.indexOf(',');
          if (commaIdx > 0) {
            const header = trackUrl.slice(0, commaIdx);
            const rawBody = trackUrl.slice(commaIdx + 1);
            const decoded = header.includes(';base64')
              ? Buffer.from(rawBody, 'base64').toString('utf8')
              : decodeURIComponent(rawBody);
            trackTextCache.set(trackUrl, parseSubtitleTranscript(decoded));
          }
          continue;
        }
        const resolvedUrl = new URL(trackUrl, page.url()).toString();
        const resp = await page.context().request.get(resolvedUrl, { timeout: 6000 });
        if (resp.ok()) {
          const txt = await resp.text();
          trackTextCache.set(trackUrl, parseSubtitleTranscript(txt));
        }
      } catch {}
    }
  }

  for (const ins of inspections) {
    const q = promoted[ins.idx];
    if (!q) continue;

    const fetchedTrackTexts = ins.trackUrls
      .map(u => trackTextCache.get(u) || '')
      .filter(Boolean)
      .join(' | ');
    const combinedTranscript = [ins.transcriptText, fetchedTrackTexts].filter(Boolean).join(' | ').slice(0, 2800);

    if (ins.promoteMode === 'listening') {
      delete q.humanOnly;
      if (ins.hasAudioOnlyNoVisual) {
        q.hasVisual = false;
      }
      if (ins.scopeTitle && !q.prompt.includes(ins.scopeTitle)) {
        q.prompt = `${ins.scopeTitle} (Option context: ${q.prompt})`;
      }
      if (combinedTranscript) {
        q.prompt = `${q.prompt}\n[Transcript / Phụ đề Audio-Video]: ${combinedTranscript}`;
      } else if (ins.mediaHints.length > 0) {
        q.prompt = `${q.prompt}\n[Media đính kèm]: ${ins.mediaHints.join(', ')}`;
      }
    } else if (ins.promoteMode === 'speech') {
      q.kind = 'textarea';
      q.sourceType = 'interactive:speech';
      q.hasVisual = false;
      delete q.humanOnly;
      delete q.unsupportedReason;
      q.prompt = `${q.prompt}\n[Yêu cầu Nói / Ghi âm: Trả về chính xác câu tiếng Anh/Việt cần đọc hoặc câu trả lời nói trong trường "text"]`;
      if (combinedTranscript) {
        q.prompt += `\n[Transcript mẫu]: ${combinedTranscript}`;
      }
    } else if (ins.promoteMode === 'matching' && ins.options && ins.zones) {
      q.kind = 'dragdrop';
      q.sourceType = 'interactive:matching';
      q.options = ins.options;
      q.zones = ins.zones;
      q.hasVisual = false;
      delete q.humanOnly;
      delete q.unsupportedReason;
      q.prompt = `${q.prompt}\n[Yêu cầu Nối cặp (Matching): Ghép từng itemId cột trái với đúng zoneId cột phải trong "placements"]`;
    } else if (ins.promoteMode === 'dragdrop' && ins.options && ins.zones) {
      q.kind = 'dragdrop';
      q.sourceType = 'interactive:dragdrop';
      q.options = ins.options;
      q.zones = ins.zones;
      delete q.humanOnly;
      delete q.unsupportedReason;
    } else if (ins.promoteMode === 'ordering' && ins.options) {
      q.kind = 'ordering';
      q.sourceType = 'interactive:ordering';
      q.options = ins.options;
      q.hasVisual = false;
      delete q.humanOnly;
      delete q.unsupportedReason;
    } else if (ins.promoteMode === 'slider' && ins.sliderMeta) {
      q.kind = 'text';
      q.sourceType = 'interactive:slider';
      q.hasVisual = false;
      delete q.humanOnly;
      delete q.unsupportedReason;
      q.prompt = `${q.prompt}\n[Slider: min=${ins.sliderMeta.min}, max=${ins.sliderMeta.max}, step=${ins.sliderMeta.step}, current=${ins.sliderMeta.value} -> Trả về giá trị số vào trường "text"]`;
    }
  }

  // 2. Discover any standalone interactive blocks NOT caught by scanQuestions (specific widgets first, broad wrappers second)
  const extraStartIndex = promoted.length + 1;
  const extras: DiscoveredExtraInteractive[] = await page.evaluate((startIdx) => {
    const out: DiscoveredExtraInteractive[] = [];
    const regionSel = 'nav,header,footer,aside,[role="navigation"]';
    const specificSel = [
      '.matching-question', '.match-question', '.pair-matching', '.matching-container',
      '.drag-drop-question', '.dragdrop-container', '.dnd-question',
      '.ordering-question', '.word-ordering', '.speaking-question', '.speech-question',
      '[data-activity-type="matching"]', '[data-activity-type="dragdrop"]',
      '[data-activity-type="ordering"]', '[data-activity-type="speaking"]',
      '.quiz-question', '.question'
    ].join(',');
    const broadSel = 'form > div, section, .card';
    const orderedCandidates = [
      ...Array.from(document.querySelectorAll<HTMLElement>(specificSel)),
      ...Array.from(document.querySelectorAll<HTMLElement>(broadSel))
    ];

    let seq = startIdx;
    const seen = new Set<Element>();
    for (const blk of orderedCandidates) {
      if (blk.closest(regionSel) || blk.closest('[data-atqa-id]') || blk.hasAttribute('data-atqa-id')) continue;
      if (blk.querySelector('[data-atqa-id]')) continue;
      if (blk.querySelector(specificSel)) continue;
      const style = getComputedStyle(blk);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      // Avoid nested duplicate containers if a child was already handled or contains multiple separate questions
      const leftNodes = Array.from(
        blk.querySelectorAll<HTMLElement>('.match-left, [data-match-left], .left-item, .pair-left, .matching-left > *, .column-left > *')
      ).filter(el => !el.closest('[data-atqa-id]') && getComputedStyle(el).display !== 'none');
      const rightNodes = Array.from(
        blk.querySelectorAll<HTMLElement>('.match-right, [data-match-right], .right-item, .pair-right, .matching-right > *, .column-right > *')
      ).filter(el => !el.closest('[data-atqa-id]') && getComputedStyle(el).display !== 'none');

      if (leftNodes.length >= 2 && rightNodes.length >= 2 && !seen.has(blk)) {
        seen.add(blk);
        const id = `q${seq++}`;
        blk.setAttribute('data-atqa-id', id);
        const promptEl = blk.querySelector('h1,h2,h3,h4,.question-title,.qtext,.prompt,p');
        const promptTxt = (promptEl?.textContent || blk.textContent || 'Nối cặp tương ứng').replace(/\s+/g, ' ').trim().slice(0, 600);
        const options = leftNodes.map((n, i) => {
          const oid = `${id}_o${i}`;
          n.setAttribute('data-atqa-choice', oid);
          return { id: oid, text: (n.textContent || n.getAttribute('aria-label') || `Item ${i + 1}`).replace(/\s+/g, ' ').trim() };
        });
        const zones = rightNodes.map((n, i) => {
          const zid = `${id}_z${i}`;
          n.setAttribute('data-atqa-zone', zid);
          return { id: zid, text: (n.textContent || n.getAttribute('aria-label') || `Target ${i + 1}`).replace(/\s+/g, ' ').trim() };
        });
        out.push({
          id,
          kind: 'dragdrop',
          sourceType: 'interactive:matching',
          prompt: `${promptTxt}\n[Yêu cầu Nối cặp (Matching): Ghép từng itemId cột trái với đúng zoneId cột phải trong "placements"]`,
          options,
          zones
        });
        continue;
      }

      const dragNodes = Array.from(
        blk.querySelectorAll<HTMLElement>('[draggable="true"], .drag-item, .word-bank > span, .word-bank > div, .sortableitem')
      ).filter(el => !el.closest('[data-atqa-id]') && !el.closest('.dropzone, [data-dropzone]') && getComputedStyle(el).display !== 'none');
      const zoneNodes = Array.from(
        blk.querySelectorAll<HTMLElement>('.dropzone, .drop-target, [data-dropzone], [data-zone], .drop-slot, .blank-slot')
      ).filter(el => !el.closest('[data-atqa-id]') && getComputedStyle(el).display !== 'none');

      if (dragNodes.length >= 1 && zoneNodes.length >= 1 && !seen.has(blk)) {
        seen.add(blk);
        const id = `q${seq++}`;
        blk.setAttribute('data-atqa-id', id);
        const promptEl = blk.querySelector('h1,h2,h3,h4,.question-title,.qtext,.prompt,p');
        const promptTxt = (promptEl?.textContent || blk.textContent || 'Kéo thả vào ô đúng').replace(/\s+/g, ' ').trim().slice(0, 600);
        const options = dragNodes.map((n, i) => {
          const oid = `${id}_o${i}`;
          n.setAttribute('data-atqa-choice', oid);
          return { id: oid, text: (n.textContent || n.getAttribute('aria-label') || `Drag ${i + 1}`).replace(/\s+/g, ' ').trim() };
        });
        const zones = zoneNodes.map((n, i) => {
          const zid = `${id}_z${i}`;
          n.setAttribute('data-atqa-zone', zid);
          const zLabel = n.getAttribute('aria-label') || n.getAttribute('data-place') || n.getAttribute('data-dropzone') || (n.textContent || '').replace(/\s+/g, ' ').trim() || `Drop zone ${i + 1}`;
          return { id: zid, text: zLabel };
        });
        out.push({
          id,
          kind: 'dragdrop',
          sourceType: 'interactive:dragdrop',
          prompt: promptTxt,
          options,
          zones
        });
        continue;
      }

      if (dragNodes.length >= 2 && zoneNodes.length === 0 && !seen.has(blk)) {
        seen.add(blk);
        const id = `q${seq++}`;
        blk.setAttribute('data-atqa-id', id);
        const orderTarget = blk.querySelector<HTMLElement>('.answer-area, .sentence-box, .ordered-words, .drop-area');
        if (orderTarget) orderTarget.setAttribute('data-atqa-order-target', id);
        const promptEl = blk.querySelector('h1,h2,h3,h4,.question-title,.qtext,.prompt,p');
        const promptTxt = (promptEl?.textContent || blk.textContent || 'Sắp xếp thứ tự').replace(/\s+/g, ' ').trim().slice(0, 600);
        const options = dragNodes.map((n, i) => {
          const oid = `${id}_o${i}`;
          n.setAttribute('data-atqa-choice', oid);
          return { id: oid, text: (n.textContent || n.getAttribute('aria-label') || `Item ${i + 1}`).replace(/\s+/g, ' ').trim() };
        });
        out.push({
          id,
          kind: 'ordering',
          sourceType: 'interactive:ordering',
          prompt: promptTxt,
          options
        });
        continue;
      }

      const hasSpeechBtn = !!blk.querySelector('.btn-microphone, .recordrtc, [class*="recordrtc" i], button[aria-label*="record" i]');
      if (hasSpeechBtn && !seen.has(blk)) {
        seen.add(blk);
        const id = `q${seq++}`;
        blk.setAttribute('data-atqa-id', id);
        blk.setAttribute('data-atqa-speech', 'true');
        const promptEl = blk.querySelector('h1,h2,h3,h4,.question-title,.qtext,.prompt,p');
        const promptTxt = (promptEl?.textContent || blk.textContent || 'Ghi âm câu trả lời').replace(/\s+/g, ' ').trim().slice(0, 600);
        out.push({
          id,
          kind: 'textarea',
          sourceType: 'interactive:speech',
          prompt: `${promptTxt}\n[Yêu cầu Nói / Ghi âm: Trả về chính xác câu tiếng Anh/Việt cần đọc hoặc câu trả lời nói trong trường "text"]`,
          options: []
        });
      }
    }
    return out;
  }, extraStartIndex).catch(() => [] as DiscoveredExtraInteractive[]);

  for (const ex of extras) {
    promoted.push({
      id: ex.id,
      kind: ex.kind,
      sourceType: ex.sourceType,
      prompt: ex.prompt,
      options: ex.options,
      ...(ex.zones ? { zones: ex.zones } : {}),
      required: false,
      hasVisual: false
    });
  }

  return promoted;
}
