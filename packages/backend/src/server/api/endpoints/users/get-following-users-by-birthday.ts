/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Brackets } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type {
	FollowingsRepository,
	UserProfilesRepository,
} from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { Packed } from '@/misc/json-schema.js';

export const meta = {
	tags: ['users'],

	requireCredential: true,
	kind: 'read:account',

	description: 'Retrieve users who have a birthday on the specified range.',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			properties: {
				id: {
					type: 'string',
					optional: false, nullable: false,
					format: 'misskey:id',
				},
				birthday: {
					type: 'string',
					optional: false, nullable: false,
				},
				user: {
					type: 'object',
					optional: false, nullable: false,
					ref: 'UserLite',
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		offset: { type: 'integer', default: 0 },
		year: { type: 'integer', minimum: 1, maximum: 9998, description: 'Calendar year of the beginning of the birthday range. Defaults to the next occurrence in the server calendar.' },
		birthday: {
			oneOf: [{
				type: 'object',
				properties: {
					month: { type: 'integer', minimum: 1, maximum: 12 },
					day: { type: 'integer', minimum: 1, maximum: 31 },
				},
				required: ['month', 'day'],
			}, {
				type: 'object',
				properties: {
					begin: {
						type: 'object',
						properties: {
							month: { type: 'integer', minimum: 1, maximum: 12 },
							day: { type: 'integer', minimum: 1, maximum: 31 },
						},
						required: ['month', 'day'],
					},
					end: {
						type: 'object',
						properties: {
							month: { type: 'integer', minimum: 1, maximum: 12 },
							day: { type: 'integer', minimum: 1, maximum: 31 },
						},
						required: ['month', 'day'],
					},
				},
				required: ['begin', 'end'],
			}],
		},
	},
	required: ['birthday'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,
		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private userEntityService: UserEntityService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const query = this.followingsRepository
				.createQueryBuilder('following')
				.andWhere('following.followerId = :userId', { userId: me.id })
				.innerJoin(this.userProfilesRepository.metadata.targetName, 'followeeProfile', 'followeeProfile.userId = following.followeeId');

			const range = 'begin' in ps.birthday ? ps.birthday : { begin: ps.birthday, end: ps.birthday };
			const begin = range.begin.month * 100 + range.begin.day;
			const end = range.end.month * 100 + range.end.day;
			const today = new Date();
			const year = ps.year ?? today.getFullYear() + (begin < (today.getMonth() + 1) * 100 + today.getDate() ? 1 : 0);
			const leapDayYear = year + (begin > end && begin > 301 ? 1 : 0);
			const isLeapYear = leapDayYear % 4 === 0 && (leapDayYear % 100 !== 0 || leapDayYear % 400 === 0);
			const rawBirthday = 'get_birthday_date(followeeProfile.birthday)';
			const birthday = isLeapYear ? rawBirthday : `CASE WHEN ${rawBirthday} = 229 THEN 301 ELSE ${rawBirthday} END`;

			// Keep indexed bounds for ordinary birthdays and select leap-day birthdays by their observed date.
			query.andWhere(new Brackets(qb => {
				qb.where(new Brackets(dates => {
					if (begin <= end) {
						dates.where(`${rawBirthday} BETWEEN :begin AND :end`, { begin, end });
					} else {
						dates.where(`${rawBirthday} BETWEEN :begin AND 1231`, { begin });
						dates.orWhere(`${rawBirthday} BETWEEN 101 AND :end`, { end });
					}
				}));
				if (!isLeapYear) {
					qb.andWhere(`${rawBirthday} != 229`);
					if (begin <= end ? begin <= 301 && end >= 301 : begin <= 301 || end >= 301) {
						qb.orWhere(`${rawBirthday} BETWEEN 229 AND 229`);
					}
				}
			}));

			query.select('following.followeeId', 'user_id');
			query.addSelect(birthday, 'birthday_date');
			if (begin > end) {
				query.orderBy(`CASE WHEN ${birthday} >= :begin THEN 0 ELSE 1 END`, 'ASC');
			}
			query.addOrderBy('birthday_date', 'ASC');
			query.addOrderBy('following.followeeId', 'ASC');

			const birthdayUsers = await query
				.offset(ps.offset).limit(ps.limit)
				.getRawMany<{ birthday_date: number; user_id: string }>();

			const users = new Map<string, Packed<'UserLite'>>((
				await this.userEntityService.packMany(
					birthdayUsers.map(u => u.user_id),
					me,
					{ schema: 'UserLite' },
				)
			).map(u => [u.id, u]));

			return birthdayUsers
				.map(item => {
					const occurrenceYear = year + (begin > end && item.birthday_date < begin ? 1 : 0);
					const birthdayStr = `${occurrenceYear.toString().padStart(4, '0')}-${Math.floor(item.birthday_date / 100).toString().padStart(2, '0')}-${(item.birthday_date % 100).toString().padStart(2, '0')}`;
					return {
						id: item.user_id,
						birthday: birthdayStr,
						user: users.get(item.user_id),
					};
				})
				.filter(item => item.user != null)
				.map(item => item as { id: string; birthday: string; user: Packed<'UserLite'> });
		});
	}
}
