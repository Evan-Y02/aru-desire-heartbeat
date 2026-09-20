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
  const descriptions = {
    idle: '这一轮状态自然演进，没有形成需要说出口的意图。',
    withheld: '旧版概率门控曾在这一轮选择不说；新版达到门槛后必定行动。',
    held_disabled: '已经形成主动意图，但发送门禁仍然关闭。',
    submitting: '主动意图已经形成，正在交给 Aru。',
    submitted: 'Aru 已接收这次主动唤醒。',
    held_claimed: '这次意图已有发送记录，没有重复提交。',
    delivery_failed: '主动意图仍被保留，发送结果没有确认。',
    solo_completed: '性欲达到门槛，本轮选择独处消解并完成回落。',
  };
  return descriptions[entry.outcome] || '这一轮已经留下记录。';
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
    runtimeRow('Solo 次数', String(snapshot.solo.count)),
    runtimeRow('模型调用', '面板读取与 Solo 均不调用'),
  );
}

function render(snapshot) {
  elements.livePill.classList.toggle('stale', !snapshot.heartbeat.recentlyObserved);
  elements.liveLabel.textContent = snapshot.heartbeat.recentlyObserved ? 'Live' : '状态静止';
  elements.strongestHeading.textContent = snapshot.strongest.label;
  elements.strongestValue.textContent = formatPercent(snapshot.strongest.valuePercent);
  elements.intentLabel.textContent = '当前倾向：' + snapshot.expression.intentLabel;
  elements.expressionLabel.textContent = snapshot.expression.label + '；达到门槛后必须执行，不再随机沉默';
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