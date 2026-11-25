/** AutoTask AI Terminal Autonomous Agent Interface (REPL & CLI) */
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrapIntermediateCa } from '../ca-bootstrap.js';
import { createAgentContext, runAgentLoop } from './loop.js';
import { executeAgentTool } from './tools.js';
import type { AgentContext, AgentExecutionResult } from './types.js';
import { listPlaybooks, deletePlaybook, registerAllowedUrlHost, stripVietnameseAccents } from './playbooks.js';
import { listRecentRunLogs, readRunLog, formatRunLogMarkdown } from './run-logger.js';
import {
  checkAllProfilesQuota,
  formatQuotaReport,
  inspectSingleApiKeySpecs,
  formatSingleKeySpecReport,
  formatTokenShort
} from '../model-center/quota-checker.js';
import { getKeySlotTelemetrySnapshot } from '../model-center/model-router.js';
import { readProfilesDb, saveProfilesDb, getProfileKeySlots, nextKeySlotId } from '../model-center/routing.js';
import { addApiKeysToProfile } from '../model-center/key-manager.js';
import { GEMINI_AUTO_MODEL_POOL, VERIFIED_CAPABILITIES, PROVIDER_REGISTRY, fetchLiveModels } from '../model-center/catalog.js';
import { maskApiKey, setModelKey, getModelKey } from '../model-center/keyring.js';
import type { ModelProfilesDb, ProviderId } from '../model-center/types.js';
import { runModelCenter, runLiveQuotaWatchUi } from '../ui/model-center-cli.js';
import {
  header,
  renderBreadcrumb,
  paint,
  gradientText,
  badge,
  introAnimation,
  setupTerminalCleanup,
  registerExitCleanup,
  renderTable,
  renderMeterBar,
  renderSparkline,
  renderThemeSwatches,
  withSpinner,
  animateKeyRotation,
  gradientStopsForTheme
} from '../ui/tokyo.js';
import { loadTheme, saveTheme, theme } from '../ui/themes.js';
import { promptSecret } from '../security/secure-input.js';
import {
  listAccounts,
  saveAccount,
  getDefaultAccountId,
  setDefaultAccount,
  forgetSession
} from '../accounts.js';

export interface SelectableModelOption {
  mode: 'auto' | 'manual';
  modelId?: string;
  profileId?: string;
  label: string;
  description: string;
}

export interface ModelSelectionResult {
  cancelled: boolean;
  mode: 'auto' | 'manual';
  modelOverride?: string;
  profileOverride?: string;
}

const CURATED_MODEL_DESCRIPTIONS: Record<string, string> = {
  'gemini-3-flash-preview': 'Nhanh + suy luận tốt (~2s, 5 RPM / 20 RPD/key) — Hợp giải quiz & thao tác chuẩn',
  'gemini-3.6-flash': 'Flash suy luận sâu (5 RPM / 20 RPD/key) — Hợp câu hỏi khó, bẫy logic',
  'gemini-3.7-flash': 'Gemini 3.7 Flash cân bằng thông minh (5 RPM / 20 RPD/key)',
  'gemini-3.8-flash': 'Gemini 3.8 Flash mới nhất (5 RPM / 20 RPD/key)',
  'gemini-3.5-flash': 'Gemini 3.5 Flash chuẩn (5 RPM / 20 RPD/key)',
  'gemini-flash-latest': 'Alias Gemini Flash mới nhất (5 RPM / 20 RPD/key)',
  'gemini-3.5-flash-lite': 'Siêu nhanh, hạn mức cao (15 RPM / 500 RPD/key) — Hợp kiểm tra / chạy dài',
  'gemini-3.1-flash-lite': 'Nhẹ, ổn định, hạn mức cao (15 RPM / 500 RPD/key) — Hợp chạy tác vụ dài',
  'gemma-4-31b-it': 'RPD cực cao (30 RPM / 14.4K RPD/key, chỉ text) — Dự phòng nhiều chữ'
};

/** Builds ordered interactive model options from live profiles + curated Gemini/Gemma pool */
export function buildSelectableModelOptions(db: ModelProfilesDb): SelectableModelOption[] {
  const options: SelectableModelOption[] = [
    {
      mode: 'auto',
      label: 'Tự động thông minh (Khuyên dùng)',
      description: 'Ưu tiên Flash suy luận mạnh trước, hết quota tự xoay key & fallback'
    }
  ];

  const profiles = db?.profiles || {};
  const profileEntries = Object.entries(profiles);
  const seenModels = new Set<string>();

  // 1. Add non-Gemini configured profiles (OpenAI, Anthropic, Groq, custom gateways) if available
  for (const [id, prof] of profileEntries) {
    if (!prof || prof.verifiedStatus === 'FAILED') continue;
    if (prof.provider === 'gemini') continue;
    const norm = `${prof.provider}:${prof.model.toLowerCase()}`;
    if (seenModels.has(norm)) continue;
    seenModels.add(norm);
    const capDesc = VERIFIED_CAPABILITIES[prof.model]?.description || `${prof.provider} (${id})`;
    options.push({
      mode: 'manual',
      modelId: prof.model,
      profileId: id,
      label: `${prof.model} [${prof.provider}]`,
      description: capDesc
    });
  }

  // 2. Add curated Gemini / Gemma choices when Gemini keys exist (or no profiles configured yet)
  const hasGemini = profileEntries.some(([, p]) => p && p.provider === 'gemini' && p.verifiedStatus !== 'FAILED');
  if (hasGemini || profileEntries.length === 0) {
    const preferredOrder = [
      'gemini-3-flash-preview',
      'gemini-3.6-flash',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemma-4-31b-it',
      ...GEMINI_AUTO_MODEL_POOL
    ];
    for (const modelId of preferredOrder) {
      const lower = modelId.toLowerCase();
      if (seenModels.has(lower)) continue;
      // Skip less-needed lite duplicate aliases unless explicitly configured as primary default
      if (modelId === 'gemini-3.1-flash-lite-preview' || modelId === 'gemini-flash-lite-latest' || modelId === 'gemma-4-26b-a4b-it') {
        continue;
      }
      seenModels.add(lower);
      options.push({
        mode: 'manual',
        modelId,
        label: modelId,
        description: CURATED_MODEL_DESCRIPTIONS[modelId] || VERIFIED_CAPABILITIES[modelId]?.description || 'Gemini model'
      });
    }

    // Also include any custom Gemini profile model IDs saved by user that aren't in preferredOrder
    for (const [, prof] of profileEntries) {
      if (!prof || prof.provider !== 'gemini' || prof.verifiedStatus === 'FAILED') continue;
      const lower = prof.model.trim().toLowerCase();
      if (!lower || seenModels.has(lower)) continue;
      seenModels.add(lower);
      options.push({
        mode: 'manual',
        modelId: prof.model.trim(),
        label: prof.model.trim(),
        description: CURATED_MODEL_DESCRIPTIONS[prof.model.trim()] || VERIFIED_CAPABILITIES[prof.model.trim()]?.description || 'Model cấu hình sẵn trong Model Center'
      });
    }
  }

  return options;
}

/** Auto-detects LLM provider from user API key prefix */
export function detectProviderFromApiKey(rawKey: string): ProviderId | undefined {
  const k = String(rawKey || '').trim();
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(k)) return 'gemini';
  if (/^gsk_[0-9A-Za-z_-]{20,}$/.test(k)) return 'groq';
  if (/^sk-ant-[0-9A-Za-z_-]{20,}$/.test(k)) return 'anthropic';
  if (/^sk-[0-9A-Za-z_-]{20,}$/.test(k)) return 'openai';
  return undefined;
}

export interface ApiKeyScanOptions {
  providerHint?: ProviderId;
  customEndpoint?: string;
  dbPath?: string;
  bypassCache?: boolean;
  fetchModelsFn?: typeof fetchLiveModels;
  setKeyFn?: (profileId: string, apiKey: string) => void;
  getKeyFn?: (profileId: string) => string | null;
  saveProfile?: boolean;
  profileId?: string;
  appendToProfileId?: string;
  additionalKeys?: string[];
}

export { addApiKeysToProfile };

