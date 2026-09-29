import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState } from '../src/engine.mjs';
import {
  createInteractionState,
  processPersistedMessage,
  settlePendingClassifiedSettlement,
  validateInteractionState,
} from '../src/interaction-runtime.mjs';
import { loadConfig } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = Date.parse('2026-09-28T08:00:00.000Z');
const baseConfig = await loadConfig(path.join(ROOT, 'config/default.json'));

function config() {
  const value = structuredClone(baseConfig);
  value.chatStimulusEnabled = true;
  value.arousalEnabled = true;
  value.arousalDriveSettlementEnabled = true;
  return value;
}

function state(libido = 0) {
  const active = config();
  const desireState = createInitialState(active, START);
  desireState.drives.libido = libido;
  return {
    config: active,
    desireState,
    interactionState: createInteractionState(START),
  };
}

function message(content, id, at, values = {}) {
  return {
    source: 'synthetic-v099',
    conversationId: 'conversation-v099',
    providerMessageId: id,
    parentMessageId: values.role === 'assistant' ? values.parentMessageId ?? 'user-root' : null,
    role: 'user',
    status: 'complete',
    persisted: true,
    final: true,
    cancelled: false,
    completedAt: at,
    content,
    ...values,
  };
}

function process(current, content, id, at, values = {}) {
  return processPersistedMessage({
    ...current,
    message: message(content, id, at, values),
  });
}

function continueFrom(current, result) {
  return {
    config: current.config,
    desireState: result.desireState,
    interactionState: result.interactionState,
  };
}

test('Chinese sexual hierarchy is mutually exclusive and numerically bounded', () => {
  const cases = [
    ['neutral_discussion', '我在讨论医学文章里的高潮概念。', 0],
    ['flirt_tease', '老婆，你今天真勾人，把我撩得心痒。', 0.020],
    ['direct_desire', '老婆，我现在想要你，身体已经有反应了。', 0.050],
    ['sexual_explicit', '老婆，我现在想做爱。', 0.080],
    ['concrete_intimate_action', '老婆，我正在吻你。', 0.080],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [expectedClass, text, libido] = cases[index];
    const initial = state();
    const result = process(initial, text, `class-${index}`, START + index + 1);
    assert.equal(result.interpreted.sexualClass, expectedClass);
    assert.ok(Math.abs(result.desireState.drives.libido - libido) < 1e-12);
    if (expectedClass === 'neutral_discussion') {
      assert.equal(result.interactionState.arousal.value, 0);
    } else {
      assert.ok(result.interactionState.arousal.value > 0);
    }
  }
});

test('single sensitive words, negation, hypotheses, future plans, questions, and quotes are neutral', () => {
  const samples = [
    '我进入了会议，随后摸着键盘完成系统设计。',
    '我摸着键盘对你解释这次测试。',
    '我没有在摸你，也不想进入任何亲密状态。',
    '如果以后我们高潮了会怎样？',
    '明天计划讨论射精和高潮的健康知识。',
    '> “我刚刚高潮了。”',
    '她说自己刚刚高潮了。',
  ];
  let current = state();
  for (let index = 0; index < samples.length; index += 1) {
    const result = process(current, samples[index], `neutral-${index}`, START + index + 1);
    assert.equal(result.interpreted.sexualClass, 'neutral_discussion');
    assert.equal(result.interpreted.settlementType, null);
    assert.equal(result.desireState.drives.libido, 0);
    assert.equal(result.interactionState.arousal.value, 0);
    current = continueFrom(current, result);
  }
});

test('continuous explicit messages rise gradually but obey the one-hour libido cap', () => {
  let current = state();
  for (let index = 0; index < 8; index += 1) {
    const result = process(
      current,
      `老婆，我们现在想做爱，继续这段亲密 ${index}。`,
      `explicit-${index}`,
      START + index * 1000 + 1,
    );
    current = continueFrom(current, result);
  }
  assert.ok(current.desireState.drives.libido <= 0.24);
  assert.ok(current.desireState.drives.libido > 0.23);
  assert.ok(current.interactionState.arousal.value > 0);
  assert.ok(current.interactionState.arousal.value <= 1);
});

