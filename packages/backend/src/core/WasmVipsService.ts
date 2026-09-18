/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fork } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import type { ChildProcess } from 'node:child_process';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { ConversionRequest, ConversionResponse, JxlOptions } from './workers/wasm-vips.mjs';
import type { IImage } from '@/core/ImageProcessingService.js';
import { bindThis } from '@/decorators.js';

const IDLE_TIMEOUT_MS = 30_000;
const MAX_JOBS_PER_PROCESS = 100;
const SHUTDOWN_TIMEOUT_MS = 5_000;

type ConversionJob = {
	request: ConversionRequest;
	result: PromiseWithResolvers<IImage>;
};

type ConversionProcess = {
	child: ChildProcess;
	ready: PromiseWithResolvers<void>;
	closed: PromiseWithResolvers<void>;
	pending?: PromiseWithResolvers<Buffer>;
	jobs: number;
	stopping: boolean;
	finished: boolean;
	failure?: Error;
	killTimer?: NodeJS.Timeout;
};

@Injectable()
export class WasmVipsService implements OnApplicationShutdown {
	private process: ConversionProcess | null = null;
	private queue: ConversionJob[] = [];
	private draining: Promise<void> | null = null;
	private idleTimer?: NodeJS.Timeout;
	private disposed = false;
	private shutdownPromise?: Promise<void>;

	@bindThis
	public async convertAnimatedToJxl(
		inputBuffer: Buffer,
		width: number,
		height: number,
		options?: JxlOptions,
	): Promise<IImage> {
		if (this.disposed) throw new Error('WasmVipsService is shutting down');

		clearTimeout(this.idleTimer);
		const result = Promise.withResolvers<IImage>();
		this.queue.push({ request: { inputBuffer, width, height, options }, result });
		this.startDraining();
		return result.promise;
	}

	private startDraining(): void {
		if (this.draining != null) return;
		this.draining = this.drain().finally(() => {
			this.draining = null;
			if (this.disposed) return;
			if (this.queue.length > 0) this.startDraining();
			else this.scheduleIdleShutdown();
		});
	}

	private async drain(): Promise<void> {
		while (!this.disposed && this.queue.length > 0) {
			const job = this.queue.shift()!;
			let worker: ConversionProcess | undefined;
			try {
				worker = await this.getProcess();
				const pending = Promise.withResolvers<Buffer>();
				worker.pending = pending;
				// Count failed conversions too: they can also allocate wasm resources.
				worker.jobs++;
				const current = worker;
				try {
					if (!current.child.connected) throw new Error('Wasm-vips IPC channel is closed');
					current.child.send(job.request, error => {
						if (error) this.failProcess(current, error);
					});
				} catch (error) {
					this.failProcess(current, error instanceof Error ? error : new Error(String(error)));
				}
				const data = await pending.promise;
				job.result.resolve({ data, ext: 'jxl', type: 'image/jxl' });
			} catch (error) {
				job.result.reject(error);
			} finally {
				if (worker) {
					worker.pending = undefined;
					if (worker.jobs >= MAX_JOBS_PER_PROCESS) await this.stopProcess(worker);
				}
			}
		}
	}

	private async getProcess(): Promise<ConversionProcess> {
		if (this.process?.stopping) await this.process.closed.promise;
		if (this.disposed) throw new Error('WasmVipsService is shutting down');
		const worker = this.process ?? this.createProcess();
		worker.child.ref();
		worker.child.channel?.ref();
		await worker.ready.promise;
		if (worker.failure) throw worker.failure;
		if (this.disposed) throw new Error('WasmVipsService is shutting down');
		return worker;
	}

	private createProcess(): ConversionProcess {
		const child = fork(new URL('./workers/wasm-vips.mjs', import.meta.url), [], {
			serialization: 'advanced',
			execArgv: [],
			stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
		});
		const worker: ConversionProcess = {
			child,
			ready: Promise.withResolvers<void>(),
			closed: Promise.withResolvers<void>(),
			jobs: 0,
			stopping: false,
			finished: false,
		};
		this.process = worker;

		// Boot can exit without calling Nest shutdown hooks.
		const onParentExit = () => { child.kill('SIGKILL'); };
		process.once('exit', onParentExit);
		const finalize = (error: Error) => {
			if (worker.finished) return;
			worker.finished = true;
			clearTimeout(worker.killTimer);
			process.off('exit', onParentExit);
			worker.ready.reject(worker.failure ?? error);
			worker.pending?.reject(worker.failure ?? error);
			if (this.process === worker) this.process = null;
			worker.closed.resolve();
		};
		child.on('message', (message: ConversionResponse) => {
			if (this.process !== worker || worker.stopping) return;
			if (message.type === 'ready') {
				worker.ready.resolve();
			} else if (message.type === 'result') {
				worker.pending?.resolve(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength));
			} else if (message.type === 'error') {
				const error = new Error(message.error.message);
				error.name = message.error.name;
				error.stack = message.error.stack ?? error.stack;
				worker.pending?.reject(error);
			}
		});
		child.on('error', error => {
			this.failProcess(worker, error);
			// Failed spawns need not produce an exit event.
			if (child.pid == null) finalize(error);
		});
		child.on('disconnect', () => {
			if (!worker.stopping) this.failProcess(worker, new Error('Wasm-vips IPC channel disconnected'));
		});
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			finalize(new Error('Wasm-vips process exited (' + (signal ?? code) + ')'));
		};
		child.once('exit', onExit);
		child.once('close', onExit);
		return worker;
	}

	private failProcess(worker: ConversionProcess, error: Error): void {
		worker.failure ??= error;
		worker.ready.reject(error);
		worker.pending?.reject(error);
		void this.stopProcess(worker, true);
	}

	private stopProcess(worker: ConversionProcess, force = false): Promise<void> {
		if (worker.finished || worker.stopping) return worker.closed.promise;
		worker.stopping = true;
		worker.child.ref();
		worker.child.channel?.ref();
		worker.killTimer = setTimeout(() => { worker.child.kill('SIGKILL'); }, SHUTDOWN_TIMEOUT_MS).unref();
		if (force || !worker.child.connected) worker.child.kill('SIGKILL');
		else worker.child.disconnect();
		return worker.closed.promise;
	}

	private scheduleIdleShutdown(): void {
		const worker = this.process;
		if (worker == null || worker.stopping) return;
		worker.child.unref();
		worker.child.channel?.unref();
		this.idleTimer = setTimeout(() => {
			if (this.process === worker && this.draining == null && this.queue.length === 0) {
				void this.stopProcess(worker);
			}
		}, IDLE_TIMEOUT_MS).unref();
	}

	@bindThis
	public onApplicationShutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.disposed = true;
		clearTimeout(this.idleTimer);
		for (const job of this.queue.splice(0)) job.result.reject(new Error('WasmVipsService is shutting down'));
		this.shutdownPromise = (async () => {
			let timer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					this.draining,
					new Promise<void>(resolve => { timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); }),
				]);
			} finally {
				clearTimeout(timer);
			}
			if (this.process) await this.stopProcess(this.process);
			await this.draining;
		})();
		return this.shutdownPromise;
	}
}
