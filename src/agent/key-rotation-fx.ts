/** Shared key-rotation telemetry tracker and terminal spin animation bridge for agent LLM calls. */
import type { AgentContext } from './types.js';
import type { KeyRotationEvent } from '../model-center/model-router.js';
import { animateKeyRotation } from '../ui/tokyo.js';

export function getLastActiveKeySlot(ctx: AgentContext): string | undefined {
  const val = ctx.collectedFindings['lastActiveKeySlot'];
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

export function recordLastActiveKeySlot(
  ctx: AgentContext,
  res?: { keySlotUsed?: string; finalProfile?: string }
): void {
  const active = res?.keySlotUsed || res?.finalProfile;
  if (typeof active === 'string' && active.trim()) {
    ctx.collectedFindings['lastActiveKeySlot'] = active.trim();
  }
}

export async function handleAgentKeyRotation(
  ctx: AgentContext,
  event: KeyRotationEvent
): Promise<void> {
  if (event.toSlot) {
    ctx.collectedFindings['lastActiveKeySlot'] = event.toSlot;
  }
  if (!ctx.config.verbose) return;
  await animateKeyRotation({
    from: event.from,
    to: event.to,
    reason: event.reason,
    slotIndex: event.slotIndex,
    totalSlots: event.totalSlots,
    mode: event.mode
  });
}
