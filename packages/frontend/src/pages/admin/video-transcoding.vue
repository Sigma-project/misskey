<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 700px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<div class="_gaps">
			<!-- Capability -->
			<MkFolder :defaultOpen="true">
				<template #icon><i class="ti ti-cpu"></i></template>
				<template #label>FFmpeg Capability</template>
				<div class="_gaps_s">
					<div v-for="cap in capabilityList" :key="cap.key" class="_panel" style="padding: 12px 16px; display: flex; align-items: center; justify-content: space-between;">
						<span>{{ cap.label }}</span>
						<span v-if="cap.available" style="color: var(--MI_THEME-success);"><i class="ti ti-check"></i> available</span>
						<span v-else style="color: var(--MI_THEME-fg); opacity: .6;"><i class="ti ti-x"></i> not available</span>
					</div>
				</div>
			</MkFolder>

			<!-- Settings -->
			<MkFolder :defaultOpen="true">
				<template #icon><i class="ti ti-settings"></i></template>
				<template #label>{{ i18n.ts.settings }}</template>
				<template v-if="form.modified.value" #footer>
					<MkFormFooter :form="form"/>
				</template>

				<div class="_gaps_m">
					<MkSwitch v-model="form.state.enableVideoTranscoding">
						<template #label>Enable video transcoding<span v-if="form.modifiedStates.enableVideoTranscoding" class="_modified">{{ i18n.ts.modified }}</span></template>
						<template #caption>アップロードされた動画をバックグラウンドでAV1(HLS)/VVC(DASH)にトランスコードします。オリジナルは常に保持されます。</template>
					</MkSwitch>

					<MkInput v-model="form.state.videoTranscodeMaxFileSize" type="number">
						<template #label>Max file size (bytes, 0 = unlimited)<span v-if="form.modifiedStates.videoTranscodeMaxFileSize" class="_modified">{{ i18n.ts.modified }}</span></template>
						<template #caption>この値を超えるファイルはトランスコードしません。0で無制限ですが、サーバー負荷のため上限の設定を推奨します。</template>
					</MkInput>

					<MkInput v-model="form.state.videoTranscodeMaxDuration" type="number">
						<template #label>Max duration (seconds, 0 = unlimited)<span v-if="form.modifiedStates.videoTranscodeMaxDuration" class="_modified">{{ i18n.ts.modified }}</span></template>
						<template #caption>この長さを超える動画はトランスコードしません。</template>
					</MkInput>
				</div>
			</MkFolder>

			<!-- Active jobs -->
			<MkFolder :defaultOpen="true">
				<template #icon><i class="ti ti-player-play"></i></template>
				<template #label>進行中のジョブ</template>
				<template #suffix>{{ activeJobs.length }}</template>

				<div v-if="activeJobs.length === 0" class="_fullinfo">
					<div>進行中のジョブはありません</div>
				</div>
				<div v-else class="_gaps_s">
					<div v-for="job in activeJobs" :key="job.fileId" class="_panel" style="padding: 12px 16px;">
						<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
							<b style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ job.fileName }}</b>
							<MkButton v-if="!isTerminal(job.phase)" danger small @click="cancel(job.fileId)">Cancel</MkButton>
						</div>
						<div style="margin-top: 6px; font-size: .85em; opacity: .8;">
							{{ job.phase }}<template v-if="job.codec"> ({{ job.codec }})</template>
							<template v-if="job.fps"> · {{ Math.round(job.fps) }}fps</template>
							<template v-if="job.speed"> · {{ job.speed }}</template>
							<template v-if="job.message"> · {{ job.message }}</template>
						</div>
						<div :class="$style.progressTrack">
							<div :class="$style.progressBar" :style="{ width: `${job.overallPercent}%` }"></div>
						</div>
						<div style="margin-top: 2px; font-size: .8em; opacity: .7; text-align: right;">{{ job.overallPercent }}%</div>
					</div>
				</div>
			</MkFolder>

			<!-- Failed jobs -->
			<MkFolder :defaultOpen="true">
				<template #icon><i class="ti ti-alert-triangle"></i></template>
				<template #label>失敗したジョブ</template>
				<template #suffix>{{ failedJobs.length }}</template>

				<div v-if="failedJobs.length === 0" class="_fullinfo">
					<div>失敗したジョブはありません</div>
				</div>
				<div v-else class="_gaps_s">
					<div v-for="job in failedJobs" :key="job.fileId" class="_panel" style="padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
						<b style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ job.fileName }}</b>
						<MkButton primary small @click="retry(job.fileId)">Retry</MkButton>
					</div>
				</div>
			</MkFolder>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, markRaw, onMounted, onUnmounted, ref } from 'vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useStream } from '@/stream.js';
import { fetchInstance } from '@/instance.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { useForm } from '@/composables/use-form.js';
import MkSwitch from '@/components/MkSwitch.vue';
import MkInput from '@/components/MkInput.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkButton from '@/components/MkButton.vue';
import MkFormFooter from '@/components/MkFormFooter.vue';

