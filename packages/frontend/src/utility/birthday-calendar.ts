/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function getBirthdayRangeEnd(begin: Date, period: string): Date {
	const days = period === '3day' ? 3 : period === 'week' ? 7 : period === 'month' ? 30 : 1;
	return new Date(begin.getFullYear(), begin.getMonth(), begin.getDate() + days - 1);
}

export function formatBirthdayDate(birthday: string): string {
	const [, month, day] = birthday.split('-').map(Number);
	return `${month}/${day}`;
}
