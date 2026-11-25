/** Shared API key pool operations across profiles & keyring slots (no plaintext secrets stored in JSON). */
import { readProfilesDb, saveProfilesDb, getProfileKeySlots, nextKeySlotId } from './routing.js';
import { setModelKey, getModelKey, deleteModelKey } from './keyring.js';
import type { ModelProfilesDb } from './types.js';

export interface KeyManagerIoOptions {
  dbPath?: string;
  setKeyFn?: (slotId: string, apiKey: string) => void;
  getKeyFn?: (slotId: string) => string | null;
  deleteKeyFn?: (slotId: string) => void;
}

/** Splits raw user input (comma, semicolon, whitespace, newline) into candidate API keys. */
export function parseApiKeyList(rawKeys: string | string[]): string[] {
  const tokens = Array.isArray(rawKeys)
    ? rawKeys
    : String(rawKeys || '').split(/[\s,;]+/);
  return Array.from(new Set(tokens.map(k => k.trim()).filter(k => k.length >= 10)));
}

/** Appends 1 or more API keys into an existing profile's keyring slots for balanced rotation. */
export async function addApiKeysToProfile(
  targetProfileId: string,
  rawKeys: string | string[],
  options?: KeyManagerIoOptions
): Promise<{ profileId: string; addedSlots: string[]; skippedDuplicates: number; totalSlots: number }> {
  const rawTokens = Array.isArray(rawKeys) ? rawKeys : String(rawKeys || '').split(/[\s,;]+/);
  const keys = rawTokens.map(k => k.trim()).filter(k => k.length >= 10);
  if (keys.length === 0) {
    throw new Error('Không có API key hợp lệ để thêm.');
  }

  const db = await readProfilesDb(options?.dbPath);
  const prof = db.profiles[targetProfileId];
  if (!prof) {
    throw new Error(`Không tìm thấy profile "${targetProfileId}" trong Model Center.`);
  }

  const setKeyFn = options?.setKeyFn || setModelKey;
  const getKeyFn = options?.getKeyFn || getModelKey;
  const slots = getProfileKeySlots(targetProfileId, prof);
  const existingSecrets = new Set(
    slots.map(s => (getKeyFn(s) || '').trim()).filter(Boolean)
  );
  const addedSlots: string[] = [];
  let skippedDuplicates = 0;

  for (const apiKey of keys) {
    if (existingSecrets.has(apiKey)) {
      skippedDuplicates++;
      continue;
    }
    const primaryOccupied = Boolean(getKeyFn(targetProfileId)?.trim());
    let slotId: string;
    if (!primaryOccupied && addedSlots.length === 0) {
      slotId = targetProfileId;
    } else {
      slotId = nextKeySlotId(targetProfileId, slots);
      slots.push(slotId);
    }
    setKeyFn(slotId, apiKey);
    existingSecrets.add(apiKey);
    addedSlots.push(slotId);
  }

  prof.keySlots = Array.from(new Set(slots));
  // If profile previously failed due to missing/bad key, lift FAILED gate so router/tester can evaluate new keys
  if (addedSlots.length > 0 && prof.verifiedStatus === 'FAILED') {
    prof.verifiedStatus = 'UNTESTED';
  }
  await saveProfilesDb(db, options?.dbPath);
  return {
    profileId: targetProfileId,
    addedSlots,
    skippedDuplicates,
    totalSlots: prof.keySlots.length
  };
}

/** Replaces the API key stored in an existing profile or key slot. */
export async function replaceApiKeyInSlot(
  profileOrSlotId: string,
  newApiKey: string,
  options?: KeyManagerIoOptions
): Promise<{ profileId: string; slotId: string }> {
  const cleanKey = String(newApiKey || '').trim();
  if (cleanKey.length < 10) {
    throw new Error('API key mới quá ngắn hoặc không hợp lệ.');
  }
  const db = await readProfilesDb(options?.dbPath);
  const profileIds = Object.keys(db.profiles);
  const ownerId = db.profiles[profileOrSlotId]
    ? profileOrSlotId
    : profileIds.find(pid => getProfileKeySlots(pid, db.profiles[pid]).includes(profileOrSlotId));

  if (!ownerId) {
    throw new Error(`Không tìm thấy profile hoặc key slot "${profileOrSlotId}".`);
  }

  const setKeyFn = options?.setKeyFn || setModelKey;
  setKeyFn(profileOrSlotId, cleanKey);
  if (db.profiles[ownerId].verifiedStatus === 'FAILED') {
    db.profiles[ownerId].verifiedStatus = 'UNTESTED';
    await saveProfilesDb(db, options?.dbPath);
  }
  return { profileId: ownerId, slotId: profileOrSlotId };
}

/** Removes either all key slots of a profile or a single secondary slot from OS vault & JSON metadata. */
export async function removeApiKeySlotFromProfile(
  profileOrSlotId: string,
  options?: KeyManagerIoOptions
): Promise<{ profileId: string; removedSlots: string[]; remainingSlots: number }> {
  const db = await readProfilesDb(options?.dbPath);
  const deleteKeyFn = options?.deleteKeyFn || deleteModelKey;

  if (db.profiles[profileOrSlotId]) {
    const slots = getProfileKeySlots(profileOrSlotId, db.profiles[profileOrSlotId]);
    for (const s of slots) deleteKeyFn(s);
    db.profiles[profileOrSlotId].keySlots = undefined;
    await saveProfilesDb(db, options?.dbPath);
    return { profileId: profileOrSlotId, removedSlots: slots, remainingSlots: 0 };
  }

  const profileIds = Object.keys(db.profiles);
  const ownerId = profileIds.find(pid => getProfileKeySlots(pid, db.profiles[pid]).includes(profileOrSlotId));
  if (!ownerId) {
    throw new Error(`Không tìm thấy profile hoặc key slot "${profileOrSlotId}".`);
  }

  deleteKeyFn(profileOrSlotId);
  const remaining = getProfileKeySlots(ownerId, db.profiles[ownerId]).filter(s => s !== profileOrSlotId);
  db.profiles[ownerId].keySlots = remaining.length > 0 ? remaining : undefined;
  await saveProfilesDb(db, options?.dbPath);
  return { profileId: ownerId, removedSlots: [profileOrSlotId], remainingSlots: remaining.length };
}

/** Counts configured key slots across all profiles without reading secrets. */
export function countTotalProfileKeySlots(db: ModelProfilesDb): number {
  return Object.entries(db.profiles || {}).reduce((acc, [id, prof]) => {
    return acc + getProfileKeySlots(id, prof).length;
  }, 0);
}
