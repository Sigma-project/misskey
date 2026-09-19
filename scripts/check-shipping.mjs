/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// @ts-check
/**
 * Misskey 変更の完了前検査。
 *
 * 変更ファイル lint、SPDX 自動修正と再検査、locale safety を独立して実行し、
 * 最後に終了コードを集約する。
 *
 * 使い方:
 *   node scripts/check-shipping.mjs
 *   node scripts/check-shipping.mjs --base <ref>
 *
 * 終了コード:
 *   0 = 全検査に合格 (lint 対象なしの SKIPPED を含む)
 *   1 = lint / SPDX / locale の違反
 *   2 = 引数、Git ref、コマンド起動などの理由で検査不能
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_INTEGRATION_REFS, findClosestMergeBase, gitLines, gitMergeBase, listChangedFiles } from './lib/git.mjs';
import { forbiddenLocaleChanges } from './lib/locale-provenance.mjs';

const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const LINT_TARGETS = [
	{ root: 'packages/backend', pattern: /^packages\/backend\/(src|test-federation)\/.*\.ts$/ },
	{ root: 'packages/frontend', pattern: /^packages\/frontend\/src\/.*\.(ts|vue)$/ },
	{ root: 'packages/frontend-embed', pattern: /^packages\/frontend-embed\/src\/.*\.(ts|vue)$/ },
	{ root: 'packages/icons-subsetter', pattern: /^packages\/icons-subsetter\/src\/.*\.ts$/ },
	{ root: 'packages/sw', pattern: /^packages\/sw\/src\/.*\.ts$/ },
	...['frontend-shared', 'frontend-builder', 'i18n', 'misskey-js', 'misskey-bubble-game', 'misskey-reversi'].map((name) => ({
		root: `packages/${name}`,
		pattern: new RegExp(`^packages/${name}/.*\\.(js|jsx|ts|tsx)$`),
	})),
	...['changelog-checker', 'diagnostics-backend', 'diagnostics-frontend', 'diagnostics-shared'].map((name) => ({
		root: `packages-private/${name}`,
		pattern: new RegExp(`^packages-private/${name}/.*\\.(js|jsx|ts|tsx)$`),
	})),
];

class OperationalError extends Error {}

/**
 * 明示 ref または最も近い統合先から merge-base を選ぶ。
 *
 * @param {string | null} explicitRef
 * @returns {string}
 */
function resolveMergeBase(explicitRef) {
	if (explicitRef !== null) return gitMergeBase(explicitRef);

	try {
		return findClosestMergeBase(DEFAULT_INTEGRATION_REFS);
	} catch (error) {
		const detail = error instanceof Error ? ` — ${error.message}` : '';
		throw new OperationalError(`統合先の merge-base を解決できない。--base <ref> または MISSKEY_BASE_REF を指定すること${detail}`);
	}
}

/**
 * パスが存在する通常ファイルかを判定する。
 *
 * @param {string} file
 * @returns {boolean}
 */
function isRegularFile(file) {
	try {
		return statSync(file).isFile();
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false;
		throw new OperationalError(`${file}: ファイル種別を確認できない`);
	}
}

/**
 * 指定ディレクトリでコマンドを実行し、終了コードを返す。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {number}
 */
function runCommand(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'inherit',
	});
	if (result.error !== undefined) {
		throw new OperationalError(`${command} を起動できない: ${result.error.message}`);
	}
	if (result.status === null) {
		throw new OperationalError(`${command} が signal ${result.signal ?? 'unknown'} で終了した`);
	}
	return result.status;
}

/**
 * 子プロセスの終了コードを検査結果の 0・1・2 に正規化する。
 *
 * @param {number} status
 * @returns {0 | 1 | 2}
 */
function normalizeStatus(status) {
	if (status === 0) return 0;
	if (status === 1) return 1;
	return 2;
}

/**
 * 変更ファイルを package ごとに分け、対象限定 ESLint を実行する。
 *
 * @param {string[]} changedFiles
 * @param {string} repoRoot
 * @returns {{ status: 0 | 1 | 2, summary: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED' }}
 */
