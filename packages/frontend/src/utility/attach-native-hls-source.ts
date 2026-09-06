/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Native HLS support does not imply support for the codecs in the manifest. */
export function attachNativeHlsSource(el: HTMLVideoElement, manifestUrl: string, originalUrl: string): () => void {
	const fallback = () => {
		el.src = originalUrl;
	};
	el.addEventListener('error', fallback, { once: true });
	el.src = manifestUrl;

	return () => el.removeEventListener('error', fallback);
}