/** Scans live models for 1 or more user-supplied API keys, lets the user pick a model or append to a profile, and binds rotation into AgentContext */
export async function scanAndSelectModelFromApiKey(
  rawKeyInput: string,
  ctx: AgentContext,
  rl?: { question: (q: string) => Promise<string> },
  options?: ApiKeyScanOptions
): Promise<ModelSelectionResult & { provider?: ProviderId; source?: 'API_LIVE' | 'OFFICIAL_REGISTRY'; scannedCount: number; addedSlots?: string[] }> {
  const rawTokens = String(rawKeyInput || '')
    .replace(/^(?:key|api)\s+/i, '')
    .split(/[\s,;]+/)
    .map(k => k.trim())
    .filter(Boolean);
  const apiKey = rawTokens[0] || '';
  const extraKeys = [
    ...rawTokens.slice(1),
    ...(options?.additionalKeys || [])
  ].filter(k => k.length >= 10 && k !== apiKey);

  const baseCancelled = (): ModelSelectionResult & { scannedCount: number } => ({
    cancelled: true,
    mode: ctx.config.modelOverride ? 'manual' : 'auto',
    modelOverride: ctx.config.modelOverride,
    profileOverride: ctx.config.profileOverride,
    scannedCount: 0
  });

  if (apiKey.length < 10) {
    console.log(paint('  ✖ API key quá ngắn hoặc không hợp lệ.\n', 'red'));
    return baseCancelled();
  }

  let provider: ProviderId | undefined = options?.providerHint || detectProviderFromApiKey(apiKey);
  if (!provider) {
    if (!rl) return baseCancelled();
    console.log(paint('\nChưa nhận diện được nhà cung cấp từ định dạng key. Hãy chọn provider:', 'yellow'));
    console.log('  [1] Google Gemini  [2] OpenAI  [3] Groq  [4] Anthropic Claude  [5] Custom');
    const pChoice = (await rl.question(paint('  ❯ Chọn provider [1-5, 0=Hủy]: ', 'cyan'))).trim();
    const map: Record<string, ProviderId> = { '1': 'gemini', '2': 'openai', '3': 'groq', '4': 'anthropic', '5': 'custom' };
    provider = map[pChoice];
    if (!provider) return baseCancelled();
  }

  const meta = PROVIDER_REGISTRY[provider];
  console.log(paint(`\n[Key Scanner] Đang quét các model từ API key ${maskApiKey(apiKey)}${extraKeys.length > 0 ? ` (+${extraKeys.length} key bổ sung)` : ''} (${meta.name})...`, 'cyan', true));
  const fetcher = options?.fetchModelsFn || fetchLiveModels;
  const res = await fetcher(provider, apiKey, options?.customEndpoint, options?.bypassCache ?? true);

  if (res.note) {
    console.log(paint(`  ℹ ${res.note}`, res.source === 'API_LIVE' ? 'green' : 'yellow'));
  }
  if (!res.models || res.models.length === 0) {
    console.log(paint('  ✖ Không quét được model nào từ API key này.\n', 'red'));
    return { ...baseCancelled(), provider, source: res.source };
  }

  console.log(paint(`\n── CÁC MODEL KHẢ DỤNG TỪ KEY (${res.source === 'API_LIVE' ? 'API LIVE' : 'DANH MỤC CHUẨN'}) ──`, 'cyan', true));
  res.models.forEach((m, i) => {
    const cap = m.capabilities?.vision ? 'Vision+Text' : 'Text';
    const tag = m.isVerified ? ' [Verified]' : '';
    console.log(`  [${i + 1}] ` + paint(m.id, 'fg', i === 0) + paint(` (${cap}${tag})`, 'muted'));
  });
  console.log(paint('  [0] Quay lại (giữ nguyên cấu hình hiện tại)', 'muted'));

  let chosenModel = res.models[0];
  if (rl) {
    while (true) {
      const pick = (await rl.question(paint(`\n  ❯ Chọn model (1-${res.models.length}, tên model, Enter=[1], 0=Hủy): `, 'cyan', true))).trim();
      const pickNorm = pick.toLowerCase();
      if (pickNorm === '0' || pickNorm === 'huy' || pickNorm === 'hủy' || pickNorm === 'cancel') {
        return { ...baseCancelled(), provider, source: res.source, scannedCount: res.models.length };
      }
      if (!pick) {
        chosenModel = res.models[0];
        break;
      }
      if (/^\d+$/.test(pick)) {
        const idx = parseInt(pick, 10) - 1;
        if (idx >= 0 && idx < res.models.length) {
          chosenModel = res.models[idx];
          break;
        }
      } else {
        const matched = res.models.find(m => m.id.toLowerCase() === pickNorm || (m.name && m.name.toLowerCase() === pickNorm));
        if (matched) {
          chosenModel = matched;
          break;
        }
        if (pick.length >= 3 && !/\s/.test(pick)) {
          chosenModel = {
            id: pick,
            provider,
            capabilities: { vision: false, contextWindow: 128000, taskCompatibility: ['DOM', 'Reasoning'] },
            isVerified: false,
            capabilitySource: 'USER_DECLARED'
          };
          break;
        }
      }
      console.log(paint(`  ✖ Lựa chọn "${pick}" không hợp lệ.`, 'red'));
    }
  }

  let profileId = ctx.config.profileOverride;
  let addedSlots: string[] = [];
  if (options?.saveProfile !== false) {
    const db = await readProfilesDb(options?.dbPath).catch((): ModelProfilesDb => ({ profiles: {}, fallbacks: [] }));
    const setKeyFn = options?.setKeyFn || setModelKey;
    const getKeyFn = options?.getKeyFn || getModelKey;
    const compatibleExisting = Object.keys(db.profiles).filter(id => db.profiles[id]?.provider === provider);

    let targetAppendId = options?.appendToProfileId && db.profiles[options.appendToProfileId]
      ? options.appendToProfileId
      : undefined;

    if (!targetAppendId && !options?.profileId && compatibleExisting.length > 0 && rl) {
      const defProf = compatibleExisting.includes(db.default || '') ? db.default! : compatibleExisting[0];
      const existingCount = getProfileKeySlots(defProf, db.profiles[defProf]).length;
      console.log(paint(`\n  💡 Phát hiện profile ${meta.name} đang có: ${compatibleExisting.join(', ')}`, 'cyan'));
      console.log(`     [1] Gắn key này vào profile "${defProf}" để xoay vòng (${existingCount} -> ${existingCount + 1 + extraKeys.length} key) (Khuyên dùng)`);
      console.log(`     [2] Tạo profile riêng mới`);
      const modeAns = (await rl.question(paint('  ❯ Chọn [1-2 hoặc nhập tên profile muốn gắn, Enter=1]: ', 'cyan'))).trim();
      if (!modeAns || modeAns === '1') {
        targetAppendId = defProf;
      } else if (db.profiles[modeAns]) {
        targetAppendId = modeAns;
      }
    }

    if (targetAppendId) {
      profileId = targetAppendId;
      const appendRes = await addApiKeysToProfile(targetAppendId, [apiKey, ...extraKeys], {
        dbPath: options?.dbPath,
        setKeyFn,
        getKeyFn
      });
      addedSlots = appendRes.addedSlots;
      // Clear single-profile lock so ModelRouter freely rotates across all profiles & key slots
      ctx.config.profileOverride = undefined;
      console.log(paint(`✔ Đã thêm ${addedSlots.length} key vào profile ${targetAppendId} (Tổng pool: ${appendRes.totalSlots} key) -> Tự động xoay vòng đa key!\n`, 'green', true));
    } else {
      profileId = options?.profileId || `user_${provider}_${Date.now().toString(36)}`;
      setKeyFn(profileId, apiKey);
      const slots = [profileId];
      for (const ek of extraKeys) {
        const nextSlot = nextKeySlotId(profileId, slots);
        setKeyFn(nextSlot, ek);
        slots.push(nextSlot);
      }
      db.profiles[profileId] = {
        provider,
        kind: meta.kind,
        model: chosenModel.id,
        endpoint: options?.customEndpoint || meta.defaultEndpoint,
        displayName: `User ${meta.name} (${maskApiKey(apiKey)})`,
        ...(slots.length > 1 ? { keySlots: slots } : {}),
        createdAt: new Date().toISOString(),
        verifiedStatus: res.source === 'API_LIVE' ? 'VERIFIED' : 'UNTESTED',
        metadata: {
          supportsVision: chosenModel.capabilities?.vision,
          inputTokenLimit: chosenModel.capabilities?.contextWindow,
          description: chosenModel.capabilities?.description
        }
      };
      if (!db.default) db.default = profileId;
      await saveProfilesDb(db, options?.dbPath);
      addedSlots = slots;
      // Only pin profileOverride when caller explicitly specified profileId AND only 1 profile exists
      if (options?.profileId || Object.keys(db.profiles).length <= 1) {
        ctx.config.profileOverride = profileId;
      } else {
        ctx.config.profileOverride = undefined;
      }
    }
  }

  ctx.config.modelOverride = chosenModel.id;
  console.log(paint(`✔ Đã liên kết key ${maskApiKey(apiKey)} và ưu tiên model: ${chosenModel.id}${profileId ? ` (profile: ${profileId})` : ''}\n`, 'green', true));
  return {
    cancelled: false,
    mode: 'manual',
    modelOverride: chosenModel.id,
    profileOverride: ctx.config.profileOverride,
    provider,
    source: res.source,
    scannedCount: res.models.length,
    ...(addedSlots.length > 0 ? { addedSlots } : {})
  };
}

