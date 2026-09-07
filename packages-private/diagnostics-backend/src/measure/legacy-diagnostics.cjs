/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Use a distinct GC request so this also works when the old backend has a GC handler.
const { writeHeapSnapshot } = require('node:v8');

process.on('message', (message) => {
	if (message === 'diagnostics gc') {
		if (global.gc == null) {
			process.send?.('gc unavailable');
		} else {
			for (let i = 0; i < 3; i++) global.gc();
			process.send?.('gc ok');
		}
	} else if (message === 'memory usage') {
		process.send?.({ type: 'memory usage', value: process.memoryUsage() });
	} else if (message != null && typeof message === 'object' && message.type === 'heap snapshot' && typeof message.path === 'string') {
		try {
			const path = writeHeapSnapshot(message.path);
			process.send?.({ type: 'heap snapshot', path });
		} catch (error) {
			process.send?.({ type: 'heap snapshot error', message: error instanceof Error ? error.message : String(error) });
		}
	}
});
