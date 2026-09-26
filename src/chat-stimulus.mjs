import { createHash } from 'node:crypto';
import { DRIVES } from './constants.mjs';
import { clamp, timePair } from './engine.mjs';
import { ValidationError } from './schema.mjs';

export const CHAT_STATE_SCHEMA = 'aru.desire-heartbeat.chat-stimulus-state.v1';
const EVENT_TYPES = new Set([
  'intimacy_longing', 'sexual_explicit', 'hurt_anger',
  'needs_support', 'affirmation',
]);
const ZERO_DRIVES = Object.freeze(Object.fromEntries(DRIVES.map((drive) => [drive, 0])));
const TYPE_DELTAS = Object.freeze({
  intimacy_longing: { attachment: 0.055, social: 0.035 },
  sexual_explicit: { attachment: 0.015, libido: 0.080 },
  hurt_anger: { reflection: 0.070, duty: 0.070, stress: 0.060 },
  needs_support: { attachment: 0.050, duty: 0.055 },
  affirmation: { attachment: 0.050, stress: -0.035 },
});

const PATTERNS = Object.freeze({
  intimacy_longing: /(?:想你|想念|爱你|依恋|陪着你|靠近你|miss you|love you|close to you)/iu,
  sexual_explicit: /(?:亲吻|吻住|抚摸|摸着|摩擦|抽动|进入|高潮|射精|kiss(?:ing)?|strok(?:e|ing)|rubb(?:ing)?|thrust(?:ing)?|climax)/iu,
  hurt_anger: /(?:失望|生气|伤害了我|被伤害|委屈|辜负|angry|disappointed|hurt me)/iu,
  needs_support: /(?:疲惫|累坏了|难过|不舒服|身体疼|需要陪伴|陪陪我|exhausted|sad|feel sick|stay with me)/iu,
  affirmation: /(?:做得很好|真棒|谢谢你陪我|我相信你|我们一直在一起|你很重要|proud of you|trust you|we are together)/iu,
});
const AMBIGUOUS = /(?:有点难受|说不清|怪怪的|不知道怎么说|mixed feelings|not sure how I feel)/iu;
const QUESTION = /(?:[?？]|吗(?:[。！!]?$)|是不是|能不能|可不可以|如何|怎么(?:办|做)|what if|how do|could you)/iu;
const NEGATED_OR_STOP = /(?:不想(?:要)?|没有在|没在|并非|不是在|别再|不要|停止|停下|stop|do not|don't|didn't|not doing)/iu;
const HYPOTHETICAL = /(?:如果|假如|假设|要是|计划|打算|以后|明天|将来|would|could have|planning to|someday|if )/iu;
const MEMORY = /(?:以前|曾经|上次|那次|回忆|记得当时|昨天|过去|used to|remember when|last time)/iu;
const THIRD_PERSON = /(?:他|她|他们|她们|别人|某人|he |she |they |someone else)/iu;
const TUTORIAL = /(?:教程|示例|举例|代码|正则|关键词|步骤|说明文|tutorial|example|sample code|documentation)/iu;
const PARTICIPANTS = /(?:我|你|我们|彼此|me|you|we|us|each other)/iu;

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
  };
}

