/** Interactive Model Center Terminal Command Center.
 * Implements My Models, Available Models, Model Details, Multi-Key Manager, Live Per-Key/Per-Model Quota Monitor & Routing.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  header,
  section,
  choice,
  entry,
  info,
  warn,
  fail,
  renderBreadcrumb,
  renderTable,
  renderPanelBox,
  renderMeterBar,
  renderSparkline,
  renderProgressBar,
  renderErrorCard,
  badge,
  toast,
  withSpinner,
  animateKeyRotation,
  paint,
  colorEnabled
} from './tokyo.js';
import { loadTheme, theme } from './themes.js';
import {
  checkAllProfilesQuota,
  formatQuotaReport,
  inspectSingleApiKeySpecs,
  formatSingleKeySpecReport,
  watchAllProfilesQuota,
  formatTokenShort
} from '../model-center/quota-checker.js';
import { getKeySlotTelemetrySnapshot } from '../model-center/model-router.js';
import {
  readProfilesDb,
  saveProfilesDb,
  getRoutePlan,
  getProfileKeySlots
} from '../model-center/routing.js';
import {
  addApiKeysToProfile,
  replaceApiKeyInSlot,
  removeApiKeySlotFromProfile,
  parseApiKeyList,
  countTotalProfileKeySlots
} from '../model-center/key-manager.js';
import {
  PROVIDER_REGISTRY,
  fetchLiveModels,
  filterAndPaginate,
  resolveProfileCapabilities,
  normalizeModelSlug
} from '../model-center/catalog.js';
import { ModelRouter } from '../model-center/model-router.js';
import {
  getModelKey,
  deleteModelKey,
  maskApiKey
} from '../model-center/keyring.js';
import { testConnection } from '../model-center/tester.js';
import { promptSecret } from '../security/secure-input.js';
import { redactSecrets } from '../security/redact.js';
import type { ProviderId, StoredProfile, ModelProfilesDb, ModelCapability, CapabilitySource } from '../model-center/types.js';

async function promptInput(msg: string, def = ''): Promise<string> {
  const cli = createInterface({ input: stdin, output: stdout });
  try {
    const hint = def ? ` [${def}]` : '';
    const res = (await cli.question(`  ❯ ${msg}${hint}  ›  `)).trim();
    return res || def;
  } finally {
    cli.close();
  }
}

/** Resolves either a 1-based list index ("1", "2") or exact profile/slot ID */
function resolveChoiceByIndexOrId(rawInput: string, ids: string[]): string | undefined {
  const clean = rawInput.trim();
  if (!clean) return undefined;
  if (ids.includes(clean)) return clean;
  if (/^\d+$/.test(clean)) {
    const idx = parseInt(clean, 10) - 1;
    if (idx >= 0 && idx < ids.length) return ids[idx];
  }
  return undefined;
}

async function promptPickProfile(db: ModelProfilesDb, titleLabel: string, allowEmpty = false): Promise<string | undefined> {
  const profileIds = Object.keys(db.profiles || {});
  if (!profileIds.length) {
    warn('Chưa có profile nào trong Model Center.');
    return undefined;
  }
  info('Chọn Profile theo số thứ tự (1, 2...) hoặc nhập Profile ID:');
  profileIds.forEach((id, i) => {
    const p = db.profiles[id];
    const slotCount = getProfileKeySlots(id, p).length;
    const defTag = id === db.default ? ' ★ DEFAULT' : '';
    choice(String(i + 1), `${id}${defTag}`, `${p.provider.toUpperCase()} · ${p.model} · ${slotCount} key`);
  });
  const defChoice = allowEmpty ? '' : '1';
  const raw = await promptInput(titleLabel, defChoice);
  if (!raw && allowEmpty) return undefined;
  const resolved = resolveChoiceByIndexOrId(raw, profileIds);
  if (!resolved) {
    warn(`Không tìm thấy profile "${raw}".`);
    return undefined;
  }
  return resolved;
}

/** Shared interactive flow to add 1 or more API keys to any existing profile (or create one if none exist). */
export async function promptAddKeysToProfileFlow(presetProfileId?: string): Promise<boolean> {
  const db = await readProfilesDb();
  const profileIds = Object.keys(db.profiles || {});

  if (profileIds.length === 0) {
    warn('Chưa có model profile nào để gắn key.');
    const createNow = await promptInput('Bạn có muốn tạo Model Profile mới ngay bây giờ không? (Y/n)', 'y');
    if (createNow.toLowerCase() !== 'n') {
      await addNewModelWizard();
      return true;
    }
    return false;
  }

  let targetId = presetProfileId && db.profiles[presetProfileId] ? presetProfileId : undefined;
  if (!targetId) {
    section('THÊM API KEY VÀO PROFILE (XOAY VÒNG ĐA KEY)');
    targetId = await promptPickProfile(db, 'Chọn Profile muốn gắn thêm API Key');
    if (!targetId) return false;
  }

  const prof = db.profiles[targetId];
  const currentSlots = getProfileKeySlots(targetId, prof);
  info(`Profile "${targetId}" (${prof.provider.toUpperCase()} · ${prof.model}) hiện có ${currentSlots.length} key slot.`);
  info('Nhập 1 hoặc nhiều API key (cách nhau bởi dấu phẩy hoặc khoảng trắng; lưu ẩn trong Windows Credential Manager; nhấn Enter để hủy):');

  let rawInput = '';
  try {
    rawInput = await promptSecret('  ❯ API key(s) mới  ›  ', { allowEmpty: true, maskChar: '•' });
  } catch (e: any) {
    warn(e?.message || 'Hủy nhập API key');
    return false;
  }

  if (!rawInput.trim()) {
    info('Đã hủy thêm API key.');
    return false;
  }

  try {
    const res = await addApiKeysToProfile(targetId, rawInput);
    if (res.addedSlots.length > 0 && res.totalSlots > 1) {
      await animateKeyRotation({
        from: currentSlots[0] || targetId,
        to: res.addedSlots[res.addedSlots.length - 1],
        slotIndex: res.totalSlots,
        totalSlots: res.totalSlots,
        mode: 'round-robin',
        reason: `Pool ${res.totalSlots} key sẵn sàng xoay vòng`
      });
    }
    toast(
      'success',
      `Đã thêm ${res.addedSlots.length} API key vào "${res.profileId}"${res.skippedDuplicates > 0 ? ` (bỏ qua ${res.skippedDuplicates} key trùng)` : ''}! Tổng pool: ${res.totalSlots} key.`
    );

    const checkNow = await promptInput(`Đo ngay kết nối, Quota & Rate Limit từng model cho "${targetId}"? (Y/n)`, 'y');
    if (checkNow.toLowerCase() !== 'n') {
      const rep = await withSpinner(`Đang đo quota & rate limit từng model trên tất cả key của ${targetId}...`, () =>
        checkAllProfilesQuota({ profileId: targetId })
      );
      console.log('\n' + formatQuotaReport(rep) + '\n');
      await promptInput('Nhấn Enter để tiếp tục', '');
    }
    return true;
  } catch (err: any) {
    warn(err?.message || 'Không thể thêm API key vào profile.');
    return false;
  }
}

