/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'misskey-js';
import { readAndCompressImage } from '@misskey-dev/browser-image-resizer';
import { isFileAnimated } from '@/utility/isFileAnimated.js';
import { EventEmitter } from 'eventemitter3';
import { computed, markRaw, onMounted, onUnmounted, ref, triggerRef } from 'vue';
import type { MenuItem } from '@/types/menu.js';
import type { WatermarkLayers, WatermarkPreset } from '@/utility/watermark/WatermarkRenderer.js';
import type { ImageFrameParams, ImageFramePreset } from '@/utility/image-frame-renderer/ImageFrameRenderer.js';
import { genId } from '@/utility/id.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { isJxlSupported } from '@/utility/isJxlSupported.js';
import { isAvifSupported } from '@/utility/isAvifSupported.js';
import { encodeToJxl, getImageDataFromCanvas } from '@/utility/jxl-encoder.js';
import { uploadFile, UploadAbortedError } from '@/utility/drive.js';
import type { Content } from '@/components/MkLightbox.item.vue';
import * as os from '@/os.js';
import { ensureSignin } from '@/i.js';

export type UploaderFeatures = {
	imageEditing?: boolean;
	watermark?: boolean;
};

const THUMBNAIL_SUPPORTED_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/avif',
	'image/jxl',
	'image/svg+xml',
	'image/gif',
	'image/bmp',
	'image/apng',
];

const IMAGE_EDITING_SUPPORTED_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/avif',
	'image/gif',
	'image/bmp',
	'image/apng',
];

const VIDEO_COMPRESSION_SUPPORTED_TYPES = [ // TODO
	'video/mp4',
	'video/quicktime',
	'video/x-matroska',
];

const IMAGE_PREPROCESS_NEEDED_TYPES = [
	...IMAGE_EDITING_SUPPORTED_TYPES,
];

const VIDEO_PREPROCESS_NEEDED_TYPES = [
	...VIDEO_COMPRESSION_SUPPORTED_TYPES,
];

export type UploaderItem = {
	id: string;
	name: string;
	suffix: string;
	progress: { max: number; value: number } | null;
	thumbnail: string | null;
	preprocessing: boolean;
	preprocessProgress: number | null;
	uploading: boolean;
	uploaded: Misskey.entities.DriveFile | null;
	uploadFailed: boolean;
	aborted: boolean;
	compressionLevel: 0 | 1 | 2 | 3 | 4;
	compressedSize?: number | null;
	preprocessedFile?: Blob | null;
	file: File;
	objectUrl: string;
	watermarkPreset: WatermarkPreset | null;
	watermarkLayers: WatermarkLayers | null;
	imageFrameParams: ImageFrameParams | null;
	isSensitive?: boolean;
	caption?: string | null;
	isAnimated?: boolean;
	abort?: (() => void) | null;
	abortPreprocess?: (() => void) | null;
};

export function getUploadName(item: UploaderItem): string {
	return item.name + (item.name.endsWith(item.suffix) ? '' : item.suffix);
}

function getCompressionSettings(level: 0 | 1 | 2 | 3 | 4) {
	if (level === 1) {
		return {
			maxWidth: Infinity,
			maxHeight: Infinity,
			canvasQuality: 1.0,
			jxlQuality: 100,
			lossless: true,
		};
	} else if (level === 2) {
		return {
			maxWidth: 4096,
			maxHeight: 4096,
			canvasQuality: 0.90,
			jxlQuality: 90,
			lossless: false,
		};
	} else if (level === 3) {
		return {
			maxWidth: 2560,
			maxHeight: 2560,
			canvasQuality: 0.85,
			jxlQuality: 85,
			lossless: false,
		};
	} else if (level === 4) {
		return {
			maxWidth: 1920,
			maxHeight: 1920,
			canvasQuality: 0.70,
			jxlQuality: 70,
			lossless: false,
		};
	} else {
		return null;
	}
}

