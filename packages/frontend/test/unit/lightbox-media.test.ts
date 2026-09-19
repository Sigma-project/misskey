/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, h, nextTick, reactive, shallowRef } from 'vue';
import { preferState } from '../setup.unit.js';
import MkLightboxItem from '@/components/MkLightbox.item.vue';
import type { Content } from '@/components/MkLightbox.item.vue';
import { attachVideoSource } from '@/utility/attach-video-source.js';

vi.mock('@/utility/attach-video-source.js', () => ({ attachVideoSource: vi.fn(() => vi.fn()) }));
vi.mock('@/utility/sensitive-file.js', () => ({
	shouldHideFileByDefault: (file: { isSensitive: boolean }) => file.isSensitive,
	canRevealFile: async () => true,
}));
vi.mock('@/os.js', () => ({ popupMenu: vi.fn() }));
vi.mock('@/utility/get-file-menu.js', () => ({ getFileMenu: () => [] }));
vi.mock('@/components/MkBlurhash.vue', () => ({ default: { render: () => null } }));
vi.mock('@/components/MkLightbox.item.controls.vue', () => ({ default: { render: () => null } }));
vi.mock('@/components/MkLightbox.item.fileinfo.vue', () => ({ default: { render: () => null } }));

const unmounts: (() => void)[] = [];

async function mountItem(type: 'video' | 'audio', sensitive = false, activated = true) {
	const content: Content = {
		id: 'media', type, url: 'https://example.test/original.mp4',
		file: { isSensitive: sensitive, hlsManifestUrl: 'https://example.test/master.m3u8' } as Content['file'],
	};
	const props = reactive({ content, activated, pixelatedZoom: false });
	const item = shallowRef<InstanceType<typeof MkLightboxItem>>();
	const root = document.createElement('div');
	document.body.append(root);
	const app = createApp({ render: () => h(MkLightboxItem, { ...props, ref: item }) });
	app.mount(root);
	unmounts.push(() => { app.unmount(); root.remove(); });
	await nextTick();
	return { item: item.value!, props, root };
}

beforeEach(() => {
	preferState.useNativeUiForVideoAudioPlayer = true;
	vi.mocked(attachVideoSource).mockClear();
	vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
	vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
	for (const unmount of unmounts.splice(0)) unmount();
	delete preferState.useNativeUiForVideoAudioPlayer;
	vi.restoreAllMocks();
});

describe('Lightbox media lifecycle', () => {
	test('attaches only the current video and disposes it on deactivation, close and unmount', async () => {
		const { item, root } = await mountItem('video');
		expect(attachVideoSource).not.toHaveBeenCalled();
		item.onActive();
		expect(attachVideoSource).toHaveBeenCalledWith(root.querySelector('video'), 'https://example.test/original.mp4', 'https://example.test/master.m3u8');
		const firstDispose = vi.mocked(attachVideoSource).mock.results[0].value;
		item.onDeactive();
		expect(firstDispose).toHaveBeenCalledOnce();
		item.onActive();
		expect(attachVideoSource).toHaveBeenCalledTimes(2);
		const secondDispose = vi.mocked(attachVideoSource).mock.results[1].value;
		item.closeThis();
		expect(secondDispose).toHaveBeenCalledOnce();
		item.onActive();
		const finalDispose = vi.mocked(attachVideoSource).mock.results[2].value;
		unmounts.pop()!();
		expect(finalDispose).toHaveBeenCalledOnce();
	});

	test('does not attach hidden media and detaches when revealed sensitive content changes', async () => {
		const { item, props, root } = await mountItem('video', true);
		item.onActive();
		expect(attachVideoSource).not.toHaveBeenCalled();
		root.querySelector<HTMLElement>('[data-gallery-click-action="hidden"]')!.click();
		await nextTick();
		await nextTick();
		expect(attachVideoSource).toHaveBeenCalledOnce();
		const dispose = vi.mocked(attachVideoSource).mock.results[0].value;
		props.content.url = 'https://example.test/other.mp4';
		await nextTick();
		expect(dispose).toHaveBeenCalledOnce();
		expect(root.querySelector('video')).toBeNull();
	});

	test('does not play a late audio element after deactivation, but can play it on reactivation', async () => {
		const { item, props, root } = await mountItem('audio', false, false);
		item.onActive();
		item.onDeactive();
		await nextTick();
		props.activated = true;
		await nextTick();
		await nextTick();
		expect(root.querySelector('audio')).not.toBeNull();
		expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
		item.onActive();
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
		expect(attachVideoSource).not.toHaveBeenCalled();
	});
});