async function runLiveQuotaWatchUi(options: {
  intervalSec: number;
  maxIterations: number;
  profileId?: string;
  includeAllListedModels?: boolean;
}): Promise<void> {
  const ac = new AbortController();
  const onSigInt = () => ac.abort();
  process.once('SIGINT', onSigInt);
  const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);

  try {
    await watchAllProfilesQuota({
      intervalSec: options.intervalSec,
      maxIterations: options.maxIterations,
      profileId: options.profileId,
      includeAllListedModels: options.includeAllListedModels,
      signal: ac.signal,
      onReport: (rep, iter) => {
        if (isTty && colorEnabled()) {
          process.stdout.write('\x1b[H\x1b[2J');
        }
        header(`QUOTA WATCH LIVE  //  CHU KỲ ${iter}/${options.maxIterations}`);
        renderBreadcrumb(['MODEL CENTER', 'QUOTA MONITOR', 'LIVE WATCH']);
        console.log(
          `  ${badge(`CYCLE ${iter}/${options.maxIterations}`, 'cyan')}  ` +
          `${badge(`RESET TRONG ${rep.nextResetInText || '-'}`, 'purple')}  ` +
          paint(`Làm mới mỗi ${options.intervalSec}s (Ctrl+C để dừng)`, 'muted')
        );
        console.log('');
        console.log(formatQuotaReport(rep));
        console.log('');
        renderProgressBar('Tiến trình Watch', iter, options.maxIterations, `còn ${options.maxIterations - iter} chu kỳ`);
      }
    });
  } finally {
    process.removeListener('SIGINT', onSigInt);
  }
}

