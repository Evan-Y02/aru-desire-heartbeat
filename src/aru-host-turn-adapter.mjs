// Adapter for Aru Self-Hosted v0.30.2's source-level onTurnSettled callback.
// The installed server currently wires this callback only to its own remote-push
// path; it does not expose a supported plugin/webhook registration for this adapter.
export function adaptAruTurnSettled(event) {
  if (event === null || typeof event !== 'object' || event.outcome !== 'completed') return [];
  const conversation = event.conversation;
  const turn = event.turn;
  const assistant = event.assistantMessage;
  if (conversation === null || typeof conversation !== 'object' ||
      typeof conversation.conversationId !== 'string' || !Array.isArray(conversation.messages) ||
      turn === null || typeof turn !== 'object' || typeof turn.userMessageId !== 'string' ||
      typeof turn.assistantMessageId !== 'string' || !Number.isSafeInteger(turn.completedAt) ||
      assistant === null || typeof assistant !== 'object' ||
      assistant.messageId !== turn.assistantMessageId || assistant.role !== 'assistant' ||
      assistant.status !== 'completed' || typeof assistant.content !== 'string') return [];
  const user = conversation.messages.find((message) =>
    message?.messageId === turn.userMessageId && message.role === 'user' &&
    message.status === 'completed' && typeof message.content === 'string');
  if (!user || !Number.isSafeInteger(user.updatedAt ?? user.createdAt)) return [];
  const source = 'aru-host.onTurnSettled.v0.30.2';
  const base = {
    source,
    conversationId: conversation.conversationId,
    status: 'complete',
    persisted: true,
    cancelled: false,
  };
  return [
    {
      ...base,
      providerMessageId: user.messageId,
      role: 'user',
      final: true,
      content: user.content,
      completedAt: user.updatedAt ?? user.createdAt,
    },
    {
      ...base,
      providerMessageId: assistant.messageId,
      role: 'assistant',
      final: true,
      content: assistant.content,
      completedAt: turn.completedAt,
    },
  ];
}
