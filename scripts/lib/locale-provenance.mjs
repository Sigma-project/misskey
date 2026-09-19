/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// @ts-check
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { gitLines, gitPaths } from './git.mjs';

/** @param {string} ref */
function verifyUpstream(ref) {
	if (!/^[0-9a-f]{40}$/.test(ref) || gitLines(['cat-file', '-t', ref], { quiet: true })[0] !== 'commit') {
		throw new Error('--upstream-ref must be a full commit SHA');
	}
	const heads = ['HEAD'];
	const mergeHeadPath = gitLines(['rev-parse', '--git-path', 'MERGE_HEAD'])[0];
	if (mergeHeadPath === undefined) throw new Error('Cannot locate MERGE_HEAD');
	try {
		heads.push(...readFileSync(mergeHeadPath, 'utf8').trim().split('\n').filter(Boolean));
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
	}
	for (const head of heads) {
		const result = spawnSync('git', ['merge-base', '--is-ancestor', ref, head], { encoding: 'utf8' });
		if (result.error) throw result.error;
		if (result.status === 0) return;
		if (result.status !== 1) throw new Error(`Cannot check upstream ancestry: ${result.stderr}`);
	}
	throw new Error('Declared upstream commit is not included in HEAD or MERGE_HEAD');
}

/**
 * Compare Git-normalized content; missing files have a null object ID.
 * Reject symlinks, directories and unresolved index stages even if bytes match.
 * @param {string} file
 * @param {string} upstreamRef
 */
function matchesSnapshot(file, upstreamRef) {
	const upstream = gitPaths(['ls-tree', '-z', upstreamRef, '--', file]);
	const index = gitPaths(['ls-files', '--stage', '-z', '--', file]);
	if (upstream.length > 1 || index.length > 1) return false;
	const upstreamEntry = upstream[0]?.match(/^100(?:644|755) blob ([0-9a-f]{40})\t/);
	const indexEntry = index[0]?.match(/^100(?:644|755) ([0-9a-f]{40}) 0\t/);
	if ((upstream.length !== 0 && !upstreamEntry) || (index.length !== 0 && !indexEntry)) return false;
	const expected = upstreamEntry?.[1] ?? null;
	let actual = null;
	try {
		if (!lstatSync(file).isFile()) return false;
		actual = gitLines(['hash-object', `--path=${file}`, '--', file])[0];
		if (actual === undefined) throw new Error(`Cannot hash ${file}`);
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
	}
	return actual === expected && (indexEntry?.[1] ?? null) === expected;
}

/**
 * The explicit snapshot is a caller declaration, not authentication of a remote.
 * @param {string[]} changedFiles Includes committed, staged, unstaged and untracked paths.
 * @param {string | null} upstreamRef
 * @returns {string[]} Forbidden paths; operational failures throw.
 */
export function forbiddenLocaleChanges(changedFiles, upstreamRef) {
	if (upstreamRef !== null) verifyUpstream(upstreamRef);
	return changedFiles.filter(file => (
		file.startsWith('locales/') && file.endsWith('.yml') &&
		file !== 'locales/ja-JP.yml' && file !== 'locales/en-US.yml' &&
		(upstreamRef === null || !matchesSnapshot(file, upstreamRef))
	));
}
