/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Agent, createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { S3Service } from '@/core/S3Service.js';
import type { HttpRequestService } from '@/core/HttpRequestService.js';
import type { MiMeta } from '@/models/Meta.js';

vi.mock('@/core/HttpRequestService.js', () => ({ HttpRequestService: class {} }));

describe('S3 deletion cancellation', () => {
	test.each([
		['object', false],
		['list', false],
		['list', true],
		['batch', false],
		['batch', true],
	] as const)('aborts a stalled %s request (partial response: %s)', async (operation, partialResponse) => {
		const received = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const agent = new Agent({ keepAlive: true });
		const destroy = vi.spyOn(agent, 'destroy');
		const server = createServer((request, response) => {
			request.resume();
			if (operation === 'batch' && request.method === 'GET') {
				response.setHeader('Content-Type', 'application/xml');
				response.end('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>stream/segment</Key></Contents></ListBucketResult>');
				return;
			}
			request.socket.once('close', () => closed.resolve());
			if (partialResponse) {
				response.writeHead(200, { 'Content-Type': 'application/xml' });
				response.write('<');
			}
			received.resolve();
		});
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (address == null || typeof address === 'string') throw new Error('Missing test server address');
		const service = new S3Service({ getAgentByUrl: () => agent } as unknown as HttpRequestService);
		const meta = {
			objectStorageEndpoint: `127.0.0.1:${address.port}`,
			objectStorageUseSSL: false,
			objectStorageS3ForcePathStyle: true,
			objectStorageAccessKey: 'test-access-key',
			objectStorageSecretKey: 'test-secret-key',
			objectStorageRegion: 'us-east-1',
			objectStorageBucket: 'test-bucket',
		} as MiMeta;
		const controller = new AbortController();
		try {
			const result = operation === 'object'
				? service.delete(meta, { Bucket: 'test-bucket', Key: 'original' }, controller.signal)
				: service.deletePrefix(meta, 'stream/', controller.signal);
			const rejected = expect(result).rejects.toThrow();
			await received.promise;
			controller.abort();
			await rejected;
			await closed.promise;
			// Production agents also serve unrelated HTTP requests.
			expect(destroy).not.toHaveBeenCalled();
		} finally {
			controller.abort();
			agent.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
		}
	}, 5000);
});
