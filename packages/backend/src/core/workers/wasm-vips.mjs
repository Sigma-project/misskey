/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// @ts-check

/** @typedef {{ quality?: number, lossless?: boolean, effort?: number, distance?: number }} JxlOptions */
/** @typedef {{ inputBuffer: Buffer, width: number, height: number, options?: JxlOptions }} ConversionRequest */
/** @typedef {{ type: 'ready' } | { type: 'result', data: Buffer } | { type: 'error', error: { name: string, message: string, stack?: string } }} ConversionResponse */

// Keep this entry standalone: rolldown emits it unchanged beside the bundles.
process.on('disconnect', () => process.exit(0));
if (!process.connected || !process.send) throw new Error('Wasm-vips worker requires an IPC channel');

/** @param {ConversionResponse} message */
function send(message) {
	if (!process.connected) process.exit(0);
	process.send?.(message, error => {
		if (error) process.exit(1);
	});
}

const { default: Vips } = await import('wasm-vips');
const vips = await Vips();

process.on('message', /** @param {ConversionRequest} request */ (request) => {
	try {
		const img = vips.Image.thumbnailBuffer(request.inputBuffer, request.width, {
			option_string: 'n=-1',
			height: request.height,
			size: 'down',
		});
		let data;
		try {
			/** @type {Record<string, number | boolean>} */
			const options = {};
			if (request.options?.quality != null) options.Q = request.options.quality;
			if (request.options?.lossless != null) options.lossless = request.options.lossless;
			if (request.options?.effort != null) options.effort = request.options.effort;
			if (request.options?.distance != null) options.distance = request.options.distance;
			data = img.writeToBuffer('.jxl', options);
		} finally {
			img.delete();
		}
		send({ type: 'result', data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
	} catch (error) {
		const exception = error instanceof Error ? error : new Error(String(error));
		send({ type: 'error', error: { name: exception.name, message: exception.message, stack: exception.stack } });
	}
});
send({ type: 'ready' });

export {};
