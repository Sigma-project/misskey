/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WasmVipsService } from '@/core/WasmVipsService.js';
import type { ChildProcess } from 'node:child_process';
import type { ConversionRequest, ConversionResponse } from '@/core/workers/wasm-vips.mjs';

vi.mock('node:child_process', () => ({ fork: vi.fn() }));

class FakeChild extends EventEmitter {
	pid: number | undefined = 123;
	connected = true;
	channel = { ref: vi.fn(), unref: vi.fn() };
	ref = vi.fn();
	unref = vi.fn();
	sendError?: Error;
	onRequest?: (request: ConversionRequest) => void;
	send = vi.fn((request: ConversionRequest, callback: (error: Error | null) => void) => {
		callback(this.sendError ?? null);
		this.onRequest?.(request);
		return true;
	});
	disconnect = vi.fn(() => {
		this.connected = false;
		this.emit('disconnect');
	});
	kill = vi.fn(() => {
		this.close();
		return true;
	});

	reply(message: ConversionResponse): void { this.emit('message', message); }
	ready(): void { this.reply({ type: 'ready' }); }
	succeed(): void { this.reply({ type: 'result', data: Buffer.from('jxl') }); }
	close(): void {
		this.connected = false;
		this.emit('close', 0, null);
	}
}

let service: WasmVipsService;
let children: FakeChild[];
let exitListeners: number;
const flush = () => vi.advanceTimersByTimeAsync(0);
const convert = () => service.convertAnimatedToJxl(Buffer.from('gif'), 374, 317, { lossless: true, effort: 9, distance: 0 });

beforeEach(() => {
	vi.useFakeTimers();
	children = [];
	exitListeners = process.listenerCount('exit');
	vi.mocked(fork).mockImplementation(() => {
		const child = new FakeChild();
		children.push(child);
		return child as unknown as ChildProcess;
	});
	service = new WasmVipsService();
});

afterEach(async () => {
	const shutdown = service.onApplicationShutdown();
	for (const child of children) child.close();
	await vi.advanceTimersByTimeAsync(10_000);
	await shutdown;
	expect(process.listenerCount('exit')).toBe(exitListeners);
	vi.useRealTimers();
});

