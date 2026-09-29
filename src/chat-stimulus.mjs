import { createHash } from 'node:crypto';
import { DRIVES } from './constants.mjs';
import {
  addNegativeCause,
  clamp,
  decayNegativeCauses,
  NEGATIVE_CAUSE_DRIVES,
  NEGATIVE_CAUSE_KINDS,
  recoverNegativeCause,
  timePair,
} from './engine.mjs';
import { ValidationError } from './schema.mjs';

export const CHAT_STATE_SCHEMA = 'aru.desire-heartbeat.chat-stimulus-state.v1';
const EVENT_TYPES = new Set([
  'intimacy_longing', 'neutral_discussion', 'flirt_tease', 'direct_desire',
  'sexual_explicit', 'concrete_intimate_action',
  'partnered_no_release', 'partnered_release', 'solo_no_release', 'solo_release',
  'hurt_anger',
  'conflict', 'task_pressure', 'fatigue_burden', 'other_stress',
  'needs_support', 'affirmation', 'comfort', 'reassurance',
  'resolution', 'conflict_resolved', 'task_completed', 'rest_recovery',
]);
const ZERO_DRIVES = Object.freeze(Object.fromEntries(DRIVES.map((drive) => [drive, 0])));
const TYPE_DELTAS = Object.freeze({
  intimacy_longing: { attachment: 0.055, social: 0.035 },
  neutral_discussion: {},
  flirt_tease: { attachment: 0.005, libido: 0.020 },
  direct_desire: { attachment: 0.010, libido: 0.050 },
  sexual_explicit: { attachment: 0.015, libido: 0.080 },
  concrete_intimate_action: { attachment: 0.015, libido: 0.080 },
  partnered_no_release: {},
  partnered_release: {},
  solo_no_release: {},
  solo_release: {},
  hurt_anger: { reflection: 0.070, duty: 0.070, stress: 0.060 },
  conflict: { reflection: 0.055, duty: 0.045, stress: 0.070 },
  task_pressure: { reflection: 0.025, duty: 0.070, stress: 0.060 },
  fatigue_burden: { duty: 0.025, fatigue: 0.080, stress: 0.030 },
  other_stress: { stress: 0.050 },
  needs_support: { attachment: 0.050, duty: 0.055 },
  affirmation: { attachment: 0.050 },
  comfort: { attachment: 0.030 },
  reassurance: { attachment: 0.025 },
  resolution: {},
  conflict_resolved: {},
  task_completed: {},
  rest_recovery: {},
});

