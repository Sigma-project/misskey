<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<MkInfo>{{ i18n.ts._initialAccountSetting.theseSettingsCanEditLater }}</MkInfo>

	<FormSlot>
		<template #label>{{ i18n.ts.avatar }}</template>
		<div v-adaptive-bg :class="$style.avatarSection" class="_panel">
			<MkAvatar :class="$style.avatar" :user="$i" @click="setAvatar"/>
			<div style="margin-top: 16px;">
				<MkButton primary rounded inline @click="setAvatar">{{ i18n.ts._profile.changeAvatar }}</MkButton>
			</div>
		</div>
	</FormSlot>

	<MkInput v-model="name" :max="30" manualSave data-cy-user-setup-user-name>
		<template #label>{{ i18n.ts._profile.name }}</template>
	</MkInput>

	<MkTextarea v-model="description" :max="500" tall manualSave data-cy-user-setup-user-description>
		<template #label>{{ i18n.ts._profile.description }}</template>
	</MkTextarea>

	<MkInfo>{{ i18n.ts._initialAccountSetting.youCanEditMoreSettingsInSettingsPageLater }}</MkInfo>
</div>
</template>

<script lang="ts" setup>
import { ref, watch } from 'vue';
import { i18n } from '@/i18n.js';
import MkButton from '@/components/MkButton.vue';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import FormSlot from '@/components/form/slot.vue';
import MkInfo from '@/components/MkInfo.vue';
import * as os from '@/os.js';
import { ensureSignin } from '@/i.js';

const $i = ensureSignin();

const name = ref($i.name ?? '');
const description = ref($i.description ?? '');

watch(name, () => {
	os.apiWithDialog('i/update', {
		// 空文字列をnullにしたいので??は使うな

		name: name.value || null,
	}, undefined, {
		'0b3f9f6a-2f4d-4b1f-9fb4-49d3a2fd7191': {
			title: i18n.ts.yourNameContainsProhibitedWords,
			text: i18n.ts.yourNameContainsProhibitedWordsDescription,
		},
	});
});

watch(description, () => {
	os.apiWithDialog('i/update', {
		// 空文字列をnullにしたいので??は使うな

		description: description.value || null,
	});
});

async function setAvatar(ev) {
	const files = await os.chooseFileFromPc({ multiple: false });
	const file = files[0];

	let originalOrCropped = file;

	const { canceled } = await os.confirm({
		type: 'question',
		text: i18n.ts.cropImageAsk,
		okText: i18n.ts.cropYes,
		cancelText: i18n.ts.cropNo,
	});

	if (!canceled) {
		originalOrCropped = await os.cropImageFile(file, {
			aspectRatio: 1,
		});
	}

	const driveFile = (await os.launchUploader([originalOrCropped], { multiple: false }))[0];

	const i = await os.apiWithDialog('i/update', {
		avatarId: driveFile.id,
	});
	$i.avatarId = i.avatarId;
	$i.avatarUrl = i.avatarUrl;
}
</script>

<style lang="scss" module>
.avatarSection {
	text-align: center;
	padding: 20px;
}

.avatar {
	width: 100px;
	height: 100px;
}
</style>
