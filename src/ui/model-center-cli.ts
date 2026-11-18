/** Interactive Model Center Terminal Command Center.
 * Implements My Models, Available Models, Model Details, API Key Manager, Model Routing, and Test Connection.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  header,
  section,
  choice,
  entry,
  info,
  success,
  warn,
  fail,
  close,
  renderBreadcrumb,
  renderTable,
  renderErrorCard,
  toast,
  withSpinner,
  pill,
  paint
} from './tokyo.js';
import { loadTheme } from './themes.js';
import { checkGeminiProfilesQuota, formatQuotaReport } from '../model-center/quota-checker.js';
import { getKeySlotTelemetrySnapshot } from '../model-center/model-router.js';
import {
  readProfilesDb,
  saveProfilesDb,
  buildExecutionRoute,
  getRoutePlan,
  getProfileKeySlots,
  nextKeySlotId
} from '../model-center/routing.js';
import {
  PROVIDER_REGISTRY,
  fetchLiveModels,
  filterAndPaginate,
  inferCapabilities,
  resolveProfileCapabilities,
  VERIFIED_CAPABILITIES,
  normalizeModelSlug
} from '../model-center/catalog.js';
import { ModelRouter } from '../model-center/model-router.js';
import {
  getModelKey,
  setModelKey,
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

// ─────────────────────────────────────────────────────────────
// TAB A: MY MODELS
// ─────────────────────────────────────────────────────────────
export async function viewMyModels(): Promise<void> {
  while (true) {
    const db = await readProfilesDb();
    header('MODEL CENTER  /  MY MODELS');
    renderBreadcrumb(['COMMAND DECK', 'MODEL CENTER', 'MY MODELS']);

    const profileIds = Object.keys(db.profiles);
    section('DANH SÁCH MODEL ĐÃ CẤU HÌNH');

    if (profileIds.length === 0) {
      warn('Chưa có model nào được cấu hình trong hệ thống.');
      info('Hãy chọn [2] Thêm model mới hoặc vào Available Models để tìm model.');
    } else {
      const headers = ['Profile ID', 'Provider', 'Model ID', 'Keys', 'Trạng thái', 'Mặc định', 'Latency'];
      const rows = profileIds.map(id => {
        const p = db.profiles[id];
        const isDef = id === db.default ? '● DEFAULT' : '';
        const status = p.verifiedStatus || 'UNTESTED';
        const lat = p.lastLatencyMs ? `${p.lastLatencyMs}ms` : 'Chưa đo';
        const keyCnt = `${getProfileKeySlots(id, p).length} key`;
        return [id, p.provider.toUpperCase(), p.model, keyCnt, status, isDef, lat];
      });
      renderTable(headers, rows);
    }

    section('THAO TÁC');
    choice('1', 'Chuyển Model Mặc Định', 'Chọn model chính dùng cho các tác vụ');
    choice('2', 'Thêm Model Mới', 'Cấu hình model thủ công hoặc từ Catalog');
    choice('3', 'Chi Tiết Model', 'Xem thông số kỹ thuật, capabilities & endpoint');
    choice('4', 'Kiểm Tra Kết Nối Model Này', 'Gửi ping test đo độ trễ');
    choice('5', 'Xóa Model', 'Xóa profile và credential khỏi hệ thống');
    choice('0', 'Quay lại', 'Trở về menu Model Center');

    const cmd = await promptInput('Lựa chọn (0–5)');
    if (cmd === '0') break;

    if (cmd === '1') {
      if (!profileIds.length) {
        warn('Chưa có profile nào');
        continue;
      }
      const target = await promptInput(`Nhập Profile ID muốn đặt làm mặc định (${profileIds.join(', ')})`);
      if (db.profiles[target]) {
        db.default = target;
        await saveProfilesDb(db);
        toast('success', `Đã đặt ${target} làm model mặc định!`);
      } else {
        warn('Profile ID không tồn tại');
      }
    } else if (cmd === '2') {
      await addNewModelWizard();
    } else if (cmd === '3') {
      const target = await promptInput(`Nhập Profile ID muốn xem (${profileIds.join(', ')})`);
      if (db.profiles[target]) {
        await viewModelDetails(target);
      } else {
        warn('Profile ID không tồn tại');
      }
    } else if (cmd === '4') {
      const target = await promptInput(`Nhập Profile ID muốn test (${profileIds.join(', ')})`);
      if (db.profiles[target]) {
        await runSingleTest(target, db.profiles[target]);
      } else {
        warn('Profile ID không tồn tại');
      }
    } else if (cmd === '5') {
      const target = await promptInput(`Nhập Profile ID muốn xóa (${profileIds.join(', ')})`);
      if (db.profiles[target]) {
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

  let catalogResult = await withSpinner(`Đang tải danh sách model ${meta.name}...`, async () => {
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
  const db = await readProfilesDb();
  const profile = db.profiles[profileId];
  if (!profile) {
    warn(`Không tìm thấy profile ${profileId}`);
    return;
  }

  header(`CHI TIẾT MODEL: ${profileId}`);
  renderBreadcrumb(['MODEL CENTER', 'MY MODELS', profileId]);

  const { capabilities: caps, capabilitySource, autoVisionRoutingAllowed } = inspectProfileCapabilityDetails(profile);
  const key = getModelKey(profileId);

  section('THÔNG TIN CẤU HÌNH');
  entry('PROFILE ID', profileId, 'aqua');
  entry('PROVIDER', profile.provider.toUpperCase(), 'purple');
  entry('MODEL ID', profile.model, 'green');
  entry('ENDPOINT', profile.endpoint || 'Mặc định nhà cung cấp', 'fg');
  entry('API KEY TRẠNG THÁI', key ? `ĐÃ LƯU (${maskApiKey(key)})` : 'CHƯA CÓ KEY', key ? 'green' : 'red');
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

  section('TRẠNG THÁI KIỂM THỬ (TEST STATUS)');
  entry('TRẠNG THÁI', profile.verifiedStatus || 'UNTESTED', profile.verifiedStatus === 'VERIFIED' ? 'green' : profile.verifiedStatus === 'FAILED' ? 'red' : 'orange');
  entry('LẦN TEST CUỐI', profile.lastTestedAt || 'Chưa test', 'muted');
  entry('ĐỘ TRỄ (LATENCY)', profile.lastLatencyMs ? `${profile.lastLatencyMs}ms` : 'N/A', 'cyan');

  section('LỰA CHỌN');
  choice('1', 'Kiểm tra kết nối (Ping Test)');
  choice('2', 'Đổi API Key cho profile này');
  choice('0', 'Quay lại');

  const act = await promptInput('Lựa chọn (0–2)');
  if (act === '1') {
    await runSingleTest(profileId, profile);
  } else if (act === '2') {
    info('Nhập API key mới (ký tự được ẩn hoàn toàn; lưu an toàn trong OS keyring):');
    try {
      const newKey = await promptSecret('  ❯ API key mới  ›  ', { allowEmpty: false, maskChar: '•' });
      if (newKey) {
        setModelKey(profileId, newKey);
        toast('success', 'Đã cập nhật API key trong Windows Credential Manager!');
      }
    } catch (e: any) {
      warn(e.message || 'Hủy nhập key');
    }
  }
}

// ─────────────────────────────────────────────────────────────
// TAB D: API KEY MANAGER
// ─────────────────────────────────────────────────────────────
export async function viewApiKeyManager(): Promise<void> {
  while (true) {
    const db = await readProfilesDb();
    header('MODEL CENTER  /  API KEY MANAGER (MULTI-KEY ROTATION)');
    renderBreadcrumb(['COMMAND DECK', 'MODEL CENTER', 'API KEY MANAGER']);

    info('Mọi API key được lưu mã hóa an toàn trong Windows Credential Manager.');
    info('Mỗi Profile có thể gắn nhiều API key (nhiều project/tài khoản khác nhau) để tự động xoay vòng.');

    const profileIds = Object.keys(db.profiles);
    section('DANH SÁCH KEY SLOT THEO PROFILE');

    if (!profileIds.length) {
      warn('Chưa có model profile nào để quản lý key.');
    } else {
      const headers = ['Profile ID', 'Key Slot', 'Provider', 'Model', 'Masked Key', 'Keyring Status'];
      const rows: string[][] = [];
      for (const id of profileIds) {
        const p = db.profiles[id];
        const slots = getProfileKeySlots(id, p);
        slots.forEach((slotId, sIdx) => {
          const key = getModelKey(slotId);
          const masked = key ? maskApiKey(key) : '[MISSING KEY]';
          const st = key ? 'PROTECTED (OS VAULT)' : 'CHƯA CÓ';
          const slotLabel = sIdx === 0 ? `${slotId} (Chính)` : `${slotId} (#${sIdx + 1})`;
          rows.push([id, slotLabel, p.provider.toUpperCase(), p.model, masked, st]);
        });
      }
      renderTable(headers, rows);
    }

    section('THAO TÁC');
    choice('1', 'Thêm API Key mới vào Profile (Xoay vòng nhiều key)', 'Gắn thêm key #2, #3... vào profile có sẵn');
    choice('2', 'Thay thế API Key của Profile / Slot');
    choice('3', 'Xóa 1 API Key Slot (hoặc key chính)');
    choice('4', 'Kiểm tra kết nối tất cả Key của Profile (Ping Test từng slot)');
    choice('5', 'Đo Thông Số & Hạn Mức Thời Gian Thực (RPM / TPM / RPD / Reset)');
    choice('0', 'Quay lại');

    const cmd = await promptInput('Lựa chọn (0–5)');
    if (cmd === '0') break;

    if (cmd === '1') {
      const target = await promptInput(`Nhập Profile ID (${profileIds.join(', ')})`, profileIds[0] || '');
      const prof = db.profiles[target];
      if (prof) {
        info(`Nhập 1 hoặc nhiều API key để thêm vào "${target}" (cách nhau bằng dấu phẩy hoặc khoảng trắng; lưu trong OS keyring):`);
        try {
          const rawInput = await promptSecret('  ❯ API key(s)  ›  ', { allowEmpty: false, maskChar: '•' });
          const keys = rawInput.split(/[\s,;]+/).map(k => k.trim()).filter(k => k.length >= 8);
          if (keys.length === 0) {
            warn('Không có API key hợp lệ nào được nhập.');
            continue;
          }
          const slots = getProfileKeySlots(target, prof);
          const existingSecrets = new Set(slots.map(s => (getModelKey(s) || '').trim()).filter(Boolean));
          let addedCount = 0;
          let skippedDup = 0;
          for (const k of keys) {
            if (existingSecrets.has(k)) {
              skippedDup++;
              continue;
            }
            const existingPrimary = getModelKey(target);
            let slotToUse: string;
            if (!existingPrimary && addedCount === 0) {
              slotToUse = target;
            } else {
              slotToUse = nextKeySlotId(target, slots);
              slots.push(slotToUse);
            }
            setModelKey(slotToUse, k);
            existingSecrets.add(k);
            addedCount++;
          }
          prof.keySlots = Array.from(new Set(slots));
          await saveProfilesDb(db);
          toast('success', `Đã thêm ${addedCount} API key vào ${target}${skippedDup > 0 ? ` (bỏ qua ${skippedDup} key trùng)` : ''} (Tổng: ${prof.keySlots.length} key)!`);
        } catch (e: any) {
          warn(e.message || 'Hủy nhập key');
        }
      } else {
        warn('Profile không tồn tại');
      }
    } else if (cmd === '2') {
      const target = await promptInput(`Nhập Profile ID hoặc Key Slot ID (${profileIds.join(', ')})`);
      const ownerId = db.profiles[target]
        ? target
        : profileIds.find(pid => getProfileKeySlots(pid, db.profiles[pid]).includes(target));
      if (ownerId) {
        info(`Nhập API key mới cho slot "${target}" (ký tự được ẩn hoàn toàn; lưu an toàn trong OS keyring):`);
        try {
          const newKey = await promptSecret('  ❯ API key mới  ›  ', { allowEmpty: false, maskChar: '•' });
          if (newKey) {
            setModelKey(target, newKey);
            toast('success', `Đã cập nhật API key cho ${target}!`);
          }
        } catch (e: any) {
          warn(e.message || 'Hủy nhập key');
        }
      } else {
        warn('Profile / Slot không tồn tại');
      }
    } else if (cmd === '3') {
      const target = await promptInput(`Nhập Profile ID hoặc Key Slot ID muốn xóa key (${profileIds.join(', ')})`);
      if (db.profiles[target]) {
        const slots = getProfileKeySlots(target, db.profiles[target]);
        for (const s of slots) deleteModelKey(s);
        db.profiles[target].keySlots = undefined;
        await saveProfilesDb(db);
        toast('success', `Đã xóa toàn bộ ${slots.length} key của ${target} khỏi OS keyring`);
      } else {
        const ownerId = profileIds.find(pid => getProfileKeySlots(pid, db.profiles[pid]).includes(target));
        if (ownerId) {
          deleteModelKey(target);
          const remaining = getProfileKeySlots(ownerId, db.profiles[ownerId]).filter(s => s !== target);
          db.profiles[ownerId].keySlots = remaining.length > 0 ? remaining : undefined;
          await saveProfilesDb(db);
          toast('success', `Đã gỡ slot ${target} khỏi ${ownerId}`);
        } else {
          warn('Profile / Slot không tồn tại');
        }
      }
    } else if (cmd === '4') {
      const target = await promptInput(`Nhập Profile ID muốn kiểm tra (${profileIds.join(', ')})`, profileIds[0] || '');
      if (db.profiles[target]) {
        await runSingleTest(target, db.profiles[target]);
      } else {
        warn('Profile không tồn tại');
      }
    } else if (cmd === '5') {
      const snap = getKeySlotTelemetrySnapshot();
      if (snap.length > 0) {
        renderTable(
          ['Profile / Slot', 'Model', 'RPM (60s)', 'TPM (60s)', 'Ngày (Req/Tok)', 'Cooldown'],
          snap.map(s => [
            s.keySlot === s.profileId ? s.profileId : `${s.profileId} (${s.keySlot})`,
            s.model,
            `${s.usedRpm60s}/${s.limits.rpm}`,
            `${s.usedTpm60s}/${s.limits.tpm}`,
            `${s.usedRpdToday} req / ${s.usedTokensToday} tok`,
            s.cooldownRemainingMs > 0 ? `${s.cooldownScope || 'COOL'} ${Math.ceil(s.cooldownRemainingMs / 1000)}s` : 'Sẵn sàng'
          ])
        );
      }
      const rep = await withSpinner('Đang đo trực tiếp thông số API & Quota từ Google AI...', () => checkGeminiProfilesQuota());
      console.log('\n' + formatQuotaReport(rep) + '\n');
      await promptInput('Nhấn Enter để tiếp tục', '');
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

    info('Cơ chế Auto-Switch: Tự động chuyển model khi timeout, 429 rate limit, 500/503 server error hoặc mạng.');
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
      const target = await promptInput(`Chọn Profile ID làm model chính (${available.join(', ')})`);
      if (db.profiles[target]) {
        db.default = target;
        await saveProfilesDb(db);
        toast('success', `Đã đặt ${target} làm model chính!`);
      }
    } else if (cmd === '2') {
      const target = await promptInput(`Chọn Profile ID làm fallback (${available.join(', ')})`);
      if (db.profiles[target]) {
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
      const target = await promptInput(`Nhập Profile ID muốn gỡ khỏi fallback (${(db.fallbacks || []).join(', ')})`);
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

  const profileId = await promptInput('Đặt Profile ID đại diện (chữ, số, gạch ngang/dưới, VD: gpt4o-main, gemini-fast)', presetModelId ? presetModelId.replace(/[^a-zA-Z0-9_-]/g, '-') : 'my-model');
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(profileId)) {
    fail('Profile ID không hợp lệ');
    return;
  }

  let provider = presetProvider;
  if (!provider) {
    const provInput = await promptInput('Chọn Provider (1: openai, 2: gemini, 3: anthropic, 4: groq, 5: custom)', '1');
    const mapping: Record<string, ProviderId> = { '1': 'openai', '2': 'gemini', '3': 'anthropic', '4': 'groq', '5': 'custom' };
    provider = mapping[provInput] || 'openai';
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

  const defaultSuggestion = provider === 'gemini' ? 'gemini-3.1-flash-lite' : 'gpt-4o';
  const rawModelId = presetModelId || (await promptInput(`Nhập Model ID chính xác của ${meta.name}`, defaultSuggestion));
  if (!rawModelId) {
    fail('Model ID không được để trống');
    return;
  }
  const modelId = normalizeModelSlug(provider, rawModelId);
  if (modelId !== rawModelId.trim()) {
    info(`Tự động chuẩn hóa Model ID: "${rawModelId}" -> "${modelId}"`);
  }

  let key = presetKey || '';
  if (!key) {
    info('Nhập API key (ký tự được ẩn hoàn toàn; lưu an toàn trong OS keyring, Enter để bỏ qua):');
    try {
      key = await promptSecret('  ❯ API key  ›  ', { allowEmpty: true, maskChar: '•' });
    } catch {
      key = '';
    }
  }

  if (key) {
    setModelKey(profileId, key);
  } else {
    warn('Chưa nhập key; hãy thêm key trong API Key Manager trước khi sử dụng.');
  }

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
  toast('success', `Đã lưu profile ${profileId} (${modelId}) thành công!`);

  const testNow = await promptInput('Bạn có muốn kiểm tra kết nối ngay không? (Y/n)', 'y');
  if (testNow.toLowerCase() !== 'n') {
    await runSingleTest(profileId, db.profiles[profileId]);
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN MODEL CENTER MENU
// ─────────────────────────────────────────────────────────────
export async function runModelCenter(): Promise<void> {
  await loadTheme();
  while (true) {
    const db = await readProfilesDb();
    header('MODEL CENTER  /  AI MANAGEMENT CONSOLE');
    renderBreadcrumb(['COMMAND DECK', 'MODEL CENTER']);

    const routePlan = getRoutePlan(db);
    section('TỔNG QUAN HỆ THỐNG AI');
    entry('MODEL CHÍNH (PRIMARY)', routePlan.primary ? `${routePlan.primary} (${db.profiles[routePlan.primary]?.model || 'model'})` : 'CHƯA CẤU HÌNH', routePlan.primary ? 'green' : 'red');
    entry('SỐ MODEL PROFILE', `${Object.keys(db.profiles).length} profile(s)`, 'cyan');
    entry('FALLBACKS ĐÃ GÁN', `${routePlan.fallbacks.length} fallback(s)`, routePlan.fallbacks.length ? 'aqua' : 'orange');

    section('CÁC PHÂN HỆ QUẢN LÝ');
    choice('A', 'My Models', 'Quản lý danh sách model đã cấu hình, CRUD & đổi mặc định');
    choice('B', 'Available Models', 'Duyệt Catalog, tìm kiếm, phân trang & lấy model từ API');
    choice('C', 'Model Details', 'Xem chi tiết Vision, Context Window & Task Support');
    choice('D', 'API Key Manager', 'Quản lý API key trong Windows Credential Vault');
    choice('E', 'Model Routing', 'Thiết lập model chính và chuỗi fallback tự động');
    choice('F', 'Test Connection', 'Gửi ping test tối thiểu, đo latency & chẩn đoán lỗi');
    choice('0', 'Quay lại Command Deck');

    const sel = (await promptInput('Chọn phân hệ (A–F hoặc 0)')).toUpperCase();
    if (sel === '0') break;

    if (sel === 'A' || sel === '1') await viewMyModels();
    else if (sel === 'B' || sel === '2') await viewAvailableModels();
    else if (sel === 'C' || sel === '3') {
      const pids = Object.keys(db.profiles);
      if (!pids.length) warn('Chưa có profile nào');
      else {
        const id = await promptInput(`Nhập Profile ID (${pids.join(', ')})`, pids[0]);
        if (db.profiles[id]) await viewModelDetails(id);
      }
    } else if (sel === 'D' || sel === '4') await viewApiKeyManager();
    else if (sel === 'E' || sel === '5') await viewModelRouting();
    else if (sel === 'F' || sel === '6') await testAllConnections();
    else warn('Lựa chọn không hợp lệ; vui lòng nhập A, B, C, D, E, F hoặc 0.');
  }
}

if (process.argv[1] && /(?:^|[\\/])model-center-cli\.(?:ts|js)$/.test(process.argv[1])) {
  void runModelCenter();
}
