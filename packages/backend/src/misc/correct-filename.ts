/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Array.includes()よりSet.has()の方が高速
 */
const targetExtsToSkip = new Set([
	'.gz',
	'.tar',
	'.tgz',
	'.bz2',
	'.xz',
	'.zip',
	'.7z',
]);

/**
 * 画像形式間の変換時に拡張子を置換すべき組み合わせ
 * key: 変換先の拡張子, value: 変換元の拡張子のSet
 */
const replaceableImageExts: Record<string, Set<string>> = {
	'.jxl': new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp', '.tif', '.tiff']),
	'.avif': new Set(['.jpg', '.jpeg', '.png', '.webp', '.jxl', '.gif', '.bmp', '.tif', '.tiff']),
	'.webp': new Set(['.jpg', '.jpeg', '.png', '.avif', '.jxl', '.gif', '.bmp', '.tif', '.tiff']),
};

const extRegExp = /\.[0-9a-zA-Z]+$/i;

/**
 * 与えられた拡張子とファイル名が一致しているかどうかを確認し、
 * 一致していない場合は拡張子を付与して返す
 *
 * extはfile-typeのextを想定
 */
export function correctFilename(filename: string, ext: string | null) {
	const dotExt = ext ? ext[0] === '.' ? ext : `.${ext}` : '.unknown';

	const match = extRegExp.exec(filename);
	if (!match || !match[0]) {
		// filenameが拡張子を持っていない場合は拡張子をつける
		return `${filename}${dotExt}`;
	}

	const filenameExt = match[0].toLowerCase();
	if (
		// 未知のファイル形式かつ拡張子がある場合は何もしない
		ext === null ||
		// 拡張子が一致している場合は何もしない
		filenameExt === dotExt ||

		// jpeg, tiffを同一視
		dotExt === '.jpg' && filenameExt === '.jpeg' ||
		dotExt === '.tif' && filenameExt === '.tiff' ||
		// dllもexeもportable executableなので判定が正しく行われない
		dotExt === '.exe' && filenameExt === '.dll' ||

		// 圧縮形式っぽければ下手に拡張子を変えない
		// https://github.com/misskey-dev/misskey/issues/11482
		targetExtsToSkip.has(dotExt)
	) {
		return filename;
	}

	// 画像形式間の変換時は拡張子を置換する
	if (replaceableImageExts[dotExt]?.has(filenameExt)) {
		return filename.replace(extRegExp, dotExt);
	}

	// 拡張子があるが一致していないなどの場合は拡張子を付け足す
	return `${filename}${dotExt}`;
}
