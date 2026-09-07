/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DEFAULT_INVITATION_CODE, registerUser, resetState, visitHome, waitApiResponse } from '../../../../packages/frontend/test/e2e/shared';
import { sleep } from './server';
import { locateDiagnosticControl } from './selectors';
import type { HeadlessChromeController } from './controller';

export const scenarioDescription = 'fresh browser signup, first timeline note, after the note becomes visible';

/**
 * 各ラウンドを同じ初期状態から始めるため、DBを消して管理者だけ作り直す。
 */
export async function prepareInstance(baseUrl: string) {
	await resetState(baseUrl);
	await registerUser(baseUrl, 'admin', 'admin1234', true);
}

export async function runSignupAndPostScenario(chrome: HeadlessChromeController, baseUrl: string) {
	const page = chrome.page;
	const noteText = `Frontend browser metrics ${Date.now()}`;

	await visitHome(page, baseUrl);
	const control = (id: string) => locateDiagnosticControl(page, id);
	await control('signup').click();
	await control('signup-rules-continue').waitFor({ state: 'visible' });
	await control('signup-rules-notes-agree').locator('[data-testid="switch-toggle"], [data-cy-switch-toggle]').click();
	await control('modal-dialog-ok').click();
	await control('signup-rules-continue').click();
	await control('signup-username').locator('input').fill('alice');
	await control('signup-password').locator('input').fill('password');
	await control('signup-password-retype').locator('input').fill('password');
	await control('signup-invitation-code').locator('input').fill(DEFAULT_INVITATION_CODE);
	const signupResponse = waitApiResponse(page, '/api/signup');
	await control('signup-submit').click();
	await signupResponse;
	await control('user-setup-dialog').locator('[data-testid="modal-window-close"], [data-cy-modal-window-close]').click();
	await control('modal-dialog-ok').click();
	await control('open-post-form').click();
	await control('post-form-text').fill(noteText);
	await control('post-form-submit').click();
	await page.getByText(noteText).waitFor({ timeout: 10_000 });

	// 投稿直後の非同期処理が落ち着いてから計測したいので少し待つ
	await sleep(1000);
}