const PATTERNS = Object.freeze({
  intimacy_longing: /(?:想你|想念|爱你|依恋|陪着你|靠近你|miss you|love you|close to you)/iu,
  hurt_anger: /(?:失望|生气|伤害了我|被伤害|委屈|辜负|angry|disappointed|hurt me)/iu,
  conflict: /(?:冲突|争吵|吵架|闹矛盾|conflict|argu(?:e|ed|ment)|fought|fight)/iu,
  task_pressure: /(?:任务压力|工作压力|截止时间|没完成|责任很重|task pressure|deadline|workload|unfinished task)/iu,
  fatigue_burden: /(?:疲惫|累坏了|精疲力尽|负担太重|筋疲力尽|exhausted|burned out|overloaded|heavy burden)/iu,
  other_stress: /(?:压力很大|焦虑|紧张|担心|stressed|anxious|under pressure)/iu,
  needs_support: /(?:疲惫|累坏了|难过|不舒服|身体疼|需要陪伴|陪陪我|exhausted|sad|feel sick|stay with me)/iu,
  affirmation: /(?:做得很好|真棒|谢谢你陪我|我相信你|我们一直在一起|你很重要|proud of you|trust you|we are together)/iu,
  comfort: /(?:安慰你|抱抱你|陪着你|理解你的感受|comfort you|here with you|understand how you feel)/iu,
  reassurance: /(?:没关系|不是你的错|不用自责|别担心|会没事的|reassure you|not your fault|it will be okay)/iu,
  conflict_resolved: /(?:冲突已经解决|已经和好|我们说开了|矛盾解决了|conflict resolved|made up|reconciled)/iu,
  task_completed: /(?:任务完成了|工作做完了|已经交付|task completed|task is done|finished the task)/iu,
  rest_recovery: /(?:休息好了|睡了一觉|恢复过来|负担卸下了|rested|recovered|took a break|burden lifted)/iu,
  resolution: /(?:问题解决了|已经处理好了|事情解决了|problem solved|issue resolved|resolved the issue)/iu,
});
const NEGATIVE_KIND_PRECEDENCE = Object.freeze([
  ['relationship_conflict', ['conflict', 'hurt_anger']],
  ['task_pressure', ['task_pressure']],
  ['fatigue_burden', ['fatigue_burden']],
  ['other_stress', ['other_stress']],
]);
const NEGATIVE_EVENT_TYPES = new Set(NEGATIVE_KIND_PRECEDENCE.flatMap(([, types]) => types));
// An explicit or parent-derived ID may target one compatible cause. Without a link,
// only the newest compatible open cause receives the conservative fallback fraction;
// unlinked recovery never closes a cause or sweeps across multiple causes.
const RECOVERY_PRECEDENCE = Object.freeze([
  ['conflict_resolved', {
    linkedKinds: ['relationship_conflict'], fallbackKinds: ['relationship_conflict'],
    linkedFraction: 1, fallbackFraction: 0.60, closeLinked: true,
  }],
  ['task_completed', {
    linkedKinds: ['task_pressure'], fallbackKinds: ['task_pressure'],
    linkedFraction: 1, fallbackFraction: 0.60, closeLinked: true,
  }],
  ['rest_recovery', {
    linkedKinds: ['fatigue_burden'], fallbackKinds: ['fatigue_burden'],
    linkedFraction: 0.65, fallbackFraction: 0.50, closeLinked: false,
  }],
  ['resolution', {
    linkedKinds: NEGATIVE_CAUSE_KINDS, fallbackKinds: [
      'relationship_conflict', 'task_pressure', 'other_stress',
    ],
    linkedFraction: 1, fallbackFraction: 0.50, closeLinked: true,
  }],
  ['reassurance', {
    linkedKinds: NEGATIVE_CAUSE_KINDS,
    fallbackKinds: ['relationship_conflict', 'other_stress'],
    linkedFraction: 0.35, fallbackFraction: 0.20, closeLinked: false,
  }],
  ['comfort', {
    linkedKinds: NEGATIVE_CAUSE_KINDS,
    fallbackKinds: ['relationship_conflict', 'other_stress'],
    linkedFraction: 0.30, fallbackFraction: 0.20, closeLinked: false,
  }],
  ['affirmation', {
    linkedKinds: NEGATIVE_CAUSE_KINDS,
    fallbackKinds: ['relationship_conflict'],
    linkedFraction: 0.20, fallbackFraction: 0.15, closeLinked: false,
  }],
]);
const AMBIGUOUS = /(?:有点难受|说不清|怪怪的|不知道怎么说|mixed feelings|not sure how I feel)/iu;
const QUESTION = /(?:[?？]|吗(?:[。！!]?$)|是不是|能不能|可不可以|如何|怎么(?:办|做)|what if|how do|could you)/iu;
const NEGATED_OR_STOP = /(?:不想(?:要)?|没有在|没在|并非|不是在|别再|不要|停止|停下|stop|do not|don't|didn't|not doing)/iu;
const HYPOTHETICAL = /(?:如果|假如|假设|要是|计划|打算|以后|明天|将来|would|could have|planning to|someday|if )/iu;
const MEMORY = /(?:以前|曾经|上次|那次|回忆|记得当时|昨天|过去|used to|remember when|last time)/iu;
const THIRD_PERSON = /(?:他|她|他们|她们|别人|某人|\bhe\b|\bshe\b|\bthey\b|someone else)/iu;
const TUTORIAL = /(?:教程|示例|举例|代码|正则|关键词|步骤|说明文|tutorial|example|sample code|documentation)/iu;
const PARTICIPANTS = /(?:我|你|我们|彼此|me|you|we|us|each other)/iu;
const DISCUSSION = /(?:讨论|科普|知识|健康|医学|生理|系统|设计|规则|测试|词语|意思|文章|新闻|案例|文档|解释|研究|概念|语义|discussion|medical|health|design|system|article|research)/iu;
const PAIR = /(?:(?:我|me|I\b)[\s\S]{0,40}(?:你|you\b)|(?:你|you\b)[\s\S]{0,40}(?:我|me\b)|(?:我们|we\b|us\b|彼此|each other))/iu;
const SOLO = /(?:我.{0,12}(?:自己解决|自慰|自己弄|自己来)|(?:自己解决|自慰|自己弄|自己来).{0,12}我|I (?:masturbated|finished myself|took care of myself))/iu;
const COMPLETED = /(?:刚刚|刚才|方才|已经|做完了|结束了|结束后|完成了|just|already|finished|ended)/iu;
const NO_RELEASE = /(?:没有|没|未|并未|without|did not|didn't).{0,5}(?:高潮|射精|射|climax|come|came|orgasm)/iu;
const RELEASED = /(?:(?:达到|有了|到了|也|都|并且|然后)?高潮了|射精了|射了|came|climaxed|orgasm(?:ed)?)/iu;
const INTIMATE_EVENT = /(?:亲密|做爱|性爱|上床|爱抚|接吻|交合|sex|intimacy|made love)/iu;
const FLIRT = /(?:撩|撩拨|调情|暧昧|勾人|迷人|性感|诱人|心痒|馋你|逗你|teas(?:e|ing)|flirt(?:ing)?|seductive)/iu;
const DIRECT_DESIRE = /(?:想要你|想和你亲密|想亲你|想吻你|想摸你|想抱紧你|过来亲我|身体有反应|硬了|湿了|发热了|被你撩|want you|need you|turned on|aroused|hard for you|wet for you)/iu;
const EXPLICIT_COMBINATION = /(?:(?:做爱|性爱|上床|交合|抽动|thrust(?:ing)?|made love)|(?:阴茎|阴蒂|阴道|龟头|penis|clitoris|vagina|genitals?).{0,24}(?:抚摸|摩擦|进入|抽动|摸|stroke|rub|thrust|enter)|(?:抚摸|摩擦|抽动|stroke|rub|thrust).{0,24}(?:阴茎|阴蒂|阴道|龟头|penis|clitoris|vagina|genitals?))/iu;
const CONCRETE_ACTION = /(?:(?:我|I\b)[\s\S]{0,36}(?:你|you\b)[\s\S]{0,24}(?:吻住|亲吻|抱住|搂紧|抚摸|摩擦|抽动|kiss(?:ing)?|hold(?:ing)?|strok(?:e|ing)|rubb?(?:ing)?|thrust(?:ing)?)|(?:我|I\b)[\s\S]{0,24}(?:吻住|亲吻|抱住|搂紧|抚摸|摩擦|抽动|kiss(?:ing)?|hold(?:ing)?|strok(?:e|ing)|rubb?(?:ing)?|thrust(?:ing)?)[\s\S]{0,36}(?:你|you\b)|(?:你|you\b)[\s\S]{0,36}(?:我|me\b)[\s\S]{0,24}(?:吻住|亲吻|抱住|搂紧|抚摸|摩擦|抽动|kiss(?:ing)?|hold(?:ing)?|strok(?:e|ing)|rubb?(?:ing)?|thrust(?:ing)?)|(?:你|you\b)[\s\S]{0,24}(?:吻住|亲吻|抱住|搂紧|抚摸|摩擦|抽动|kiss(?:ing)?|hold(?:ing)?|strok(?:e|ing)|rubb?(?:ing)?|thrust(?:ing)?)[\s\S]{0,36}(?:我|me\b))/iu;
const DIRECTED_ACTION = /(?:(?:我|I\b).{0,16}(?:亲|吻|抱|搂|摸|抚摸|摩擦|进入|抽动)(?:着|住|紧|了)?(?:你|you\b)|(?:你|you\b).{0,16}(?:亲|吻|抱|搂|摸|抚摸|摩擦|进入|抽动)(?:着|住|紧|了)?(?:我|me\b)|(?:I\b).{0,16}(?:kiss|hold|touch|stroke|rub|enter|thrust)(?:ed|ing)?\s+(?:you\b)|(?:you\b).{0,16}(?:kiss|hold|touch|stroke|rub|enter|thrust)(?:ed|ing)?\s+(?:me\b))/iu;
const SEXUAL_ENTRY = /(?:进入(?:你|我|身体|阴道|体内)|enter(?:ing)? (?:you|me)|(?:你|我).{0,12}(?:进入|抽动)|(?:进入|抽动).{0,12}(?:你|我))/iu;
const SEXUAL_CLASS_INTENSITY = Object.freeze({
  neutral_discussion: 0,
  flirt_tease: 0.25,
  direct_desire: 0.55,
  sexual_explicit: 0.80,
  concrete_intimate_action: 1,
});
const SETTLEMENT_TYPES = new Set([
  'partnered_no_release', 'partnered_release', 'solo_no_release', 'solo_release',
]);
const SETTLEMENT_FACTORS = Object.freeze({
  partnered_no_release: 0.80,
  partnered_release: 0.30,
  solo_no_release: 0.80,
  solo_release: 0.38,
});
const SETTLEMENT_RANK = Object.freeze({
  partnered_no_release: 1,
  partnered_release: 2,
  solo_no_release: 1,
  solo_release: 2,
});

function emptySettlementResult({ duplicateIgnored = null } = {}) {
  return {
    libidoBefore: null,
    libidoAfter: null,
    arousalBefore: null,
    arousalAfter: null,
    refractoryUntil: null,
    cooldownUntil: null,
    receiptStatus: 'settled',
    settled: true,
    duplicateIgnored,
  };
}

function validateOptionalTime(pair) {
  return pair === null || (
    pair && Number.isSafeInteger(pair.epochMs) && pair.epochMs >= 0 &&
    typeof pair.iso === 'string' && Date.parse(pair.iso) === pair.epochMs
  );
}

function validateSettlementResult(result) {
  if (result === null) return;
  const expected = [
    'arousalAfter', 'arousalBefore', 'cooldownUntil', 'duplicateIgnored',
    'libidoAfter', 'libidoBefore', 'receiptStatus', 'refractoryUntil', 'settled',
  ].sort().join(',');
  if (typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).sort().join(',') !== expected ||
      !['pending', 'settled', 'unknown'].includes(result.receiptStatus) ||
      ![true, false, null].includes(result.settled) ||
      ![true, false, null].includes(result.duplicateIgnored) ||
      !validateOptionalTime(result.refractoryUntil) ||
      !validateOptionalTime(result.cooldownUntil)) {
    throw new ValidationError('settlement result is invalid', 'CHAT_STATE_CORRUPT');
  }
  for (const field of ['libidoBefore', 'libidoAfter', 'arousalBefore', 'arousalAfter']) {
    if (result[field] !== null &&
        (!Number.isFinite(result[field]) || result[field] < 0 || result[field] > 1)) {
      throw new ValidationError('settlement result value is invalid', 'CHAT_STATE_CORRUPT');
    }
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireEpoch(epochMs, previous = 0) {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || epochMs < previous) {
    throw new ValidationError('chat event clock moved backwards or is invalid', 'CLOCK_ANOMALY');
  }
}

export function createChatStimulusState(epochMs = Date.now()) {
  requireEpoch(epochMs);
  return {
    schema: CHAT_STATE_SCHEMA,
    version: 1,
    updatedAt: timePair(epochMs),
    influenceAt: timePair(epochMs),
    influence: structuredClone(ZERO_DRIVES),
    processedEvents: [],
    pending: [],
    settlementFacts: [],
    pendingSettlementReceipt: null,
  };
}

export function validateChatStimulusState(state, config) {
  if (state === null || typeof state !== 'object' || Array.isArray(state) ||
      state.schema !== CHAT_STATE_SCHEMA || state.version !== 1) {
    throw new ValidationError('unsupported chat stimulus state', 'CHAT_STATE_CORRUPT');
  }
  // v0.9.8 states did not contain settlement state. Adding empty fields is a
  // lossless in-memory migration; the next normal atomic save persists v0.9.9.
  state.settlementFacts ??= [];
  state.pendingSettlementReceipt ??= null;
  requireEpoch(state.updatedAt?.epochMs);
  requireEpoch(state.influenceAt?.epochMs);
  for (const pair of [state.updatedAt, state.influenceAt]) {
    if (typeof pair.iso !== 'string' || Date.parse(pair.iso) !== pair.epochMs) {
      throw new ValidationError('chat stimulus timestamp is invalid', 'CHAT_STATE_CORRUPT');
    }
  }
  if (state.influence === null || typeof state.influence !== 'object' ||
      Object.keys(state.influence).sort().join(',') !== [...DRIVES].sort().join(',')) {
    throw new ValidationError('chat influence record is invalid', 'CHAT_STATE_CORRUPT');
  }
  for (const amount of Object.values(state.influence)) {
    if (!Number.isFinite(amount) || Math.abs(amount) > 1) {
      throw new ValidationError('chat influence amount is invalid', 'CHAT_STATE_CORRUPT');
    }
  }
  if (!Array.isArray(state.processedEvents) || state.processedEvents.length > config.ledgerMaxCount ||
      !Array.isArray(state.pending) || state.pending.length > config.pendingMaxCount) {
    throw new ValidationError('chat queues are invalid', 'CHAT_STATE_CORRUPT');
  }
  for (const record of state.processedEvents) {
    record.sexualClass ??= record.types.includes('sexual_explicit')
      ? 'sexual_explicit' : 'neutral_discussion';
    record.intensity ??= SEXUAL_CLASS_INTENSITY[record.sexualClass] ?? 0;
    record.factFingerprint ??= null;
    record.settlementType ??= null;
    const keys = Object.keys(record).sort().join(',');
    if (keys !== 'at,deltas,eventId,factFingerprint,intensity,labels,settlementType,sexualClass,types' ||
        typeof record.eventId !== 'string' || !/^event-[a-f0-9]{64}$/.test(record.eventId) ||
        !Array.isArray(record.types) || record.types.some((type) => !EVENT_TYPES.has(type)) ||
        !Object.hasOwn(SEXUAL_CLASS_INTENSITY, record.sexualClass) ||
        !Number.isFinite(record.intensity) || record.intensity < 0 || record.intensity > 1 ||
        (record.factFingerprint !== null &&
          (typeof record.factFingerprint !== 'string' ||
            !/^fact-[a-f0-9]{64}$/u.test(record.factFingerprint))) ||
        (record.settlementType !== null && !SETTLEMENT_TYPES.has(record.settlementType)) ||
        !Array.isArray(record.labels) || record.labels.length > 4 ||
        record.labels.some((label) => typeof label !== 'string' || label.length > 40) ||
        record.deltas === null || typeof record.deltas !== 'object' || Array.isArray(record.deltas)) {
      throw new ValidationError('chat event ledger record is invalid', 'CHAT_STATE_CORRUPT');
    }
    requireEpoch(record.at?.epochMs);
    if (Date.parse(record.at.iso) !== record.at.epochMs) {
      throw new ValidationError('chat event ledger timestamp is invalid', 'CHAT_STATE_CORRUPT');
    }
    for (const [drive, amount] of Object.entries(record.deltas)) {
      if (!DRIVES.includes(drive) || !Number.isFinite(amount) || Math.abs(amount) > 1) {
        throw new ValidationError('chat event delta is invalid', 'CHAT_STATE_CORRUPT');
      }
    }
  }
  if (!Array.isArray(state.settlementFacts) ||
      state.settlementFacts.length > config.ledgerMaxCount) {
    throw new ValidationError('settlement fact ledger is invalid', 'CHAT_STATE_CORRUPT');
  }
  for (const fact of state.settlementFacts) {
    if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) {
      throw new ValidationError('settlement fact record is invalid', 'CHAT_STATE_CORRUPT');
    }
    fact.result ??= null;
    if (Object.keys(fact).sort().join(',') !==
          'at,carryoverFactor,effectId,eventIds,factFingerprint,result,type' ||
        typeof fact.factFingerprint !== 'string' ||
        !/^fact-[a-f0-9]{64}$/u.test(fact.factFingerprint) ||
        !SETTLEMENT_TYPES.has(fact.type) ||
        !Number.isFinite(fact.carryoverFactor) || fact.carryoverFactor <= 0 ||
        fact.carryoverFactor > 1 || typeof fact.effectId !== 'string' ||
        !/^effect-[a-f0-9]{64}$/u.test(fact.effectId) || !Array.isArray(fact.eventIds) ||
        fact.eventIds.length === 0 || fact.eventIds.length > config.ledgerMaxCount ||
        new Set(fact.eventIds).size !== fact.eventIds.length ||
        fact.eventIds.some((id) => typeof id !== 'string' || !/^event-[a-f0-9]{64}$/u.test(id))) {
      throw new ValidationError('settlement fact record is invalid', 'CHAT_STATE_CORRUPT');
    }
    requireEpoch(fact.at?.epochMs);
    if (typeof fact.at.iso !== 'string' || Date.parse(fact.at.iso) !== fact.at.epochMs) {
      throw new ValidationError('settlement fact timestamp is invalid', 'CHAT_STATE_CORRUPT');
    }
    validateSettlementResult(fact.result);
  }
  if (state.pendingSettlementReceipt !== null) {
    const receipt = state.pendingSettlementReceipt;
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt) ||
        Object.keys(receipt).sort().join(',') !==
          'at,effectId,eventId,factFingerprint,fromFactor,toFactor,type' ||
        typeof receipt.effectId !== 'string' || !/^effect-[a-f0-9]{64}$/u.test(receipt.effectId) ||
        typeof receipt.eventId !== 'string' || !/^event-[a-f0-9]{64}$/u.test(receipt.eventId) ||
        typeof receipt.factFingerprint !== 'string' ||
        !/^fact-[a-f0-9]{64}$/u.test(receipt.factFingerprint) ||
        !SETTLEMENT_TYPES.has(receipt.type) ||
        !Number.isFinite(receipt.fromFactor) || receipt.fromFactor <= 0 || receipt.fromFactor > 1 ||
        !Number.isFinite(receipt.toFactor) || receipt.toFactor <= 0 || receipt.toFactor > 1) {
      throw new ValidationError('pending settlement receipt is invalid', 'CHAT_STATE_CORRUPT');
    }
    requireEpoch(receipt.at?.epochMs);
    if (typeof receipt.at.iso !== 'string' || Date.parse(receipt.at.iso) !== receipt.at.epochMs) {
      throw new ValidationError('pending settlement timestamp is invalid', 'CHAT_STATE_CORRUPT');
    }
  }
  for (const item of state.pending) {
    if (Object.keys(item).sort().join(',') !== 'at,eventId,labels,role' ||
        typeof item.eventId !== 'string' || !/^event-[a-f0-9]{64}$/.test(item.eventId) ||
        !['user', 'assistant'].includes(item.role) || !Array.isArray(item.labels) ||
        item.labels.some((label) => typeof label !== 'string' || label.length > 40)) {
      throw new ValidationError('chat pending record is invalid', 'CHAT_STATE_CORRUPT');
    }
    requireEpoch(item.at?.epochMs);
  }
  const serialized = JSON.stringify(state);
  if (/\b(?:content|text|message|raw)\b/iu.test(serialized)) {
    throw new ValidationError('chat state contains a forbidden raw-text field', 'CHAT_STATE_CORRUPT');
  }
  return state;
}

