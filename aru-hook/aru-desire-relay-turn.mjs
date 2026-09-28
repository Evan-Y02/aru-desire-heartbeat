import { createHash } from 'node:crypto';
const stableId = (prefix, value) => `${prefix}_${createHash('sha256')
  .update(String(value), 'utf8').digest('hex').slice(0, 32)}`;
const bounded = (value, maximum) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, maximum)
  : '';
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part
    : ['text', 'input_text', 'output_text'].includes(part?.type) ? part.text ?? '' : '').join('\n');
}
function extractLatestUserText(body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  if (buffer.byteLength > 2 * 1024 * 1024) throw new Error('relay input is too large');
  const payload = JSON.parse(buffer.toString('utf8'));
  const items = Array.isArray(payload.messages) ? payload.messages
    : Array.isArray(payload.input) ? payload.input : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === 'user') return bounded(contentText(items[index].content), 4000);
  }
  return bounded(typeof payload.input === 'string' ? payload.input : '', 4000);
}
function extractAssistantTextFromSse(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
  if (buffer.byteLength > 2 * 1024 * 1024) throw new Error('relay output is too large');
  const parts = [];
  for (const line of buffer.toString('utf8').split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let item;
    try { item = JSON.parse(data); } catch { continue; }
    if (item?.type === 'response.output_text.delta' && typeof item.delta === 'string') {
      parts.push(item.delta);
      continue;
    }
    for (const choice of item?.choices ?? []) {
      parts.push(contentText(choice?.delta?.content) ||
        contentText(choice?.message?.content) || choice?.text || '');
    }
  }
  return bounded(parts.join(''), 8000);
}

// The relay has durably written the provider response before this is called.
// Raw material exists only in this in-memory callback and is never added to
// relay state, diagnostics, settlement state, or logs.
export function buildAruDesireRelayTurn({ turn, providerBody, responseBody } = {}) {
  if (turn?.state !== 'succeeded' ||
      !['openai-compatible', 'chatgpt-codex-subscription'].includes(turn.protocolId) ||
      !String(turn.providerContentType ?? '').toLowerCase().startsWith('text/event-stream') ||
      typeof turn.turnId !== 'string' || typeof turn.conversationId !== 'string' ||
      !Number.isSafeInteger(turn.createdAt) || !Number.isSafeInteger(turn.completedAt)) return null;
  let userText;
  let assistantText;
  try {
    userText = extractLatestUserText(providerBody);
    assistantText = extractAssistantTextFromSse(responseBody);
  } catch {
    return null;
  }
  if (!userText || !assistantText) return null;
  const userMessageId = stableId('relaymsg', `${turn.turnId}:user`);
  const assistantMessageId = stableId('relaymsg', `${turn.turnId}:assistant`);
  const user = {
    messageId: userMessageId,
    role: 'user',
    status: 'completed',
    content: userText,
    createdAt: turn.createdAt,
    updatedAt: turn.createdAt,
  };
  const assistant = {
    messageId: assistantMessageId,
    role: 'assistant',
    status: 'completed',
    content: assistantText,
    createdAt: turn.completedAt,
    updatedAt: turn.completedAt,
  };
  return {
    outcome: 'completed',
    conversation: {
      conversationId: turn.conversationId,
      messages: [user, assistant],
    },
    turn: {
      userMessageId,
      assistantMessageId,
      baseMessageId: stableId('relaybase', turn.turnId),
      completedAt: turn.completedAt,
    },
    assistantMessage: assistant,
  };
}
