<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root" class="_gaps">
	<template v-if="layer.type === 'text'">
		<MkInput v-model="layer.text">
			<template #label>{{ i18n.ts._watermarkEditor.text }}</template>
		</MkInput>

		<FormSlot>
			<template #label>{{ i18n.ts._watermarkEditor.position }}</template>
			<MkPositionSelector
				v-model:x="layer.align.x"
				v-model:y="layer.align.y"
			></MkPositionSelector>
		</FormSlot>

		<MkRange
			v-model="layer.scale"
			:min="0"
			:max="1"
			:step="0.01"
			:textConverter="(v) => (v * 100).toFixed(1) + '%'"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.scale }}</template>
		</MkRange>

		<MkRange
			v-model="layer.angle"
			:min="-1"
			:max="1"
			:step="0.01"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.angle }}</template>
		</MkRange>

		<MkRange
			v-model="layer.opacity"
			:min="0"
			:max="1"
			:step="0.01"
			:textConverter="(v) => (v * 100).toFixed(1) + '%'"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.opacity }}</template>
		</MkRange>

		<MkSwitch v-model="layer.repeat">
			<template #label>{{ i18n.ts._watermarkEditor.repeat }}</template>
		</MkSwitch>
	</template>

	<template v-else-if="layer.type === 'image'">
		<MkButton inline rounded primary @click="chooseFile">{{ i18n.ts.selectFile }}</MkButton>

		<FormSlot>
			<template #label>{{ i18n.ts._watermarkEditor.position }}</template>
			<MkPositionSelector
				v-model:x="layer.align.x"
				v-model:y="layer.align.y"
			></MkPositionSelector>
		</FormSlot>

		<MkRange
			v-model="layer.scale"
			:min="0"
			:max="1"
			:step="0.01"
			:textConverter="(v) => (v * 100).toFixed(1) + '%'"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.scale }}</template>
		</MkRange>

		<MkRange
			v-model="layer.angle"
			:min="-1"
			:max="1"
			:step="0.01"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.angle }}</template>
		</MkRange>

		<MkRange
			v-model="layer.opacity"
			:min="0"
			:max="1"
			:step="0.01"
			:textConverter="(v) => (v * 100).toFixed(1) + '%'"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.opacity }}</template>
		</MkRange>

		<MkSwitch v-model="layer.repeat">
			<template #label>{{ i18n.ts._watermarkEditor.repeat }}</template>
		</MkSwitch>

		<MkSwitch v-model="layer.cover">
			<template #label>{{ i18n.ts._watermarkEditor.cover }}</template>
		</MkSwitch>
	</template>

	<template v-else-if="layer.type === 'stripe'">
		<MkRange
			v-model="layer.frequency"
			:min="1"
			:max="30"
			:step="0.01"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.stripeFrequency }}</template>
		</MkRange>

		<MkRange
			v-model="layer.threshold"
			:min="0"
			:max="1"
			:step="0.01"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.stripeWidth }}</template>
		</MkRange>

		<MkRange
			v-model="layer.angle"
			:min="-1"
			:max="1"
			:step="0.01"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.angle }}</template>
		</MkRange>

		<MkRange
			v-model="layer.opacity"
			:min="0"
			:max="1"
			:step="0.01"
			:textConverter="(v) => (v * 100).toFixed(1) + '%'"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.opacity }}</template>
		</MkRange>
	</template>

	<template v-else-if="layer.type === 'polkadot'">
		<MkRange
			v-model="layer.angle"
			:min="-1"
			:max="1"
			:step="0.01"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.angle }}</template>
		</MkRange>

		<MkRange
			v-model="layer.scale"
			:min="0"
			:max="10"
			:step="0.01"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.scale }}</template>
		</MkRange>

		<MkRange
			v-model="layer.majorRadius"
			:min="0"
			:max="1"
			:step="0.01"
			:textConverter="(v) => (v * 100).toFixed(1) + '%'"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.polkadotMainDotRadius }}</template>
		</MkRange>

		<MkRange
			v-model="layer.majorOpacity"
			:min="0"
			:max="1"
			:step="0.01"
			:textConverter="(v) => (v * 100).toFixed(1) + '%'"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.polkadotMainDotOpacity }}</template>
		</MkRange>

		<MkRange
			v-model="layer.minorDivisions"
			:min="0"
			:max="16"
			:step="1"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.polkadotSubDotDivisions }}</template>
		</MkRange>

		<MkRange
			v-model="layer.minorRadius"
			:min="0"
			:max="1"
			:step="0.01"
			:textConverter="(v) => (v * 100).toFixed(1) + '%'"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.polkadotSubDotRadius }}</template>
		</MkRange>

		<MkRange
			v-model="layer.minorOpacity"
			:min="0"
			:max="1"
			:step="0.01"
			:textConverter="(v) => (v * 100).toFixed(1) + '%'"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.polkadotSubDotOpacity }}</template>
		</MkRange>
	</template>

	<template v-else-if="layer.type === 'checker'">
		<MkRange
			v-model="layer.angle"
			:min="-1"
			:max="1"
			:step="0.01"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.angle }}</template>
		</MkRange>

		<MkRange
			v-model="layer.scale"
			:min="0"
			:max="10"
			:step="0.01"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.scale }}</template>
		</MkRange>

		<MkRange
			v-model="layer.opacity"
			:min="0"
			:max="1"
			:step="0.01"
			:textConverter="(v) => (v * 100).toFixed(1) + '%'"
			continuousUpdate
		>
			<template #label>{{ i18n.ts._watermarkEditor.opacity }}</template>
		</MkRange>
	</template>
</div>
</template>

<script setup lang="ts">
import { ref, useTemplateRef, watch, onMounted, onUnmounted } from 'vue';
import type { WatermarkPreset } from '@/utility/watermark.js';
import { i18n } from '@/i18n.js';
import MkSelect from '@/components/MkSelect.vue';
import MkButton from '@/components/MkButton.vue';
import MkInput from '@/components/MkInput.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkRange from '@/components/MkRange.vue';
import FormSlot from '@/components/form/slot.vue';
import MkPositionSelector from '@/components/MkPositionSelector.vue';
import * as os from '@/os.js';
import { selectFile } from '@/utility/drive.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { prefer } from '@/preferences.js';

const layer = defineModel<WatermarkPreset['layers'][number]>('layer', { required: true });

const driveFile = ref();
const driveFileError = ref(false);
onMounted(async () => {
	if (layer.value.type === 'image' && layer.value.imageId != null) {
		await misskeyApi('drive/files/show', {
			fileId: layer.value.imageId,
		}).then((res) => {
			driveFile.value = res;
		}).catch((err) => {
			driveFileError.value = true;
		});
	}
});

function chooseFile(ev: MouseEvent) {
	selectFile(ev.currentTarget ?? ev.target, i18n.ts.selectFile).then((file) => {
		if (!file.type.startsWith('image')) {
			os.alert({
				type: 'warning',
				title: i18n.ts._watermarkEditor.driveFileTypeWarn,
				text: i18n.ts._watermarkEditor.driveFileTypeWarnDescription,
			});
			return;
		}

		layer.value.imageId = file.id;
		layer.value.imageUrl = file.url;
		driveFileError.value = false;
	});
}
</script>

<style module>
.root {

}
</style>