test('concrete passive contact remains capped and concrete active actions use body formula', () => {
  let current = state(1);
  for (let index = 0; index < 100; index += 1) {
    const result = process(
      current,
      '老婆，我正贴着你，紧紧抱住你。',
      `passive-${index}`,
      START + index + 1,
    );
    current = continueFrom(current, result);
  }
  assert.ok(current.interactionState.arousal.value <= current.config.arousal.passiveContactCap);
  const active = process(current, '老婆，我正抚摸着你的阴蒂。', 'active', START + 200);
  assert.ok(active.interactionState.arousal.value > current.interactionState.arousal.value);
  assert.ok(active.interactionState.arousal.value <= 1);
});

const settlements = [
  ['partnered_no_release', '老婆，我刚才亲密结束了，但我没有高潮。', 0.80, false],
  ['partnered_release', '老婆，我刚才做爱结束了，我也高潮了。', 0.30, true],
  ['solo_no_release', '我刚刚自己解决完了，但没有高潮。', 0.80, false],
  ['solo_release', '我刚刚自己解决完了，也高潮了。', 0.38, true],
];

for (const [type, text, factor, releases] of settlements) {
  test(`${type} is reachable, proportional, and exclusive`, () => {
    const initial = state(0.80);
    const staged = process(initial, text, `settle-${type}`, START + 1);
    assert.equal(staged.interpreted.settlementType, type);
    assert.equal(staged.desireState.drives.libido, 0.80);
    assert.equal(staged.interactionState.arousal.value, 0);
    assert.ok(staged.settlementReceipt);
    const settled = settlePendingClassifiedSettlement({
      desireState: staged.desireState,
      interactionState: staged.interactionState,
      config: initial.config,
    });
    assert.ok(Math.abs(settled.desireState.drives.libido - 0.80 * factor) < 1e-12);
    assert.equal(settled.interactionState.chat.pendingSettlementReceipt, null);
    const fact = settled.interactionState.chat.settlementFacts[0];
    assert.equal(fact.type, type);
    assert.equal(fact.result.libidoBefore, 0.80);
    assert.equal(fact.result.libidoAfter, settled.desireState.drives.libido);
    assert.equal(fact.result.arousalBefore, staged.interactionState.arousal.value);
    assert.equal(fact.result.arousalAfter, settled.interactionState.arousal.value);
    assert.equal(fact.result.receiptStatus, 'settled');
    assert.equal(fact.result.settled, true);
    assert.equal(fact.result.duplicateIgnored, false);
    assert.equal(settled.interactionState.arousal.refractoryUntil !== null, releases);
    assert.equal(settled.desireState.solo.refractoryUntil !== null, type === 'solo_release');
  });
}

test('discussion of climax is neutral while a completed related event settles', () => {
  const initial = state(0.80);
  const discussion = process(initial, '我在讨论高潮的健康知识。', 'discussion', START + 1);
  assert.equal(discussion.interpreted.settlementType, null);
  assert.equal(discussion.desireState.drives.libido, 0.80);
  const completed = process(
    continueFrom(initial, discussion),
    '老婆，我们刚才做爱结束了，我高潮了。',
    'completed',
    START + 2,
  );
  assert.equal(completed.interpreted.settlementType, 'partnered_release');
});

