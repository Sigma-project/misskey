/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { formatBirthdayDate, getBirthdayCountdown, getBirthdayRangeEnd } from '@/utility/birthday-calendar.js';

describe('birthday calendar', () => {
	test.each([
		['today', 1], ['3day', 3], ['week', 7], ['month', 30],
	] as const)('includes exactly the requested dates for %s', (period, days) => {
		for (const begin of [new Date(2026, 2, 7, 23), new Date(2026, 9, 31, 23), new Date(2026, 11, 31, 23)]) {
			const end = getBirthdayRangeEnd(begin, period);
			const endString = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
			expect(getBirthdayCountdown(endString, begin)).toBe(days - 1);
		}
	});

	test('formats date-only separators without UTC conversion', () => {
		expect(formatBirthdayDate('2026-08-07')).toBe('8/7');
	});

	test('counts calendar dates across DST and year boundaries', () => {
		expect(getBirthdayCountdown('2026-03-09', new Date(2026, 2, 8))).toBe(1);
		expect(getBirthdayCountdown('2026-11-02', new Date(2026, 10, 1))).toBe(1);
		expect(getBirthdayCountdown('2027-01-01', new Date(2026, 11, 31))).toBe(1);
		expect(getBirthdayCountdown('2026-08-07', new Date(2026, 7, 7, 23))).toBe(0);
		expect(getBirthdayCountdown('2026-08-06', new Date(2026, 7, 7))).toBe(-1);
	});
});