export function validateChatStimulusState(state, config) {
  if (state === null || typeof state !== 'object' || Array.isArray(state) ||
      state.schema !== CHAT_STATE_SCHEMA || state.version !== 1) {
    throw new ValidationError('unsupported chat stimulus state', 'CHAT_STATE_CORRUPT');
  }
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
    const keys = Object.keys(record).sort().join(',');
    if (keys !== 'at,deltas,eventId,labels,types' ||
        typeof record.eventId !== 'string' || !/^event-[a-f0-9]{64}$/.test(record.eventId) ||
        !Array.isArray(record.types) || record.types.some((type) => !EVENT_TYPES.has(type)) ||
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
  return event;
}

export function stableMessageEventId(event) {
  validateCompleteMessageEvent(event);
  return `event-${digest([
    event.source, event.conversationId, event.providerMessageId, event.role,
  ].join('\u0000'))}`;
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

function stimulusForText(text, role) {
  if (!PATTERNS.sexual_explicit.test(text) || !PARTICIPANTS.test(text)) return [];
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
  const definitions = [
    ['contact', /(?:接触|贴着|touch(?:ing)?)/iu, 'passive'],
    ['hold', /(?:抱住|搂紧|hold(?:ing)?)/iu, 'passive'],
    ['kiss', /(?:亲吻|吻住|kiss(?:ing)?)/iu, 'active'],
    ['stroke', /(?:抚摸|摸着|strok(?:e|ing))/iu, 'active'],
    ['rub', /(?:摩擦|rubb(?:ing)?)/iu, 'active'],
    ['thrust', /(?:抽动|进入|thrust(?:ing)?)/iu, 'active'],
    ['climax', /(?:高潮|射精|climax|come)/iu, 'active'],
  ];
  return definitions
    .filter(([, pattern]) => pattern.test(text))
    .map(([action, , mode]) => ({
      action, bodyPart, posture, mode, direction,
      releaseSignal: action === 'climax',
    }));
}

export function interpretCompleteMessage(event) {
  validateCompleteMessageEvent(event);
  const eventId = stableMessageEventId(event);
  const text = stripNonAssertions(event.content);
  const blocker = contextBlocker(text);
  if (blocker) {
    return {
      eventId, role: event.role, types: [], labels: [blocker],
      deltas: {}, stimuli: [], ambiguous: false,
    };
  }
  const types = [...EVENT_TYPES].filter((type) => PATTERNS[type].test(text));
  const deltas = {};
  for (const type of types) {
    for (const [drive, amount] of Object.entries(TYPE_DELTAS[type])) {
      deltas[drive] = (deltas[drive] ?? 0) + amount;
    }
  }
  const ambiguous = types.length === 0 && AMBIGUOUS.test(text);
  const labels = types.length > 0 ? types.slice(0, 4) : ambiguous ? ['ambiguous_affect'] : ['no_op'];
  return {
    eventId, role: event.role, types, labels, deltas,
    stimuli: stimulusForText(text, event.role), ambiguous,
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

export function applyChatStimulus(desireInput, chatInput, rootConfig, interpreted, nowMs) {
  if (rootConfig.chatStimulusEnabled !== true) {
    return { desireState: desireInput, chatState: chatInput, applied: false };
  }
  const desireState = structuredClone(desireInput);
  const chatState = structuredClone(validateChatStimulusState(
    chatInput, rootConfig.chatStimulus,
  ));
  requireEpoch(nowMs, chatState.updatedAt.epochMs);
  if (chatState.processedEvents.some((record) => record.eventId === interpreted.eventId)) {
    return { desireState, chatState, applied: false };
  }
  if (desireState.appliedChatEventIds?.includes(interpreted.eventId)) {
    chatState.processedEvents = [...chatState.processedEvents, {
      eventId: interpreted.eventId,
      types: interpreted.types,
      deltas: {},
      at: timePair(nowMs),
      labels: ['replay_reconciled'],
    }].slice(-rootConfig.chatStimulus.ledgerMaxCount);
    chatState.updatedAt = timePair(nowMs);
    return { desireState, chatState, applied: false };
  }
  decayInfluence(chatState, desireState, rootConfig.chatStimulus, nowMs);
  const deltas = boundedDeltas(interpreted, chatState, rootConfig.chatStimulus, nowMs);
  for (const [drive, delta] of Object.entries(deltas)) {
    const previous = desireState.drives[drive];
    desireState.drives[drive] = clamp(previous + delta);
    chatState.influence[drive] += desireState.drives[drive] - previous;
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
  }].slice(-rootConfig.chatStimulus.ledgerMaxCount);
  desireState.appliedChatEventIds = [
    ...(desireState.appliedChatEventIds ?? []), interpreted.eventId,
  ].slice(-rootConfig.chatStimulus.ledgerMaxCount);
  chatState.updatedAt = timePair(nowMs);
  return {
    desireState,
    chatState,
    applied: Object.keys(deltas).length > 0,
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