/** Prompts user right after prompt input to choose an AI model or Auto mode */
export async function promptModelSelection(
  ctx: AgentContext,
  rl: { question: (q: string) => Promise<string> },
  opts?: {
    db?: ModelProfilesDb;
    compactIfChosen?: boolean;
    dbPath?: string;
    setKeyFn?: (slotId: string, apiKey: string) => void;
    getKeyFn?: (slotId: string) => string | null;
    promptSecretFn?: (msg: string) => Promise<string>;
  }
): Promise<ModelSelectionResult> {
  const db = opts?.db || await readProfilesDb(opts?.dbPath).catch(() => ({ profiles: {}, fallbacks: [] }));
  const options = buildSelectableModelOptions(db);

  let defaultIdx = 0;
  if (ctx.config.modelOverride) {
    const foundIdx = options.findIndex(o =>
      o.mode === 'manual' &&
      o.modelId?.toLowerCase() === ctx.config.modelOverride?.toLowerCase() &&
      (!ctx.config.profileOverride || !o.profileId || o.profileId === ctx.config.profileOverride)
    );
    if (foundIdx >= 0) defaultIdx = foundIdx;
  }
  const defaultNum = defaultIdx + 1;

  const printFullModelMenu = () => {
    console.log('\n' + gradientText('── LỰA CHỌN MODEL AI PHÙ HỢP ──────────────────────────', undefined, true));
    console.log(paint('Bạn hãy lựa chọn model bên dưới:', 'fg', true));
    options.forEach((opt, i) => {
      const num = i + 1;
      const isActive = i === defaultIdx;
      const activeBadge = isActive ? badge('★ ĐANG CHỌN', 'green') : '';
      const lineColor = opt.mode === 'auto' ? 'green' : (opt.modelId?.includes('flash-preview') || opt.modelId?.includes('3.6') || opt.modelId?.includes('gpt-4o') ? 'cyan' : 'fg');
      console.log(`  [${num}] ` + paint(opt.label, lineColor, isActive) + (activeBadge ? ' ' + activeBadge : ''));
      console.log(`      ` + paint(opt.description, 'muted'));
    });
    console.log(paint('  [k] Nhập API key cá nhân (Gemini/OpenAI/Groq/Claude) để quét & chọn model trực tiếp', 'cyan'));
    console.log(paint('  [a] Thêm API key vào profile có sẵn (tăng pool xoay vòng đa key)', 'purple'));
    console.log(paint('  [0] Hủy chạy lệnh này (quay lại nhập lệnh khác)', 'muted'));
  };

  let compactMode = Boolean(opts?.compactIfChosen);
  if (!compactMode) {
    printFullModelMenu();
  }

  while (true) {
    const activeOpt = options[defaultIdx];
    const activeLabel = ctx.config.modelOverride
      ? `${ctx.config.modelOverride}${ctx.config.profileOverride ? ` (${ctx.config.profileOverride})` : ''}`
      : (activeOpt?.label || 'Tự động thông minh (Khuyên dùng)');
    const promptMsg = compactMode
      ? paint(`\n⚡ Model đang chọn: ${activeLabel} (Enter = Giữ nguyên, "m" = Bảng chọn đầy đủ, "k" = Nhập API key, "a" = Thêm key vào profile, số/tên = Đổi nhanh, "0" = Hủy): `, 'cyan', true)
      : paint(`\n  ❯ Chọn model (1-${options.length}, tên model, "k"/dán key, "a" = thêm key vào profile, hoặc 0 để hủy) [${defaultNum}]: `, 'cyan', true);

    const raw = (await rl.question(promptMsg)).trim();
    const norm = raw.toLowerCase();

    if (compactMode && (norm === 'm' || norm === 'menu' || norm === 'list' || norm === 'danh sach')) {
      compactMode = false;
      printFullModelMenu();
      continue;
    }

    if (norm === '0' || norm === 'huy' || norm === 'hủy' || norm === 'cancel' || norm === 'back') {
      return {
        cancelled: true,
        mode: ctx.config.modelOverride ? 'manual' : 'auto',
        modelOverride: ctx.config.modelOverride,
        profileOverride: ctx.config.profileOverride
      };
    }

    if (norm === 'a' || norm === 'add' || norm === 'add key' || norm === 'key add') {
      const latestDb = opts?.dbPath
        ? await readProfilesDb(opts.dbPath).catch((): ModelProfilesDb => ({ profiles: {}, fallbacks: [] }))
        : (opts?.db || await readProfilesDb().catch((): ModelProfilesDb => ({ profiles: {}, fallbacks: [] })));
      const profIds = Object.keys(latestDb.profiles || {});
      const readSecret = opts?.promptSecretFn || ((msg: string) => promptSecret(msg, { allowEmpty: true }));
      if (profIds.length === 0) {
        console.log(paint('  ℹ Chưa có profile nào; chuyển sang nhập API key mới để tạo profile...', 'yellow'));
        const suppliedKey = (await readSecret('  Nhập API key cá nhân (được che khi gõ): ')).trim();
        if (suppliedKey) {
          const scanRes = await scanAndSelectModelFromApiKey(suppliedKey, ctx, rl, {
            dbPath: opts?.dbPath,
            setKeyFn: opts?.setKeyFn,
            getKeyFn: opts?.getKeyFn
          });
          if (!scanRes.cancelled) {
            return {
              cancelled: false,
              mode: scanRes.mode,
              modelOverride: scanRes.modelOverride,
              profileOverride: scanRes.profileOverride
            };
          }
        }
        continue;
      }
      console.log(paint('\n  ── THÊM API KEY VÀO PROFILE CÓ SẴN ──', 'cyan', true));
      profIds.forEach((pid, idx) => {
        const pr = latestDb.profiles[pid];
        const slots = getProfileKeySlots(pid, pr);
        console.log(`    [${idx + 1}] ` + paint(pid, 'fg', pid === latestDb.default) + paint(` (${pr.provider.toUpperCase()} · ${pr.model} · ${slots.length} key)`, 'muted'));
      });
      const pickPrfRaw = (await rl.question(paint(`  ❯ Chọn STT (1-${profIds.length}) hoặc Profile ID [1, 0=Hủy]: `, 'cyan'))).trim() || '1';
      if (pickPrfRaw === '0') continue;
      let targetPrf: string | undefined = latestDb.profiles[pickPrfRaw] ? pickPrfRaw : undefined;
      if (!targetPrf && /^\d+$/.test(pickPrfRaw)) {
        const pIdx = parseInt(pickPrfRaw, 10) - 1;
        if (pIdx >= 0 && pIdx < profIds.length) targetPrf = profIds[pIdx];
      }
      if (!targetPrf) {
        console.log(paint(`  ✖ Không tìm thấy profile "${pickPrfRaw}".`, 'red'));
        continue;
      }
      const extraKeys = (await readSecret(`  Nhập 1 hoặc nhiều API key để gắn vào "${targetPrf}" (cách nhau bởi dấu cách/phẩy): `)).trim();
      if (extraKeys) {
        try {
          const addRes = await addApiKeysToProfile(targetPrf, extraKeys, {
            dbPath: opts?.dbPath,
            setKeyFn: opts?.setKeyFn,
            getKeyFn: opts?.getKeyFn
          });
          console.log(paint(`✔ Đã gắn thêm ${addRes.addedSlots.length} key vào "${addRes.profileId}" (Tổng: ${addRes.totalSlots} key sẵn sàng xoay vòng).\n`, 'green', true));
        } catch (err: any) {
          console.log(paint(`✖ Lỗi thêm API key: ${err?.message || err}\n`, 'red'));
        }
      }
      continue;
    }

    if (norm === 'k' || norm === 'key' || norm.startsWith('key ') || norm.startsWith('api ') || detectProviderFromApiKey(raw)) {
      const suppliedKey = (norm === 'k' || norm === 'key')
        ? (await promptSecret('  Nhập API key cá nhân (được che khi gõ): ')).trim()
        : raw.replace(/^(?:key|api)\s+/i, '').trim();
      const scanRes = await scanAndSelectModelFromApiKey(suppliedKey, ctx, rl);
      if (!scanRes.cancelled) {
        return {
          cancelled: false,
          mode: scanRes.mode,
          modelOverride: scanRes.modelOverride,
          profileOverride: scanRes.profileOverride
        };
      }
      continue;
    }

    let chosen: SelectableModelOption | undefined;
    if (!raw) {
      chosen = options[defaultIdx];
    } else if (/^\d+$/.test(raw)) {
      const idx = parseInt(raw, 10) - 1;
      if (idx >= 0 && idx < options.length) {
        chosen = options[idx];
      }
    } else {
      chosen = options.find(o => o.modelId?.toLowerCase() === norm || (norm === 'auto' && o.mode === 'auto'));
      if (!chosen && raw.length >= 3 && !/\s/.test(raw)) {
        // Allow user to type any custom model slug directly
        chosen = { mode: 'manual', modelId: raw, label: raw, description: 'Model nhập trực tiếp' };
      }
    }

    if (!chosen) {
      console.log(paint(`  ✖ Lựa chọn "${raw}" chưa hợp lệ. Hãy nhập số từ 1 đến ${options.length}, tên model, hoặc 0 để hủy.`, 'red'));
      continue;
    }

    if (chosen.mode === 'auto') {
      ctx.config.modelOverride = undefined;
      ctx.config.profileOverride = undefined;
      console.log(paint(`✔ Đã chọn chế độ Model: ${chosen.label}\n`, 'green', true));
      return { cancelled: false, mode: 'auto' };
    }

    ctx.config.modelOverride = chosen.modelId;
    ctx.config.profileOverride = chosen.profileId;
    console.log(paint(`✔ Đã chọn Model: ${chosen.modelId}${chosen.profileId ? ` (profile: ${chosen.profileId})` : ' (tự xoay key khi chạy)'}\n`, 'green', true));
    return {
      cancelled: false,
      mode: 'manual',
      modelOverride: chosen.modelId,
      profileOverride: chosen.profileId
    };
  }
}

/** Parses CLI flags (--headless, --model, --profile, --auto-model, --no-model-prompt) without corrupting singlePrompt */
export function parseAgentCliArgs(argv: string[]): {
  singlePrompt: string;
  isHeadless: boolean;
  modelOverride?: string;
  profileOverride?: string;
  autoModel: boolean;
  noModelPrompt: boolean;
} {
  let isHeadless = false;
  let modelOverride: string | undefined;
  let profileOverride: string | undefined;
  let autoModel = false;
  let noModelPrompt = false;
  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--headless') {
      isHeadless = true;
    } else if (arg === '--auto-model') {
      autoModel = true;
    } else if (arg === '--no-model-prompt') {
      noModelPrompt = true;
    } else if (arg === '--model' && i + 1 < argv.length) {
      modelOverride = argv[++i].trim() || undefined;
    } else if (arg.startsWith('--model=')) {
      modelOverride = arg.slice('--model='.length).trim() || undefined;
    } else if (arg === '--profile' && i + 1 < argv.length) {
      profileOverride = argv[++i].trim() || undefined;
    } else if (arg.startsWith('--profile=')) {
      profileOverride = arg.slice('--profile='.length).trim() || undefined;
    } else if (!arg.startsWith('--')) {
      promptParts.push(arg);
    }
  }

  return {
    singlePrompt: promptParts.join(' ').trim(),
    isHeadless,
    modelOverride,
    profileOverride,
    autoModel,
    noModelPrompt
  };
}

