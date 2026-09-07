/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Page } from 'playwright';

/** Share the same UI scenario across the data-cy and data-testid generations. */
export function locateDiagnosticControl(page: Page, id: string) {
	const legacyId = id === 'user-setup-dialog' ? 'user-setup'
		: id === 'post-form-submit' ? 'open-post-form-submit' : id;
	return page.locator(`[data-testid="${id}"], [data-cy-${legacyId}]`);
}