function runChangedFileLint(changedFiles, repoRoot) {
	let ran = false;
	/** @type {0 | 1 | 2} */ let status = 0;

	for (const target of LINT_TARGETS) {
		try {
			const files = changedFiles
				.filter((file) => target.pattern.test(file) && isRegularFile(file))
				.map((file) => file.slice(target.root.length + 1));
			if (files.length === 0) continue;

			ran = true;
			console.log(`Lint: ${target.root} (${files.length} files)`);
			const current = normalizeStatus(runCommand(PNPM_COMMAND, ['exec', 'eslint', '--quiet', '--', ...files], join(repoRoot, target.root)));
			if (current > status) status = current;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Lint: 検査不能 — ${message}`);
			status = 2;
		}
	}

	if (!ran && status === 0) {
		console.log('Lint: SKIPPED (対象ファイルなし)');
		return { status: 0, summary: 'SKIPPED' };
	}
	return { status, summary: status === 0 ? 'PASS' : status === 1 ? 'FAIL' : 'ERROR' };
}

/**
 * SPDX 検査を実行し、違反時は対象内を修正して再検査する。
 *
 * @param {string} base
 * @param {string} repoRoot
 * @returns {0 | 1 | 2}
 */
function runSpdx(base, repoRoot) {
	try {
		let status = normalizeStatus(runCommand(process.execPath, ['scripts/check-spdx.mjs'], repoRoot));
		if (status !== 1) return status;

		console.log('SPDX: 違反を検出。ローカル変更の欠落だけを自動修正する。');
		const fixStatus = normalizeStatus(runCommand(process.execPath, ['scripts/check-spdx.mjs', '--fix', '--base', base], repoRoot));
		if (fixStatus === 2) return 2;

		status = normalizeStatus(runCommand(process.execPath, ['scripts/check-spdx.mjs'], repoRoot));
		return status;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`SPDX: 検査不能 — ${message}`);
		return 2;
	}
}

/**
 * ja/en 以外は明示した upstream snapshot と一致する取り込みのみ許可する。
 *
 * @param {string[]} changedFiles
 * @param {string | null} upstreamRef
 * @returns {0 | 1 | 2}
 */
function runLocaleSafety(changedFiles, upstreamRef) {
	try {
		const badLocales = forbiddenLocaleChanges(changedFiles, upstreamRef);
		if (badLocales.length === 0) {
			console.log('Locale safety: PASS');
			return 0;
		}
		for (const file of badLocales) console.error(`forbidden locale change: ${file}`);
		return 1;
	} catch (error) {
		console.error(`Locale safety: 検査不能 — ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
}

/**
 * CLI 引数または環境変数から基準 ref を取り出す。
 *
 * @param {string[]} args
 * @returns {{ base: string | null, upstream: string | null } | undefined}
 */
function parseOptions(args) {
	const options = { base: process.env.MISSKEY_BASE_REF || null, upstream: /** @type {string | null} */ (null) };
	const seen = new Set();
	for (let i = 0; i < args.length; i += 2) {
		const flag = args[i];
		const value = args[i + 1];
		if (!['--base', '--upstream-ref'].includes(flag) || seen.has(flag) || !value || value.startsWith('--')) return undefined;
		seen.add(flag);
		if (flag === '--base') options.base = value;
		else options.upstream = value;
	}
	return options;
}

/**
 * lint・SPDX・locale safety を実行し、終了コードを集約する。
 *
 * @returns {number}
 */
function main() {
	const options = parseOptions(process.argv.slice(2));
	if (options === undefined) {
		console.error('usage: node scripts/check-shipping.mjs [--base <ref>] [--upstream-ref <full SHA>]');
		return 2;
	}

	try {
		const repoRoot = gitLines(['rev-parse', '--show-toplevel'])[0];
		if (repoRoot === undefined) throw new OperationalError('git リポジトリの外で実行された');
		process.chdir(repoRoot);

		const base = resolveMergeBase(options.base);
		const changedFiles = listChangedFiles(base);
		const lint = runChangedFileLint(changedFiles, repoRoot);
		const spdxStatus = runSpdx(base, repoRoot);
		const localeStatus = runLocaleSafety(changedFiles, options.upstream);

		console.log('');
		console.log('Shipping checks:');
		console.log(`Lint:          ${lint.summary}`);
		console.log(`SPDX:          ${spdxStatus === 0 ? 'PASS' : spdxStatus === 1 ? 'FAIL' : 'ERROR'}`);
		console.log(`Locale safety: ${localeStatus === 0 ? 'PASS' : localeStatus === 1 ? 'FAIL' : 'ERROR'}`);

		if (lint.status === 2 || spdxStatus === 2 || localeStatus === 2) return 2;
		if (lint.status === 1 || spdxStatus === 1 || localeStatus === 1) return 1;
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Shipping checks: 検査不能 — ${message}`);
		return 2;
	}
}

process.exitCode = main();
