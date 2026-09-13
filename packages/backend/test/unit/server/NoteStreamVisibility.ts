/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Config } from '@/config.js';
import { GlobalEventService, type GlobalEvents } from '@/core/GlobalEventService.js';
import { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';
import Connection from '@/server/api/stream/Connection.js';
import type * as Redis from 'ioredis';

type NoteEvent = GlobalEvents['note']['payload'];
type VisibilityCase = {
	name: string;
	visibility: MiNote['visibility'];
	viewer?: string;
	following?: boolean;
	replyUserId?: string;
	mentions?: string[];
	visibleUserIds?: string[];
	allowed: boolean;
};

const cases: VisibilityCase[] = [
	{ name: 'followers author', visibility: 'followers', viewer: 'author', allowed: true },
	{ name: 'follower', visibility: 'followers', viewer: 'viewer', following: true, allowed: true },
	{ name: 'reply recipient without a mention', visibility: 'followers', viewer: 'viewer', replyUserId: 'viewer', allowed: true },
	{ name: 'mentioned non-follower', visibility: 'followers', viewer: 'viewer', mentions: ['viewer'], allowed: true },
	{ name: 'unrelated non-follower', visibility: 'followers', viewer: 'viewer', replyUserId: 'other', mentions: ['other'], allowed: false },
	{ name: 'anonymous followers viewer', visibility: 'followers', allowed: false },
	{ name: 'specified author', visibility: 'specified', viewer: 'author', allowed: true },
	{ name: 'specified recipient', visibility: 'specified', viewer: 'viewer', visibleUserIds: ['viewer'], allowed: true },
	{ name: 'specified mention outside recipients', visibility: 'specified', viewer: 'viewer', mentions: ['viewer'], visibleUserIds: ['other'], allowed: false },
	{ name: 'specified reply outside recipients', visibility: 'specified', viewer: 'viewer', replyUserId: 'viewer', visibleUserIds: ['other'], allowed: false },
	{ name: 'specified follower outside recipients', visibility: 'specified', viewer: 'viewer', following: true, visibleUserIds: ['other'], allowed: false },
	{ name: 'anonymous specified viewer', visibility: 'specified', visibleUserIds: ['other'], allowed: false },
	{ name: 'public signed-in viewer', visibility: 'public', viewer: 'viewer', allowed: true },
	{ name: 'public anonymous viewer', visibility: 'public', allowed: true },
	{ name: 'home signed-in viewer', visibility: 'home', viewer: 'viewer', allowed: true },
	{ name: 'home anonymous viewer', visibility: 'home', allowed: true },
];

function createConnection(viewer: string | undefined, following = false) {
	const connection = new Connection(mock(), mock(), mock(), mock(), mock(), {
		user: viewer == null ? null : mock<MiUser>({ id: viewer }),
		token: null,
	});
	connection.following = following ? { author: { withReplies: false } } : {};
	const send = vi.spyOn(connection, 'sendMessageToWs').mockImplementation(() => {});
	return { connection, send };
}

function publishNote(testCase: VisibilityCase, type: 'reacted' | 'deleted'): NoteEvent {
	const redis = mock<Redis.Redis>();
	const service = new GlobalEventService(mock<Config>({ host: 'example.test' }), redis);
	const note = new MiNote({
		id: 'note',
		userId: 'author',
		visibility: testCase.visibility,
		visibleUserIds: testCase.visibleUserIds ?? [],
		replyUserId: testCase.replyUserId ?? null,
		mentions: testCase.mentions ?? [],
	});
	if (type === 'reacted') {
		service.publishNoteStream(note, 'reacted', { reaction: '❤', userId: 'reactor' });
	} else {
		service.publishNoteStream(note, 'deleted', { deletedAt: new Date('2026-09-14T00:00:00Z') });
	}
	expect(redis.publish).toHaveBeenCalledOnce();
	const envelope = JSON.parse(redis.publish.mock.calls[0][1] as string);
	expect(envelope.channel).toBe('noteStream:note');
	expect(envelope.message.body.replyUserId).toBe(note.replyUserId);
	expect(envelope.message.body.mentions).toEqual(note.mentions);
	return envelope.message;
}

describe.each(['reacted', 'deleted'] as const)('note stream visibility: %s', type => {
	test.each(cases)('$name', async testCase => {
		const event = publishNote(testCase, type);
		const { connection, send } = createConnection(testCase.viewer, testCase.following);
		await connection['onNoteStreamMessage'](event);
		if (testCase.allowed) {
			expect(send).toHaveBeenCalledExactlyOnceWith('noteUpdated', {
				id: 'note', type, body: event.body.body,
			});
		} else {
			expect(send).not.toHaveBeenCalled();
		}
	});

	test.each([
		{ name: 'author', viewer: 'author', following: false, allowed: true },
		{ name: 'follower', viewer: 'viewer', following: true, allowed: true },
		{ name: 'unrelated viewer', viewer: 'viewer', following: false, allowed: false },
		{ name: 'anonymous viewer', viewer: undefined, following: false, allowed: false },
	])('accepts an old envelope for $name without broadening access', async testCase => {
		const event = publishNote({ ...testCase, visibility: 'followers' }, type);
		// During rolling updates, existing publishers omit both new fields.
		Reflect.deleteProperty(event.body, 'replyUserId');
		Reflect.deleteProperty(event.body, 'mentions');
		const { connection, send } = createConnection(testCase.viewer, testCase.following);
		await connection['onNoteStreamMessage'](event);
		expect(send).toHaveBeenCalledTimes(testCase.allowed ? 1 : 0);
	});
});
