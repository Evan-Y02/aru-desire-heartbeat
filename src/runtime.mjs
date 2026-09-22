import { deliverPending, DeliveryError } from '../delivery/aru-adapter.mjs';
import { satisfySoloDecision, tickState } from './engine.mjs';
import { SOLO_INTENT } from './constants.mjs';
import { atomicSaveState, loadState } from './storage.mjs';
import { withLock } from './security.mjs';
import {
  appendTimeline,
  createTimelineEntry,
  finishLatestTimeline,
} from './timeline.mjs';

export async function runHeartbeatCycle({
  dataDirectory,
  heartbeatConfig,
  deliveryConfig,
  submitEvent,
  nowMs = Date.now(),
}) {
  return withLock(dataDirectory, async (directory) => {
    const previous = await loadState(directory, heartbeatConfig);
    const tick = tickState(previous, heartbeatConfig, nowMs);
    const pending = tick.state.pendingDecision;
    const isSolo = pending?.intent === SOLO_INTENT;
    const deliveryDisabled = heartbeatConfig.observeOnly ||
      !heartbeatConfig.deliveryEnabled || !deliveryConfig.enabled;
    const actionDisabled = heartbeatConfig.observeOnly ||
      (isSolo ? !heartbeatConfig.solo.enabled : deliveryDisabled);
    const extraReasons = [];
    let status = 'idle';

    if (tick.expression?.expressed === false) {
      status = 'withheld';
      extraReasons.push('expression-withheld');
      const countReason = {
        1: 'withheld-first',
        2: 'withheld-second',
        3: 'withheld-third',
      }[tick.expression.withholdCount];
      if (countReason) extraReasons.push(countReason);
    } else if (pending && actionDisabled) {
      status = 'held_disabled';
      if (!isSolo && !deliveryConfig.enabled) extraReasons.push('delivery-adapter-disabled');
    } else if (pending && isSolo) {
      status = 'solo_completed';
      extraReasons.push('solo-completed');
    } else if (pending) {
      status = 'submitting';
    }
    if (tick.expression?.expressed === true) {
      extraReasons.push('expression-chosen');
      if (tick.expression.forcedReason) extraReasons.push(tick.expression.forcedReason);
    }

    if (pending || tick.expression !== null) {
      appendTimeline(
        tick.state,
        createTimelineEntry(tick, heartbeatConfig, nowMs, status, extraReasons),
      );
    }

    if (pending && isSolo && !actionDisabled) {
      const completed = satisfySoloDecision(
        tick.state, heartbeatConfig, pending.id, nowMs,
      );
      await atomicSaveState(directory, completed, heartbeatConfig);
      return {
        status,
        state: completed,
        elapsedSeconds: tick.elapsedSeconds,
        decisionId: pending.id,
        intent: pending.intent,
      };
    }

    // Persist an outbound decision and its audit entry before any external side effect.
    await atomicSaveState(directory, tick.state, heartbeatConfig);

    if (!pending) {
      return {
        status,
        state: tick.state,
        elapsedSeconds: tick.elapsedSeconds,
        candidate: tick.candidate,
        expression: tick.expression,
      };
    }
    if (actionDisabled) {
      return {
        status,
        state: tick.state,
        elapsedSeconds: tick.elapsedSeconds,
        decisionId: pending.id,
        intent: pending.intent,
      };
    }

    try {
      const delivery = await deliverPending({
        state: tick.state,
        heartbeatConfig,
        deliveryConfig,
        dataDirectory: directory,
        submitEvent,
        nowMs,
      });
      finishLatestTimeline(delivery.state, nowMs, 'submitted', ['delivery-accepted']);
      await atomicSaveState(directory, delivery.state, heartbeatConfig);
      return {
        status: 'submitted',
        state: delivery.state,
        elapsedSeconds: tick.elapsedSeconds,
        decisionId: delivery.decisionId,
        intent: delivery.intent,
      };
    } catch (error) {
      if (error instanceof DeliveryError &&
          error.code === 'DELIVERY_ALREADY_CLAIMED') {
        finishLatestTimeline(
          tick.state, nowMs, 'held_claimed', ['delivery-already-claimed'],
        );
        await atomicSaveState(directory, tick.state, heartbeatConfig);
        return {
          status: 'held_claimed',
          state: tick.state,
          elapsedSeconds: tick.elapsedSeconds,
          decisionId: pending.id,
          intent: pending.intent,
        };
      }
      finishLatestTimeline(tick.state, nowMs, 'delivery_failed', ['delivery-failed']);
      await atomicSaveState(directory, tick.state, heartbeatConfig);
      throw error;
    }
  });
}