// ─────────────────────────────────────────────────────────────
// TAB A: MY MODELS
// ─────────────────────────────────────────────────────────────
export async function viewMyModels(): Promise<void> {
  while (true) {
    const db = await readProfilesDb();
    const telemetrySnap = getKeySlotTelemetrySnapshot();
    header('MODEL CENTER  /  MY MODELS');
    renderBreadcrumb(['COMMAND DECK', 'MODEL CENTER', 'MY MODELS']);

    const profileIds = Object.keys(db.profiles);
    section('DANH SÁCH MODEL ĐÃ CẤU HÌNH');

    if (profileIds.length === 0) {
      warn('Chưa có model nào được cấu hình trong hệ thống.');
      info('Hãy chọn [2] Thêm model mới hoặc vào Available Models để tìm model.');
    } else {
      const headers = ['#', 'Profile ID', 'Provider', 'Model ID', 'Keys', 'Hôm nay', 'Trạng thái', 'Mặc định', 'Latency'];
      const rows = profileIds.map((id, idx) => {
        const p = db.profiles[id];
        const isDef = id === db.default ? '● DEFAULT' : '';
        const status = p.verifiedStatus || 'UNTESTED';
        const lat = p.lastLatencyMs ? `${p.lastLatencyMs}ms` : 'Chưa đo';
        const keyCnt = `${getProfileKeySlots(id, p).length} key`;
        const profTel = telemetrySnap.filter(t => t.profileId === id);
        const reqSum = profTel.reduce((s, t) => s + t.usedRpdToday, 0);
        const tokSum = profTel.reduce((s, t) => s + t.usedTokensToday, 0);
        const usageStr = reqSum > 0 || tokSum > 0 ? `${reqSum}r / ${formatTokenShort(tokSum)}` : '0 req';
        return [`[${idx + 1}]`, id, p.provider.toUpperCase(), p.model, keyCnt, usageStr, status, isDef, lat];
      });
      renderTable(headers, rows);
    }

    section('THAO TÁC');
    choice('1', 'Chuyển Model Mặc Định', 'Chọn theo STT hoặc Profile ID');
    choice('2', 'Thêm Model Mới', 'Cấu hình model thủ công hoặc từ Catalog');
    choice('3', 'Thêm API Key vào Profile', 'Gắn thêm 1 hoặc nhiều key xoay vòng cho profile');
    choice('4', 'Chi Tiết Model & Key Pool', 'Xem thông số kỹ thuật, toàn bộ key slot & telemetry');
    choice('5', 'Đo Quota & Rate Limit Profile', 'Đo từng model của mọi API key trong profile');
    choice('6', 'Kiểm Tra Kết Nối Model Này', 'Gửi ping test đo độ trễ từng key');
    choice('7', 'Xóa Model', 'Xóa profile và toàn bộ key khỏi hệ thống');
    choice('0', 'Quay lại', 'Trở về menu Model Center');

    const cmd = await promptInput('Lựa chọn (0–7)');
    if (cmd === '0') break;

    if (cmd === '1') {
      if (!profileIds.length) {
        warn('Chưa có profile nào');
        continue;
      }
      const raw = await promptInput(`Nhập STT (1-${profileIds.length}) hoặc Profile ID muốn đặt làm mặc định`);
      const target = resolveChoiceByIndexOrId(raw, profileIds);
      if (target && db.profiles[target]) {
        db.default = target;
        await saveProfilesDb(db);
        toast('success', `Đã đặt ${target} làm model mặc định!`);
      } else {
        warn('Profile ID không tồn tại');
      }
    } else if (cmd === '2') {
      await addNewModelWizard();
    } else if (cmd === '3') {
      await promptAddKeysToProfileFlow();
    } else if (cmd === '4') {
      if (!profileIds.length) {
        warn('Chưa có profile nào');
        continue;
      }
      const raw = await promptInput(`Nhập STT (1-${profileIds.length}) hoặc Profile ID muốn xem`, '1');
      const target = resolveChoiceByIndexOrId(raw, profileIds);
      if (target && db.profiles[target]) {
        await viewModelDetails(target);
      } else {
        warn('Profile ID không tồn tại');
      }
    } else if (cmd === '5') {
      if (!profileIds.length) {
        warn('Chưa có profile nào');
        continue;
      }
      const raw = await promptInput(`Nhập STT (1-${profileIds.length}) hoặc Profile ID muốn đo quota`, '1');
      const target = resolveChoiceByIndexOrId(raw, profileIds);
      if (target && db.profiles[target]) {
        const rep = await withSpinner(`Đang đo quota & rate limit từng model của "${target}"...`, () =>
          checkAllProfilesQuota({ profileId: target })
        );
        console.log('\n' + formatQuotaReport(rep) + '\n');
        await promptInput('Nhấn Enter để tiếp tục', '');
      } else {
        warn('Profile ID không tồn tại');
      }
    } else if (cmd === '6') {
      if (!profileIds.length) {
        warn('Chưa có profile nào');
        continue;
      }
      const raw = await promptInput(`Nhập STT (1-${profileIds.length}) hoặc Profile ID muốn test`, '1');
      const target = resolveChoiceByIndexOrId(raw, profileIds);
      if (target && db.profiles[target]) {
        await runSingleTest(target, db.profiles[target]);
      } else {
        warn('Profile ID không tồn tại');
      }
    } else if (cmd === '7') {
      if (!profileIds.length) {
        warn('Chưa có profile nào');
        continue;
      }
      const raw = await promptInput(`Nhập STT (1-${profileIds.length}) hoặc Profile ID muốn xóa`);
      const target = resolveChoiceByIndexOrId(raw, profileIds);
      if (target && db.profiles[target]) {
        const confirm = await promptInput(`Gõ DELETE để xác nhận xóa ${target}`);
        if (confirm === 'DELETE') {
          const allSlots = getProfileKeySlots(target, db.profiles[target]);
          delete db.profiles[target];
          if (db.default === target) {
            db.default = Object.keys(db.profiles)[0] || undefined;
          }
          db.fallbacks = (db.fallbacks || []).filter(f => f !== target);
          for (const slot of allSlots) {
            deleteModelKey(slot);
          }
          await saveProfilesDb(db);
          toast('success', `Đã xóa profile ${target} và toàn bộ ${allSlots.length} key khỏi OS keyring!`);
        }
      } else {
        warn('Profile ID không tồn tại');
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// TAB B: AVAILABLE MODELS (Provider picker + dynamic API listing)
// ─────────────────────────────────────────────────────────────
export async function viewAvailableModels(): Promise<void> {
  header('MODEL CENTER  /  AVAILABLE MODELS');
  renderBreadcrumb(['COMMAND DECK', 'MODEL CENTER', 'AVAILABLE MODELS']);

  section('CHỌN NHÀ CUNG CẤP AI (PROVIDER)');
  const providers: ProviderId[] = ['openai', 'gemini', 'anthropic', 'groq', 'custom'];
  providers.forEach((p, idx) => {
    const meta = PROVIDER_REGISTRY[p];
    choice(String(idx + 1), meta.name, meta.listingNote || '');
  });
  choice('0', 'Quay lại');

  const pSel = await promptInput('Chọn nhà cung cấp (0–5)');
  const idx = parseInt(pSel, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= providers.length) return;

  const chosenProvider = providers[idx];
  const meta = PROVIDER_REGISTRY[chosenProvider];

  if (chosenProvider === 'custom') {
    info('Custom Provider: Bạn có thể nhập model ID và endpoint tự do.');
    await addNewModelWizard('custom');
    return;
  }

  // Look for any existing API key for this provider to fetch live models
  const db = await readProfilesDb();
  let existingKey = '';
  for (const [pId, pData] of Object.entries(db.profiles)) {
    if (pData.provider === chosenProvider) {
      const k = getModelKey(pId);
      if (k) {
        existingKey = k;
        break;
      }
    }
  }

  if (!existingKey && meta.supportsApiListing) {
    info(`Bạn chưa có API key lưu sẵn cho ${meta.name}.`);
    info('Nhập API key (ký tự sẽ được ẩn; nhấn Enter nếu muốn bỏ qua để xem danh mục mẫu):');
    try {
      const tempKey = await promptSecret('  ❯ API key  ›  ', { allowEmpty: true, maskChar: '•' });
      if (tempKey) existingKey = tempKey;
    } catch {}
  }

  const catalogResult = await withSpinner(`Đang tải danh sách model ${meta.name}...`, async () => {
    return await fetchLiveModels(chosenProvider, existingKey);
  });

  if (catalogResult.note) {
    info(`ℹ ${catalogResult.note}`);
  }

  let page = 1;
  let query = '';

  while (true) {
    const { items, total, totalPages, currentPage } = filterAndPaginate(catalogResult.models, query, page, 6);
    page = currentPage;

    header(`AVAILABLE MODELS: ${meta.name.toUpperCase()} (Trang ${page}/${totalPages} - ${total} models)`);
    renderBreadcrumb(['MODEL CENTER', 'AVAILABLE MODELS', meta.name]);

    if (query) {
      entry('TÌM KIẾM HIỆN TẠI', `"${query}"`, 'aqua');
    }

    const headers = ['#', 'Model ID', 'Nguồn', 'Vision', 'Context', 'Task Support', 'Ghi chú'];
    const rows = items.map((m, i) => {
      const sourceBadge =
        m.capabilitySource === 'VERIFIED' ? '[XÁC THỰC]' :
        m.capabilitySource === 'PROVIDER_REPORTED' ? '[PROVIDER]' :
        m.capabilitySource === 'INFERRED' ? '[ƯỚC LƯỢNG]' : '[CHƯA RÕ]';
      return [
        String(i + 1),
        m.id,
        sourceBadge,
        m.capabilities.vision ? '✓ CÓ' : 'KHÔNG',
        m.capabilities.contextWindow ? `${Math.round(m.capabilities.contextWindow / 1000)}k` : 'N/A',
        m.capabilities.taskCompatibility.join('+'),
        m.capabilities.description?.slice(0, 32) || (m.isVerified ? 'Chính thức' : 'Từ API')
      ];
    });
    renderTable(headers, rows);

    section('ĐIỀU HƯỚNG');
    info('[1–6] Chọn model để thêm profile  ·  [S] Tìm kiếm  ·  [C] Xóa tìm kiếm');
    info('[N] Trang sau  ·  [P] Trang trước  ·  [M] Nhập model ID thủ công  ·  [0] Quay lại');

    const action = (await promptInput('Hành động')).toLowerCase();
    if (action === '0') break;
    if (action === 'n') {
      if (page < totalPages) page++;
      continue;
    }
    if (action === 'p') {
      if (page > 1) page--;
      continue;
    }
    if (action === 's') {
      query = await promptInput('Nhập từ khóa tìm kiếm (VD: flash, sonnet, gpt-4o, llama)');
      page = 1;
      continue;
    }
    if (action === 'c') {
      query = '';
      page = 1;
      continue;
    }
    if (action === 'm') {
      const customId = await promptInput('Nhập chính xác Model ID');
      if (customId) {
        await addNewModelWizard(chosenProvider, customId, existingKey);
      }
      break;
    }

    const selNum = parseInt(action, 10);
    if (!isNaN(selNum) && selNum >= 1 && selNum <= items.length) {
      const selectedModel = items[selNum - 1];
      await addNewModelWizard(chosenProvider, selectedModel.id, existingKey);
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// TAB C: MODEL DETAILS
// ─────────────────────────────────────────────────────────────
/** Unified inspector ensuring Model Center UI displays the exact same capability provenance and Vision routing gate as Catalog & ModelRouter. */
export function inspectProfileCapabilityDetails(profile: StoredProfile): {
  capabilities: ModelCapability;
  capabilitySource: CapabilitySource;
  autoVisionRoutingAllowed: boolean;
} {
  const resolved = resolveProfileCapabilities(profile);
  const autoVisionRoutingAllowed = ModelRouter.isVisionCapable(profile);
  return {
    capabilities: resolved.capabilities,
    capabilitySource: resolved.capabilitySource,
    autoVisionRoutingAllowed
  };
}

export async function viewModelDetails(profileId: string): Promise<void> {
  while (true) {
    const db = await readProfilesDb();
    const profile = db.profiles[profileId];
    if (!profile) {
      warn(`Không tìm thấy profile ${profileId}`);
      return;
    }

    header(`CHI TIẾT MODEL: ${profileId}`);
    renderBreadcrumb(['MODEL CENTER', 'MY MODELS', profileId]);

    const { capabilities: caps, capabilitySource, autoVisionRoutingAllowed } = inspectProfileCapabilityDetails(profile);
    const slots = getProfileKeySlots(profileId, profile);
    const allTelemetry = getKeySlotTelemetrySnapshot().filter(t => t.profileId === profileId);

    section('THÔNG TIN CẤU HÌNH');
    entry('PROFILE ID', profileId, 'aqua');
    entry('PROVIDER', profile.provider.toUpperCase(), 'purple');
    entry('MODEL ID', profile.model, 'green');
    entry('ENDPOINT', profile.endpoint || 'Mặc định nhà cung cấp', 'fg');
    entry('SỐ API KEY TRONG POOL', `${slots.length} slot (${slots.filter(s => Boolean(getModelKey(s))).length} key hợp lệ)`, slots.some(s => Boolean(getModelKey(s))) ? 'green' : 'red');
    entry('MÔ TẢ', caps.description || 'N/A', 'muted');

    section('NĂNG LỰC & NGUỒN XÁC MINH (CAPABILITIES & PROVENANCE)');
    entry(
      'NGUỒN NĂNG LỰC (PROVENANCE)',
      capabilitySource,
      capabilitySource === 'VERIFIED' || capabilitySource === 'PROVIDER_REPORTED'
        ? 'green'
        : capabilitySource === 'USER_DECLARED'
          ? 'cyan'
          : 'orange'
    );
    entry('VISION / ẢNH CHỤP', caps.vision ? 'CÓ (Khai báo/Xác minh hỗ trợ ảnh)' : 'KHÔNG (Chỉ text)', caps.vision ? 'green' : 'orange');
    entry(
      'AUTO-VISION ROUTING',
      autoVisionRoutingAllowed ? 'ĐƯỢC PHÉP (Đủ điều kiện gửi ảnh chụp)' : 'ĐÃ CHẶN (Không gửi ảnh chụp tới model chưa đủ điều kiện)',
      autoVisionRoutingAllowed ? 'green' : 'orange'
    );
    entry('CONTEXT WINDOW', `${caps.contextWindow.toLocaleString()} tokens`, 'cyan');
    entry('TASK COMPATIBILITY', caps.taskCompatibility.join(', '), 'purple');

    section('DANH SÁCH API KEY SLOTS & TELEMETRY');
    renderTable(
      ['#', 'Slot ID', 'Masked Key', 'OS Vault', 'Req/Tok hôm nay', 'Latency EMA'],
      slots.map((slotId, idx) => {
        const k = getModelKey(slotId);
        const slotTel = allTelemetry.filter(t => t.keySlot === slotId);
        const reqSum = slotTel.reduce((s, t) => s + t.usedRpdToday, 0);
        const tokSum = slotTel.reduce((s, t) => s + t.usedTokensToday, 0);
        const lats = slotTel.map(t => t.avgLatencyMs).filter((x): x is number => typeof x === 'number' && x > 0);
        const avgLat = lats.length > 0 ? `${Math.round(lats.reduce((a, b) => a + b, 0) / lats.length)}ms` : '-';
        return [
          `[${idx + 1}]`,
          idx === 0 ? `${slotId} (Chính)` : `${slotId} (#${idx + 1})`,
          k ? maskApiKey(k) : '[MISSING KEY]',
          k ? 'PROTECTED' : 'CHƯA CÓ',
          `${reqSum} req / ${formatTokenShort(tokSum)}`,
          avgLat
        ];
      })
    );

    if (allTelemetry.length > 0) {
      section('RATE LIMIT & QUOTA ĐÃ GHI NHẬN THEO TỪNG KEY / MODEL');
      renderTable(
        ['Key Slot', 'Model', 'RPM (60s)', 'TPM (60s)', 'RPD (Ngày)', 'Nguồn', 'Trạng thái'],
        allTelemetry.map(t => [
          t.keySlot,
          t.model,
          `${t.usedRpm60s}/${t.limits.rpm}`,
          `${formatTokenShort(t.usedTpm60s)}/${formatTokenShort(t.limits.tpm)}`,
          `${t.usedRpdToday}/${formatTokenShort(t.limits.rpd)}`,
          t.limitSource === 'API_HEADER' ? 'API' : t.limitSource === 'API_ERROR' ? '429' : 'Tier',
          t.cooldownRemainingMs > 0 ? `COOL ${Math.ceil(t.cooldownRemainingMs / 1000)}s` : 'SẴN SÀNG'
        ])
      );
    }

    section('TRẠNG THÁI KIỂM THỬ (TEST STATUS)');
    entry('TRẠNG THÁI', profile.verifiedStatus || 'UNTESTED', profile.verifiedStatus === 'VERIFIED' ? 'green' : profile.verifiedStatus === 'FAILED' ? 'red' : 'orange');
    entry('LẦN TEST CUỐI', profile.lastTestedAt || 'Chưa test', 'muted');
    entry('ĐỘ TRỄ (LATENCY)', profile.lastLatencyMs ? `${profile.lastLatencyMs}ms` : 'N/A', 'cyan');

    section('LỰA CHỌN');
    choice('1', 'Kiểm tra kết nối tất cả Key Slot (Ping Test)');
    choice('2', 'Thêm API Key mới vào Profile này (Xoay vòng đa key)');
    choice('3', 'Thay thế API Key của một Slot');
    choice('4', 'Xóa một Key Slot phụ');
    choice('5', 'Đo Live Quota & Rate Limit từng Model của Profile này');
    choice('0', 'Quay lại');

    const act = await promptInput('Lựa chọn (0–5)');
    if (act === '0') break;

    if (act === '1') {
      await runSingleTest(profileId, profile);
    } else if (act === '2') {
      await promptAddKeysToProfileFlow(profileId);
    } else if (act === '3') {
      const targetRaw = await promptInput(`Chọn STT (1-${slots.length}) hoặc Slot ID muốn thay key`, '1');
      const slotTarget = resolveChoiceByIndexOrId(targetRaw, slots);
      if (!slotTarget) {
        warn('Slot không tồn tại');
        continue;
      }
      info(`Nhập API key mới cho "${slotTarget}" (ký tự được ẩn hoàn toàn; lưu an toàn trong OS keyring):`);
      try {
        const newKey = await promptSecret('  ❯ API key mới  ›  ', { allowEmpty: true, maskChar: '•' });
        if (newKey) {
          await replaceApiKeyInSlot(slotTarget, newKey);
          toast('success', `Đã cập nhật API key cho ${slotTarget}!`);
        }
      } catch (e: any) {
        warn(e.message || 'Hủy nhập key');
      }
    } else if (act === '4') {
      if (slots.length <= 1) {
        warn('Profile chỉ có 1 slot chính; không có slot phụ để gỡ.');
        continue;
      }
      const targetRaw = await promptInput(`Chọn STT (2-${slots.length}) hoặc Slot ID phụ muốn gỡ`);
      const slotTarget = resolveChoiceByIndexOrId(targetRaw, slots);
      if (!slotTarget || slotTarget === profileId) {
        warn('Hãy chọn key slot phụ (khác slot chính) hoặc dùng API Key Manager để xóa toàn bộ.');
        continue;
      }
      await removeApiKeySlotFromProfile(slotTarget);
      toast('success', `Đã gỡ slot ${slotTarget} khỏi ${profileId}`);
    } else if (act === '5') {
      const rep = await withSpinner(`Đang đo Quota & Rate Limit từng model của ${profileId}...`, () =>
        checkAllProfilesQuota({ profileId })
      );
      console.log('\n' + formatQuotaReport(rep) + '\n');
      await promptInput('Nhấn Enter để tiếp tục', '');
    }
  }
}

// ─────────────────────────────────────────────────────────────
// TAB D: API KEY MANAGER
// ─────────────────────────────────────────────────────────────
export async function viewApiKeyManager(): Promise<void> {
  while (true) {
    const db = await readProfilesDb();
    const telemetry = getKeySlotTelemetrySnapshot();
    header('MODEL CENTER  /  API KEY MANAGER (MULTI-KEY ROTATION)');
    renderBreadcrumb(['COMMAND DECK', 'MODEL CENTER', 'API KEY MANAGER']);

    info('Mọi API key được lưu mã hóa an toàn trong Windows Credential Manager.');
    info('Mỗi Profile có thể gắn nhiều API key (nhiều project/tài khoản khác nhau) để tự động xoay vòng.');

    const profileIds = Object.keys(db.profiles);
    const allSlotIds: string[] = [];
    section('DANH SÁCH KEY SLOT THEO PROFILE');

    if (!profileIds.length) {
      warn('Chưa có model profile nào để quản lý key. Chọn [1] để tạo profile & thêm key.');
    } else {
      const headers = ['#', 'Profile ID', 'Key Slot', 'Provider', 'Masked Key', 'Keyring', 'Tải hôm nay'];
      const rows: string[][] = [];
      for (const id of profileIds) {
        const p = db.profiles[id];
        const slots = getProfileKeySlots(id, p);
        slots.forEach((slotId, sIdx) => {
          allSlotIds.push(slotId);
          const idxNum = allSlotIds.length;
          const key = getModelKey(slotId);
          const masked = key ? maskApiKey(key) : '[MISSING KEY]';
          const st = key ? 'PROTECTED' : 'CHƯA CÓ';
          const slotLabel = sIdx === 0 ? `${slotId} (Chính)` : `${slotId} (#${sIdx + 1})`;
          const slotTel = telemetry.filter(t => t.profileId === id && t.keySlot === slotId);
          const reqSum = slotTel.reduce((s, t) => s + t.usedRpdToday, 0);
          const tokSum = slotTel.reduce((s, t) => s + t.usedTokensToday, 0);
          const coolCount = slotTel.filter(t => t.cooldownRemainingMs > 0).length;
          const telStr = `${reqSum} req / ${formatTokenShort(tokSum)}${coolCount > 0 ? ` · ${coolCount} cool` : ''}`;
          rows.push([`[${idxNum}]`, id, slotLabel, p.provider.toUpperCase(), masked, st, telStr]);
        });
      }
      renderTable(headers, rows);
    }

    section('THAO TÁC');
    choice('1', 'Thêm API Key mới vào Profile (Xoay vòng nhiều key)', 'Chọn profile theo STT/ID và gắn thêm key #2, #3...');
    choice('2', 'Thay thế API Key của Profile / Slot', 'Chọn theo STT hoặc Slot ID');
    choice('3', 'Xóa 1 API Key Slot (hoặc toàn bộ key của profile)', 'Gỡ khỏi Windows Credential Vault');
    choice('4', 'Kiểm tra kết nối tất cả Key của Profile (Ping Test từng slot)');
    choice('5', 'Đo Quota & Rate Limit TẤT CẢ Key & Model (Tất cả Provider)');
    choice('6', 'Đo TOÀN BỘ Model của 1 Profile cụ thể (Full Catalog Scan)');
    choice('7', 'Đo Thông Số & Rate Limit 1 API Key bất kỳ (Dán Key trực tiếp)');
    choice('0', 'Quay lại');

    const cmd = await promptInput('Lựa chọn (0–7)');
    if (cmd === '0') break;

    if (cmd === '1') {
      await promptAddKeysToProfileFlow();
    } else if (cmd === '2') {
      if (!allSlotIds.length) {
        warn('Chưa có slot nào.');
        continue;
      }
      const raw = await promptInput(`Nhập STT (1-${allSlotIds.length}) hoặc Key Slot ID`);
      const target = resolveChoiceByIndexOrId(raw, allSlotIds);
      if (!target) {
        warn('Profile / Slot không tồn tại');
        continue;
      }
      info(`Nhập API key mới cho slot "${target}" (ký tự được ẩn hoàn toàn; lưu an toàn trong OS keyring):`);
      try {
        const newKey = await promptSecret('  ❯ API key mới  ›  ', { allowEmpty: true, maskChar: '•' });
        if (newKey) {
          await replaceApiKeyInSlot(target, newKey);
          toast('success', `Đã cập nhật API key cho ${target}!`);
        }
      } catch (e: any) {
        warn(e.message || 'Hủy nhập key');
      }
    } else if (cmd === '3') {
      if (!allSlotIds.length) {
        warn('Chưa có slot nào.');
        continue;
      }
      const raw = await promptInput(`Nhập STT Slot (1-${allSlotIds.length}), Slot ID hoặc Profile ID muốn xóa key`);
      const target = resolveChoiceByIndexOrId(raw, allSlotIds) || (db.profiles[raw] ? raw : undefined);
      if (!target) {
        warn('Profile / Slot không tồn tại');
        continue;
      }
      const rmRes = await removeApiKeySlotFromProfile(target);
      toast('success', `Đã xóa ${rmRes.removedSlots.length} key slot (${rmRes.removedSlots.join(', ')}) khỏi OS keyring!`);
    } else if (cmd === '4') {
      const target = await promptPickProfile(db, 'Chọn Profile muốn Ping Test');
      if (target && db.profiles[target]) {
        await runSingleTest(target, db.profiles[target]);
      }
    } else if (cmd === '5') {
      const snap = getKeySlotTelemetrySnapshot();
      if (snap.length > 0) {
        section('TELEMETRY CỬA SỔ TRƯỢT HIỆN TẠI (TRƯỚC KHI PROBE LIVE)');
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
      const rep = await withSpinner('Đang đo trực tiếp Quota & Rate Limit từng model trên MỌI API key...', () =>
        checkAllProfilesQuota()
      );
      console.log('\n' + formatQuotaReport(rep) + '\n');
      await promptInput('Nhấn Enter để tiếp tục', '');
    } else if (cmd === '6') {
      const target = await promptPickProfile(db, 'Chọn Profile muốn quét toàn bộ model của từng API key');
      if (target) {
        const rep = await withSpinner(`Đang quét toàn bộ model & rate limit từng key của "${target}"...`, () =>
          checkAllProfilesQuota({ profileId: target, includeAllListedModels: true })
        );
        console.log('\n' + formatQuotaReport(rep) + '\n');
        await promptInput('Nhấn Enter để tiếp tục', '');
      }
    } else if (cmd === '7') {
      info('Dán 1 API key bất kỳ (Gemini/OpenAI/Groq/Anthropic) để đo thông số & rate limit từng model (ẩn khi nhập):');
      try {
        const rawKey = await promptSecret('  ❯ API key  ›  ', { allowEmpty: true, maskChar: '•' });
        if (rawKey) {
          const spec = await withSpinner('Đang đo thông số kỹ thuật, quota & rate limit từng model...', () =>
            inspectSingleApiKeySpecs(rawKey)
          );
          console.log('\n' + formatSingleKeySpecReport(spec) + '\n');
          await promptInput('Nhấn Enter để tiếp tục', '');
        }
      } catch (e: any) {
        warn(e?.message || 'Không thể đo API key');
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// TAB Q: QUOTA & RATE LIMIT MONITOR CENTER
// ─────────────────────────────────────────────────────────────
export async function viewQuotaMonitor(): Promise<void> {
  while (true) {
    const db = await readProfilesDb();
    const profileIds = Object.keys(db.profiles || {});
    const totalKeys = countTotalProfileKeySlots(db);
    const snap = getKeySlotTelemetrySnapshot();

    header('MODEL CENTER  /  QUOTA & RATE LIMIT MONITOR');
    renderBreadcrumb(['COMMAND DECK', 'MODEL CENTER', 'QUOTA MONITOR']);

    const totalReqToday = snap.reduce((s, t) => s + t.usedRpdToday, 0);
    const totalTokToday = snap.reduce((s, t) => s + t.usedTokensToday, 0);
    const lats = snap.map(t => t.avgLatencyMs).filter((x): x is number => typeof x === 'number' && x > 0);
    renderPanelBox(
      'TỔNG QUAN TELEMETRY & HẠN MỨC',
      [
        `Hồ sơ & Key Pool : ${paint(`${profileIds.length} profile`, 'cyan', true)} · ${paint(`${totalKeys} API key slot`, 'purple', true)}`,
        `Tiêu thụ hôm nay : ${paint(`${totalReqToday} requests`, 'green', true)} · ${paint(`${totalTokToday.toLocaleString('en-US')} tokens`, 'aqua')}`,
        ...(lats.length > 0 ? [`Độ trễ gần đây   : ${renderSparkline(lats.slice(-16))} (${Math.round(lats.reduce((a, b) => a + b, 0) / lats.length)}ms avg)`] : [])
      ],
      'cyan',
      'LIVE TELEMETRY'
    );

    section('CHẾ ĐỘ ĐO QUOTA & RATE LIMIT (THEO TỪNG KEY & MODEL)');
    choice('1', 'Đo Tất Cả Profile & Tất Cả API Key', 'Kiểm tra mọi key slot và từng model của mỗi key (mọi provider)');
    choice('2', 'Quét TOÀN BỘ Model của Tất Cả Key (Full Catalog)', 'Kiểm tra mọi model hỗ trợ chat trên từng API key');
    choice('3', 'Đo Riêng 1 Profile (Mọi Key Slot của Profile)', 'Chọn theo STT hoặc Profile ID');
    choice('4', 'Đo 1 API Key Dán Trực Tiếp', 'Kiểm tra key bất kỳ không cần lưu');
    choice('5', 'Live Watch Dashboard (Tự làm mới tại chỗ)', 'Theo dõi liên tục khi chờ reset RPM / RPD');
    choice('0', 'Quay lại');

    const cmd = await promptInput('Lựa chọn (0–5)');
    if (cmd === '0') break;

    if (cmd === '1') {
      const rep = await withSpinner('Đang đo live quota & rate limit từng model của từng API key...', () =>
        checkAllProfilesQuota()
      );
      console.log('\n' + formatQuotaReport(rep) + '\n');
      await promptInput('Nhấn Enter để tiếp tục', '');
    } else if (cmd === '2') {
      const rep = await withSpinner('Đang quét toàn bộ catalog model trên từng API key...', () =>
        checkAllProfilesQuota({ includeAllListedModels: true })
      );
      console.log('\n' + formatQuotaReport(rep) + '\n');
      await promptInput('Nhấn Enter để tiếp tục', '');
    } else if (cmd === '3') {
      const target = await promptPickProfile(db, 'Chọn Profile muốn đo quota');
      if (target) {
        const fullAns = (await promptInput('Quét toàn bộ model trên từng key? (y/N)', 'n')).toLowerCase() === 'y';
        const rep = await withSpinner(`Đang đo quota từng key/model của "${target}"...`, () =>
          checkAllProfilesQuota({ profileId: target, includeAllListedModels: fullAns })
        );
        console.log('\n' + formatQuotaReport(rep) + '\n');
        await promptInput('Nhấn Enter để tiếp tục', '');
      }
    } else if (cmd === '4') {
      info('Dán API key cần kiểm tra (ẩn khi nhập):');
      try {
        const rawKey = await promptSecret('  ❯ API key  ›  ', { allowEmpty: true, maskChar: '•' });
        if (rawKey) {
          const spec = await withSpinner('Đang đo thông số & rate limit từng model của API key...', () =>
            inspectSingleApiKeySpecs(rawKey)
          );
          console.log('\n' + formatSingleKeySpecReport(spec) + '\n');
          await promptInput('Nhấn Enter để tiếp tục', '');
        }
      } catch (e: any) {
        warn(e?.message || 'Hủy kiểm tra');
      }
    } else if (cmd === '5') {
      const secRaw = await promptInput('Chu kỳ làm mới (giây, 5–600)', '20');
      const iterRaw = await promptInput('Số chu kỳ theo dõi (1–60)', '6');
      const intervalSec = Math.max(5, Math.min(600, parseInt(secRaw, 10) || 20));
      const maxIterations = Math.max(1, Math.min(60, parseInt(iterRaw, 10) || 6));
      await runLiveQuotaWatchUi({ intervalSec, maxIterations });
      await promptInput('Live Watch hoàn tất. Nhấn Enter để tiếp tục', '');
    }
  }
}

// ─────────────────────────────────────────────────────────────
// TAB E: MODEL ROUTING & FALLBACKS
// ─────────────────────────────────────────────────────────────
export async function viewModelRouting(): Promise<void> {
  while (true) {
    const db = await readProfilesDb();
    header('MODEL CENTER  /  MODEL ROUTING & FALLBACK');
    renderBreadcrumb(['COMMAND DECK', 'MODEL CENTER', 'ROUTING']);

    const routePlan = getRoutePlan(db);
    section('CHUỖI ĐIỀU HƯỚNG HIỆN TẠI (ROUTING CHAIN)');

    entry('1. MODEL CHÍNH (PRIMARY)', routePlan.primary ? `${routePlan.primary} (${db.profiles[routePlan.primary]?.model || 'model'})` : 'CHƯA CÓ', routePlan.primary ? 'green' : 'red');

    if (routePlan.fallbacks.length > 0) {
      routePlan.fallbacks.forEach((fb, i) => {
        entry(`  ↳ Fallback #${i + 1}`, `${fb} (${db.profiles[fb]?.model || 'model'})`, 'cyan');
      });
    } else {
      entry('  ↳ Fallback list', 'Không có model dự phòng nào (Khuyến nghị thêm ít nhất 1 fallback)', 'orange');
    }

    info('Cơ chế Auto-Switch: Tự động chuyển key slot / model khi timeout, 429 rate limit, 500/503 server error hoặc mạng.');
    info('Bảo vệ vòng lặp: Sử dụng tập hợp định danh duy nhất (visited set), không bao giờ lặp vô hạn.');
    info('Bảo vệ xác thực: Không tự fallback khi gặp lỗi 401/403 (sai key) để tránh lãng phí request.');

    section('THAO TÁC');
    choice('1', 'Chọn Model Chính (Set Primary)');
    choice('2', 'Thêm Model Dự Phòng (Add Fallback)');
    choice('3', 'Xóa Model Khỏi Danh Sách Dự Phòng');
    choice('4', 'Đổi Thứ Tự Ưu Tiên Fallback');
    choice('0', 'Quay lại');

    const cmd = await promptInput('Lựa chọn (0–4)');
    if (cmd === '0') break;

    const available = Object.keys(db.profiles);

    if (cmd === '1') {
      const target = await promptPickProfile(db, 'Chọn Profile làm model chính');
      if (target && db.profiles[target]) {
        db.default = target;
        await saveProfilesDb(db);
        toast('success', `Đã đặt ${target} làm model chính!`);
      }
    } else if (cmd === '2') {
      const target = await promptPickProfile(db, 'Chọn Profile làm fallback');
      if (target && db.profiles[target]) {
        if (!db.fallbacks) db.fallbacks = [];
        if (!db.fallbacks.includes(target) && target !== db.default) {
          db.fallbacks.push(target);
          await saveProfilesDb(db);
          toast('success', `Đã thêm ${target} vào danh sách fallback!`);
        } else {
          warn('Profile đã nằm trong chuỗi routing');
        }
      }
    } else if (cmd === '3') {
      const targetRaw = await promptInput(`Nhập Profile ID muốn gỡ khỏi fallback (${(db.fallbacks || []).join(', ')})`);
      const target = resolveChoiceByIndexOrId(targetRaw, available) || targetRaw;
      db.fallbacks = (db.fallbacks || []).filter(f => f !== target);
      await saveProfilesDb(db);
      toast('success', `Đã gỡ ${target} khỏi fallback list!`);
    } else if (cmd === '4') {
      info(`Thứ tự hiện tại: ${(db.fallbacks || []).join(' -> ')}`);
      const newOrder = await promptInput('Nhập lại danh sách Profile ID theo thứ tự mới (cách nhau bởi dấu phẩy)');
      const parsed = newOrder.split(',').map(s => s.trim()).filter(id => db.profiles[id]);
      if (parsed.length) {
        db.fallbacks = parsed;
        await saveProfilesDb(db);
        toast('success', 'Đã cập nhật thứ tự fallback!');
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// TAB F: TEST CONNECTION
// ─────────────────────────────────────────────────────────────
export async function runSingleTest(profileId: string, profile: StoredProfile): Promise<void> {
  const slots = getProfileKeySlots(profileId, profile);
  let anySuccess = false;
  let bestLatency = 0;

  for (let i = 0; i < slots.length; i++) {
    const slotId = slots[i];
    if (i > 0) {
      await animateKeyRotation({
        from: slots[i - 1],
        to: slotId,
        slotIndex: i + 1,
        totalSlots: slots.length,
        mode: 'probe',
        reason: `Xoay sang key #${i + 1}/${slots.length} để kiểm tra`
      });
    }
    const slotLabel = slots.length > 1 ? `${profileId} [${slotId}]` : profileId;
    const key = getModelKey(slotId);
    const res = await withSpinner(`Đang kiểm tra kết nối tới ${slotLabel} (${profile.model})...`, async () => {
      return await testConnection({
        provider: profile.provider,
        kind: profile.kind,
        model: profile.model,
        endpoint: profile.endpoint,
        apiKey: key || ''
      });
    });

    if (res.success) {
      anySuccess = true;
      bestLatency = bestLatency === 0 ? res.latencyMs : Math.min(bestLatency, res.latencyMs);
      toast('success', `Kết nối thành công tới ${slotLabel} (${profile.model})! Độ trễ: ${res.latencyMs}ms`);
    } else {
      renderErrorCard(
        `Kiểm tra kết nối thất bại (${slotLabel}): ${res.category}`,
        redactSecrets(res.errorMessage || 'Lỗi không xác định'),
        res.suggestion
      );
    }
  }

  const db = await readProfilesDb();
  if (db.profiles[profileId]) {
    db.profiles[profileId].lastTestedAt = new Date().toISOString();
    if (bestLatency > 0) db.profiles[profileId].lastLatencyMs = bestLatency;
    db.profiles[profileId].verifiedStatus = anySuccess ? 'VERIFIED' : 'FAILED';
    await saveProfilesDb(db);
  }
}

export async function testAllConnections(): Promise<void> {
  const db = await readProfilesDb();
  const profileIds = Object.keys(db.profiles);
  if (!profileIds.length) {
    warn('Chưa có profile nào');
    return;
  }

  header('KIỂM TRA KẾT NỐI TẤT CẢ MODEL');
  renderBreadcrumb(['MODEL CENTER', 'TEST ALL']);

  for (const pid of profileIds) {
    const p = db.profiles[pid];
    info(`Testing ${pid} (${p.model})...`);
    await runSingleTest(pid, p);
  }
}

// ─────────────────────────────────────────────────────────────
// ADD NEW MODEL WIZARD
// ─────────────────────────────────────────────────────────────
export async function addNewModelWizard(presetProvider?: ProviderId, presetModelId?: string, presetKey?: string): Promise<void> {
  section('THÊM MODEL PROFILE MỚI');
  const db = await readProfilesDb();

  const defaultProfId = presetModelId ? presetModelId.replace(/[^a-zA-Z0-9_-]/g, '-') : 'my-model';
  const profileId = await promptInput('Đặt Profile ID đại diện (chữ, số, gạch ngang/dưới, VD: gpt4o-main, gemini-fast)', defaultProfId);
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(profileId)) {
    fail('Profile ID không hợp lệ');
    return;
  }

  let provider = presetProvider;
  if (!provider) {
    const provInput = await promptInput('Chọn Provider (1: openai, 2: gemini, 3: anthropic, 4: groq, 5: custom)', '2');
    const mapping: Record<string, ProviderId> = { '1': 'openai', '2': 'gemini', '3': 'anthropic', '4': 'groq', '5': 'custom' };
    provider = mapping[provInput] || 'gemini';
  }

  const meta = PROVIDER_REGISTRY[provider];
  let endpoint = meta.defaultEndpoint;

  if (provider === 'custom') {
    endpoint = await promptInput('Nhập URL API Endpoint đầy đủ (HTTPS)');
    if (!endpoint.startsWith('https://')) {
      fail('Endpoint phải là HTTPS');
      return;
    }
  }

  const defaultSuggestion = provider === 'gemini' ? 'gemini-3.5-flash-lite' : provider === 'groq' ? 'llama-3.3-70b-versatile' : provider === 'anthropic' ? 'claude-3-5-sonnet-20241022' : 'gpt-4o';
  const rawModelId = presetModelId || (await promptInput(`Nhập Model ID chính xác của ${meta.name}`, defaultSuggestion));
  if (!rawModelId) {
    fail('Model ID không được để trống');
    return;
  }
  const modelId = normalizeModelSlug(provider, rawModelId);
  if (modelId !== rawModelId.trim()) {
    info(`Tự động chuẩn hóa Model ID: "${rawModelId}" -> "${modelId}"`);
  }

  let rawKeyInput = presetKey || '';
  if (!rawKeyInput) {
    info('Nhập 1 hoặc nhiều API key (cách nhau bởi dấu phẩy/khoảng trắng; ẩn hoàn toàn trong OS keyring, Enter để bỏ qua):');
    try {
      rawKeyInput = await promptSecret('  ❯ API key(s)  ›  ', { allowEmpty: true, maskChar: '•' });
    } catch {
      rawKeyInput = '';
    }
  }

  const parsedKeys = parseApiKeyList(rawKeyInput);
  db.profiles[profileId] = {
    provider,
    kind: meta.kind,
    model: modelId,
    endpoint,
    createdAt: new Date().toISOString(),
    verifiedStatus: 'UNTESTED'
  };
  if (!db.default) db.default = profileId;
  await saveProfilesDb(db);

  if (parsedKeys.length > 0) {
    const addRes = await addApiKeysToProfile(profileId, parsedKeys);
    toast('success', `Đã lưu profile ${profileId} (${modelId}) với ${addRes.totalSlots} API key!`);
  } else {
    warn('Chưa nhập key; hãy chọn [K] hoặc vào API Key Manager để thêm key cho profile này.');
    toast('success', `Đã lưu profile ${profileId} (${modelId}) thành công!`);
  }

  const testNow = await promptInput('Bạn có muốn kiểm tra kết nối ngay không? (Y/n)', 'y');
  if (testNow.toLowerCase() !== 'n') {
    const freshDb = await readProfilesDb();
    if (freshDb.profiles[profileId]) {
      await runSingleTest(profileId, freshDb.profiles[profileId]);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN MODEL CENTER MENU
// ─────────────────────────────────────────────────────────────
export async function runModelCenter(): Promise<void> {
  await loadTheme();
  while (true) {
    const db = await readProfilesDb();
    const snap = getKeySlotTelemetrySnapshot();
    const profileIds = Object.keys(db.profiles || {});
    const totalKeys = countTotalProfileKeySlots(db);
    const totalReqToday = snap.reduce((s, t) => s + t.usedRpdToday, 0);
    const totalTokToday = snap.reduce((s, t) => s + t.usedTokensToday, 0);
    const coolingNow = snap.filter(t => t.cooldownRemainingMs > 0).length;

    header('MODEL CENTER  /  AI MANAGEMENT CONSOLE');
    renderBreadcrumb(['COMMAND DECK', 'MODEL CENTER']);

    const routePlan = getRoutePlan(db);
    const primaryLabel = routePlan.primary
      ? `${routePlan.primary} (${db.profiles[routePlan.primary]?.model || 'model'})`
      : 'CHƯA CẤU HÌNH';

    renderPanelBox(
      'TỔNG QUAN HỆ THỐNG AI & KEY POOL',
      [
        `Model chính  : ${paint(primaryLabel, routePlan.primary ? 'green' : 'red', true)}`,
        `Hồ sơ & Keys : ${paint(`${profileIds.length} profile(s)`, 'cyan', true)} · ${paint(`${totalKeys} API key slot(s)`, 'purple', true)} · ${paint(`${routePlan.fallbacks.length} fallback(s)`, routePlan.fallbacks.length ? 'aqua' : 'orange')}`,
        `Tải hôm nay  : ${renderMeterBar(totalReqToday, Math.max(20, totalKeys * 20), 14)}  (${totalReqToday} req / ${formatTokenShort(totalTokToday)} tok${coolingNow > 0 ? ` · ${coolingNow} slot đang chờ` : ''})`
      ],
      theme().theme === 'cyberpunk' ? 'cyan' : 'purple',
      totalKeys > 0 ? `${totalKeys} KEYS` : 'NO KEY'
    );

    if (profileIds.length > 0) {
      renderTable(
        ['#', 'Profile ID', 'Provider', 'Model', 'Keys', 'Trạng thái', 'Mặc định'],
        profileIds.map((id, i) => {
          const p = db.profiles[id];
          return [
            `[${i + 1}]`,
            id,
            p.provider.toUpperCase(),
            p.model,
            `${getProfileKeySlots(id, p).length} key`,
            p.verifiedStatus || 'UNTESTED',
            id === db.default ? '● DEFAULT' : ''
          ];
        })
      );
    }

    section('CÁC PHÂN HỆ QUẢN LÝ');
    choice('A', 'My Models', 'Quản lý danh sách model đã cấu hình, CRUD & đổi mặc định');
    choice('B', 'Available Models', 'Duyệt Catalog, tìm kiếm, phân trang & lấy model từ API');
    choice('C', 'Model Details', 'Xem chi tiết Vision, Context Window, Key Slots & Telemetry');
    choice('D', 'API Key Manager', 'Quản lý xoay vòng nhiều API key trong Windows Credential Vault');
    choice('K', 'Thêm API Key vào Profile', 'Gắn nhanh 1 hoặc nhiều API key mới cho profile bất kỳ');
    choice('Q', 'Quota & Rate Limit Monitor', 'Đo live RPM / TPM / RPD cho từng model của mỗi API key');
    choice('E', 'Model Routing', 'Thiết lập model chính và chuỗi fallback tự động');
    choice('F', 'Test Connection', 'Gửi ping test tối thiểu, đo latency & chẩn đoán lỗi');
    choice('0', 'Quay lại Command Deck');

    const sel = (await promptInput('Chọn phân hệ (A–F, K, Q hoặc 0)')).toUpperCase();
    if (sel === '0') break;

    if (sel === 'A' || sel === '1') await viewMyModels();
    else if (sel === 'B' || sel === '2') await viewAvailableModels();
    else if (sel === 'C' || sel === '3') {
      if (!profileIds.length) warn('Chưa có profile nào');
      else {
        const id = await promptPickProfile(db, 'Chọn Profile muốn xem chi tiết');
        if (id && db.profiles[id]) await viewModelDetails(id);
      }
    } else if (sel === 'D' || sel === '4') await viewApiKeyManager();
    else if (sel === 'K') await promptAddKeysToProfileFlow();
    else if (sel === 'Q') await viewQuotaMonitor();
    else if (sel === 'E' || sel === '5') await viewModelRouting();
    else if (sel === 'F' || sel === '6') await testAllConnections();
    else warn('Lựa chọn không hợp lệ; vui lòng nhập A, B, C, D, E, F, K, Q hoặc 0.');
  }
}

export { runLiveQuotaWatchUi };

if (process.argv[1] && /(?:^|[\\/])model-center-cli\.(?:ts|js)$/.test(process.argv[1])) {
  void runModelCenter();
}
