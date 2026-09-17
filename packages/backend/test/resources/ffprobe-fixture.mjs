/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(process.argv.at(-1), 'utf8'));
process.on('SIGTERM', () => {});
fs.writeFileSync(config.pidPath, String(process.pid));
fs.writeFileSync(config.argsPath, JSON.stringify(process.argv.slice(2)));

switch (config.mode) {
	case 'hang':
		setInterval(() => {}, 1000);
		break;
	case 'overflow-stdout':
	case 'overflow-stderr':
		process[config.mode.slice('overflow-'.length)].write(Buffer.alloc(4 * 1024 * 1024 + 1, 'x'));
		setInterval(() => {}, 1000);
		break;
	case 'nonzero':
		process.stderr.write('ffprobe fixture failed');
		process.exitCode = 1;
		break;
	case 'malformed':
		process.stdout.write('not JSON');
		break;
	default:
		process.stdout.write(JSON.stringify(config.data));
		break;
}