test('assistant restatement upgrades one fact once without stacking settlement', () => {
  const initial = state(0.80);
  const user = process(
    initial,
    '老婆，我们刚才亲密结束了，但我没有高潮。',
    'fact-user',
    START + 1,
  );
  const first = settlePendingClassifiedSettlement({
    desireState: user.desireState,
    interactionState: user.interactionState,
    config: initial.config,
  });
  const assistant = process({
    config: initial.config,
    desireState: first.desireState,
    interactionState: first.interactionState,
  }, '你和我刚才做爱结束了，你后来高潮了。', 'fact-assistant', START + 2, {
    role: 'assistant', parentMessageId: 'fact-user',
  });
  assert.equal(assistant.interpreted.settlementType, 'partnered_release');
  const upgraded = settlePendingClassifiedSettlement({
    desireState: assistant.desireState,
    interactionState: assistant.interactionState,
    config: initial.config,
  });
  assert.ok(Math.abs(upgraded.desireState.drives.libido - 0.80 * 0.30) < 1e-12);
  assert.equal(upgraded.interactionState.chat.settlementFacts.length, 1);
  assert.equal(upgraded.interactionState.chat.settlementFacts[0].type, 'partnered_release');
  assert.ok(upgraded.interactionState.arousal.refractoryUntil);
  const duplicate = process({
    config: initial.config,
    desireState: upgraded.desireState,
    interactionState: upgraded.interactionState,
  }, '你和我刚才做爱结束了，你高潮了。', 'fact-duplicate', START + 3, {
    role: 'assistant', parentMessageId: 'fact-user',
  });
  assert.equal(duplicate.interactionState.chat.pendingSettlementReceipt, null);
  assert.equal(duplicate.interactionState.chat.settlementFacts.length, 1);
  assert.equal(duplicate.interactionState.chat.settlementFacts[0].result.duplicateIgnored, true);
});

test('an affirmative release in a mixed partnered report outranks no-release wording', () => {
  const initial = state(0.80);
  const staged = process(
    initial,
    '老婆，我们刚才做爱结束了，我没有高潮，但你高潮了。',
    'mixed-partnered-release',
    START + 1,
  );
  assert.equal(staged.interpreted.settlementType, 'partnered_release');
  const settled = settlePendingClassifiedSettlement({
    desireState: staged.desireState,
    interactionState: staged.interactionState,
    config: initial.config,
  });
  assert.ok(Math.abs(settled.desireState.drives.libido - 0.80 * 0.30) < 1e-12);
  assert.ok(settled.interactionState.arousal.refractoryUntil);
});

test('disabled settlement gate never leaves a receipt for later retroactive application', () => {
  const initial = state(0.80);
  initial.config.arousalDriveSettlementEnabled = false;
  const result = process(
    initial,
    '老婆，我们刚才做爱结束了，我高潮了。',
    'disabled-settlement',
    START + 1,
  );
  assert.equal(result.interpreted.settlementType, 'partnered_release');
  assert.equal(result.interactionState.chat.pendingSettlementReceipt, null);
  assert.equal(result.desireState.drives.libido, 0.80);
  assert.equal(result.status, 'no_op');
});

test('receipt crash replay applies the effect once and clears the receipt', () => {
  const initial = state(0.80);
  const staged = process(
    initial,
    '老婆，我们刚才做爱结束了，我高潮了。',
    'crash',
    START + 1,
  );
  const first = settlePendingClassifiedSettlement({
    desireState: staged.desireState,
    interactionState: staged.interactionState,
    config: initial.config,
  });
  const replay = settlePendingClassifiedSettlement({
    desireState: first.desireState,
    interactionState: staged.interactionState,
    config: initial.config,
  });
  assert.equal(replay.applied, false);
  assert.equal(replay.desireState.drives.libido, first.desireState.drives.libido);
  assert.equal(replay.interactionState.chat.pendingSettlementReceipt, null);
  assert.equal(replay.interactionState.chat.settlementFacts.length, 1);
  assert.ok(replay.interactionState.arousal.refractoryUntil);
  const legacy = structuredClone(first.interactionState);
  delete legacy.chat.settlementFacts[0].result;
  validateInteractionState(legacy, initial.config);
  assert.equal(legacy.chat.settlementFacts[0].result, null);
});

test('v0.9.8 interaction state migrates without losing its old ledgers', () => {
  const active = config();
  const legacy = createInteractionState(START);
  delete legacy.chat.settlementFacts;
  delete legacy.chat.pendingSettlementReceipt;
  legacy.chat.processedEvents.push({
    eventId: `event-${'a'.repeat(64)}`,
    types: ['sexual_explicit'],
    deltas: { libido: 0.08 },
    at: { iso: new Date(START).toISOString(), epochMs: START },
    labels: ['sexual_explicit'],
  });
  const migrated = validateInteractionState(legacy, active);
  assert.deepEqual(migrated.chat.settlementFacts, []);
  assert.equal(migrated.chat.pendingSettlementReceipt, null);
  assert.equal(migrated.chat.processedEvents[0].sexualClass, 'sexual_explicit');
});