export function useUploader(options: {
	folderId?: string | null;
	multiple?: boolean;
	features?: UploaderFeatures;
} = {}) {
	const $i = ensureSignin();

	const events = new EventEmitter<{
		'itemUploaded': (ctx: { item: UploaderItem; }) => void;
	}>();

	const uploaderFeatures = computed<Required<UploaderFeatures>>(() => {
		return {
			imageEditing: options.features?.imageEditing ?? true,
			watermark: options.features?.watermark ?? true,
		};
	});

	const items = ref<UploaderItem[]>([]);

	function initializeFile(file: File) {
		const id = genId();
		const filename = file.name ?? 'untitled';
		const extension = filename.split('.').length > 1 ? '.' + filename.split('.').pop() : '';
		const watermarkPreset = uploaderFeatures.value.watermark && $i.policies.watermarkAvailable ? (prefer.s.watermarkPresets.find(p => p.id === prefer.s.defaultWatermarkPresetId) ?? null) : null;
		const objectUrl = window.URL.createObjectURL(file);
		items.value.push({
			id,
			name: prefer.s.keepOriginalFilename ? filename : id + extension,
			suffix: '',
			progress: null,
			thumbnail: THUMBNAIL_SUPPORTED_TYPES.includes(file.type) ? objectUrl : null,
			preprocessing: false,
			preprocessProgress: null,
			uploading: false,
			aborted: false,
			uploaded: null,
			uploadFailed: false,
			compressionLevel: IMAGE_EDITING_SUPPORTED_TYPES.includes(file.type) ? prefer.s.defaultImageCompressionLevel : VIDEO_COMPRESSION_SUPPORTED_TYPES.includes(file.type) ? prefer.s.defaultVideoCompressionLevel : 0,
			watermarkPreset,
			watermarkLayers: watermarkPreset?.layers ?? null,
			imageFrameParams: null,
			file: markRaw(file),
			objectUrl,
		});
		const reactiveItem = items.value.at(-1)!;
		preprocess(reactiveItem).then(() => {
			triggerRef(items);
		});
	}

	function addFiles(newFiles: File[]) {
		for (const file of newFiles) {
			initializeFile(file);
		}
	}

	function revokeItemObjectUrls(item: UploaderItem) {
		if (item.thumbnail != null) URL.revokeObjectURL(item.thumbnail);
		URL.revokeObjectURL(item.objectUrl);
	}

	function createItemObjectUrl(item: UploaderItem, file: Blob | File): string {
		revokeItemObjectUrls(item);
		return window.URL.createObjectURL(file);
	}

	function updateItemObjectUrls(item: UploaderItem, file: Blob | File) {
		const newObjectUrl = createItemObjectUrl(item, file);
		item.objectUrl = newObjectUrl;
		item.thumbnail = THUMBNAIL_SUPPORTED_TYPES.includes(file.type) ? newObjectUrl : null;
	}

	function removeItem(item: UploaderItem) {
		revokeItemObjectUrls(item);
		items.value.splice(items.value.indexOf(item), 1);
	}

	function getMenu(item: UploaderItem): MenuItem[] {
		const menu: MenuItem[] = [];

		if (
			!item.preprocessing &&
			!item.uploading &&
			!item.uploaded
		) {
			menu.push({
				icon: 'ti ti-forms',
				text: i18n.ts.rename,
				action: async () => {
					const { result, canceled } = await os.inputText({
						type: 'text',
						title: i18n.ts.rename,
						placeholder: item.name,
						default: item.name,
					});
					if (canceled) return;
					if (result.trim() === '') return;

					item.name = result;
				},
			}, {
				type: 'switch',
				text: i18n.ts.sensitive,
				icon: 'ti ti-eye-exclamation',
				ref: computed({
					get: () => item.isSensitive ?? false,
					set: (value) => item.isSensitive = value,
				}),
			}, {
				text: i18n.ts.describeFile,
				icon: 'ti ti-text-caption',
				action: async () => {
					const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkFileCaptionEditWindow.vue').then(x => x.default), {
						default: item.caption ?? null,
					}, {
						done: caption => {
							if (caption != null) {
								item.caption = caption.trim().length === 0 ? null : caption;
							}
						},
						closed: () => dispose(),
					});
				},
			});

			if (item.file.type.startsWith('image/') || item.file.type.startsWith('video/')) {
				menu.push({
					text: i18n.ts.preview,
					icon: 'ti ti-photo-search',
					action: async () => {
						const contents = items.value
							.filter(item => item.file.type.startsWith('image/') || item.file.type.startsWith('video/'))
							.map<Content>(item => ({
								id: item.id,
								type: item.file.type.startsWith('video/') ? 'video' : 'image',
								url: item.objectUrl,
								thumbnail: item.thumbnail,
								filename: getUploadName(item),
								caption: item.caption ?? null,
							}));

						const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkLightbox.vue').then(x => x.default), {
							defaultIndex: contents.findIndex(x => x.id === item.id),
							contents,
						}, {
							closed: () => dispose(),
						});
					},
				});
			}

			menu.push({
				type: 'divider',
			});
		}

		if (
			uploaderFeatures.value.imageEditing &&
			IMAGE_EDITING_SUPPORTED_TYPES.includes(item.file.type) &&
			!item.isAnimated &&
			!item.preprocessing &&
			!item.uploading &&
			!item.uploaded
		) {
			menu.push({
				type: 'parent',
				icon: 'ti ti-photo-edit',
				text: i18n.ts._uploader.editImage,
				children: [{
					icon: 'ti ti-crop',
					text: i18n.ts.cropImage,
					action: async () => {
						const cropped = await os.cropImageFile(item.file, { aspectRatio: null });
						const newObjectUrl = createItemObjectUrl(item, cropped);
						items.value.splice(items.value.indexOf(item), 1, {
							...item,
							file: markRaw(cropped),
							thumbnail: THUMBNAIL_SUPPORTED_TYPES.includes(cropped.type) ? newObjectUrl : null,
							objectUrl: newObjectUrl,
						});
						const reactiveItem = items.value.find(x => x.id === item.id)!;
						preprocess(reactiveItem).then(() => {
							triggerRef(items);
						});
					},
				}, /*{
					icon: 'ti ti-resize',
					text: i18n.ts.resize,
					action: async () => {
						// TODO
					},
				},*/ {
					icon: 'ti ti-sparkles',
					text: i18n.ts._imageEffector.title,
					action: async () => {
						const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkImageEffectorDialog.vue').then(x => x.default), {
							image: item.file,
						}, {
							ok: (file) => {
									const newObjectUrl = createItemObjectUrl(item, file);
								items.value.splice(items.value.indexOf(item), 1, {
									...item,
									file: markRaw(file),
									thumbnail: THUMBNAIL_SUPPORTED_TYPES.includes(file.type) ? newObjectUrl : null,
									objectUrl: newObjectUrl,
								});
								const reactiveItem = items.value.find(x => x.id === item.id)!;
								preprocess(reactiveItem).then(() => {
									triggerRef(items);
								});
							},
							closed: () => dispose(),
						});
					},
				}],
			});
		}

		if (
			uploaderFeatures.value.watermark &&
			$i.policies.watermarkAvailable &&
			IMAGE_EDITING_SUPPORTED_TYPES.includes(item.file.type) &&
			!item.isAnimated &&
			!item.preprocessing &&
			!item.uploading &&
			!item.uploaded
		) {
			function change(layers: WatermarkLayers | null, preset?: WatermarkPreset | null) {
				item.watermarkPreset = preset ?? null;
				item.watermarkLayers = layers;
				preprocess(item).then(() => {
					triggerRef(items);
				});
			}

			menu.push({
				icon: 'ti ti-copyright',
				text: i18n.ts.watermark,
				caption: computed(() => item.watermarkPreset != null ? item.watermarkPreset.name : item.watermarkLayers != null ? i18n.ts.custom : null),
				type: 'parent',
				children: [{
					type: 'button' as const,
					icon: 'ti ti-pencil',
					text: i18n.ts.edit,
					action: async () => {
						const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkWatermarkEditorDialog.vue').then(x => x.default), {
							layers: item.watermarkLayers,
							image: item.file,
						}, {
							ok: (layers) => {
								change(layers);
							},
							closed: () => dispose(),
						});
					},
				}, {
					type: 'button' as const,
					icon: 'ti ti-x',
					text: i18n.ts.remove,
					action: () => change(null),
				}, {
					type: 'divider',
				}, {
					type: 'label',
					text: i18n.ts.presets,
				}, ...prefer.s.watermarkPresets.map(preset => ({
					type: 'radioOption' as const,
					text: preset.name,
					active: computed(() => item.watermarkPreset?.id === preset.id),
					action: () => change(preset.layers, preset),
				}))],
			});
		}

		if (
			uploaderFeatures.value.imageEditing &&
			IMAGE_EDITING_SUPPORTED_TYPES.includes(item.file.type) &&
			!item.isAnimated &&
			!item.preprocessing &&
			!item.uploading &&
			!item.uploaded
		) {
			function change(params: ImageFrameParams | null) {
				item.imageFrameParams = params;
				preprocess(item).then(() => {
					triggerRef(items);
				});
			}

			menu.push({
				icon: 'ti ti-device-ipad-horizontal',
				text: i18n.ts.frame,
				type: 'parent' as const,
				children: [{
					type: 'button' as const,
					icon: 'ti ti-pencil',
					text: i18n.ts.edit,
					action: async () => {
						const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkImageFrameEditorDialog.vue').then(x => x.default), {
							params: item.imageFrameParams,
							image: item.file,
							imageCaption: item.caption ?? null,
							imageFilename: item.name,
						}, {
							ok: (params) => {
								change(params);
							},
							closed: () => dispose(),
						});
					},
				}, ...(item.imageFrameParams != null ? [{
					type: 'button' as const,
					icon: 'ti ti-x',
					text: i18n.ts.remove,
					action: () => change(null),
				}] : []), {
					type: 'divider' as const,
				}, {
					type: 'label' as const,
					text: i18n.ts.presets,
				}, ...prefer.s.imageFramePresets.map(preset => ({
					type: 'button' as const,
					text: preset.name,
					action: async () => {
						const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkImageFrameEditorDialog.vue').then(x => x.default), {
							params: preset.params,
							image: item.file,
							imageCaption: item.caption ?? null,
							imageFilename: item.name,
						}, {
							ok: (params) => {
								change(params);
							},
							closed: () => dispose(),
						});
					},
				}))],
			});
		}

		if (
			(IMAGE_EDITING_SUPPORTED_TYPES.includes(item.file.type) || VIDEO_COMPRESSION_SUPPORTED_TYPES.includes(item.file.type)) &&
			!item.isAnimated &&
			!item.preprocessing &&
			!item.uploading &&
			!item.uploaded
		) {
			function changeCompressionLevel(level: 0 | 1 | 2 | 3 | 4) {
				item.compressionLevel = level;
				preprocess(item).then(() => {
					triggerRef(items);
				});
			}

			menu.push({
				icon: 'ti ti-leaf',
				text: computed(() => {
					let text = i18n.ts.compress;

					if (item.compressionLevel === 0 || item.compressionLevel == null) {
						text += `: ${i18n.ts.none}`;
					} else if (item.compressionLevel === 1) {
						text += `: ${i18n.ts.highest}`;
					} else if (item.compressionLevel === 2) {
						text += `: ${i18n.ts.high}`;
					} else if (item.compressionLevel === 3) {
						text += `: ${i18n.ts.medium}`;
					} else if (item.compressionLevel === 4) {
						text += `: ${i18n.ts.low}`;
					}

					return text;
				}),
				type: 'parent',
				children: [{
					type: 'radioOption',
					text: i18n.ts.none,
					active: computed(() => item.compressionLevel === 0 || item.compressionLevel == null),
					action: () => changeCompressionLevel(0),
				}, {
					type: 'divider',
				}, {
					type: 'radioOption',
					text: i18n.ts.highest,
					active: computed(() => item.compressionLevel === 1),
					action: () => changeCompressionLevel(1),
				}, {
					type: 'radioOption',
					text: i18n.ts.high,
					active: computed(() => item.compressionLevel === 2),
					action: () => changeCompressionLevel(2),
				}, {
					type: 'radioOption',
					text: i18n.ts.medium,
					active: computed(() => item.compressionLevel === 3),
					action: () => changeCompressionLevel(3),
				}, {
					type: 'radioOption',
					text: i18n.ts.low,
					active: computed(() => item.compressionLevel === 4),
					action: () => changeCompressionLevel(4),
				}],
			});
		}

		if (!item.preprocessing && !item.uploading && !item.uploaded) {
			menu.push({
				type: 'divider',
			}, {
				icon: 'ti ti-upload',
				text: i18n.ts.upload,
				action: () => {
					uploadOne(item);
				},
			}, {
				icon: 'ti ti-x',
				text: i18n.ts.remove,
				danger: true,
				action: () => {
					removeItem(item);
				},
			});
		} else if (item.preprocessing && item.abortPreprocess != null) {
			menu.push({
				type: 'divider',
			}, {
				icon: 'ti ti-player-stop',
				text: i18n.ts.abort,
				danger: true,
				action: () => {
					if (item.abortPreprocess != null) {
						item.abortPreprocess();
					}
				},
			});
		} else if (item.uploading) {
			menu.push({
				type: 'divider',
			}, {
				icon: 'ti ti-cloud-pause',
				text: i18n.ts.abort,
				danger: true,
				action: () => {
					if (item.abort != null) {
						item.abort();
					}
				},
			});
		}

		return menu;
	}

	async function uploadOne(item: UploaderItem): Promise<void> {
		item.uploadFailed = false;
		item.uploading = true;

		const { filePromise, abort } = uploadFile(item.preprocessedFile ?? item.file, {
			name: getUploadName(item),
			folderId: options.folderId === undefined ? prefer.s.uploadFolder : options.folderId,
			isSensitive: item.isSensitive ?? false,
			caption: item.caption ?? null,
			onProgress: (progress) => {
				if (item.progress == null) {
					item.progress = { max: progress.total, value: progress.loaded };
				} else {
					item.progress.value = progress.loaded;
					item.progress.max = progress.total;
				}
			},
		});

		item.abort = () => {
			item.abort = null;
			abort();
			item.uploading = false;
			item.uploadFailed = true;
		};

		await filePromise.then((file) => {
			item.uploaded = file;
			item.abort = null;
			events.emit('itemUploaded', { item });
		}).catch(err => {
			item.uploadFailed = true;
			item.progress = null;
			if (!(err instanceof UploadAbortedError)) {
				throw err;
			}
		}).finally(() => {
			item.uploading = false;
		});
	}

	async function upload() { // エラーハンドリングなどを考慮してシーケンシャルにやる
		items.value = items.value.map(item => ({
			...item,
			aborted: false,
			uploadFailed: false,
			uploading: false,
		}));

		for (const item of items.value.filter(item => item.uploaded == null)) {
			// アップロード処理途中で値が変わる場合（途中で全キャンセルされたりなど）もあるので、Array filterではなくここでチェック
			if (item.aborted) {
				continue;
			}

			await uploadOne(item);
		}
	}

	function abortAll() {
		for (const item of items.value) {
			if (item.uploaded != null) {
				continue;
			}

			if (item.abortPreprocess != null) {
				item.abortPreprocess();
			}

			if (item.abort != null) {
				item.abort();
			}
			item.aborted = true;
			item.uploadFailed = true;
		}
	}

	async function preprocess(item: UploaderItem): Promise<void> {
		item.preprocessing = true;
		item.preprocessProgress = null;

		if (IMAGE_PREPROCESS_NEEDED_TYPES.includes(item.file.type)) {
			try {
				await preprocessForImage(item);
			} catch (err) {
				console.error('Failed to preprocess image', err);

			// nop
			}
		}

		if (VIDEO_PREPROCESS_NEEDED_TYPES.includes(item.file.type)) {
			try {
				await preprocessForVideo(item);
			} catch (err) {
				console.error('Failed to preprocess video', err);

				// nop
			}
		}

		item.preprocessing = false;
		item.preprocessProgress = null;
	}

	async function preprocessForImage(item: UploaderItem): Promise<void> {
		item.isAnimated = await isFileAnimated(item.file);

		// アニメ画像は watermark/image-frame/圧縮いずれの canvas 経路でも 1 フレーム化されてしまうため、
		// 設定済みのレイヤー類をクリアした上で前処理をすべてスキップする
		if (item.isAnimated) {
			item.watermarkLayers = null;
			item.imageFrameParams = null;
			item.compressedSize = null;
			item.suffix = '';
			item.preprocessedFile = markRaw(item.file);
			return;
		}

		const imageBitmap = await window.createImageBitmap(item.file);

		let preprocessedFile: Blob | File = item.file;

		const needsWatermark = item.watermarkLayers != null && IMAGE_EDITING_SUPPORTED_TYPES.includes(preprocessedFile.type) && $i.policies.watermarkAvailable;
		if (needsWatermark && item.watermarkLayers != null) {
			const canvas = window.document.createElement('canvas');
			const WatermarkRenderer = await import('@/utility/watermark/WatermarkRenderer.js').then(x => x.WatermarkRenderer);
			const renderer = new WatermarkRenderer({
				canvas: canvas,
				renderWidth: imageBitmap.width,
				renderHeight: imageBitmap.height,
				image: imageBitmap,
			});

			await renderer.render(item.watermarkLayers);

			preprocessedFile = await new Promise<Blob>((resolve) => {
				canvas.toBlob((blob) => {
					if (blob == null) {
						throw new Error('Failed to convert canvas to blob');
					}
					resolve(blob);
					renderer.destroy();
				}, 'image/png');
			});
		}

		const needsImageFrame = item.imageFrameParams != null && IMAGE_EDITING_SUPPORTED_TYPES.includes(preprocessedFile.type);
		if (needsImageFrame && item.imageFrameParams != null) {
			const canvas = window.document.createElement('canvas');
			const ExifReader = await import('exifreader');
			const exif = await ExifReader.load(await item.file.arrayBuffer());
			const ImageFrameRenderer = await import('@/utility/image-frame-renderer/ImageFrameRenderer.js').then(x => x.ImageFrameRenderer);
			const frameRenderer = new ImageFrameRenderer({
				canvas: canvas,
				image: await window.createImageBitmap(preprocessedFile),
				exif,
				caption: item.caption ?? null,
				filename: item.name,
			});

			await frameRenderer.render(item.imageFrameParams);

			preprocessedFile = await new Promise<Blob>((resolve) => {
				canvas.toBlob((blob) => {
					if (blob == null) {
						throw new Error('Failed to convert canvas to blob');
					}
					resolve(blob);
					frameRenderer.destroy();
				}, 'image/png');
			});
		}

		const compressionSettings = getCompressionSettings(item.compressionLevel);
		const needsCompress = item.compressionLevel !== 0 && compressionSettings && IMAGE_EDITING_SUPPORTED_TYPES.includes(preprocessedFile.type);

		if (needsCompress) {
			let compressed = false;

			// Stage 1: Canvas JXL（ブラウザが Canvas API で JXL をネイティブサポートしている場合）
			if (!compressed && isJxlSupported()) {
				try {
					const result = await readAndCompressImage(preprocessedFile, {
						mimeType: 'image/jxl' as const,
						maxWidth: compressionSettings.maxWidth,
						maxHeight: compressionSettings.maxHeight,
						quality: compressionSettings.canvasQuality,
					});
					// Canvas API はEXIF除去を兼ねるため、サイズ増加でも採用する
					preprocessedFile = result;
					item.compressedSize = result.size;
					item.suffix = '';
					compressed = true;
				} catch (err) {
					console.error('Failed to compress image with Canvas JXL', err);
				}
			}

			// Stage 2: WASM JXL（@jsquash/jxl でエンコード）
			if (!compressed) {
				try {
					const resizedCanvas = await readAndCompressImage(preprocessedFile, {
						mimeType: null,
						maxWidth: compressionSettings.maxWidth,
						maxHeight: compressionSettings.maxHeight,
					});
					const imageData = getImageDataFromCanvas(resizedCanvas);
					const jxlBlob = await encodeToJxl(imageData, {
						quality: compressionSettings.jxlQuality,
						lossless: compressionSettings.lossless,
						effort: 9,
					});
					if (jxlBlob != null && (jxlBlob.size < preprocessedFile.size || compressionSettings.lossless)) {
						preprocessedFile = jxlBlob;
						item.compressedSize = jxlBlob.size;
						item.suffix = '';
						compressed = true;
					}
				} catch (err) {
					console.error('Failed to compress image with WASM JXL', err);
				}
			}

			// Stage 3: Canvas AVIF/WebP フォールバック
			if (!compressed) {
				try {
					const result = await readAndCompressImage(preprocessedFile, {
						mimeType: isAvifSupported() ? 'image/avif' as const : 'image/webp' as const,
						maxWidth: compressionSettings.maxWidth,
						maxHeight: compressionSettings.maxHeight,
						quality: compressionSettings.canvasQuality,
					});
					if (result.size < preprocessedFile.size) {
						preprocessedFile = result;
						item.compressedSize = result.size;
						item.suffix = '';
						compressed = true;
					}
				} catch (err) {
					console.error('Failed to compress image with Canvas AVIF/WebP', err);
				}
			}

			if (!compressed) {
				item.suffix = '';
			}
		} else {
			item.compressedSize = null;
			item.suffix = '';
		}

		imageBitmap.close();

		// WASM JXL 圧縮後はブラウザで JXL を表示できないため、既存サムネイル・objectUrlを保持
		if (preprocessedFile.type !== 'image/jxl' || isJxlSupported()) {
			updateItemObjectUrls(item, preprocessedFile);
		}
		item.preprocessedFile = markRaw(preprocessedFile);
	}

	async function preprocessForVideo(item: UploaderItem): Promise<void> {
		let preprocessedFile: Blob | File = item.file;

		const needsCompress = item.compressionLevel !== 0 && VIDEO_COMPRESSION_SUPPORTED_TYPES.includes(preprocessedFile.type);

		if (needsCompress) {
			const mediabunny = await import('mediabunny');

			const source = new mediabunny.BlobSource(preprocessedFile);

			const input = new mediabunny.Input({
				source,
				formats: mediabunny.ALL_FORMATS,
			});

			const output = new mediabunny.Output({
				target: new mediabunny.BufferTarget(),
				format: new mediabunny.Mp4OutputFormat(),
			});

			let bitrate;
			if (item.compressionLevel === 1) {
				// @ts-expect-error Quality constructor accepts a factor parameter internally
				bitrate = new mediabunny.Quality(8);
			} else if (item.compressionLevel === 2) {
				bitrate = mediabunny.QUALITY_VERY_HIGH;
			} else if (item.compressionLevel === 3) {
				bitrate = mediabunny.QUALITY_MEDIUM;
			} else {
				bitrate = mediabunny.QUALITY_VERY_LOW;
			}

			const videoOptions = {
				codec: (await mediabunny.getFirstEncodableVideoCodec(['av1', 'hevc', 'avc'])) ?? undefined,
				bitrate,
			};

			const currentConversion = await mediabunny.Conversion.init({
				input,
				output,
				video: videoOptions,
				audio: {
					// Explicitly keep audio (don't discard) and copy it if possible
					// without re-encoding to avoid WebCodecs limitations on iOS Safari
					discard: false,
				},
				tags: (inputTags) => ({
					title: inputTags.title,
					description: inputTags.description,
				}),
			});

			currentConversion.onProgress = newProgress => item.preprocessProgress = newProgress;

			item.abortPreprocess = () => {
				item.abortPreprocess = null;
				currentConversion.cancel();
				item.preprocessing = false;
				item.preprocessProgress = null;
			};

			await currentConversion.execute();

			item.abortPreprocess = null;

			preprocessedFile = new Blob([output.target.buffer!], { type: output.format.mimeType });
			item.compressedSize = output.target.buffer!.byteLength;
			item.suffix = '.mp4';
		} else {
			item.compressedSize = null;
			item.suffix = '';
		}

		updateItemObjectUrls(item, preprocessedFile);
		item.preprocessedFile = markRaw(preprocessedFile);
	}

	function reset() {
		for (const item of items.value) {
			revokeItemObjectUrls(item);
		}

		abortAll();
		items.value = [];
	}

	function dispose() {
		reset();
	}

	onUnmounted(() => {
		dispose();
	});

	return {
		items,
		addFiles,
		removeItem,
		abortAll,
		reset,
		dispose,
		upload,
		getMenu,
		uploading: computed(() => items.value.some(item => item.uploading)),
		readyForUpload: computed(() => items.value.length > 0 && items.value.some(item => item.uploaded == null) && !items.value.some(item => item.uploading || item.preprocessing)),
		allItemsUploaded: computed(() => items.value.every(item => item.uploaded != null)),
		events,
	};
}

