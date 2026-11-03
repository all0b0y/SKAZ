import { expect, it } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { BridgeRequest } from '../../api/bridge';
import { KbClient } from '../api/client';
import { createFakeBridge } from '../test/fakeBridge';
import { serveFake } from '../test/fakeKb';
import { createAgentsStore } from './agents';

it('an installation owns one monitor outside any card; hiding progress does not cancel or stop it', async () => {
  const fake = createFakeBridge();
  const requests: BridgeRequest[] = [];
  let release!: () => void;
  const response = new Promise<void>((resolve) => { release = resolve; });
  fake.requestMock.mockImplementation(async (request) => {
    requests.push(request);
    if (request.method === 'GET' && request.path.startsWith('/kb/agents/install/')) await response;
    return serveFake(fake.world, request) ?? { ok: false, status: 404, detail: 'Unknown route' };
  });
  const store = createAgentsStore(new KbClient(fake.bridge));
  const reads = () => requests.filter((r) => r.method === 'GET' && r.path.startsWith('/kb/agents/install/'));
  try {
    expect((await store.getState().install('codex')).ok).toBe(true);
    expect(reads()).toHaveLength(1);
    const task = store.getState().installs.codex!.task;
    const first = store.getState().followInstall('codex', task.id);
    expect(store.getState().followInstall('codex', task.id)).toBe(first);
    expect(reads()).toHaveLength(1);
    expect(store.getState().installDialog).toBe('codex');
    store.getState().closeInstallDialog();
    expect(store.getState().installDialog).toBeNull();
    store.getState().showInstall('codex');
    store.getState().closeInstallDialog();
    expect(reads()).toHaveLength(1);
    fake.world.installTasks[task.id]!.state = 'succeeded';
    release();
    await waitFor(() => expect(store.getState().installs.codex?.task.state).toBe('succeeded'));
    expect(requests.some((r) => r.path.endsWith('/cancel'))).toBe(false);
  } finally {
    release();
    store.getState().stopMonitoring();
  }
});

it('a confirmed cancel clears a prior read error and preserves the final output returned by the backend', async () => {
  const fake = createFakeBridge();
  fake.requestMock.mockImplementation(async (request) => {
    if (request.method === 'GET' && request.path.startsWith('/kb/agents/install/')) {
      return { ok: false as const, status: 404, detail: 'The task could not be read.' };
    }
    return serveFake(fake.world, request) ?? { ok: false as const, status: 404, detail: 'Unknown route' };
  });
  const store = createAgentsStore(new KbClient(fake.bridge));
  try {
    await store.getState().install('codex');
    await waitFor(() => expect(store.getState().installErrors.codex).toBeDefined());
    const task = store.getState().installs.codex!.task;
    expect(task.state).toBe('running');
    expect(fake.calls.some((c) => c.path.endsWith('/cancel'))).toBe(false);
    const serverTask = fake.world.installTasks[task.id]!;
    serverTask.lines.push({ ...serverTask.lines[0]!, seq: serverTask.cursor + 1, text: 'Final installer output' });
    serverTask.cursor += 1;
    expect((await store.getState().cancelInstall('codex')).ok).toBe(true);
    expect(store.getState().installs.codex!.task.state).toBe('cancelled');
    expect(store.getState().installErrors.codex).toBeUndefined();
    expect(store.getState().installs.codex!.lines.at(-1)?.text).toBe('Final installer output');
  } finally { store.getState().stopMonitoring(); }
});

it('an older agents snapshot cannot replace observation of a newer task of the same engine', async () => {
  const fake = createFakeBridge();
  const reads: string[] = [];
  let releaseAgents!: () => void;
  let releaseTasks!: () => void;
  const agentsReply = new Promise<void>((r) => { releaseAgents = r; });
  const taskReplies = new Promise<void>((r) => { releaseTasks = r; });
  fake.requestMock.mockImplementation(async (request) => {
    const reply = serveFake(fake.world, request) ?? { ok: false as const, status: 404, detail: 'Unknown route' };
    if (request.method === 'GET' && request.path === '/kb/agents') await agentsReply;
    if (request.method === 'GET' && request.path.startsWith('/kb/agents/install/')) {
      reads.push(request.path); await taskReplies;
    }
    return reply;
  });
  const store = createAgentsStore(new KbClient(fake.bridge));
  try {
    await store.getState().install('codex');
    const first = store.getState().installs.codex!.task.id;
    const oldSnapshot = store.getState().refresh();
    fake.world.installTasks[first]!.state = 'succeeded';
    await store.getState().install('codex');
    const next = store.getState().installs.codex!.task.id;
    expect(next).not.toBe(first);
    releaseAgents(); await oldSnapshot;
    expect(reads).toEqual([`/kb/agents/install/${first}`, `/kb/agents/install/${next}`]);
    expect(store.getState().installs.codex?.task.id).toBe(next);
  } finally {
    store.getState().stopMonitoring(); releaseAgents(); releaseTasks();
  }
});