/** Displays the formatted ready banner after account setup */
export function printReadyBanner(ctx: AgentContext): void {
  const targetWeb = ctx.config.targetWebUrl || 'https://lms.hust.edu.vn';
  const targetAcc = ctx.activeAccountId
    ? (ctx.activeAccountId === 'in_memory'
        ? 'Tài khoản tạm thời (Bộ nhớ phiên)'
        : `${ctx.activeAccountId} (Windows Credential Manager)`)
    : 'Chế độ khách (Chưa chọn tài khoản)';

  const authState = ctx.isLoggedIn
    ? '✔ Đã xác thực đăng nhập'
    : '⏳ Chưa đăng nhập (Sẵn sàng tự động đăng nhập khi mở web hoặc gõ "login")';

  const modelLabel = ctx.config.modelOverride
    ? `${ctx.config.modelOverride}${ctx.config.profileOverride ? ` (${ctx.config.profileOverride})` : ' (Cố định theo lựa chọn, tự xoay key)'}`
    : 'Tự động thông minh (Ưu tiên Flash mạnh — có hộp chọn sau khi nhập lệnh)';

  const telemetrySlots = getKeySlotTelemetrySnapshot();
  const readySlots = telemetrySlots.filter(s => s.cooldownRemainingMs === 0).length;
  const totalReqToday = telemetrySlots.reduce((acc, s) => acc + (s.usedRpdToday || 0), 0);
  const totalTokToday = telemetrySlots.reduce((acc, s) => acc + (s.usedTokensToday || 0), 0);
  const totalRpdCap = telemetrySlots.reduce((acc, s) => acc + (s.limits?.rpd || 0), 0);
  const lats = telemetrySlots.map(s => s.avgLatencyMs).filter((x): x is number => typeof x === 'number' && x > 0);
  const sparkStr = lats.length > 0 ? `  ${renderSparkline(lats.slice(-10))}` : '';
  const keyPoolStatus = telemetrySlots.length > 0
    ? `${badge(`${readySlots}/${telemetrySlots.length} SLOT SẴN SÀNG`, readySlots > 0 ? 'green' : 'yellow')} ${renderMeterBar(totalReqToday, Math.max(20, totalRpdCap), 10)} ${paint(`(${totalReqToday} req / ${formatTokenShort(totalTokToday)} tok)`, 'muted')}${sparkStr}`
    : `${badge('MULTI-KEY AUTO ROTATION', 'cyber')} ${paint('(gõ "quota" để đo thông số live)', 'muted')}`;

  const themeTag = theme().theme === 'cyberpunk' ? 'CYBER GRID' : 'TOKYO OS';

  console.log('');
  console.log(gradientText('┏' + '━'.repeat(78) + '┓'));
  console.log(
    paint('┃ ', 'purple', true) +
    badge(themeTag, theme().theme === 'cyberpunk' ? 'cyber' : 'purple') + ' ' +
    paint('🤖 AGENT ĐÃ SẴN SÀNG TIẾP NHẬN YÊU CẦU LÀM BÀI / THAO TÁC', 'cyan', true)
  );
  console.log(paint('┣' + '─'.repeat(78), 'violet'));
  console.log(paint('┃ ', 'purple') + paint(`• Web LMS mục tiêu : ${targetWeb}`, 'fg', true));
  console.log(paint('┃ ', 'purple') + paint(`• Tài khoản        : ${targetAcc}`, 'fg'));
  console.log(paint('┃ ', 'purple') + paint(`• Trạng thái phiên : ${authState}`, ctx.isLoggedIn ? 'green' : 'yellow'));
  console.log(paint('┃ ', 'purple') + paint(`• Model AI         : ${modelLabel}`, 'cyan'));
  console.log(paint('┃ ', 'purple') + paint('• Key-Pool Router  : ', 'fg') + keyPoolStatus);
  console.log(paint('┃ ', 'purple') + paint(`• Gợi ý lệnh       : "Vào LMS kiểm tra bài tập tuần này", "Làm bài trắc nghiệm", v.v.`, 'muted'));
  console.log(paint('┃ ', 'purple') + paint(`• Phím tắt         : "login", "switch", "key", "key add", "model", "models", "quota", "theme", "fx", "help", "exit"`, 'muted'));
  console.log(gradientText('┗' + '━'.repeat(78) + '┛') + '\n');
}

async function handleLogsCommand(rawQuery: string): Promise<void> {
  const parts = rawQuery.trim().split(/\s+/);
  const selector = parts[1]?.trim();

  if (!selector) {
    const items = await listRecentRunLogs(10);
    console.log(paint(`\n[Nhật Ký Chạy Agent (.private/logs)]`, 'cyan', true));
    if (items.length === 0) {
      console.log(paint('Chưa có log phiên chạy thực tế nào. Hãy chạy một tác vụ Agent trên LMS để ghi log tự động!\n', 'yellow'));
      return;
    }
    renderTable(
      ['#', 'Run ID', 'Trạng thái', 'Quiz', 'Thời gian', 'Mục tiêu'],
      items.map((item, idx) => [
        String(idx + 1),
        item.runId,
        item.status,
        String(item.quizCount),
        item.durationMs ? `${(item.durationMs / 1000).toFixed(1)}s` : '-',
        item.goal.slice(0, 42)
      ])
    );
    console.log(paint('Dùng "logs 1" (hoặc "logs <runId>") để xem chi tiết từng bước, model switch & đáp án quiz.\n', 'muted'));
    return;
  }

  const targetSelector = selector.toLowerCase() === 'latest' ? 1 : selector;
  const log = await readRunLog(targetSelector);
  if (!log) {
    console.log(paint(`Không tìm thấy run log "${selector}". Dùng "logs" để xem danh sách.\n`, 'yellow'));
    return;
  }
  console.log('\n' + formatRunLogMarkdown(log));
}

/** Prompts for adding a new account and target LMS web URL */
async function promptAddNewAccount(
  ctx: AgentContext,
  rl: { question: (q: string) => Promise<string> }
): Promise<void> {
  console.log(paint('\n── THÊM TRANG WEB LMS & TÀI KHOẢN MỚI ──────────────────', 'cyan', true));

  const rawUrl = (await rl.question(paint('  ❯ Link Web LMS / Trường học [https://lms.hust.edu.vn]: ', 'cyan', true))).trim();
  const loginUrl = rawUrl || 'https://lms.hust.edu.vn';

  let username = '';
  while (!username) {
    username = (await rl.question(paint('  ❯ Tài khoản / Email / Tên đăng nhập: ', 'cyan', true))).trim();
    if (!username) console.log(paint('  ✖ Tài khoản không được để trống.', 'red'));
  }

  let password = '';
  while (!password) {
    try {
      password = await promptSecret(paint('  ❯ Mật khẩu (ẩn khi nhập): ', 'cyan', true));
    } catch {
      password = (await rl.question(paint('  ❯ Mật khẩu: ', 'cyan', true))).trim();
    }
    if (!password) console.log(paint('  ✖ Mật khẩu không được để trống.', 'red'));
  }

  const savePrompt = (await rl.question(paint('  ❯ Bạn có muốn lưu tài khoản này vào Windows Credential Manager để lần sau chỉ cần chọn không? (Y/n) [Y]: ', 'yellow', true))).trim().toLowerCase();
  const shouldSave = savePrompt === '' || savePrompt === 'y' || savePrompt === 'yes' || savePrompt === 'c' || savePrompt === 'có';

  registerAllowedUrlHost(ctx.config.allowedHosts, loginUrl);

  if (shouldSave) {
    let defaultAccId = 'hust_sv';
    try {
      const hostPart = new URL(loginUrl).hostname.split('.')[0] || 'lms';
      const userPart = username.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '');
      defaultAccId = `${hostPart}_${userPart}`.slice(0, 20) || 'main_account';
    } catch {}

    const rawAccId = (await rl.question(paint(`  ❯ Tên gợi nhớ tài khoản [${defaultAccId}]: `, 'cyan', true))).trim();
    const accId = rawAccId || defaultAccId;

    try {
      await saveAccount(accId, { loginUrl, displayName: accId, isDefault: true }, username, password);
      ctx.activeAccountId = accId;
      ctx.config.accountId = accId;
      ctx.config.targetWebUrl = loginUrl;
      console.log(paint(`\n✔ Đã lưu tài khoản "${accId}" thành công vào Windows Credential Manager!`, 'green', true));
      console.log(paint(`Mật khẩu được mã hóa an toàn trong OS Keyring, không lưu plaintext ra file JSON.\n`, 'muted'));
    } catch (err: any) {
      console.log(paint(`\n✖ Không thể lưu vào Windows Credential Manager: ${err.message}. Sử dụng trong bộ nhớ tạm phiên này.\n`, 'yellow'));
      ctx.config.inMemoryCredentials = { username, password };
      ctx.config.targetWebUrl = loginUrl;
      ctx.activeAccountId = 'in_memory';
    }
  } else {
    ctx.config.inMemoryCredentials = { username, password };
    ctx.config.targetWebUrl = loginUrl;
    ctx.activeAccountId = 'in_memory';
    console.log(paint(`\n✔ Đã ghi nhớ thông tin tài khoản cho phiên làm việc hiện tại (Không lưu vào ổ đĩa).\n`, 'green', true));
  }
}

/**
 * Prompts user for LMS web URL and account selection / addition at startup
 * Returns true to continue to REPL, or false if user chose to exit.
 */
