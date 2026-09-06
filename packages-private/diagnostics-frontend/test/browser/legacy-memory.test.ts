/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test } from 'vitest';
import { HeadlessChromeController } from '../../src/browser/controller';

test('allows an absent memory API only for base and rejects invalid measurements', async () => {
	const controller = Object.create(HeadlessChromeController.prototype) as HeadlessChromeController;
	Object.assign(controller, { allowUnavailableTabMemory: true, evaluate: async () => ({ unavailable: true }) });
	await expect(controller.collectTabMemory()).resolves.toEqual({ totalBytes: null });
	Object.assign(controller, { allowUnavailableTabMemory: false });
	await expect(controller.collectTabMemory()).rejects.toThrow('did not return finite bytes');
	Object.assign(controller, { allowUnavailableTabMemory: true, evaluate: async () => ({ bytes: Number.NaN }) });
	await expect(controller.collectTabMemory()).rejects.toThrow('did not return finite bytes');
	Object.assign(controller, { evaluate: async () => ({ bytes: 1024 }) });
	await expect(controller.collectTabMemory()).resolves.toEqual({ totalBytes: 1024 });
});
