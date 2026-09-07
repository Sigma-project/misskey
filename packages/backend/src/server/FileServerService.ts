/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { Config } from '@/config.js';
import type { DriveFilesRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { StatusError } from '@/misc/status-error.js';
import type Logger from '@/logger.js';
import { DownloadService } from '@/core/DownloadService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { FileInfoService } from '@/core/FileInfoService.js';
import { ImageProcessingService } from '@/core/ImageProcessingService.js';
import { WasmVipsService } from '@/core/WasmVipsService.js';
import { VideoProcessingService } from '@/core/VideoProcessingService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import { handleRequestRedirectToOmitSearch } from '@/misc/fastify-hook-handlers.js';
import { FileServerDriveHandler } from './file/FileServerDriveHandler.js';
import { FileServerFileResolver } from './file/FileServerFileResolver.js';
import { FileServerProxyHandler } from './file/FileServerProxyHandler.js';
import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';

@Injectable()
export class FileServerService {
	private logger: Logger;
	private driveHandler: FileServerDriveHandler;
	private proxyHandler: FileServerProxyHandler;
	private fileResolver: FileServerFileResolver;

	private readonly assets: string;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private fileInfoService: FileInfoService,
		private downloadService: DownloadService,
		private imageProcessingService: ImageProcessingService,
		private wasmVipsService: WasmVipsService,
		private videoProcessingService: VideoProcessingService,
		private internalStorageService: InternalStorageService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('server', 'gray');
		this.assets = resolve(this.config.rootDir, 'packages/backend/src/server/file/assets');
		this.fileResolver = new FileServerFileResolver(
			this.driveFilesRepository,
			this.fileInfoService,
			this.downloadService,
			this.internalStorageService,
		);
		this.driveHandler = new FileServerDriveHandler(
			this.config,
			this.fileResolver,
			this.assets,
			this.videoProcessingService,
		);
		this.proxyHandler = new FileServerProxyHandler(
			this.config,
			this.fileResolver,
			this.assets,
			this.imageProcessingService,
			this.wasmVipsService,
		);

		//this.createServer = this.createServer.bind(this);
	}

	@bindThis
	public createServer(fastify: FastifyInstance, options: FastifyPluginOptions, done: (err?: Error) => void) {
		fastify.addHook('onRequest', (request, reply, done) => {
			reply.header('Content-Security-Policy', 'default-src \'none\'; img-src \'self\'; media-src \'self\'; style-src \'unsafe-inline\'');
			if (process.env.NODE_ENV === 'development') {
				reply.header('Access-Control-Allow-Origin', '*');
			}
			done();
		});

		fastify.register((fastify, options, done) => {
			fastify.addHook('onRequest', handleRequestRedirectToOmitSearch);
			fastify.get('/files/app-default.jpg', (request, reply) => {
				const file = fs.createReadStream(`${this.assets}/dummy.png`);
				reply.header('Content-Type', 'image/jpeg');
				reply.header('Cache-Control', 'max-age=31536000, immutable');
				return reply.send(file);
			});

			fastify.get<{ Params: { key: string; } }>('/files/:key', async (request, reply) => {
				return await this.driveHandler.handle(request, reply)
					.catch(err => this.errorHandler(request, reply, err));
			});
			fastify.get<{ Params: { key: string; } }>('/files/:key/*', async (request, reply) => {
				return await reply.redirect(`${this.config.url}/files/${request.params.key}`, 301);
			});
			done();
		});

		fastify.get<{
			Params: { url: string; };
			Querystring: { url?: string; };
		}>('/proxy/:url*', async (request, reply) => {
			return await this.proxyHandler.handle(request, reply)
				.catch(err => this.errorHandler(request, reply, err));
		});

		// 内部ストレージに保存したトランスコード成果物（HLS/DASHのネストしたm3u8/m4s等）を配信する。
		// ObjectStorage保存時は成果物URLがS3を直接指すため、このルートは内部ストレージ専用。
		fastify.get<{
			Params: { prefix: string; '*': string; };
		}>('/transcoded/:prefix/*', async (request, reply) => {
			return await this.transcodedHandler(request, reply)
				.catch(err => this.errorHandler(request, reply, err));
		});

		done();
	}

	@bindThis
	private async transcodedHandler(request: FastifyRequest<{ Params: { prefix: string; '*': string; } }>, reply: FastifyReply) {
		const prefix = request.params.prefix;
		const rest = request.params['*'];

		// prefix検証: stream-{fileId}-{rand}
		if (!/^stream-[0-9a-z]+-[0-9a-z]+$/i.test(prefix)) {
			throw new StatusError('Not Found', 404);
		}
		// rest検証: path traversal を拒否
		if (rest.length === 0 || rest.includes('..') || rest.includes('\\') || rest.startsWith('/')) {
			throw new StatusError('Not Found', 404);
		}

		// 許可拡張子のみ配信
		const ext = rest.split('.').pop()?.toLowerCase();
		const contentTypes: Record<string, string> = {
			m3u8: 'application/vnd.apple.mpegurl',
			mpd: 'application/dash+xml',
			m4s: 'video/iso.segment',
			mp4: 'video/mp4',
		};
		if (ext == null || !(ext in contentTypes)) {
			throw new StatusError('Not Found', 404);
		}

		const fullPath = this.internalStorageService.resolvePathWithinBase(`${prefix}/${rest}`);
		if (fullPath == null) {
			throw new StatusError('Not Found', 404);
		}

		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(fullPath);
		} catch {
			throw new StatusError('Not Found', 404);
		}
		if (!stat.isFile()) {
			throw new StatusError('Not Found', 404);
		}

		reply.header('Content-Type', contentTypes[ext]);
		reply.header('Accept-Ranges', 'bytes');
		// セグメント/initは不変、manifestは短めにキャッシュ
		if (ext === 'm3u8' || ext === 'mpd') {
			reply.header('Cache-Control', 'max-age=10');
		} else {
			reply.header('Cache-Control', 'max-age=31536000, immutable');
		}

		// Range対応（単一レンジのみ。suffix形式 bytes=-N も扱う）
		const range = request.headers.range;
		if (range != null) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (match && (match[1] !== '' || match[2] !== '')) {
				let start: number;
				let end: number;
				if (match[1] === '') {
					// suffix range: 末尾 N バイト
					const suffixLength = parseInt(match[2], 10);
					end = stat.size - 1;
					start = Math.max(0, stat.size - suffixLength);
				} else {
					start = parseInt(match[1], 10);
					end = match[2] !== '' ? parseInt(match[2], 10) : stat.size - 1;
				}
				if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stat.size) {
					reply.code(416);
					reply.header('Content-Range', `bytes */${stat.size}`);
					return;
				}
				reply.code(206);
				reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
				reply.header('Content-Length', end - start + 1);
				return reply.send(fs.createReadStream(fullPath, { start, end }));
			}
		}

		reply.header('Content-Length', stat.size);
		return reply.send(fs.createReadStream(fullPath));
	}

	@bindThis
	private async errorHandler(request: FastifyRequest<{ Params?: { [x: string]: any }; Querystring?: { [x: string]: any }; }>, reply: FastifyReply, err?: any) {
		this.logger.error(`${err}`);

		reply.header('Cache-Control', 'max-age=300');

		if (request.query && 'fallback' in request.query) {
			return reply.sendFile('/dummy.png', this.assets);
		}

		if (err instanceof StatusError && (err.statusCode === 302 || err.isClientError)) {
			reply.code(err.statusCode);
			return;
		}

		reply.code(500);
		return;
	}
}