type Phase = 'queued' | 'downloading' | 'probing' | 'encoding-av1' | 'encoding-vvc' | 'uploading' | 'done' | 'skipped' | 'failed';

type JobState = {
	fileId: string;
	userId: string | null;
	fileName: string;
	phase: Phase;
	percent: number;
	overallPercent: number;
	codec?: 'av1' | 'vvc';
	fps?: number;
	speed?: string;
	message?: string;
	startedAt: number;
	updatedAt: number;
};

type Capabilities = { av1: boolean; vvc: boolean; opus: boolean; hls: boolean; dash: boolean };

// NOTE: admin/video-transcoding/* と videoTranscodingチャンネルは autogen / misskey-js の
// 型生成が未反映のため any 経由で呼ぶ。`pnpm run update-autogen-code` 等で再生成すれば型が付く。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = misskeyApi as any;

const meta = await misskeyApi('admin/meta');

const form = useForm({
	enableVideoTranscoding: meta.enableVideoTranscoding,
	videoTranscodeMaxFileSize: meta.videoTranscodeMaxFileSize,
	videoTranscodeMaxDuration: meta.videoTranscodeMaxDuration,
}, async (state) => {
	await os.apiWithDialog('admin/update-meta', {
		enableVideoTranscoding: state.enableVideoTranscoding,
		videoTranscodeMaxFileSize: state.videoTranscodeMaxFileSize,
		videoTranscodeMaxDuration: state.videoTranscodeMaxDuration,
	});
	fetchInstance(true);
});

const capabilities = ref<Capabilities>({ av1: false, vvc: false, opus: false, hls: false, dash: false });
const capabilityList = computed(() => [
	{ key: 'av1', label: 'AV1 encoder (libsvtav1)', available: capabilities.value.av1 },
	{ key: 'vvc', label: 'VVC encoder (libvvenc)', available: capabilities.value.vvc },
	{ key: 'opus', label: 'Opus encoder (libopus)', available: capabilities.value.opus },
	{ key: 'hls', label: 'HLS fMP4 muxer', available: capabilities.value.hls },
	{ key: 'dash', label: 'DASH muxer', available: capabilities.value.dash },
]);

const jobs = ref<Map<string, JobState>>(new Map());
const failedJobs = ref<{ fileId: string; fileName: string; userId: string | null }[]>([]);

const activeJobs = computed(() => Array.from(jobs.value.values()).sort((a, b) => b.updatedAt - a.updatedAt));

function isTerminal(phase: Phase): boolean {
	return phase === 'done' || phase === 'failed' || phase === 'skipped';
}

// 終端ジョブを30秒後に一覧から除去する
const removalTimers = new Map<string, number>();

function scheduleRemoval(fileId: string) {
	const existing = removalTimers.get(fileId);
	if (existing) window.clearTimeout(existing);
	removalTimers.set(fileId, window.setTimeout(() => {
		jobs.value.delete(fileId);
		jobs.value = new Map(jobs.value);
		removalTimers.delete(fileId);
	}, 30000));
}

function applyProgress(job: JobState) {
	jobs.value.set(job.fileId, job);
	jobs.value = new Map(jobs.value);
	if (isTerminal(job.phase)) {
		scheduleRemoval(job.fileId);
	}
}

async function cancel(fileId: string) {
	await os.apiWithDialog('admin/video-transcoding/cancel-job' as never, { fileId } as never);
	jobs.value.delete(fileId);
	jobs.value = new Map(jobs.value);
}

async function retry(fileId: string) {
	await os.apiWithDialog('admin/video-transcoding/retry-job' as never, { fileId } as never);
	failedJobs.value = failedJobs.value.filter(j => j.fileId !== fileId);
}

const connection = markRaw(useStream().useChannel('videoTranscoding' as never));

onMounted(async () => {
	const res = await api('admin/video-transcoding/list-jobs', {});
	capabilities.value = res.capabilities;
	failedJobs.value = res.failed;
	for (const job of res.active as JobState[]) {
		jobs.value.set(job.fileId, job);
	}
	jobs.value = new Map(jobs.value);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(connection as any).on('progress', (payload: JobState) => {
		applyProgress(payload);
		if (payload.phase === 'failed') {
			if (!failedJobs.value.some(j => j.fileId === payload.fileId)) {
				failedJobs.value = [{ fileId: payload.fileId, fileName: payload.fileName, userId: payload.userId }, ...failedJobs.value];
			}
		}
	});
});

onUnmounted(() => {
	connection.dispose();
	for (const timer of removalTimers.values()) {
		window.clearTimeout(timer);
	}
	removalTimers.clear();
});

const headerActions = computed(() => []);
const headerTabs = computed(() => []);

definePage(() => ({
	title: 'Video Transcoding',
	icon: 'ti ti-movie',
}));
</script>

<style lang="scss" module>
.progressTrack {
	margin-top: 8px;
	width: 100%;
	height: 6px;
	border-radius: 3px;
	background: var(--MI_THEME-divider);
	overflow: hidden;
}

.progressBar {
	height: 100%;
	background: var(--MI_THEME-accent);
	transition: width .3s ease;
}
</style>