export async function promptStartupAccount(
  ctx: AgentContext,
  rl: { question: (q: string) => Promise<string> }
): Promise<boolean> {
  const accounts = await listAccounts();
  const defaultId = await getDefaultAccountId();
  const accountIds = Object.keys(accounts);

  console.log(paint('\n' + '─'.repeat(74), 'purple'));
  console.log(paint('  AUTOTASK AI — THIẾT LẬP TÀI KHOẢN & TRANG WEB LMS', 'cyan', true));
  console.log(paint('─'.repeat(74), 'purple'));

  if (accountIds.length > 0) {
    console.log(paint('\n[TÙY CHỌN KHỞI ĐỘNG]', 'fg', true));
    console.log(paint('  [1] Chọn tài khoản & trang web đã lưu (Khuyên dùng)', 'green', true));
    console.log(paint('  [2] Thêm trang web LMS & tài khoản mới', 'fg'));
    console.log(paint('  [3] Chạy chế độ khách (Chưa dùng tài khoản / Đăng nhập thủ công sau)', 'fg'));
    console.log(paint('  [0] Thoát', 'muted'));

    const choiceRaw = (await rl.question(paint('\n  ❯ Lựa chọn của bạn [1]: ', 'cyan', true))).trim();
    const choice = choiceRaw || '1';

    if (choice === '0') {
      console.log(paint('Đang thoát...', 'yellow'));
      return false;
    }

    if (choice === '1') {
      console.log(paint('\n[DANH SÁCH TÀI KHOẢN ĐÃ LƯU TRONG WINDOWS CREDENTIAL MANAGER]', 'cyan', true));
      const headers = ['STT', 'Account ID', 'Web LMS URL', 'Host', 'Mặc định?'];
      const rows = accountIds.map((id, index) => {
        const acc = accounts[id];
        const isDef = id === (ctx.activeAccountId || defaultId) ? '★ ĐANG DÙNG' : (id === defaultId ? '★ MẶC ĐỊNH' : '');
        return [`[${index + 1}]`, id, acc.loginUrl || 'https://lms.hust.edu.vn', acc.loginHost, isDef];
      });
      renderTable(headers, rows);

      const pickRaw = (await rl.question(paint(`\n  ❯ Chọn số thứ tự tài khoản cần sử dụng [1]: `, 'cyan', true))).trim();
      const pickIdx = pickRaw ? parseInt(pickRaw, 10) - 1 : 0;
      const chosenId = (pickIdx >= 0 && pickIdx < accountIds.length) ? accountIds[pickIdx] : accountIds[0];
      const chosenAcc = accounts[chosenId];

      // Step 2: Allow picking any saved LMS URL after choosing the account (defaulting to the chosen account's URL)
      const savedUrlEntries: Array<{ url: string; owners: string[] }> = [];
      const addSavedUrlEntry = (rawUrl: string | undefined, ownerId: string) => {
        const url = (rawUrl || '').trim();
        if (!url) return;
        const found = savedUrlEntries.find(e => e.url === url);
        if (found) {
          if (!found.owners.includes(ownerId)) found.owners.push(ownerId);
        } else {
          savedUrlEntries.push({ url, owners: [ownerId] });
        }
      };
      addSavedUrlEntry(chosenAcc.loginUrl || 'https://lms.hust.edu.vn', chosenId);
      for (const id of accountIds) {
        addSavedUrlEntry(accounts[id].loginUrl || 'https://lms.hust.edu.vn', id);
      }

      console.log(paint('\n[DANH SÁCH URL ĐÃ LƯU]', 'cyan', true));
      renderTable(
        ['STT', 'Web LMS URL', 'Tài khoản gắn kết', 'Mặc định?'],
        savedUrlEntries.map((entry, index) => [
          `[${index + 1}]`,
          entry.url,
          entry.owners.join(', '),
          index === 0 ? '★ MẶC ĐỊNH' : ''
        ])
      );

      const pickUrlRaw = (await rl.question(paint(`\n  ❯ Chọn số thứ tự URL đã lưu cho "${chosenId}" [1]: `, 'cyan', true))).trim();
      let chosenUrl = savedUrlEntries[0].url;
      if (pickUrlRaw) {
        if (/^\d+$/.test(pickUrlRaw)) {
          const urlIdx = parseInt(pickUrlRaw, 10) - 1;
          if (urlIdx >= 0 && urlIdx < savedUrlEntries.length) {
            chosenUrl = savedUrlEntries[urlIdx].url;
          }
        } else if (/^https?:\/\//i.test(pickUrlRaw)) {
          chosenUrl = pickUrlRaw;
        }
      }

      ctx.activeAccountId = chosenId;
      ctx.config.accountId = chosenId;
      ctx.config.targetWebUrl = chosenUrl;

      // Update allowed hosts for the chosen URL while keeping the selected account's auth/SSO hosts
      const matchedUrlHosts = Object.values(accounts)
        .filter(a => (a.loginUrl || '').trim() === chosenUrl)
        .flatMap(a => [a.loginHost, ...(a.trustedLoginHosts || [])]);
      registerAllowedUrlHost(ctx.config.allowedHosts, chosenUrl, [
        chosenAcc.loginHost,
        ...(chosenAcc.trustedLoginHosts || []),
        ...matchedUrlHosts
      ]);

      await setDefaultAccount(chosenId).catch(() => {});

      console.log(paint(`\n✔ ĐÃ CHỌN TÀI KHOẢN: "${chosenId}"`, 'green', true));
      console.log(paint(`🌐 TRANG WEB MỤC TIÊU: "${chosenUrl}"\n`, 'cyan'));
      printReadyBanner(ctx);
      return true;
    }

    if (choice === '2') {
      await promptAddNewAccount(ctx, rl);
      printReadyBanner(ctx);
      return true;
    }

    if (choice === '3') {
      const guestUrl = (await rl.question(paint('  ❯ Link Web LMS muốn mở [https://lms.hust.edu.vn]: ', 'cyan', true))).trim() || 'https://lms.hust.edu.vn';
      ctx.config.targetWebUrl = guestUrl;
      ctx.activeAccountId = undefined;
      ctx.config.accountId = undefined;
      registerAllowedUrlHost(ctx.config.allowedHosts, guestUrl);
      console.log(paint(`\n✔ Chạy chế độ khách. Trang web: "${guestUrl}"\n`, 'green', true));
      printReadyBanner(ctx);
      return true;
    }

    // Default fallback to 1
    const defaultAcc = accounts[accountIds[0]];
    ctx.activeAccountId = accountIds[0];
    ctx.config.accountId = accountIds[0];
    ctx.config.targetWebUrl = defaultAcc.loginUrl;
    registerAllowedUrlHost(ctx.config.allowedHosts, defaultAcc.loginUrl || defaultAcc.loginHost, [
      defaultAcc.loginHost,
      ...(defaultAcc.trustedLoginHosts || [])
    ]);
    printReadyBanner(ctx);
    return true;
  }

  // No saved accounts yet:
  console.log(paint('\nChưa có tài khoản nào được lưu trên thiết bị.', 'yellow'));
  console.log(paint('[TÙY CHỌN KHỞI ĐỘNG]', 'fg', true));
  console.log(paint('  [1] Thêm trang web LMS & tài khoản mới (Khuyên dùng)', 'green', true));
  console.log(paint('  [2] Chạy chế độ khách (Chưa dùng tài khoản / Đăng nhập thủ công sau)', 'fg'));
  console.log(paint('  [0] Thoát', 'muted'));

  const choiceRaw = (await rl.question(paint('\n  ❯ Lựa chọn của bạn [1]: ', 'cyan', true))).trim();
  const choice = choiceRaw || '1';

  if (choice === '0') {
    console.log(paint('Đang thoát...', 'yellow'));
    return false;
  }

  if (choice === '2') {
    const guestUrl = (await rl.question(paint('  ❯ Link Web LMS muốn mở [https://lms.hust.edu.vn]: ', 'cyan', true))).trim() || 'https://lms.hust.edu.vn';
    ctx.config.targetWebUrl = guestUrl;
    ctx.activeAccountId = undefined;
    ctx.config.accountId = undefined;
    registerAllowedUrlHost(ctx.config.allowedHosts, guestUrl);
    console.log(paint(`\n✔ Chạy chế độ khách. Trang web: "${guestUrl}"\n`, 'green', true));
    printReadyBanner(ctx);
    return true;
  }

  // choice === '1'
  await promptAddNewAccount(ctx, rl);
  printReadyBanner(ctx);
  return true;
}

/** Renders color-coded status banner and quick log hint after agent execution */
export function renderAgentResultBanner(result: AgentExecutionResult): void {
  const tone = result.status === 'DONE'
    ? 'green'
    : (result.status === 'NEEDS_REVIEW' || result.status === 'WAITING_FOR_AUTH' ? 'yellow' : 'red');
  const barStops = result.status === 'DONE'
    ? gradientStopsForTheme('success')
    : (result.status === 'FAILED' ? gradientStopsForTheme('danger') : gradientStopsForTheme('warn'));
  const icon = result.status === 'DONE' ? '✔' : (result.status === 'FAILED' ? '✖' : '⚠');

  console.log('');
  console.log(gradientText('┏' + '━'.repeat(78) + '┓', barStops));
  console.log(
    paint('┃ ', tone, true) +
    badge(result.status, tone) + ' ' +
    paint(`${icon} [KẾT QUẢ AGENT - ${result.status}] (Thời gian: ${(result.durationMs / 1000).toFixed(1)}s, ${result.modelCalls} AI calls)`, tone, true)
  );
  console.log(gradientText('┗' + '━'.repeat(78) + '┛', barStops) + '\n');
  console.log(result.summary);
  if (result.runLogPath) {
    console.log(paint(`\n💡 Gõ "logs 1" (hoặc "xem log") để xem chi tiết lập luận AI & từng bước thực thi.`, 'muted'));
  }
  console.log('');
}

