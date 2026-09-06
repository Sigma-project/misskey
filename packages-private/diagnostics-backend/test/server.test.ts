/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { forkBackendServer, getRuntimeMemoryUsage, requestHeapSnapshot, shutdownBackendServer, triggerGc, waitForMessage, waitForServerReady } from '../src/measure/server';
import type { ChildProcess } from 'node:child_process';

describe('forkBackendServer', () => {
	test.each([
		{ legacy: false, oldGc: true },
		{ legacy: true, oldGc: true },
		{ legacy: true, oldGc: false },
	])('supports legacy=$legacy with existing GC=$oldGc', async ({ legacy, oldGc }) => {
		const dir = mkdtempSync(join(tmpdir(), 'diagnostics-backend-'));
		let child: ChildProcess | undefined;
		try {
			mkdirSync(join(dir, 'built/boot'), { recursive: true });
			const ipc = `${oldGc ? 'process.on("message", msg => { if (msg === "gc") { global.gc(); process.send("gc ok"); } });' : ''} process.send('ok');`;
			writeFileSync(join(dir, 'built/boot/entry.js'), legacy ? ipc : 'throw new Error(\'legacy entry must not run\');');
			if (!legacy) {
				writeFileSync(join(dir, 'built/entry.js'), `process.on('message', msg => { if (msg === 'memory usage') process.send({type:'memory usage', value:process.memoryUsage()}); }); ${ipc}`);
			}
			child = forkBackendServer(dir);
			await waitForServerReady(child, 5000);
			const gcReplies: unknown[] = [];
			child.on('message', message => { if (message === 'gc ok') gcReplies.push(message); });
			await triggerGc(child, 5000);
			const memory = await getRuntimeMemoryUsage(child, 5000);
			expect(gcReplies).toEqual(['gc ok']);
			expect(memory.HeapUsed).toBeGreaterThan(0);
			if (legacy) {
				const snapshot = join(dir, 'snapshot.heapsnapshot');
				expect(await requestHeapSnapshot(child, snapshot, 10000)).toBe(snapshot);
				expect(statSync(snapshot).size).toBeGreaterThan(0);
				await expect(requestHeapSnapshot(child, join(dir, 'missing/snapshot'), 5000)).rejects.toThrow('Failed to write heap snapshot');
			} else {
				expect(child.spawnargs).not.toContain('--require');
			}
		} finally {
			if (child) await shutdownBackendServer(child);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** waitForMessage が使うのは message/exit/error/disconnect の購読だけなので EventEmitter で足りる */
function createFakeServer() {
	return new EventEmitter() as unknown as ChildProcess;
}

function isPing(message: unknown): message is 'ping' {
	return message === 'ping';
}

describe('waitForMessage', () => {
	test('resolves with the first matching message', async () => {
		const server = createFakeServer();
		const received = waitForMessage(server, isPing, 'ping', 1_000);

		server.emit('message', 'noise');
		server.emit('message', 'ping');

		await expect(received).resolves.toBe('ping');
	});

	// 子が死んだあとメッセージは来ないので、タイムアウトまで待たずに理由を添えて失敗させる
	test('rejects immediately when the server exits', async () => {
		const server = createFakeServer();
		const received = waitForMessage(server, isPing, 'ping', 60_000);

		server.emit('exit', 1, null);

		await expect(received).rejects.toThrow(/Server exited \(code=1, signal=null\) while waiting for ping/);
	});

	test('rejects immediately when the server errors', async () => {
		const server = createFakeServer();
		const received = waitForMessage(server, isPing, 'ping', 60_000);

		server.emit('error', new Error('spawn failed'));

		await expect(received).rejects.toThrow(/spawn failed/);
	});

	test('rejects immediately when the IPC channel closes', async () => {
		const server = createFakeServer();
		const received = waitForMessage(server, isPing, 'ping', 60_000);

		server.emit('disconnect');

		await expect(received).rejects.toThrow(/IPC channel closed/);
	});

	test('rejects on timeout', async () => {
		const server = createFakeServer();
		await expect(waitForMessage(server, isPing, 'ping', 1)).rejects.toThrow(/Timed out waiting for ping/);
	});

	// 待機が終わった後もリスナーが残っていると、ラウンドを重ねるごとに積み上がる
	test('removes every listener once settled', async () => {
		const server = createFakeServer();
		const emitter = server as unknown as EventEmitter;
		const received = waitForMessage(server, isPing, 'ping', 1_000);

		server.emit('message', 'ping');
		await received;

		for (const event of ['message', 'exit', 'error', 'disconnect']) {
			expect(emitter.listenerCount(event)).toBe(0);
		}
	});
});
