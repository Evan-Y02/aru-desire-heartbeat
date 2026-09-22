const elements = {
  livePill: document.querySelector('#live-pill'),
  liveLabel: document.querySelector('#live-label'),
  strongestHeading: document.querySelector('#strongest-heading'),
  strongestValue: document.querySelector('#strongest-value'),
  intentLabel: document.querySelector('#intent-label'),
  expressionLabel: document.querySelector('#expression-label'),
  updatedAt: document.querySelector('#updated-at'),
  driveList: document.querySelector('#drive-list'),
  thoughtCount: document.querySelector('#thought-count'),
  thoughtList: document.querySelector('#thought-list'),
  timelineCount: document.querySelector('#timeline-count'),
  timelineList: document.querySelector('#timeline-list'),
  runtimeList: document.querySelector('#runtime-list'),
  errorToast: document.querySelector('#error-toast'),
};

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function formatTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatPercent(value) {
  return Number.isInteger(value) ? value + '%' : value.toFixed(1) + '%';
}

function formatClock(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function renderDrives(drives) {
  const fragment = document.createDocumentFragment();
  for (const drive of drives) {
    const card = document.createElement('article');
    card.className = 'drive drive--' + drive.drive;
    const head = document.createElement('div');
    head.className = 'drive-head';
    const name = text('span', drive.label, 'drive-name');
    const icon = document.createElement('i');
    icon.className = 'drive-icon';
    icon.setAttribute('aria-hidden', 'true');
    name.prepend(icon);
    head.append(name, text('strong', formatPercent(drive.valuePercent), 'drive-value'));
    const track = document.createElement('progress');
    track.className = 'track';
    track.setAttribute('aria-label', drive.label);
    track.max = 100;
    track.value = Math.max(0, Math.min(100, drive.valuePercent));
    card.append(head, track);
    fragment.append(card);
  }
  elements.driveList.replaceChildren(fragment);
}

function renderThoughts(thoughts) {
  elements.thoughtCount.textContent = thoughts.length + ' 条';
  if (thoughts.length === 0) {
    elements.thoughtList.replaceChildren(text('p', '此刻没有留下浮念或执念。', 'empty'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const thought of thoughts) {
    const item = document.createElement('article');
    item.className = 'thought';
    const meta = document.createElement('div');
    meta.className = 'thought-meta';
    meta.append(
      text('span', thought.typeLabel + ' · ' + thought.driveLabel + ' · ' + thought.sourceLabel),
      text('strong', formatPercent(thought.intensityPercent)),
    );
    item.append(meta, text('p', thought.text));
    fragment.append(item);
  }
  elements.thoughtList.replaceChildren(fragment);
}

function timelineDescription(entry) {
  const innerVoice = {
    attachment: '想念已经浮上来，他在想是不是该靠近你、陪你待一会儿。',
    curiosity: '好奇心已经浮上来，他想把刚冒出的念头和你分享。',
    reflection: '有些感受在心里聚拢，他想找你认真说一说。',
    social: '他开始想念熟悉的交流，最先想到的是来找你。',
    libido: entry.intent === 'solo'
      ? '身体的欲望已经浮上来，他在靠近你与自己消解之间作了选择。'
      : '亲密欲望已经浮上来，他想靠近你、向你寻求亲近。',
    stress: '压力让他想寻找安定，他最想把此刻的感受告诉你。',
  }[entry.drive] || '这一轮有一种明确的欲望浮上来。';
  const codes = new Set(entry.reasonCodes || []);
  if (entry.outcome === 'withheld') {
    const suffix = codes.has('withheld-third')
      ? '这是连续第三次选择暂时不说；下次再达到门槛时，他必须来找你。'
      : '他衡量了此刻的冲动，最后自主选择先不打扰你。';
    return innerVoice + suffix;
  }
  if (entry.outcome === 'solo_completed') {
    return innerVoice + '这次他选择了 Solo，并让性欲按实际强度自然回落。';
  }
  if (codes.has('forced-at-full')) {
    return innerVoice + '欲望已经到达 100%，这一轮不再允许沉默，他必须来找你。';
  }
  if (codes.has('forced-after-three-withholds')) {
    return innerVoice + '此前已经连续三次没有开口，这一轮到达上限，他必须来找你。';
  }
  const descriptions = {
    held_disabled: '他已经决定表达，但发送门禁仍然关闭。',
    submitting: '他已经决定来找你，主动意图正在交给 Aru。',
    submitted: '他已经决定来找你，Aru 也接收了这次主动唤醒。',
    held_claimed: '这次想法已经有发送记录，因此没有重复提交。',
    delivery_failed: '他已经决定来找你，但发送结果还没有确认，意图会继续保留。',
  };
  return innerVoice + (descriptions[entry.outcome] || '这次醒来已经留下了决定。');
}

function renderTimeline(timeline, total) {
  elements.timelineCount.textContent = total + ' 条';
  if (timeline.length === 0) {
    elements.timelineList.replaceChildren(
      text('p', '心跳尚未开启，第一轮推进后会从这里开始记录。', 'empty'),
    );
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of timeline.slice(0, 10)) {
    const item = document.createElement('article');
    item.className = 'timeline-entry timeline--' + entry.outcome;
    const heading = document.createElement('div');
    heading.className = 'timeline-heading';
    heading.append(
      text('time', formatClock(entry.at), 'timeline-time'),
      text('strong', entry.outcomeLabel, 'timeline-title'),
    );
    const chips = document.createElement('div');
    chips.className = 'timeline-chips';
    if (entry.drive) chips.append(text('span', entry.driveLabel));
    if (entry.intent) chips.append(text('span', entry.intentLabel));
    const reason = entry.reasons.length ? entry.reasons.join(' · ') : '正常推进';
    const metrics = entry.drives
      .map((drive) => drive.label + ' ' + formatPercent(drive.valuePercent))
      .join(' · ');
    item.append(
      heading,
      chips,
      text('p', timelineDescription(entry), 'timeline-copy'),
      text('p', reason, 'timeline-reason'),
      text('p', metrics, 'timeline-metrics'),
      text('p', '下次检查 ' + formatClock(entry.nextCheckAt), 'timeline-next'),
    );
    fragment.append(item);
  }
  elements.timelineList.replaceChildren(fragment);
}

function runtimeRow(label, value) {
  const wrapper = document.createElement('div');
  wrapper.className = 'runtime-row';
  wrapper.append(text('dt', label), text('dd', value));
  return wrapper;
}

function renderRuntime(snapshot) {
  const heartbeat = snapshot.heartbeat.recentlyObserved
    ? '最近有推进'
    : '可能暂停或延迟';
  const delivery = snapshot.gates.observeOnly || !snapshot.gates.deliveryEnabled
    ? '未开启'
    : '已允许';
  const pending = snapshot.pendingDecision
    ? snapshot.pendingDecision.intentLabel + ' · 等待处理'
    : '无';
  const soloStatus = snapshot.solo.cooldownActive
    ? '冷却至 ' + formatTime(snapshot.solo.refractoryUntil)
    : snapshot.solo.enabled ? '可自主选择' : '未开启';
  elements.runtimeList.replaceChildren(
    runtimeRow('心跳间隔', Math.round(snapshot.heartbeat.intervalSeconds / 60) + ' 分钟'),
    runtimeRow('心跳迹象', heartbeat),
    runtimeRow('按状态推算的下次检查', formatTime(snapshot.nextCheckAt)),
    runtimeRow('自动发送门禁', delivery),
    runtimeRow('待处理意图', pending),
    runtimeRow('Solo 状态', soloStatus),
    runtimeRow(
      '连续没开口',
      snapshot.expression.consecutiveWithholds + ' / ' +
        snapshot.expression.maxConsecutiveWithholds + ' 次',
    ),
    runtimeRow('Solo 次数', String(snapshot.solo.count)),
    runtimeRow('模型调用', '面板读取、心理活动与 Solo 均不调用'),
  );
}

function render(snapshot) {
  elements.livePill.classList.toggle('stale', !snapshot.heartbeat.recentlyObserved);
  elements.liveLabel.textContent = snapshot.heartbeat.recentlyObserved ? 'Live' : '状态静止';
  elements.strongestHeading.textContent = snapshot.strongest.label;
  elements.strongestValue.textContent = formatPercent(snapshot.strongest.valuePercent);
  elements.intentLabel.textContent = '当前倾向：' + snapshot.expression.intentLabel;
  elements.expressionLabel.textContent = snapshot.expression.label +
    '；达到 78% 后自主决定，连续三次没开口则下次必须联系';
  elements.updatedAt.textContent = '更新于 ' + formatTime(snapshot.stateUpdatedAt);
  renderDrives(snapshot.drives);
  renderTimeline(snapshot.timeline ?? [], snapshot.timelineTotal ?? 0);
  renderThoughts(snapshot.thoughts);
  renderRuntime(snapshot);
}

async function refresh() {
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!response.ok) throw new Error('snapshot unavailable');
    render(await response.json());
    elements.errorToast.hidden = true;
  } catch {
    elements.errorToast.hidden = false;
    elements.livePill.classList.add('stale');
    elements.liveLabel.textContent = '读取失败';
  }
}

refresh();
setInterval(refresh, 15000);
