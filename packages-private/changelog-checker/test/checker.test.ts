/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, describe, test } from 'vitest';
import { Release, ReleaseCategory } from '../src/parser.js';
import { checkNewRelease, checkNewTopic } from '../src/checker.js';

describe('checkNewRelease', () => {
	test.each([
		['Unreleased', 'Unreleased', '2026.9.0', '2026.7.0'],
		['Unreleased', '2026.9.0', 'Unreleased', '2026.7.0'],
	])('Unreleasedが重複した履歴を拒否する: %j', (...names) => {
		const base = [new Release('Unreleased'), new Release('2026.7.0')];
		const head = names.map(name => new Release(name));

		expect(checkNewRelease(base, head).success).toBe(false);
	});

	test('Unreleasedを保持したまま複数のupstreamリリースを追加できる', () => {
		const base = [new Release('Unreleased'), new Release('2026.7.0')];
		const head = [
			new Release('Unreleased', [new ReleaseCategory('General', ['upstreamを取り込み'])]),
			new Release('2026.9.0'), new Release('2026.8.0'), new Release('2026.7.0'),
		];

		expect(checkNewRelease(base, head).success).toBe(true);
	});

	test('Unreleasedがあっても既存リリースの順序変更を拒否する', () => {
		const base = [new Release('Unreleased'), new Release('2026.7.0'), new Release('2026.6.0')];
		const head = [new Release('Unreleased'), new Release('2026.9.0'), new Release('2026.6.0'), new Release('2026.7.0')];

		expect(checkNewRelease(base, head).success).toBe(false);
	});

	test('リリース追加時に既存のUnreleasedが失われた場合は拒否する', () => {
		const base = [new Release('Unreleased'), new Release('2026.7.0')];
		const head = [new Release('2026.9.0'), new Release('2026.8.0'), new Release('2026.7.0')];

		expect(checkNewRelease(base, head).success).toBe(false);
	});

	test('headに新しいリリースがある1', () => {
		const base = [new Release('2024.12.0')];
		const head = [new Release('2024.12.1'), new Release('2024.12.0')];

		const result = checkNewRelease(base, head);

		expect(result.success).toBe(true);
	});

	test('headに新しいリリースがある2', () => {
		const base = [new Release('2024.12.0')];
		const head = [new Release('2024.12.2'), new Release('2024.12.1'), new Release('2024.12.0')];

		const result = checkNewRelease(base, head);

		expect(result.success).toBe(true);
	});

	test('リリースの数が同じ', () => {
		const base = [new Release('2024.12.0')];
		const head = [new Release('2024.12.0')];

		const result = checkNewRelease(base, head);

		console.log(result.message);
		expect(result.success).toBe(false);
	});

	test('baseにあるリリースがheadにない', () => {
		const base = [new Release('2024.12.0')];
		const head = [new Release('2024.12.2'), new Release('2024.12.1')];

		const result = checkNewRelease(base, head);

		console.log(result.message);
		expect(result.success).toBe(false);
	});

	// 先頭だけ比較していると、より古いリリースの書き換えを見逃す
	test('追加分の直後は一致しているが、より古いリリースが書き換えられている', () => {
		const base = [new Release('2024.12.1'), new Release('2024.12.0')];
		const head = [new Release('2024.12.2'), new Release('2024.12.1'), new Release('2024.11.0')];

		const result = checkNewRelease(base, head);

		console.log(result.message);
		expect(result.success).toBe(false);
	});
});

describe('checkNewTopic', () => {
	test('追記なし', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat3',
					'feat4',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat3',
					'feat4',
				]),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat3',
					'feat4',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat3',
					'feat4',
				]),
			]),
		];

		const result = checkNewTopic(base, head);

		expect(result.success).toBe(true);
	});

	test('最新バージョンにカテゴリを追加したときはエラーにならない', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat3',
					'feat4',
				]),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat3',
					'feat4',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat3',
					'feat4',
				]),
			]),
		];

		const result = checkNewTopic(base, head);

		expect(result.success).toBe(true);
	});

	test('最新バージョンからカテゴリを削除したときはエラーにならない', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat3',
					'feat4',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat3',
					'feat4',
				]),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat3',
					'feat4',
				]),
			]),
		];

		const result = checkNewTopic(base, head);

		expect(result.success).toBe(true);
	});

	test('最新バージョンに追記したときはエラーにならない', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
					'feat3',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
		];

		const result = checkNewTopic(base, head);

		expect(result.success).toBe(true);
	});

	test('最新バージョンから削除したときはエラーにならない', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
		];

		const result = checkNewTopic(base, head);

		expect(result.success).toBe(true);
	});

	test('古いバージョンにカテゴリを追加したときはエラーになる', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
				new ReleaseCategory('Client', [
					'feat1',
					'feat2',
				]),
			]),
		];

		const result = checkNewTopic(base, head);

		console.log(result.message);
		expect(result.success).toBe(false);
	});

	test('古いバージョンからカテゴリを削除したときはエラーになる', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
			]),
		];

		const result = checkNewTopic(base, head);

		console.log(result.message);
		expect(result.success).toBe(false);
	});

	test('古いバージョンに追記したときはエラーになる', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
					'feat3',
				]),
			]),
		];

		const result = checkNewTopic(base, head);

		console.log(result.message);
		expect(result.success).toBe(false);
	});

	test('古いバージョンから削除したときはエラーになる', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', [
					'feat1',
					'feat2',
				]),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', [
					'feat1',
				]),
			]),
		];

		const result = checkNewTopic(base, head);

		console.log(result.message);
		expect(result.success).toBe(false);
	});

	// 件数が同じでも内容が変わっていれば履歴の書き換えなのでエラーにする
	test('古いバージョンの項目が書き換えられたときはエラーになる', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', ['feat1']),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', ['feat1', 'feat2']),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', ['feat1']),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', ['feat1', 'feat2-rewritten']),
			]),
		];

		const result = checkNewTopic(base, head);

		console.log(result.message);
		expect(result.success).toBe(false);
	});

	test('古いバージョンの項目が並べ替えられたときはエラーになる', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', ['feat1']),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', ['feat1', 'feat2']),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', ['feat1']),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', ['feat2', 'feat1']),
			]),
		];

		const result = checkNewTopic(base, head);

		console.log(result.message);
		expect(result.success).toBe(false);
	});

	// 最新リリースの書き換えは通常の編集なので許容する
	test('最新バージョンの項目を書き換えたときはエラーにならない', () => {
		const base = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', ['feat1']),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', ['feat1']),
			]),
		];

		const head = [
			new Release('2024.12.1', [
				new ReleaseCategory('Server', ['feat1-rewritten']),
			]),
			new Release('2024.12.0', [
				new ReleaseCategory('Server', ['feat1']),
			]),
		];

		const result = checkNewTopic(base, head);

		expect(result.success).toBe(true);
	});
});