export function validateCompleteMessageEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new ValidationError('message event must be an object', 'MESSAGE_EVENT_INVALID');
  }
  for (const key of ['source', 'conversationId', 'providerMessageId', 'role', 'status', 'content']) {
    if (typeof event[key] !== 'string' || event[key].length === 0) {
      throw new ValidationError(`message event ${key} is invalid`, 'MESSAGE_EVENT_INVALID');
    }
  }
  if (!['user', 'assistant'].includes(event.role) || event.status !== 'complete' ||
      event.persisted !== true || (event.role === 'assistant' && event.final !== true) ||
      event.cancelled === true) {
    throw new ValidationError('message event is not a persisted complete turn', 'MESSAGE_EVENT_INCOMPLETE');
  }
  requireEpoch(event.completedAt);
  if (event.content.length > 20_000) {
    throw new ValidationError('message event content is too large', 'MESSAGE_EVENT_INVALID');
  }
  if (event.causeId !== undefined && event.causeId !== null &&
      (typeof event.causeId !== 'string' || !/^event-[a-f0-9]{64}$/u.test(event.causeId))) {
    throw new ValidationError('message event causeId is invalid', 'MESSAGE_EVENT_INVALID');
  }
  if (event.parentMessageId !== undefined && event.parentMessageId !== null &&
      (typeof event.parentMessageId !== 'string' || event.parentMessageId.length === 0 ||
        event.parentMessageId.length > 200)) {
    throw new ValidationError('message event parentMessageId is invalid', 'MESSAGE_EVENT_INVALID');
  }
  return event;
}

