/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type Hls from 'hls.js';

/** Attach a video source and return a disposer, including while hls.js is still loading. */
export function attachVideoSource(
	el: HTMLVideoElement,
	url: string,
	manifestUrl: string | null | undefined,
	loadHls: () => Promise<{ default: typeof Hls }> = () => import('hls.js'),
): () => void {
	let disposed = false;
	let hls: Hls | null = null;

	function play() {
		if (!disposed) void el.play().catch(() => { /* Autoplay may require a user gesture. */ });
	}

	function fallback() {
		if (disposed) return;
		el.removeEventListener('error', fallback);
		hls?.destroy();
		hls = null;
		el.src = url;
		play();
	}

	if (manifestUrl == null) {
		fallback();
	} else if (el.canPlayType('application/vnd.apple.mpegurl') !== '') {
		el.addEventListener('error', fallback, { once: true });
		el.src = manifestUrl;
		play();
	} else {
		void loadHls().then(({ default: HlsCtor }) => {
			if (disposed) return;
			if (!HlsCtor.isSupported()) {
				fallback();
				return;
			}
			const instance = new HlsCtor({ enableWorker: true });
			hls = instance;
			instance.on(HlsCtor.Events.ERROR, (_event, data) => {
				if (data.fatal) fallback();
			});
			instance.on(HlsCtor.Events.MANIFEST_PARSED, play);
			instance.loadSource(manifestUrl);
			instance.attachMedia(el);
		}).catch(fallback);
	}

	return () => {
		disposed = true;
		el.removeEventListener('error', fallback);
		hls?.destroy();
		hls = null;
		el.pause();
		el.removeAttribute('src');
		el.load();
	};
}
