import { describe, it, expect } from 'vitest';
import { inspect } from '../src/inspection.js';
import { assessContext } from '../src/context.js';
import { fakeJev, testConfig } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { assessWorkflow } from '../src/context.js';
describe('private input inspection', () => {
  it('redacts known credentials and sensitive fields without removing evidence', () => {
    expect(inspect({ evidence: 'works offline KEY_VALUE', password: 'hidden', text: 'Bearer abc' }, ['KEY_VALUE'])).toEqual({ evidence: 'works offline [REDACTED]', password: '[REDACTED]', text: 'Bearer [REDACTED]' });
  });
  it('records the received decision and actual JEV request only when enabled', async () => {
    const input = { system: '', turns: [{ role: 'user' as const, text: 'Choose offline' }], tools: [], toolChoice: 'auto' as const };
    const context = { kind: 'comparison' as const, candidates: [{ id: 'a', text: 'offline' }, { id: 'b', text: 'online' }] };
    for (const enabled of [false, true]) {
      const f = fakeJev({ selection: { choice: 'a' } });
      const r = await assessContext(input, context, { ...testConfig(), contextRouting: true, inspectInputs: enabled }, f.askJev);
      if (enabled) {
        expect(r.inspection?.requests).toEqual(f.requests);
        expect(r.inspection?.received).toEqual({ input, context });
      } else expect(r.inspection).toBeUndefined();
    }
  });
  it('defaults to eight seconds and enforces maximum fifteen seconds', () => {
    expect(loadConfig({}).jevTimeoutMs).toBe(8000);
    expect(() => loadConfig({ JEV_TIMEOUT_MS: '16000' })).toThrow();
  });
  it.each(['/master/context', '/router/decide'])('keeps inspection in the dashboard only for %s', async (path) => {
    const f = fakeJev({ selection: { choice: 'a' } });
    const config = testConfig({ contextRouting: true, inspectInputs: true, jevApiKey: 'fixture-private-key' });
    const app = createApp({ config, askJev: f.askJev });
    const objective = 'Private evidence fixture-private-key';
    const context = { kind: 'comparison', candidates: [{ id: 'a', text: 'offline' }, { id: 'b', text: 'online' }] };
    const body = path === '/master/context' ? { objective, context }
      : { model: 'test', messages: [{ role: 'user', content: objective }], master_context: context };
    const response = await app.request(path, { method: 'POST', body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(path === '/master/context' ? result : result.context).toMatchObject({ assessments: { selection: { choice: 'a' } } });
    expect(JSON.stringify(result)).not.toContain('inspection');
    expect(JSON.stringify(result)).not.toContain('Private evidence');
    const feed = await (await app.request('/dashboard/events')).json();
    expect(feed.events[0].context.inspection.requests).toHaveLength(1);
    expect(JSON.stringify(feed)).toContain('Private evidence [REDACTED]');
    expect(JSON.stringify(feed)).not.toContain('fixture-private-key');
    expect(JSON.stringify(f.requests)).toContain(objective);
  });
  it('captures workflow calls in order without changing the submitted data', async () => {
    const f = fakeJev({ first: { choice: 'yes' }, second: { choice: 'yes' } });
    const question = { type: 'choice', instructions: 'Choose', criteria: { yes: 'yes', no: 'no' } };
    const raw = { state: { token: 'private-token', evidence: 'fixture' }, stages: [
      { id: 'one', questions: { first: question } },
      { id: 'two', when: { question: 'first', equals: 'yes' }, questions: { second: question } },
    ] };
    const snapshots: unknown[] = [];
    const result = await assessWorkflow(raw, testConfig({ inspectInputs: true }), (request) => {
      snapshots.push(structuredClone(request));
      return f.askJev(request);
    });
    expect(result.calls).toBe(2);
    expect(result.inspection?.requests).toEqual(inspect(snapshots));
    expect(result.inspection?.received).toEqual(inspect(raw));
    expect(JSON.stringify(result.inspection)).not.toContain('private-token');
    expect(JSON.stringify(f.requests)).toContain('private-token');
  });
});