export function stableMessageEventId(event) {
  validateCompleteMessageEvent(event);
  return `event-${digest([
    event.source, event.conversationId, event.providerMessageId, event.role,
  ].join('\u0000'))}`;
}

function linkedCauseId(event) {
  if (typeof event.causeId === 'string') return event.causeId;
  if (typeof event.parentMessageId !== 'string') return null;
  const parentRole = event.role === 'assistant' ? 'user' : 'assistant';
  return `event-${digest([
    event.source, event.conversationId, event.parentMessageId, parentRole,
  ].join('\u0000'))}`;
}

function negativeCauseKind(types) {
  return NEGATIVE_KIND_PRECEDENCE.find(([, matches]) =>
    matches.some((type) => types.includes(type)))?.[0] ?? null;
}

function recoveryPlan(types) {
  return RECOVERY_PRECEDENCE.find(([type]) => types.includes(type))?.[1] ?? null;
}

function stripNonAssertions(content) {
  return content
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .split(/\r?\n/u)
    .filter((line) => !/^\s*>/u.test(line) && !/^\s*["“][\s\S]*["”]\s*$/u.test(line))
    .join('\n')
    .trim();
}

function contextBlocker(text) {
  if (!text) return 'non_assertion';
  if (QUESTION.test(text)) return 'question';
  if (NEGATED_OR_STOP.test(text)) return 'negated_or_stop';
  if (HYPOTHETICAL.test(text)) return 'hypothetical_or_plan';
  if (TUTORIAL.test(text)) return 'tutorial';
  if (MEMORY.test(text)) return 'memory';
  if (THIRD_PERSON.test(text)) return 'third_person';
  return null;
}

