/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { bindThis } from '@/decorators.js';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const path = Path.resolve(_dirname, '../../../../files');

@Injectable()
export class InternalStorageService {
	constructor(
		@Inject(DI.config)
		private config: Config,
	) {
	}

	@bindThis
	public resolvePath(key: string) {
		return Path.resolve(path, key);
	}

	/**
	 * キーを解決しつつ、ベースディレクトリの外に出ていないことを保証する。
	 * path traversal（`..` 等）を含むキーには `null` を返す。
	 */
	@bindThis
	public resolvePathWithinBase(key: string): string | null {
		const base = Path.resolve(path);
		const resolved = Path.resolve(path, key);
		if (resolved !== base && !resolved.startsWith(base + Path.sep)) {
			return null;
		}
		return resolved;
	}

	@bindThis
	public read(key: string) {
		return fs.createReadStream(this.resolvePath(key));
	}

	@bindThis
	public saveFromPath(key: string, srcPath: string) {
		// ネストしたキー（例: stream-xxx/av1/seg-001.m4s）でも親ディレクトリを作る
		fs.mkdirSync(Path.dirname(this.resolvePath(key)), { recursive: true });
		fs.copyFileSync(srcPath, this.resolvePath(key));
		return `${this.config.url}/files/${key}`;
	}

	@bindThis
	public saveFromBuffer(key: string, data: Buffer) {
		fs.mkdirSync(Path.dirname(this.resolvePath(key)), { recursive: true });
		fs.writeFileSync(this.resolvePath(key), data);
		return `${this.config.url}/files/${key}`;
	}

	@bindThis
	public del(key: string) {
		fs.unlink(this.resolvePath(key), () => {});
	}

	/**
	 * プレフィックス（ディレクトリ）配下を再帰的に削除する。
	 * トランスコード成果物のクリーンアップに用いる。
	 */
	@bindThis
	public delPrefix(prefix: string) {
		const resolved = this.resolvePathWithinBase(prefix);
		// ベース自身や範囲外は削除しない（安全側）
		if (resolved == null || resolved === Path.resolve(path)) {
			return;
		}
		fs.rm(resolved, { recursive: true, force: true }, () => {});
	}
}