export async function runAgentCli(): Promise<void> {
  // Ensure intermediate CA bootstrap is loaded for strict TLS to LMS
  bootstrapIntermediateCa();
  setupTerminalCleanup();
  await loadTheme();

  const parsedCli = parseAgentCliArgs(process.argv.slice(2));
  const singlePrompt = parsedCli.singlePrompt;

  const ctx: AgentContext = createAgentContext({
    headless: parsedCli.isHeadless ? true : false, // Visible browser by default for terminal agents
    modelOverride: parsedCli.modelOverride,
    profileOverride: parsedCli.profileOverride,
    verbose: true
  });

  // Register unified Ctrl+C browser cleanup inside tokyo terminal handler
  registerExitCleanup(async () => {
    if (ctx.browser) {
      await ctx.browser.close().catch(() => {});
    }
  });

  // Mode 1: Single command invocation (e.g. npm run agent -- "Vào LMS...")
  if (singlePrompt) {
    const spLower = singlePrompt.toLowerCase();
    if (spLower === 'quota' || spLower === 'check quota' || spLower === 'models quota' || spLower === 'quota all' || spLower === 'quota full') {
      const includeAll = spLower === 'quota full';
      header('MODEL CENTER  /  LIVE MULTI-KEY QUOTA & RATE LIMIT CHECK');
      const rep = await withSpinner(
        includeAll
          ? 'Đang quét toàn bộ model trên mọi API key...'
          : 'Đang kiểm tra quota & rate limit từng model trên mọi API key...',
        () => checkAllProfilesQuota({ includeAllListedModels: includeAll })
      );
      console.log('\n' + formatQuotaReport(rep));
      return;
    }
    if (spLower === 'playbooks' || spLower === 'playbook list') {
      header('AUTONOMOUS AGENT  /  ADAPTIVE PLAYBOOK MEMORY');
      const items = await listPlaybooks();
      if (items.length === 0) {
        console.log(paint('Chưa có kịch bản nào được ghi nhớ trong .private/playbooks.json.\n', 'yellow'));
      } else {
        renderTable(
          ['ID', 'Host', 'Intent', 'Môn học', 'Thành công'],
          items.map(p => [p.id, p.host, p.intent, p.courseName || p.courseCode || '-', String(p.successCount)])
        );
      }
      return;
    }
    if (spLower === 'logs' || spLower === 'log' || spLower.startsWith('logs ') || spLower.startsWith('log ')) {
      header('AUTONOMOUS AGENT  /  RUN LOGS & DIAGNOSTICS');
      await handleLogsCommand(singlePrompt);
      return;
    }

    header('AUTONOMOUS AGENT MODE  /  COMMAND EXECUTION');
    renderBreadcrumb(['COMMAND DECK', 'AUTONOMOUS AGENT', 'CLI PROMPT']);

    // Auto-resolve active account & web URL from saved accounts if available
    const accounts = await listAccounts();
    const defaultId = await getDefaultAccountId();
    if (!ctx.activeAccountId && defaultId && accounts[defaultId]) {
      ctx.activeAccountId = defaultId;
      ctx.config.accountId = defaultId;
      ctx.config.targetWebUrl = accounts[defaultId].loginUrl;
      registerAllowedUrlHost(ctx.config.allowedHosts, accounts[defaultId].loginUrl || accounts[defaultId].loginHost, [
        accounts[defaultId].loginHost,
        ...(accounts[defaultId].trustedLoginHosts || [])
      ]);
    }

    console.log(paint(`\nPrompt: "${singlePrompt}"\n`, 'cyan', true));
    if (
      input.isTTY &&
      !parsedCli.modelOverride &&
      !parsedCli.profileOverride &&
      !parsedCli.autoModel &&
      !parsedCli.noModelPrompt
    ) {
      const rlSingle = createInterface({ input, output });
      try {
        const picked = await promptModelSelection(ctx, rlSingle);
        if (picked.cancelled) {
          console.log(paint('Đã hủy thực thi tác vụ.\n', 'yellow'));
          return;
        }
      } finally {
        rlSingle.close();
      }
    }
    const result = await runAgentLoop(singlePrompt, ctx);
    renderAgentResultBanner(result);

    if (ctx.browser) {
      await ctx.browser.close().catch(() => {});
    }
    return;
  }

  // Mode 2: Interactive Multi-Turn REPL (autotask>)
  await introAnimation();
  header('AUTONOMOUS AGENT MODE  /  INTERACTIVE REPL');
  renderBreadcrumb(['COMMAND DECK', 'AUTONOMOUS AGENT', 'TERMINAL REPL']);

  console.log(paint(`\n✦ Chào mừng đến với AutoTask AI Autonomous Agent!`, 'cyan', true));

  const rl = createInterface({ input, output });

  try {
    // Run Startup Onboarding / Account Selector Menu
    const shouldContinue = await promptStartupAccount(ctx, rl);
    if (!shouldContinue) {
      return;
    }

    let hasSelectedModelInSession = Boolean(ctx.config.modelOverride || parsedCli.autoModel);

    while (true) {
      const accBadge = ctx.activeAccountId
        ? (ctx.activeAccountId === 'in_memory' ? 'guest-mem' : ctx.activeAccountId)
        : 'no-acc';
      const authGlyph = ctx.isLoggedIn ? paint('●', 'green') : paint('○', 'yellow');
      const activeModel = ctx.config.modelOverride || 'auto-pool';
      const telemetrySlots = getKeySlotTelemetrySnapshot();
      const readySlots = telemetrySlots.filter(s => s.cooldownRemainingMs === 0).length;
      const reqToday = telemetrySlots.reduce((acc, s) => acc + (s.usedRpdToday || 0), 0);
      const keyPoolTag = telemetrySlots.length > 0
        ? `keys:${readySlots}/${telemetrySlots.length} (${reqToday}req)`
        : 'keys:ready';
      const themeTag = `${theme().theme === 'cyberpunk' ? 'CYBER' : 'TOKYO'}${theme().animations === false ? '·STATIC' : '·FX'}`;
      const hudLine =
        paint('╭─[', 'muted') +
        authGlyph + ' ' + paint(accBadge, 'cyan', true) +
        paint(' | ', 'muted') + paint(activeModel, 'purple') +
        paint(' | ', 'muted') + paint(keyPoolTag, readySlots > 0 || telemetrySlots.length === 0 ? 'green' : 'yellow') +
        paint(' | ', 'muted') + paint(themeTag, 'violet') +
        paint(']', 'muted');
      console.log(hudLine);
      const promptText = paint('╰─▶ ', 'cyan', true) + gradientText('autotask> ', undefined, true);
      const rawInput = await rl.question(promptText);
      const query = rawInput.trim();

      if (!query) continue;

      const lower = query.toLowerCase();
      const normCmd = stripVietnameseAccents(query).replace(/\s+/g, ' ').trim();
      if (lower === 'exit' || lower === 'quit') {
        console.log(paint('Tạm biệt! Đang đóng phiên Agent...', 'yellow'));
        break;
      }

      if (lower === 'clear') {
        console.clear();
        header('AUTONOMOUS AGENT MODE  /  INTERACTIVE REPL');
        printReadyBanner(ctx);
        continue;
      }

      if (
        lower === 'switch' ||
        lower === 'account switch' ||
        lower === 'change' ||
        normCmd === 'doi tai khoan' ||
        normCmd === 'chuyen tai khoan' ||
        lower === '/switch'
      ) {
        const keepGoing = await promptStartupAccount(ctx, rl);
        if (!keepGoing) break;
        continue;
      }

      if (lower === 'login' || lower === 'dang nhap' || lower === 'signin') {
        console.log(paint(`\n[AutoTask Agent] Đang thực hiện đăng nhập vào ${ctx.config.targetWebUrl || 'LMS'}...`, 'cyan', true));
        const res = await executeAgentTool({ tool: 'account.login', args: {} }, ctx);
        if (res.success) {
          console.log(paint(`\n✔ ${res.observationText}\n`, 'green', true));
        } else {
          console.log(paint(`\n✖ ${res.observationText}\n`, 'red', true));
        }
        continue;
      }

      if (lower === 'status') {
        console.log(paint(`\n[Trạng thái Agent]`, 'cyan', true));
        console.log(`- Trình duyệt: ${ctx.browser ? 'Đang mở' : 'Chưa mở'}`);
        console.log(`- Web LMS mục tiêu: ${ctx.config.targetWebUrl || 'None'}`);
        console.log(`- Tài khoản hoạt động: ${ctx.activeAccountId || 'None'}`);
        console.log(`- Trạng thái phiên: ${ctx.isLoggedIn ? '✔ Đã xác thực đăng nhập' : '⏳ Chưa đăng nhập'}`);
        console.log(`- URL hiện tại: ${ctx.activeUrl || 'None'}`);
        console.log(`- Khóa học đã lưu: ${((ctx.collectedFindings['courses'] as any[]) || []).length}`);
        console.log(`- Hạn nộp đã lưu: ${((ctx.collectedFindings['deadlines'] as any[]) || []).length}`);
        console.log(`- Lịch sử bước: ${ctx.history.length} bước\n`);
        continue;
      }

      if (lower === 'close') {
        if (ctx.browser) {
          await ctx.browser.close().catch(() => {});
          ctx.browser = undefined;
          ctx.context = undefined;
          ctx.page = undefined;
          console.log(paint('Đã đóng trình duyệt Chromium.', 'yellow'));
        } else {
          console.log(paint('Trình duyệt chưa được mở.', 'muted'));
        }
        continue;
      }

      if (lower === 'account add' || lower === 'add account' || lower === 'account:add') {
        await promptAddNewAccount(ctx, rl);
        printReadyBanner(ctx);
        continue;
      }

      if (lower === 'account list' || lower === 'accounts' || lower === 'account') {
        const accounts = await listAccounts();
        const defaultId = await getDefaultAccountId();
        const ids = Object.keys(accounts);

        console.log(paint(`\n[Danh Sách Tài Khoản Đã Lưu]`, 'cyan', true));
        if (ids.length === 0) {
          console.log(paint('Chưa có tài khoản nào. Hãy dùng "account add" để thêm tài khoản mới.\n', 'yellow'));
        } else {
          const headers = ['Account ID', 'Host', 'Mặc định?', 'Session Đã Lưu?'];
          const rows = ids.map(id => {
            const acc = accounts[id];
            const isDef = id === defaultId || id === ctx.activeAccountId ? '★ MẶC ĐỊNH' : '';
            const sDir = resolve('.private', 'sessions', id);
            const hasSess = existsSync(sDir) ? '✔ Có' : 'Chưa có';
            return [id, acc.loginHost, isDef, hasSess];
          });
          renderTable(headers, rows);
          console.log(paint(`Tài khoản đang kích hoạt: ${ctx.activeAccountId || defaultId || 'None'}\n`, 'muted'));
        }
        continue;
      }

      if (lower.startsWith('account use ') || lower.startsWith('account default ')) {
        const target = query.split(/\s+/)[2]?.trim();
        const accounts = await listAccounts();
        if (!target || !accounts[target]) {
          console.log(paint(`Lỗi: Tài khoản "${target}" không tồn tại. Dùng "account list" để xem danh sách.\n`, 'red'));
        } else {
          await setDefaultAccount(target);
          ctx.activeAccountId = target;
          ctx.config.accountId = target;
          ctx.config.targetWebUrl = accounts[target].loginUrl;
          console.log(paint(`✔ Đã chuyển tài khoản hoạt động thành "${target}".\n`, 'green', true));
        }
        continue;
      }

      if (lower.startsWith('account forget') || lower.startsWith('account logout')) {
        const target = query.split(/\s+/)[2]?.trim() || ctx.activeAccountId || (await getDefaultAccountId());
        if (!target) {
          console.log(paint('Không có tài khoản nào để xóa session.\n', 'yellow'));
        } else {
          await forgetSession(target);
          if (ctx.browser) {
            await ctx.browser.close().catch(() => {});
            ctx.browser = undefined;
            ctx.context = undefined;
            ctx.page = undefined;
          }
          console.log(paint(`✔ Đã xóa session cookies của tài khoản "${target}". Lần tới sẽ đăng nhập lại từ đầu.\n`, 'green'));
        }
        continue;
      }

      if (lower === 'playbooks' || lower === 'playbook list' || lower === 'playbook' || lower === 'kich ban') {
        const items = await listPlaybooks();
        console.log(paint(`\n[Bộ Nhớ Kịch Bản Đã Học (.private/playbooks.json)]`, 'cyan', true));
        if (items.length === 0) {
          console.log(paint('Chưa có kịch bản nào được ghi nhớ. Hãy chạy thành công một tác vụ để Agent tự động học!\n', 'yellow'));
        } else {
          renderTable(
            ['Playbook ID', 'Web', 'Intent', 'Môn học / Từ khóa', 'Thành công'],
            items.map(p => [
              p.id,
              p.host,
              p.intent,
              (p.courseName || p.courseCode || p.keywords.slice(0, 3).join(', ')).slice(0, 36),
              String(p.successCount)
            ])
          );
          console.log(paint('Dùng "playbook forget <id|all>" để xóa kịch bản đã lưu.\n', 'muted'));
        }
        continue;
      }

      if (lower.startsWith('playbook forget ') || lower.startsWith('playbook delete ')) {
        const target = query.split(/\s+/)[2]?.trim() || '';
        const { removed } = await deletePlaybook(target);
        if (removed > 0) {
          console.log(paint(`✔ Đã xóa ${removed} kịch bản khỏi bộ nhớ.\n`, 'green', true));
        } else {
          console.log(paint(`Không tìm thấy kịch bản "${target}". Dùng "playbooks" để xem ID.\n`, 'yellow'));
        }
        continue;
      }

      if (
        lower === 'logs' ||
        lower === 'log' ||
        lower.startsWith('logs ') ||
        lower.startsWith('log ') ||
        normCmd === 'xem log' ||
        normCmd === 'xem logs' ||
        normCmd === 'xem nhat ky' ||
        normCmd === 'log moi nhat' ||
        normCmd === 'logs moi nhat' ||
        lower === '/log' ||
        lower === '/logs'
      ) {
        const logArg = (lower.startsWith('logs ') || lower.startsWith('log ')) ? query : 'logs 1';
        await handleLogsCommand(logArg);
        continue;
      }

      if (
        lower === 'quota' ||
        lower === 'quota all' ||
        lower === 'quota full' ||
        lower === 'check quota' ||
        lower === 'models quota' ||
        lower.startsWith('quota watch') ||
        lower === 'key stats' ||
        lower === 'key info' ||
        lower.startsWith('key stats ') ||
        lower.startsWith('key info ') ||
        normCmd === 'kiem tra quota' ||
        normCmd === 'xem quota' ||
        lower === '/quota'
      ) {
        const specKeyArg = query.match(/^(?:key|api)\s+(?:stats|info)(?:\s+([\s\S]+))?$/i)?.[1]?.trim();
        if (lower.startsWith('key stats') || lower.startsWith('key info')) {
          const rawInspectKey = specKeyArg || (await promptSecret('Nhập API key muốn đo thông số (hoặc Enter để xem thống kê các key đã lưu): ', { allowEmpty: true })).trim();
          if (rawInspectKey) {
            try {
              const spec = await withSpinner('[Key Telemetry] Đang đo thông số kỹ thuật & rate limit từng model của API key...', () =>
                inspectSingleApiKeySpecs(rawInspectKey)
              );
              console.log('\n' + formatSingleKeySpecReport(spec) + '\n');
            } catch (err: any) {
              console.log(paint(`✖ Lỗi đo thông số key: ${err.message}\n`, 'red'));
            }
            continue;
          }
          const snap = getKeySlotTelemetrySnapshot();
          if (snap.length > 0) {
            console.log(paint('\n[Key Telemetry — Thống Kê Request / Token Thời Gian Thực]', 'cyan', true));
            renderTable(
              ['Profile / Slot', 'Model', 'RPM (60s)', 'TPM (60s)', 'Ngày (Req/Tok)', 'Nguồn', 'Cooldown'],
              snap.map(s => [
                s.keySlot === s.profileId ? s.profileId : `${s.profileId} (${s.keySlot})`,
                s.model,
                `${s.usedRpm60s}/${s.limits.rpm}`,
                `${formatTokenShort(s.usedTpm60s)}/${formatTokenShort(s.limits.tpm)}`,
                `${s.usedRpdToday}/${formatTokenShort(s.limits.rpd)} (${formatTokenShort(s.usedTokensToday)} tok)`,
                s.limitSource === 'API_HEADER' ? 'API' : s.limitSource === 'API_ERROR' ? '429' : 'Tier',
                s.cooldownRemainingMs > 0 ? `${s.cooldownScope || 'COOL'} ${Math.ceil(s.cooldownRemainingMs / 1000)}s` : 'Sẵn sàng'
              ])
            );
          }
          const rep = await withSpinner('Đang đo live quota & rate limit từng model trên mọi API key...', () =>
            checkAllProfilesQuota().catch(() => null)
          );
          if (rep) console.log('\n' + formatQuotaReport(rep) + '\n');
          continue;
        }

        const watchMatch = query.match(/^quota\s+watch(?:\s+(\d+))?(?:\s+(\d+))?/i);
        if (watchMatch) {
          const intervalSec = Math.max(5, Math.min(600, Number(watchMatch[1] || 30)));
          const maxIters = Math.max(1, Math.min(120, Number(watchMatch[2] || 6)));
          await runLiveQuotaWatchUi({ intervalSec, maxIterations: maxIters });
          continue;
        }

        const includeAll = lower === 'quota full';
        try {
          const rep = await withSpinner(
            includeAll
              ? '[Quota Checker] Đang quét TOÀN BỘ model trên mỗi API key...'
              : '[Quota Checker] Đang đo trực tiếp quota & rate limit từng model trên mỗi API key...',
            () => checkAllProfilesQuota({ includeAllListedModels: includeAll })
          );
          console.log('\n' + formatQuotaReport(rep) + '\n');
        } catch (err: any) {
          console.log(paint(`✖ Không kiểm tra được quota: ${err.message}\n`, 'red'));
        }
        continue;
      }

      if (
        lower === 'key' ||
        lower === 'api' ||
        lower.startsWith('key ') ||
        lower.startsWith('api ') ||
        Boolean(detectProviderFromApiKey(query))
      ) {
        const keyAddMatch = query.match(/^(?:key|api)\s+add(?:\s+([a-zA-Z0-9_-]{1,64}))?(?:\s+([\s\S]+))?$/i);
        if (keyAddMatch) {
          try {
            const db = await readProfilesDb();
            const profileIds = Object.keys(db.profiles);
            if (profileIds.length === 0) {
              console.log(paint('  ✖ Chưa có profile nào. Hãy gõ "key <API_KEY>" để tạo profile đầu tiên.\n', 'yellow'));
              continue;
            }
            let targetPrf = keyAddMatch[1] && db.profiles[keyAddMatch[1]] ? keyAddMatch[1] : '';
            if (!targetPrf) {
              profileIds.forEach((pid, i) => {
                const p = db.profiles[pid];
                console.log(`  [${i + 1}] ${paint(pid, 'cyan', true)} (${p.provider.toUpperCase()} · ${p.model} · ${getProfileKeySlots(pid, p).length} key)`);
              });
              const pickedRaw = (await rl.question(paint(`  ❯ Chọn STT (1-${profileIds.length}) hoặc Profile ID [1]: `, 'cyan'))).trim() || '1';
              if (db.profiles[pickedRaw]) {
                targetPrf = pickedRaw;
              } else if (/^\d+$/.test(pickedRaw)) {
                const idx = parseInt(pickedRaw, 10) - 1;
                if (idx >= 0 && idx < profileIds.length) targetPrf = profileIds[idx];
              }
            }
            if (!targetPrf || !db.profiles[targetPrf]) {
              console.log(paint(`  ✖ Profile không tồn tại.\n`, 'red'));
              continue;
            }
            const rawExtra = keyAddMatch[2]?.trim()
              ? keyAddMatch[2].trim()
              : (await promptSecret(`  Nhập 1 hoặc nhiều API key để gắn vào "${targetPrf}" (cách nhau bởi dấu cách/phẩy): `)).trim();
            const resAdd = await addApiKeysToProfile(targetPrf, rawExtra);
            if (resAdd.addedSlots.length > 0 && resAdd.totalSlots > 1) {
              await animateKeyRotation({
                from: targetPrf,
                to: resAdd.addedSlots[resAdd.addedSlots.length - 1],
                slotIndex: resAdd.totalSlots,
                totalSlots: resAdd.totalSlots,
                mode: 'round-robin',
                reason: `Pool ${resAdd.totalSlots} key sẵn sàng xoay vòng`
              });
            }
            console.log(paint(`✔ Đã gắn thêm ${resAdd.addedSlots.length} key vào "${resAdd.profileId}" (Tổng: ${resAdd.totalSlots} key sẵn sàng xoay vòng).\n`, 'green', true));
          } catch (e: any) {
            console.log(paint(`✖ Lỗi thêm API key: ${e?.message || e}\n`, 'red'));
          }
          printReadyBanner(ctx);
          continue;
        }

        const suppliedKey = (lower === 'key' || lower === 'api')
          ? (await promptSecret('Nhập 1 hoặc nhiều API key (cách nhau bởi dấu cách/phẩy; Gemini / OpenAI / Groq / Claude): ')).trim()
          : query.replace(/^(?:key|api)\s+/i, '').trim();
        const scanRes = await scanAndSelectModelFromApiKey(suppliedKey, ctx, rl);
        if (!scanRes.cancelled) hasSelectedModelInSession = true;
        printReadyBanner(ctx);
        continue;
      }

      if (lower === 'models' || lower === 'model-center') {
        await runModelCenter();
        printReadyBanner(ctx);
        continue;
      }

      if (
        lower === 'model' ||
        lower === 'model select' ||
        lower === 'select model' ||
        normCmd === 'chon model' ||
        normCmd === 'doi model' ||
        lower === '/model'
      ) {
        const manualPick = await promptModelSelection(ctx, rl);
        if (!manualPick.cancelled) hasSelectedModelInSession = true;
        printReadyBanner(ctx);
        continue;
      }

      if (
        lower === 'theme' ||
        lower.startsWith('theme ') ||
        lower === '/theme' ||
        lower.startsWith('/theme ')
      ) {
        const arg = lower.replace(/^\/?theme\s*/, '').trim();
        const curTheme = theme();
        if (arg === 'anim on' || arg === 'animations on' || arg === 'fx on') {
          await saveTheme({ ...curTheme, animations: true });
          console.log('\n' + badge('FX ENABLED', 'green') + ' ' + gradientText('Đã BẬT hiệu ứng chuyển động & gradient animations!', undefined, true) + '\n');
          continue;
        }
        if (arg === 'anim off' || arg === 'animations off' || arg === 'fx off') {
          await saveTheme({ ...curTheme, animations: false });
          console.log('\n' + badge('FX DISABLED', 'muted') + ' ' + paint('Đã TẮT hiệu ứng chuyển động (Static TrueColor mode).', 'muted') + '\n');
          continue;
        }
        let nextTheme: 'tokyo-night' | 'cyberpunk' | null = null;
        if (!arg) {
          nextTheme = curTheme.theme === 'tokyo-night' ? 'cyberpunk' : 'tokyo-night';
        } else if (arg === 'cyber' || arg === 'cyberpunk') {
          nextTheme = 'cyberpunk';
        } else if (arg === 'tokyo' || arg === 'tokyo-night') {
          nextTheme = 'tokyo-night';
        }
        if (!nextTheme) {
          console.log(paint('Cách dùng: "theme" (đổi qua lại), "theme tokyo", "theme cyberpunk", "theme anim on", hoặc "theme anim off".\n', 'yellow'));
          continue;
        }
        await saveTheme({ ...curTheme, theme: nextTheme });
        console.log(
          '\n' +
          badge('THEME UPDATED', nextTheme === 'cyberpunk' ? 'cyber' : 'purple') + ' ' +
          gradientText(`Đã chuyển sang giao diện ${nextTheme.toUpperCase()}`, undefined, true) + '  ' +
          renderThemeSwatches(nextTheme)
        );
        header('AUTONOMOUS AGENT MODE  /  INTERACTIVE REPL');
        printReadyBanner(ctx);
        continue;
      }

      if (
        lower === 'fx' ||
        lower === 'fx on' ||
        lower === 'fx off' ||
        lower === 'fx rotate' ||
        lower === 'banner' ||
        lower === 'intro' ||
        lower === '/fx' ||
        lower === '/banner'
      ) {
        if (lower === 'fx on') {
          await saveTheme({ ...theme(), animations: true });
          console.log('\n' + badge('FX ENABLED', 'green') + ' ' + gradientText('Đã BẬT hiệu ứng animations!', undefined, true) + '\n');
          continue;
        }
        if (lower === 'fx off') {
          await saveTheme({ ...theme(), animations: false });
          console.log('\n' + badge('FX DISABLED', 'muted') + ' ' + paint('Đã TẮT hiệu ứng animations.', 'muted') + '\n');
          continue;
        }
        if (lower === 'fx rotate') {
          const demoSlots = ['key#1/gemini-3-flash-preview', 'key#2/gemini-3-flash-preview', 'key#3/gemini-3.5-flash-lite'];
          for (let di = 1; di < demoSlots.length; di++) {
            await animateKeyRotation({
              from: demoSlots[di - 1],
              to: demoSlots[di],
              slotIndex: di + 1,
              totalSlots: demoSlots.length,
              mode: di === 1 ? 'round-robin' : 'failover',
              reason: di === 1 ? 'Xoay vòng cân bằng tải đa key' : 'HTTP 429 RPM -> Chuyển ngay slot kế tiếp'
            });
          }
          continue;
        }
        if (!process.stdout.isTTY || !process.stdin.isTTY) {
          console.log(paint('💡 Hiệu ứng scanline "fx" cần interactive TTY terminal để vẽ hoạt ảnh.\n', 'yellow'));
        } else {
          await introAnimation();
          await animateKeyRotation({
            from: 'slot#1/primary',
            to: 'slot#2/rotation-ready',
            slotIndex: 2,
            totalSlots: 3,
            mode: 'round-robin',
            reason: 'Key-Pool Rotation Engine Ready'
          });
        }
        header('AUTONOMOUS AGENT MODE  /  INTERACTIVE REPL');
        printReadyBanner(ctx);
        continue;
      }

      if (
        lower === 'help' ||
        normCmd === 'tro giup' ||
        normCmd === 'huong dan' ||
        lower === '/help'
      ) {
        console.log(paint(`\n[Trợ giúp Agent Mode — Quy trình tự động A-Z]`, 'cyan', true));
        console.log(`- Chỉ cần chọn hồ sơ (hoặc nhập tài khoản/mật khẩu ngay trong câu lệnh) rồi gõ yêu cầu tự nhiên.`);
        console.log(`- Ngay sau khi nhập lệnh, bạn sẽ được chọn model AI phù hợp (hoặc nhấn Enter để dùng Tự động thông minh).`);
        console.log(`- Lệnh nhanh:`);
        console.log(`  • "switch"                  : Đổi hoặc thêm hồ sơ tài khoản & trang web LMS.`);
        console.log(`  • "login"                   : Tự động đăng nhập ngay vào LMS với hồ sơ đã chọn.`);
        console.log(`  • "model"                   : Chọn trước / đổi model AI đang sử dụng (gõ "a" để gắn key vào profile).`);
        console.log(`  • "key [API_KEY...]"        : Nhập 1 hoặc nhiều API key riêng để quét & xoay vòng.`);
        console.log(`  • "key add [prf] [keys]"    : Gắn thêm API key vào profile (chọn theo STT hoặc ID) để xoay vòng.`);
        console.log(`  • "models"                  : Mở Model Center (Quản lý Profile, API Key & Quota Monitor).`);
        console.log(`  • "quota" / "quota full"    : Đo live RPM/TPM/RPD & trạng thái từng model của mỗi API key (mọi provider).`);
        console.log(`  • "quota watch [giây]"      : Live Dashboard cập nhật tại chỗ theo dõi key reset.`);
        console.log(`  • "key stats [API_KEY]"     : Đo chi tiết Context/Output/RPM/TPM từng model của 1 API key.`);
        console.log(`  • "logs [số|latest]"        : Xem log chi tiết (model switch, lập luận & đáp án từng câu quiz).`);
        console.log(`  • "playbooks"               : Xem các kịch bản web/môn học đã được ghi nhớ.`);
        console.log(`  • "playbook forget <id|all>": Xóa kịch bản đã ghi nhớ.`);
        console.log(`- Quản lý tài khoản:`);
        console.log(`  • "account add"     : Thêm và lưu tài khoản LMS vào Windows Credential Manager.`);
        console.log(`  • "account list"    : Xem danh sách tài khoản đã lưu.`);
        console.log(`  • "account use <id>": Chọn tài khoản mặc định.`);
        console.log(`  • "account forget"  : Xóa session cookies để đăng nhập lại từ đầu.`);
        console.log(`- Điều khiển hệ thống & Giao diện:`);
        console.log(`  • "theme [tokyo|cyberpunk|anim on|anim off]": Đổi màu TrueColor & bật/tắt hiệu ứng.`);
        console.log(`  • "fx" / "fx rotate" / "banner"             : Phát lại hiệu ứng Neon, hiệu ứng xoay key & làm mới HUD.`);
        console.log(`  • "status" : Xem trạng thái trình duyệt và dữ liệu thu thập.`);
        console.log(`  • "close"  : Đóng trình duyệt Chromium.`);
        console.log(`  • "clear"  : Xóa màn hình terminal.`);
        console.log(`  • "exit"   : Thoát REPL.\n`);
        continue;
      }

      // Ask user to pick the suitable AI model right after submitting the task prompt (compact 1-line prompt on follow-up turns)
      const modelPick = await promptModelSelection(ctx, rl, { compactIfChosen: hasSelectedModelInSession });
      if (modelPick.cancelled) {
        console.log(paint('↩ Đã hủy lệnh vừa nhập. Hãy nhập yêu cầu khác nếu muốn.\n', 'yellow'));
        continue;
      }
      hasSelectedModelInSession = true;

      // Execute autonomous ReAct loop for this prompt
      const result = await runAgentLoop(query, ctx);
      renderAgentResultBanner(result);
    }
  } finally {
    rl.close();
    if (ctx.browser) {
      await ctx.browser.close().catch(() => {});
    }
  }
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && /(?:^|[\\/])(?:agent[\\/])?cli\.(?:ts|js)$/.test(process.argv[1])) {
  runAgentCli().catch(err => {
    console.error(paint(`[Lỗi nghiêm trọng] ${err.message}`, 'red'));
    process.exit(1);
  });
}
