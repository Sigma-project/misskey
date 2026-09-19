/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { forbiddenLocaleChanges } from './locale-provenance.mjs';
import { listChangedFiles } from './git.mjs';

test('locale imports require the declared integrated snapshot in both index and worktree', async (t) => {
	const previousCwd = process.cwd();
	const directory = mkdtempSync(join(tmpdir(), 'misskey-locale-'));
	const identity = {
		...process.env,
		GIT_AUTHOR_NAME: 'Locale test', GIT_AUTHOR_EMAIL: 'locale-test@example.invalid',
		GIT_COMMITTER_NAME: 'Locale test', GIT_COMMITTER_EMAIL: 'locale-test@example.invalid',
	};
	const git = (...args) => execFileSync('git', args, { cwd: directory, env: identity, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	const file = 'locales/fr-FR.yml';
	const write = (value) => {
		mkdirSync('locales', { recursive: true });
		writeFileSync(file, value);
	};
	try {
		process.chdir(directory);
		git('init', '--initial-branch=master');
		mkdirSync('locales');
		writeFileSync('.gitattributes', '* text=auto eol=lf\n');
		write('value: old\n');
		git('add', '.gitattributes', file);
		git('-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
		const base = git('rev-parse', 'HEAD');
		git('switch', '-c', 'upstream');
		write('value: upstream\n');
		git('add', file);
		git('-c', 'commit.gpgsign=false', 'commit', '-m', 'upstream');
		const upstream = git('rev-parse', 'HEAD');

		await t.test('ordinary edits permit Japanese and English only', () => {
			assert.deepEqual(forbiddenLocaleChanges(['locales/ja-JP.yml', 'locales/en-US.yml', file], null), [file]);
		});
		await t.test('matching tracked content is accepted', () => {
			assert.deepEqual(forbiddenLocaleChanges([file], upstream), []);
		});
		await t.test('Git line-ending normalization does not change provenance', () => {
			write('value: upstream\r\n');
			assert.deepEqual(forbiddenLocaleChanges([file], upstream), []);
			write('value: upstream\n');
		});
		await t.test('unstaged edits and deletions are rejected', () => {
			write('value: changed\n');
			assert.deepEqual(forbiddenLocaleChanges([file], upstream), [file]);
			rmSync(file);
			assert.deepEqual(forbiddenLocaleChanges([file], upstream), [file]);
			write('value: upstream\n');
		});
		await t.test('a staged edit is rejected even if the worktree matches upstream', () => {
			write('value: staged\n');
			git('add', file);
			write('value: upstream\n');
			assert.equal(git('diff', '--name-only', 'HEAD'), '');
			assert(listChangedFiles(upstream).includes(file));
			assert.deepEqual(forbiddenLocaleChanges([file], upstream), [file]);
			git('add', file);
		});
		await t.test('symlinks are not treated as matching files', () => {
			rmSync(file);
			writeFileSync('matching.yml', 'value: upstream\n');
			symlinkSync('../matching.yml', file);
			assert.deepEqual(forbiddenLocaleChanges([file], upstream), [file]);
			rmSync(file);
			write('value: upstream\n');
		});
		await t.test('invalid and non-integrated snapshots are operational failures', () => {
			assert.throws(() => forbiddenLocaleChanges([file], 'not-a-commit'));
			assert.throws(() => forbiddenLocaleChanges([file], '0'.repeat(40)));
			git('switch', 'master');
			assert.throws(() => forbiddenLocaleChanges([file], upstream), /not included/);
		});
		await t.test('MERGE_HEAD permits validation before the merge commit', () => {
			git('merge', '--no-commit', '--no-ff', upstream);
			assert.deepEqual(forbiddenLocaleChanges([file], upstream), []);
			git('-c', 'commit.gpgsign=false', 'commit', '-m', 'merge');
		});
		await t.test('deletions must match both the snapshot and the index', () => {
			git('rm', file);
			git('-c', 'commit.gpgsign=false', 'commit', '-m', 'upstream deletion');
			const deleted = git('rev-parse', 'HEAD');
			assert.deepEqual(forbiddenLocaleChanges([file], deleted), []);
			write('value: untracked\n');
			assert.deepEqual(forbiddenLocaleChanges([file], deleted), [file]);
			git('add', file);
			rmSync(file);
			assert.deepEqual(forbiddenLocaleChanges([file], deleted), [file]);
		});
		await t.test('all unresolved index stages are rejected', () => {
			const oid = git('rev-parse', `${upstream}:${file}`);
			execFileSync('git', ['update-index', '--index-info'], {
				cwd: directory, env: identity,
				input: `0 ${'0'.repeat(40)}\t${file}\n100644 ${oid} 1\t${file}\n100644 ${oid} 2\t${file}\n100644 ${oid} 3\t${file}\n`,
			});
			write('value: upstream\n');
			assert.deepEqual(forbiddenLocaleChanges([file], upstream), [file]);
		});
		assert.equal(git('cat-file', '-t', base), 'commit');
	} finally {
		process.chdir(previousCwd);
		rmSync(directory, { recursive: true, force: true });
	}
});