describe('wasm-vips process lifecycle', () => {
	test('starts lazily, waits for ready, and never interrupts running or queued conversions for idle expiry', async () => {
		expect(fork).not.toHaveBeenCalled();
		const first = convert();
		const second = convert();
		const child = children[0];
		expect(vi.mocked(fork).mock.calls[0]).toEqual([
			new URL('../../src/core/workers/wasm-vips.mjs', import.meta.url),
			[],
			{ serialization: 'advanced', execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
		]);
		expect(child.send).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(child.disconnect).not.toHaveBeenCalled();
		child.ready();
		await flush();
		expect(child.send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(child.disconnect).not.toHaveBeenCalled();
		child.succeed();
		await expect(first).resolves.toMatchObject({ ext: 'jxl', type: 'image/jxl' });
		await flush();
		expect(child.send).toHaveBeenCalledTimes(2);
		child.succeed();
		await second;
		await flush();
		await vi.advanceTimersByTimeAsync(29_999);
		expect(child.disconnect).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(child.disconnect).toHaveBeenCalledOnce();
	});

	test('resets the idle deadline when the process is reused', async () => {
		const first = convert();
		const child = children[0];
		child.ready();
		await flush();
		child.succeed();
		await first;
		await vi.advanceTimersByTimeAsync(20_000);
		const second = convert();
		await flush();
		child.succeed();
		await second;
		await vi.advanceTimersByTimeAsync(20_000);
		expect(child.disconnect).not.toHaveBeenCalled();
		expect(children).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(child.disconnect).toHaveBeenCalledOnce();
	});

	test('waits for the old process to close before replacing it, ignoring its late replies', async () => {
		const first = convert();
		const old = children[0];
		old.ready();
		await flush();
		old.succeed();
		await first;
		await vi.advanceTimersByTimeAsync(30_000);
		const second = convert();
		await flush();
		expect(children).toHaveLength(1);
		old.close();
		await flush();
		expect(children).toHaveLength(2);
		old.succeed();
		const child = children[1];
		child.ready();
		await flush();
		child.succeed();
		await expect(second).resolves.toMatchObject({ data: Buffer.from('jxl') });
	});

	test.each([false, true])('recycles after 100 attempts with queued requests (conversion errors: %s)', async failed => {
		const results = Promise.allSettled(Array.from({ length: 101 }, convert));
		const old = children[0];
		old.onRequest = () => queueMicrotask(() => {
			if (failed) old.reply({ type: 'error', error: { name: 'Error', message: 'invalid image' } });
			else old.succeed();
		});
		old.ready();
		await flush();
		expect(old.send).toHaveBeenCalledTimes(100);
		expect(old.disconnect).toHaveBeenCalledOnce();
		expect(children).toHaveLength(1);
		old.close();
		await flush();
		children[1].onRequest = () => queueMicrotask(() => children[1].succeed());
		children[1].ready();
		await flush();
		const settled = await results;
		expect(settled.filter(result => result.status === 'rejected')).toHaveLength(failed ? 100 : 0);
		expect(settled[100].status).toBe('fulfilled');
	});

	test('recovers from a spawn error without an exit event', async () => {
		const first = expect(convert()).rejects.toThrow('spawn failed');
		children[0].pid = undefined;
		children[0].emit('error', new Error('spawn failed'));
		await first;
		const second = convert();
		await flush();
		children[1].ready();
		await flush();
		children[1].succeed();
		await second;
	});

	test('recovers when fork throws synchronously', async () => {
		vi.mocked(fork).mockImplementationOnce(() => { throw new Error('fork failed'); });
		await expect(convert()).rejects.toThrow('fork failed');
		const next = convert();
		await flush();
		children[0].ready();
		await flush();
		children[0].succeed();
		await next;
	});

	test('rejects a crashed conversion and processes the next request in a new process', async () => {
		const first = expect(convert()).rejects.toThrow('exited');
		const second = convert();
		children[0].ready();
		await flush();
		children[0].close();
		await first;
		await flush();
		children[1].ready();
		await flush();
		children[1].succeed();
		await second;
	});

	test('handles an IPC send error through its callback', async () => {
		const result = expect(convert()).rejects.toThrow('send failed');
		children[0].sendError = new Error('send failed');
		children[0].ready();
		await result;
		expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
	});

	test('rejects a ready process that fails before the request is sent', async () => {
		const result = expect(convert()).rejects.toThrow('IPC failed');
		children[0].ready();
		children[0].emit('error', new Error('IPC failed'));
		await result;
		expect(children[0].send).not.toHaveBeenCalled();
	});

	test('recovers from an unexpected disconnect while a conversion is running', async () => {
		const first = expect(convert()).rejects.toThrow('disconnected');
		const second = convert();
		children[0].ready();
		await flush();
		children[0].kill.mockImplementation(() => true);
		children[0].disconnect();
		await first;
		await flush();
		expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
		expect(children).toHaveLength(1);
		children[0].emit('exit', null, 'SIGKILL');
		await flush();
		children[1].ready();
		await flush();
		children[1].succeed();
		await second;
	});

	test('releases the process on exit even if close is delayed', async () => {
		const first = convert();
		children[0].ready();
		await flush();
		children[0].succeed();
		await first;
		await vi.advanceTimersByTimeAsync(30_000);
		const second = convert();
		children[0].emit('exit', 0, null);
		await flush();
		expect(children).toHaveLength(2);
		children[1].ready();
		await flush();
		children[1].succeed();
		await second;
	});

	test('kills the child if boot exits without Nest shutdown hooks', async () => {
		const before = new Set(process.listeners('exit'));
		const result = expect(convert()).rejects.toThrow('exited');
		const onParentExit = process.listeners('exit').find(listener => !before.has(listener))!;
		onParentExit(0);
		await result;
		expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
		expect(process.listeners('exit')).not.toContain(onParentExit);
	});

	test('forces termination if a disconnected process does not close', async () => {
		const result = convert();
		children[0].ready();
		await flush();
		children[0].succeed();
		await result;
		await vi.advanceTimersByTimeAsync(35_000);
		expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
	});

	test('allows the active conversion to finish on shutdown and rejects queued or new requests', async () => {
		const active = convert();
		const queued = expect(convert()).rejects.toThrow('shutting down');
		children[0].ready();
		await flush();
		const shutdown = service.onApplicationShutdown();
		expect(service.onApplicationShutdown()).toBe(shutdown);
		await queued;
		await expect(convert()).rejects.toThrow('shutting down');
		expect(children[0].disconnect).not.toHaveBeenCalled();
		children[0].succeed();
		await active;
		await flush();
		expect(children[0].disconnect).toHaveBeenCalledOnce();
		children[0].close();
		await shutdown;
	});

	test('bounds shutdown even when initialization never sends ready', async () => {
		const result = expect(convert()).rejects.toThrow('exited');
		const shutdown = service.onApplicationShutdown();
		await vi.advanceTimersByTimeAsync(10_000);
		await shutdown;
		await result;
		expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
	});
});
