/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

// sharp 0.35 no longer builds from source during installation automatically.
const forceGlobal = ['1', 'true'].includes(process.env.SHARP_FORCE_GLOBAL_LIBVIPS ?? '');
const buildFromSource = ['1', 'true'].includes(process.env.npm_config_build_from_source ?? '');
const ignoreGlobal = ['1', 'true'].includes(process.env.SHARP_IGNORE_GLOBAL_LIBVIPS ?? '');
if (!ignoreGlobal && (forceGlobal || buildFromSource)) {
	const require = createRequire(new URL('../packages/backend/package.json', import.meta.url));
	const sharpDir = resolve(dirname(require.resolve('sharp')), '..');
	const result = spawnSync(process.execPath, ['install/build.js'], {
		cwd: sharpDir,
		stdio: 'inherit',
	});
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
}
