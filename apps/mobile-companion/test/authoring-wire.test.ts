// Spec 011 (mobile session authoring) — the pure wire logic behind the authoring UI.
//
// These are the parsers and discipline rules that decide what the user sees after a frame arrives.
// They are tested as pure functions because the interesting cases (a Host that names its id
// `workspaceId` vs `id`, a catalgoue row with no label, a `select-model` receipt that confirms
// someone else's model) are awkward to stage end to end and are exactly where a silent regression
// would repaint the composer with a model the Host never accepted.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTHORING_FORBIDDEN_CODE,
  isAuthoringRefusal,
  parseCurrentModel,
  parseModelItems,
  parseWorkspaceItems,
  receiptConfirmsSelection,
} from '../src/app-state';
import { grantState } from '../src/ui/components/authoring';

describe('workspace parsing', () => {
  it('accepts the Host id under either name and drops rows without one', () => {
    const parsed = parseWorkspaceItems({
      items: [
        { workspaceId: 'ws-1', name: 'DiskTree', path: '/home/me/DiskTree' },
        { id: 'ws-2', name: 'DXVK' },
        { name: 'no id at all' },
        { workspaceId: '' },
        null,
        42,
      ],
    });
    assert.deepEqual(parsed, [
      { id: 'ws-1', name: 'DiskTree', path: '/home/me/DiskTree' },
      { id: 'ws-2', name: 'DXVK' },
    ]);
  });

  it('degrades to an empty list rather than throwing on a malformed reply', () => {
    assert.deepEqual(parseWorkspaceItems({}), []);
    assert.deepEqual(parseWorkspaceItems({ items: 'not-an-array' }), []);
  });
});

describe('model catalogue parsing', () => {
  it('keeps id, label and provider, falling back to name then id for the label', () => {
    assert.deepEqual(
      parseModelItems({
        items: [
          { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash', provider: 'deepseek' },
          { id: 'm-2', name: 'Second' },
          { id: 'm-3' },
          { model: 'm-4', label: 'Fourth' },
          { label: 'no id' },
        ],
      }),
      [
        { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash', provider: 'deepseek' },
        { id: 'm-2', label: 'Second' },
        { id: 'm-3', label: 'm-3' },
        { id: 'm-4', label: 'Fourth' },
      ],
    );
  });

  it('reads a catalogue published under `models` and tolerates an empty reply', () => {
    assert.deepEqual(parseModelItems({ models: [{ id: 'a', label: 'A' }] }), [{ id: 'a', label: 'A' }]);
    assert.deepEqual(parseModelItems({}), []);
  });

  it('flattens the real `groups` reply and inherits each group provider', () => {
    // This is the shape the live Host sends (contract revision 7: `{ current, groups, ... }`).
    // Reading only a flat list left the catalog empty on device, so the model pill never appeared.
    const parsed = parseModelItems({
      current: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      groups: [
        {
          provider: 'deepseek',
          label: 'DeepSeek',
          models: [
            { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash' },
            { model: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
          ],
        },
        { provider: 'other', items: [{ id: 'o-1', label: 'O1' }] },
      ],
    });
    assert.deepEqual(parsed, [
      { id: 'deepseek-v4-flash', label: 'DeepSeek-V4-Flash', provider: 'deepseek' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro', provider: 'deepseek' },
      { id: 'o-1', label: 'O1', provider: 'other' },
    ]);
  });

  it('parses the session current selection when the reply carries one', () => {
    assert.deepEqual(parseCurrentModel({ current: { model: 'm-1', label: 'One', reasoningEffort: 'high' } }), {
      id: 'm-1',
      label: 'One',
      reasoningEffort: 'high',
    });
    assert.deepEqual(parseCurrentModel({ current: { id: 'm-2' } }), { id: 'm-2' });
    assert.equal(parseCurrentModel({ current: {} }), null);
    assert.equal(parseCurrentModel({}), null);
  });
});

describe('select-model receipt discipline', () => {
  const requested = { provider: 'deepseek', model: 'deepseek-v4-flash' };

  it('applies a receipt that echoes exactly the requested selection', () => {
    assert.equal(receiptConfirmsSelection({ selected: { provider: 'deepseek', model: 'deepseek-v4-flash' } }, requested), true);
    assert.equal(receiptConfirmsSelection({ provider: 'deepseek', model: 'deepseek-v4-flash' }, requested), true);
  });

  it('DISCARDS a receipt for a different model (upstream discipline)', () => {
    // The host accepted *a* selection, but not ours: keeping the old value is the only honest move.
    assert.equal(receiptConfirmsSelection({ selected: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, requested), false);
    assert.equal(receiptConfirmsSelection({ selected: { provider: 'other', model: 'deepseek-v4-flash' } }, requested), false);
    assert.equal(receiptConfirmsSelection({ provider: 'deepseek', model: 'deepseek-v4-pro' }, requested), false);
  });

  it('treats an incomplete or unrelated receipt as unconfirmed', () => {
    assert.equal(receiptConfirmsSelection({ selected: { model: 'deepseek-v4-flash' } }, requested), false);
    assert.equal(receiptConfirmsSelection({ kind: 'error' }, requested), false);
    assert.equal(receiptConfirmsSelection({}, requested), false);
  });

  it('accepts a bare acknowledgement whose kind is the receipt itself', () => {
    assert.equal(receiptConfirmsSelection({ kind: 'select-model' }, requested), true);
  });
});

describe('permission refusals stay distinguishable', () => {
  it('uses the wire code for a device without sessions:author', () => {
    assert.equal(AUTHORING_FORBIDDEN_CODE, 'auth/forbidden-scope');
    assert.equal(isAuthoringRefusal(AUTHORING_FORBIDDEN_CODE), true);
    assert.equal(isAuthoringRefusal('op/forbidden'), true);
  });

  it('never treats a transport failure as a permission refusal', () => {
    for (const code of ['client/timeout', 'client/disconnected', 'client/bad-state', 'auth/revoked']) {
      assert.equal(isAuthoringRefusal(code), false, `${code} is not a refusal`);
    }
  });
});

describe('grant state drives the controls (recap of the snapshot contract)', () => {
  it('an empty scopes list is UNKNOWN, a scope-less grant is DENIED, and the scope is GRANTED', () => {
    assert.equal(grantState([]), 'unknown');
    assert.equal(grantState(['sessions:read', 'prompt:send']), 'denied');
    assert.equal(grantState(['sessions:read', 'sessions:author']), 'granted');
  });
});
