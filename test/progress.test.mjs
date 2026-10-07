import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { ClaudeExecutionError, ClaudeRunner } from "../dist/claude.js";
import { ProgressReporter, progressMessage } from "../dist/progress.js";
import { fixture, waitForMarker, assertExited } from "./helpers.mjs";

const snapshot = (count = 0) => ({ phase: "inference", elapsedMs: count,
  responseEventCount: count, lastResponseEventAgeMs: null, retryEventCount: 0 });

test("blocked notification delivery coalesces bursts and stops without draining", async () => {
  let release;
  const sent = [];
  const reporter = new ProgressReporter(value => {
    sent.push({ value, time: performance.now() });
    return new Promise(resolve => { release = resolve; });
  });
  try {
    reporter.update(snapshot());
    for (let i = 1; i <= 1000; i++) reporter.update(snapshot(i));
    await delay(1050);
    assert.equal(sent.length, 1);
    release();
    await delay(20);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].value.responseEventCount, 1000);
    assert.ok(sent[1].time - sent[0].time >= 1000);
    reporter.update(snapshot(2000));
    reporter.stop();
    release();
    reporter.update(snapshot(3000));
    await delay(1050);
    assert.equal(sent.length, 2);
  } finally { reporter.stop(); }
});

for (const mode of ["throw", "reject"]) {
  test(`notification ${mode} is isolated and stopping drops a scheduled update`, async () => {
    let calls = 0;
    const reporter = new ProgressReporter(() => {
      calls++;
      if (mode === "throw") throw new Error("synthetic-sensitive-observer");
      return Promise.reject(new Error("synthetic-sensitive-observer"));
    });
    reporter.update(snapshot());
    reporter.update(snapshot(1));
    await delay(20);
    reporter.stop();
    await delay(1050);
    assert.equal(calls, 1);
  });
}

for (const mode of ["throw", "reject", "never"]) {
  test(`a ${mode} observer cannot prevent a verified answer or runner shutdown`, async t => {
    const { binary } = await fixture(t);
    const runner = new ClaudeRunner({ binary, timeoutMs: 1000 });
    t.after(() => runner.close());
    let calls = 0;
    const result = await runner.run({ prompt: "exact answer", model: "opus", effort: "high" },
      new AbortController().signal, () => {
        calls++;
        if (mode === "throw") throw new Error("synthetic-sensitive-observer");
        if (mode === "reject") return Promise.reject(new Error("synthetic-sensitive-observer"));
        return new Promise(() => {});
      });
    assert.equal(result.answer, "exact answer");
    assert.equal(result.metadata.effectiveModelVerified, true);
    assert.equal(result.metadata.effectiveEffortVerified, true);
    await runner.close();
    await delay(1050);
    assert.equal(calls, 1);
  });
}

for (const operation of ["timeout", "cancel", "shutdown"]) {
  test(`${operation} freezes observations and stops reporting before child cleanup`, async t => {
    const { binary, directory } = await fixture(t);
    const runner = new ClaudeRunner({ binary, timeoutMs: 1200 });
    t.after(() => runner.close());
    const controller = new AbortController();
    const updates = [];
    const marker = resolve(directory, "ready");
    const request = runner.run({ prompt: JSON.stringify({ scenario: "progress", hang: true,
      marker, frames: [{ type: "system", subtype: "api_retry", attempt: 3,
        max_retries: 1, retry_delay_ms: 10, error_status: null }] }) }, controller.signal,
    value => { updates.push(value); });
    const rejected = assert.rejects(request, error => {
      assert.ok(error instanceof ClaudeExecutionError);
      assert.equal(error.diagnostics.failureCategory, operation === "timeout" ? "timeout" : "cancelled");
      assert.equal(error.diagnostics.responseEventCount, 0);
      assert.equal(error.diagnostics.lastResponseEventAgeMs, null);
      assert.equal(error.diagnostics.retryEventCount, 1);
      assert.equal(error.diagnostics.cleanupStatus, "close_observed");
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /synthetic-sensitive/);
      return true;
    });
    const pid = await waitForMarker(marker);
    if (operation === "cancel") controller.abort();
    if (operation === "shutdown") await runner.close();
    await rejected;
    assertExited(assert, pid);
    const count = updates.length;
    await delay(1100);
    assert.equal(updates.length, count);
    assert.doesNotMatch(updates.map(progressMessage).join("\n"), /synthetic-sensitive|stalled|thinking/);
  });
}

test("response/thinking and retry payloads cannot leak through observations or diagnostics", async t => {
  const { binary } = await fixture(t);
  const runner = new ClaudeRunner({ binary, timeoutMs: 1500 });
  t.after(() => runner.close());
  const updates = [];
  await assert.rejects(runner.run({ prompt: JSON.stringify({ scenario: "progress", hang: true,
    private: "synthetic-sensitive-prompt", frames: [
      { type: "assistant", parent_tool_use_id: null, message: {
        role: "assistant", model: "claude-opus-5-5", content: [
          { type: "text", text: "synthetic-sensitive-answer 한국어" },
          { type: "thinking", thinking: "synthetic-sensitive-thinking" },
        ] } },
      { type: "assistant", parent_tool_use_id: "synthetic-sensitive-auxiliary", message: {
        role: "assistant", model: "claude-opus-5-5", content: [
          { type: "text", text: "synthetic-sensitive-aux-answer" },
        ] } },
      { type: "system", subtype: "api_retry", attempt: 9, max_retries: 1,
        retry_delay_ms: 1, error_status: 529, error: "synthetic-sensitive-error" },
      { type: "system", subtype: "api_retry", attempt: 10, max_retries: 1,
        retry_delay_ms: 1, error_status: null, no_response: { secret: "synthetic-sensitive" } },
      ...Array.from({ length: 1000 }, () => ({ type: "unknown", text: "synthetic-sensitive-burst" })),
    ] }) }, new AbortController().signal, value => { updates.push(value); }), error => {
    assert.equal(error.diagnostics.failureCategory, "timeout");
    assert.equal(error.diagnostics.responseEventCount, 1);
    assert.equal(error.diagnostics.retryEventCount, 2);
    assert.ok(error.diagnostics.lastResponseEventAgeMs > 0);
    assert.doesNotMatch(JSON.stringify(error.diagnostics), /synthetic-sensitive|한국어/);
    return true;
  });
  assert.ok(updates.length >= 2 && updates.length <= 3);
  assert.doesNotMatch(updates.map(progressMessage).join("\n"), /synthetic-sensitive|한국어|thinking/);
});
