import assert, { strictEqual } from 'node:assert';
import { createAccount, type LoginUser, sleep } from './utils.js';

describe('Move', () => {
	test('Minimum move', async () => {
		const [alice, bob] = await Promise.all([
			createAccount('a.test'),
			createAccount('b.test'),
		]);

		await bob.client.request('i/update', { alsoKnownAs: [`@${alice.username}@a.test`] });
		await alice.client.request('i/move', { moveToAccount: `@${bob.username}@b.test` });
	});

	/** @see https://github.com/misskey-dev/misskey/issues/11320 */
	describe('Following relation is transferred after move', () => {
		let alice: LoginUser, bob: LoginUser, carol: LoginUser;

		beforeAll(async () => {
			[alice, bob] = await Promise.all([
				createAccount('a.test'),
				createAccount('b.test'),
			]);
			carol = await createAccount('a.test');

			// Follow @carol@a.test ==> @alice@a.test
			await carol.client.request('following/create', { userId: alice.id });

			// Move @alice@a.test ==> @bob@b.test
			await bob.client.request('i/update', { alsoKnownAs: [`@${alice.username}@a.test`] });
			await alice.client.request('i/move', { moveToAccount: `@${bob.username}@b.test` });
			// Moving schedules relationship/delivery jobs; the HTTP response does not await federation.
			const deadline = Date.now() + 10_000;
			while (true) {
				const [following, followers] = await Promise.all([
					carol.client.request('users/following', { userId: carol.id }),
					bob.client.request('users/followers', { userId: bob.id }),
				]);
				if (following.some(({ followee }) => followee?.url === `https://b.test/@${bob.username}`)
					&& followers.some(({ follower }) => follower?.url === `https://a.test/@${carol.username}`)) break;
				assert(Date.now() < deadline, `Move did not federate within 10 seconds (following=${following.length}, followers=${followers.length})`);
				await sleep(100);
			}
		}, 20_000);

		test('Check from follower', async () => {
			const following = await carol.client.request('users/following', { userId: carol.id });
			strictEqual(following.length, 2);
			const followees = following.map(({ followee }) => followee);
			assert(followees.every(followee => followee != null));
			assert(followees.some(({ id, url }) => id === alice.id && url === null));
			assert(followees.some(({ url }) => url === `https://b.test/@${bob.username}`));
		});

		test('Check from followee', async () => {
			const followers = await bob.client.request('users/followers', { userId: bob.id });
			strictEqual(followers.length, 1);
			const follower = followers[0].follower;
			assert(follower != null);
			strictEqual(follower.url, `https://a.test/@${carol.username}`);
		});
	});
});
