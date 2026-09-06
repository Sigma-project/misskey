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
});