function settlementForText(text, event) {
  if (!text || QUESTION.test(text) || HYPOTHETICAL.test(text) || TUTORIAL.test(text) ||
      DISCUSSION.test(text) || MEMORY.test(text) || THIRD_PERSON.test(text) ||
      !COMPLETED.test(text)) return null;
  const withoutNegatedRelease = text.replace(
    /(?:没有|没|未|并未|without|did not|didn't).{0,5}?(?:高潮(?:了)?|射精(?:了)?|射(?:了)?|climax(?:ed)?|come|came|orgasm(?:ed)?)/giu,
    ' ',
  );
  const released = RELEASED.test(withoutNegatedRelease);
  const noRelease = !released && NO_RELEASE.test(text);
  if (!noRelease && !released) return null;
  let type = null;
  if (SOLO.test(text)) type = released ? 'solo_release' : 'solo_no_release';
  else if ((PAIR.test(text) || /(?:我|I\b)/iu.test(text)) && INTIMATE_EVENT.test(text)) {
    type = released ? 'partnered_release' : 'partnered_no_release';
  }
  if (type === null) return null;
  const rootMessageId = event.role === 'assistant' && typeof event.parentMessageId === 'string'
    ? event.parentMessageId : event.providerMessageId;
  return {
    type,
    factFingerprint: `fact-${digest([
      event.source, event.conversationId, rootMessageId,
    ].join('\u0000'))}`,
  };
}

function sexualClassForText(text, role) {
  if (!text || TUTORIAL.test(text) || DISCUSSION.test(text) || MEMORY.test(text) ||
      THIRD_PERSON.test(text) || NEGATED_OR_STOP.test(text) || HYPOTHETICAL.test(text) ||
      QUESTION.test(text)) return 'neutral_discussion';
  if (!PARTICIPANTS.test(text)) return 'neutral_discussion';
  const directed = PAIR.test(text) || /(?:我|I\b)/iu.test(text) ||
    (role === 'user' && /(?:你|you\b)/iu.test(text)) ||
    (role === 'assistant' && /(?:你|you\b)/iu.test(text));
  const concrete = CONCRETE_ACTION.test(text) || DIRECTED_ACTION.test(text) ||
    (PAIR.test(text) && SEXUAL_ENTRY.test(text));
  if (concrete) return 'concrete_intimate_action';
  if (directed && EXPLICIT_COMBINATION.test(text)) return 'sexual_explicit';
  if (DIRECT_DESIRE.test(text)) return 'direct_desire';
  if (directed && FLIRT.test(text)) return 'flirt_tease';
  return 'neutral_discussion';
}

function stimulusForText(text, role, sexualClass) {
  if (sexualClass === 'neutral_discussion') return [];
  const firstToSecond = /(?:我|I\b)[\s\S]*(?:你|you\b)/iu.test(text);
  const secondToFirst = /(?:你|you\b)[\s\S]*(?:我|me\b)/iu.test(text);
  const direction = firstToSecond
    ? (role === 'user' ? 'user_to_assistant' : 'assistant_to_user')
    : secondToFirst
      ? (role === 'user' ? 'assistant_to_user' : 'user_to_assistant')
      : 'mutual';
  const posture = /(?:压紧|紧贴|pressed)/iu.test(text)
    ? 'pressed'
    : /(?:贴近|靠近|close)/iu.test(text) ? 'close' : 'neutral';
  const bodyPart = /(?:阴茎|阴蒂|阴道|龟头|genitals?|clitoris|penis|vagina)/iu.test(text)
    ? 'genitals'
    : /(?:大腿内侧|inner thigh)/iu.test(text) ? 'inner_thigh'
      : /(?:胸|乳|breast|chest)/iu.test(text) ? 'chest'
        : /(?:唇|嘴|lip)/iu.test(text) ? 'lips' : 'general';
  if (sexualClass !== 'concrete_intimate_action') {
    const action = {
      flirt_tease: 'flirt', direct_desire: 'desire', sexual_explicit: 'explicit',
    }[sexualClass];
    return action ? [{
      action, bodyPart, posture, mode: 'active', direction,
      releaseSignal: false, strength: SEXUAL_CLASS_INTENSITY[sexualClass],
    }] : [];
  }
  const definitions = [
    ['contact', /(?:接触|贴着|touch(?:ing)?)/iu, 'passive'],
    ['hold', /(?:抱(?:住|着|紧)?|搂(?:紧|着)?|hold(?:ing)?)/iu, 'passive'],
    ['kiss', /(?:亲(?:吻)?|吻(?:住|着)?|kiss(?:ing)?)/iu, 'active'],
    ['stroke', /(?:抚摸|摸(?:着)?|strok(?:e|ing))/iu, 'active'],
    ['rub', /(?:摩擦|rubb(?:ing)?)/iu, 'active'],
    ['thrust', /(?:抽动|thrust(?:ing)?|进入(?:你|我|身体|阴道|体内)|enter(?:ing)? (?:you|me))/iu, 'active'],
  ];
  return definitions
    .filter(([, pattern]) => pattern.test(text))
    .map(([action, , mode]) => ({
      action, bodyPart, posture, mode, direction,
      releaseSignal: false,
    }));
}

export function interpretCompleteMessage(event) {
  validateCompleteMessageEvent(event);
  const eventId = stableMessageEventId(event);
  const text = stripNonAssertions(event.content);
  const settlement = settlementForText(text, event);
  if (settlement !== null) {
    return {
      eventId, role: event.role, types: [settlement.type], labels: [settlement.type],
      deltas: {}, stimuli: [], ambiguous: false,
      sexualClass: 'neutral_discussion', intensity: 0,
      settlementType: settlement.type, factFingerprint: settlement.factFingerprint,
      linkedCauseId: linkedCauseId(event), negativeCauseKind: null, recoveryPlan: null,
    };
  }
  const blocker = contextBlocker(text);
  const sexualClass = sexualClassForText(text, event.role);
  const emotionalTypes = blocker ? [] : [...EVENT_TYPES].filter((type) =>
    Object.hasOwn(PATTERNS, type) && PATTERNS[type].test(text));
  const types = sexualClass === 'neutral_discussion'
    ? (emotionalTypes.length > 0 ? emotionalTypes : ['neutral_discussion'])
    : [...emotionalTypes.filter((type) => type !== 'intimacy_longing'), sexualClass];
  const recovery = recoveryPlan(types);
  const deltas = {};
  for (const type of types) {
    if (recovery !== null && NEGATIVE_EVENT_TYPES.has(type)) continue;
    for (const [drive, amount] of Object.entries(TYPE_DELTAS[type])) {
      deltas[drive] = (deltas[drive] ?? 0) + amount;
    }
  }
  const ambiguous = types.length === 1 && types[0] === 'neutral_discussion' && AMBIGUOUS.test(text);
  const labels = blocker ? [blocker]
    : ambiguous ? ['ambiguous_affect'] : types.slice(0, 4);
  return {
    eventId, role: event.role, types, labels, deltas,
    stimuli: stimulusForText(text, event.role, sexualClass), ambiguous,
    sexualClass, intensity: SEXUAL_CLASS_INTENSITY[sexualClass],
    settlementType: null, factFingerprint: null,
    linkedCauseId: linkedCauseId(event),
    negativeCauseKind: recovery === null ? negativeCauseKind(types) : null,
    recoveryPlan: recovery,
  };
}

function decayInfluence(chatState, desireState, config, nowMs) {
  requireEpoch(nowMs, chatState.influenceAt.epochMs);
  const elapsedSeconds = (nowMs - chatState.influenceAt.epochMs) / 1000;
  const factor = Math.exp(-elapsedSeconds / config.decayTauSeconds);
  for (const drive of DRIVES) {
    const previous = chatState.influence[drive];
    const retained = previous * factor;
    desireState.drives[drive] = clamp(desireState.drives[drive] - (previous - retained));
    chatState.influence[drive] = retained;
  }
  chatState.influenceAt = timePair(nowMs);
}

export function advanceChatStimulus(desireInput, chatInput, rootConfig, nowMs) {
  if (rootConfig.chatStimulusEnabled !== true) {
    return { desireState: desireInput, chatState: chatInput };
  }
  const desireState = structuredClone(desireInput);
  const chatState = structuredClone(validateChatStimulusState(
    chatInput, rootConfig.chatStimulus,
  ));
  requireEpoch(nowMs, chatState.updatedAt.epochMs);
  decayInfluence(chatState, desireState, rootConfig.chatStimulus, nowMs);
  decayNegativeCauses(desireState, rootConfig, nowMs);
  chatState.updatedAt = timePair(nowMs);
  return { desireState, chatState };
}

function boundedDeltas(interpreted, chatState, config, nowMs) {
  const start = nowMs - config.windowSeconds * 1000;
  const recent = chatState.processedEvents.filter((record) => record.at.epochMs >= start);
  const result = {};
  for (const [drive, requested] of Object.entries(interpreted.deltas)) {
    const direction = Math.sign(requested);
    const used = recent.reduce((sum, record) => {
      const amount = record.deltas[drive] ?? 0;
      return sum + (Math.sign(amount) === direction ? Math.abs(amount) : 0);
    }, 0);
    const amount = Math.min(
      Math.abs(requested),
      config.singleCaps[drive],
      Math.max(0, config.windowCaps[drive] - used),
    );
    if (amount > 0) result[drive] = amount * direction;
  }
  return result;
}

function addEventFlit(desireState, config, eventId, nowMs) {
  if (desireState.thoughts.length >= config.thoughts.maxCount) return;
  let numeric = Number.parseInt(eventId.slice(6, 18), 16);
  if (desireState.thoughts.some((thought) => thought.eventId === eventId)) return;
  while (desireState.thoughts.some((thought) => thought.id === `thought-${nowMs}-${numeric}`)) {
    numeric += 1;
  }
  desireState.thoughts.push({
    id: `thought-${nowMs}-${numeric}`,
    drive: 'reflection',
    type: 'flit',
    intensity: 0.45,
    fedCount: 1,
    text: '想认真理解这次受伤并承担责任',
    source: 'event',
    eventId,
    createdAt: timePair(nowMs),
    updatedAt: timePair(nowMs),
  });
}

function stageSettlement(chatState, interpreted, nowMs, ledgerMaxCount) {
  const type = interpreted.settlementType;
  const factFingerprint = interpreted.factFingerprint;
  if (!SETTLEMENT_TYPES.has(type) || typeof factFingerprint !== 'string') return false;
  const prior = chatState.settlementFacts.find((item) =>
    item.factFingerprint === factFingerprint);
  if (prior) {
    if (!prior.eventIds.includes(interpreted.eventId)) {
      prior.eventIds = [...prior.eventIds, interpreted.eventId].slice(-ledgerMaxCount);
    }
    const priorCause = prior.type.startsWith('solo_') ? 'solo' : 'partnered';
    const nextCause = type.startsWith('solo_') ? 'solo' : 'partnered';
    if (priorCause !== nextCause || SETTLEMENT_RANK[type] <= SETTLEMENT_RANK[prior.type]) {
      prior.result ??= emptySettlementResult();
      prior.result.duplicateIgnored = true;
      return false;
    }
  }
  if (chatState.pendingSettlementReceipt !== null) return false;
  const fromFactor = prior?.carryoverFactor ?? 1;
  const toFactor = SETTLEMENT_FACTORS[type];
  chatState.pendingSettlementReceipt = {
    effectId: `effect-${digest(`settlement:${factFingerprint}:${type}`)}`,
    eventId: interpreted.eventId,
    factFingerprint,
    type,
    fromFactor,
    toFactor,
    at: timePair(nowMs),
  };
  return true;
}

export function applyChatStimulus(desireInput, chatInput, rootConfig, interpreted, nowMs) {
  if (rootConfig.chatStimulusEnabled !== true) {
    return { desireState: desireInput, chatState: chatInput, applied: false };
  }
  const desireState = structuredClone(desireInput);
  const chatState = structuredClone(validateChatStimulusState(
    chatInput, rootConfig.chatStimulus,
  ));
  if (chatState.processedEvents.some((record) => record.eventId === interpreted.eventId)) {
    return { desireState, chatState, applied: false };
  }
  if (desireState.appliedChatEventIds?.includes(interpreted.eventId)) {
    const reconciledAtMs = Math.max(nowMs, chatState.updatedAt.epochMs);
    // The receiver persists desire before interaction state. If it stops in
    // between those writes, the desire event ledger survives but the staged
    // settlement receipt does not. Recreate only that deterministic receipt
    // while reconciling the missing interaction ledger; the drive delta must
    // not be applied again.
    const stagedSettlement = rootConfig.arousalDriveSettlementEnabled === true
      ? stageSettlement(
        chatState, interpreted, reconciledAtMs, rootConfig.chatStimulus.ledgerMaxCount,
      ) : false;
    chatState.processedEvents = [...chatState.processedEvents, {
      eventId: interpreted.eventId,
      types: interpreted.types,
      deltas: {},
      at: timePair(reconciledAtMs),
      labels: ['replay_reconciled'],
      sexualClass: interpreted.sexualClass,
      intensity: interpreted.intensity,
      factFingerprint: interpreted.factFingerprint,
      settlementType: interpreted.settlementType,
    }].slice(-rootConfig.chatStimulus.ledgerMaxCount);
    chatState.updatedAt = timePair(reconciledAtMs);
    return { desireState, chatState, applied: stagedSettlement };
  }
  requireEpoch(nowMs, chatState.updatedAt.epochMs);
  decayInfluence(chatState, desireState, rootConfig.chatStimulus, nowMs);
  decayNegativeCauses(desireState, rootConfig, nowMs);
  const stagedSettlement = rootConfig.arousalDriveSettlementEnabled === true
    ? stageSettlement(
      chatState, interpreted, nowMs, rootConfig.chatStimulus.ledgerMaxCount,
    ) : false;
  const deltas = interpreted.settlementType === null
    ? boundedDeltas(interpreted, chatState, rootConfig.chatStimulus, nowMs) : {};
  const causeContributions = {};
  if (interpreted.negativeCauseKind !== null) {
    for (const drive of NEGATIVE_CAUSE_DRIVES) {
      if ((deltas[drive] ?? 0) > 0) causeContributions[drive] = deltas[drive];
    }
  }
  for (const [drive, delta] of Object.entries(deltas)) {
    const previous = desireState.drives[drive];
    desireState.drives[drive] = clamp(previous + delta);
    const applied = desireState.drives[drive] - previous;
    if (!Object.hasOwn(causeContributions, drive)) chatState.influence[drive] += applied;
    else causeContributions[drive] = applied;
  }
  if (interpreted.negativeCauseKind !== null) {
    addNegativeCause(desireState, rootConfig, {
      causeId: interpreted.eventId,
      kind: interpreted.negativeCauseKind,
      contributions: causeContributions,
      nowMs,
    });
  } else if (interpreted.recoveryPlan !== null) {
    const linked = interpreted.linkedCauseId !== null;
    const plan = interpreted.recoveryPlan;
    const recovery = recoverNegativeCause(desireState, {
      causeId: interpreted.linkedCauseId,
      kinds: linked ? plan.linkedKinds : plan.fallbackKinds,
      fraction: linked ? plan.linkedFraction : plan.fallbackFraction,
      close: linked && plan.closeLinked,
      nowMs,
    });
    for (const [drive, delta] of Object.entries(recovery.deltas)) {
      deltas[drive] = (deltas[drive] ?? 0) + delta;
    }
  }
  if (interpreted.types.includes('hurt_anger')) {
    addEventFlit(desireState, rootConfig, interpreted.eventId, nowMs);
  }
  if (interpreted.ambiguous) {
    chatState.pending = [...chatState.pending, {
      eventId: interpreted.eventId,
      at: timePair(nowMs),
      role: interpreted.role,
      labels: interpreted.labels,
    }].slice(-rootConfig.chatStimulus.pendingMaxCount);
  }
  chatState.processedEvents = [...chatState.processedEvents, {
    eventId: interpreted.eventId,
    types: interpreted.types,
    deltas,
    at: timePair(nowMs),
    labels: interpreted.labels,
    sexualClass: interpreted.sexualClass,
    intensity: interpreted.intensity,
    factFingerprint: interpreted.factFingerprint,
    settlementType: interpreted.settlementType,
  }].slice(-rootConfig.chatStimulus.ledgerMaxCount);
  desireState.appliedChatEventIds = [
    ...(desireState.appliedChatEventIds ?? []), interpreted.eventId,
  ].slice(-rootConfig.chatStimulus.ledgerMaxCount);
  chatState.updatedAt = timePair(nowMs);
  return {
    desireState,
    chatState,
    applied: Object.keys(deltas).length > 0 || stagedSettlement,
  };
}

export function pendingForAutonomy(chatState, maximum = 6) {
  return chatState.pending.slice(-Math.max(0, maximum)).map((item) => ({
    event_id_digest: item.eventId,
    at: item.at,
    role: item.role,
    labels: item.labels,
  }));
}
