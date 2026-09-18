/**
 * The Pay agent's pilot list (lib/shadow-list.js).
 *
 * This is a BEHAVIOUR test: it imports the module and runs it. The gate used
 * to live inside the processor, where the only way to test it was to slice
 * the function out of the source text with string offsets and eval it, which
 * asserted the shape of a line of code rather than what the code does. It is
 * the first of the source-text locks to be rewritten (docs/HANDOVER_V1.5.md
 * section 4 item 5), and the pattern the rest should follow.
 *
 * What it protects: promotion into Phase 3 is measured in real agent turns,
 * so a list that silently matches nobody costs a week of calendar and looks
 * exactly like a quiet week while it does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentV3For, shadowListEntries, shadowListDiagnostics } from '../lib/shadow-list.js';

const withList = (value, fn) => {
  const prev = process.env.WAPAY_AGENT_V3_MSISDNS;
  if (value === undefined) delete process.env.WAPAY_AGENT_V3_MSISDNS;
  else process.env.WAPAY_AGENT_V3_MSISDNS = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.WAPAY_AGENT_V3_MSISDNS;
    else process.env.WAPAY_AGENT_V3_MSISDNS = prev;
  }
};

test('an unset list is nobody, never everybody', () => {
  withList(undefined, () => {
    assert.equal(agentV3For('27787051175'), false);
    assert.equal(shadowListEntries().length, 0);
  });
  withList('', () => assert.equal(agentV3For('27787051175'), false));
  withList('  ,  ,', () => assert.equal(agentV3For('27787051175'), false));
});

test('a listed number matches however a human wrote it in the dashboard', () => {
  // Every one of these is the same phone. Before 2026-09-18 only the first
  // matched, and the other three started a pilot week that could never accrue.
  for (const written of ['27787051175', '+27787051175', '0787051175', '+27 78 705 1175', ' 27787051175 ']) {
    withList(written, () => {
      assert.equal(agentV3For('27787051175'), true, `list written as "${written}" must match the wa_id Meta sends`);
    });
  }
});

test('the wa_id is matched however it arrives, and a second entry does not disturb the first', () => {
  withList('0787051175, 27600000901', () => {
    assert.equal(agentV3For('27787051175'), true);
    assert.equal(agentV3For('0787051175'), true);
    assert.equal(agentV3For('27600000901'), true);
  });
});

test('normalising never widens the list to a different number', () => {
  withList('27600000901, 27831112222', () => {
    assert.equal(agentV3For('27600000901'), true);
    assert.equal(agentV3For('27831112222'), true);
    assert.equal(agentV3For('2760000090'), false, 'no prefix');
    assert.equal(agentV3For('276000009011'), false, 'no superstring');
    assert.equal(agentV3For('27600000902'), false, 'a different number');
    assert.equal(agentV3For(''), false);
    assert.equal(agentV3For(null), false);
    assert.equal(agentV3For(undefined), false);
  });
});

test('the diagnostics say what is wrong with an entry without ever printing a whole number', () => {
  withList('27787051175, nonsense', () => {
    const [ok, bad] = shadowListDiagnostics();
    assert.equal(ok.tail, '1175');
    assert.equal(ok.valid, true);
    assert.equal(ok.waId, '27787051175', 'the account lookup form');
    assert.equal(bad.valid, false, 'an unreadable entry is reported, not silently ignored');
    for (const entry of shadowListDiagnostics()) {
      assert.ok(!entry.tail || entry.tail.length <= 4, 'never more than the last four digits');
    }
  });
});
