<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="azykntjl">
	<div class="body">
		<div class="left">
			<button v-click-anime class="item _button instance" @click="openInstanceMenu">
				<img :src="instance.iconUrl ?? instance.faviconUrl ?? '/favicon.ico'" draggable="false"/>
			</button>
			<MkA v-click-anime v-tooltip="i18n.ts.timeline" class="item index" activeClass="active" to="/" exact>
				<i class="ti ti-home ti-fw"></i>
			</MkA>
			<template v-for="item in menu">
				<div v-if="item === '-'" class="divider"></div>
				<component :is="navbarItemDef[item].to ? 'MkA' : 'button'" v-else-if="navbarItemDef[item] && (navbarItemDef[item].show !== false)" v-click-anime v-tooltip="navbarItemDef[item].title" class="item _button" :class="item" activeClass="active" :to="navbarItemDef[item].to" v-on="navbarItemDef[item].action ? { click: navbarItemDef[item].action } : {}">
					<i class="ti-fw" :class="navbarItemDef[item].icon"></i>
					<span v-if="navbarItemDef[item].indicated" class="indicator _blink"><i class="_indicatorCircle"></i></span>
				</component>
			</template>
			<div class="divider"></div>
			<MkA v-if="$i.isAdmin || $i.isModerator" v-click-anime v-tooltip="i18n.ts.controlPanel" class="item" activeClass="active" to="/admin" :behavior="settingsWindowed ? 'window' : null">
				<i class="ti ti-dashboard ti-fw"></i>
			</MkA>
			<button v-click-anime class="item _button" @click="more">
				<i class="ti ti-dots ti-fw"></i>
				<span v-if="otherNavItemIndicated" class="indicator _blink"><i class="_indicatorCircle"></i></span>
			</button>
		</div>
		<div class="right">
			<MkA v-click-anime v-tooltip="i18n.ts.settings" class="item" activeClass="active" to="/settings" :behavior="settingsWindowed ? 'window' : null">
				<i class="ti ti-settings ti-fw"></i>
			</MkA>
			<button v-click-anime class="item _button account" @click="openAccountMenu">
				<MkAvatar :user="$i" class="avatar"/><MkAcct class="acct" :user="$i"/>
			</button>
			<div class="post" @click="os.post()">
				<MkButton class="button" gradate full rounded>
					<i class="ti ti-pencil ti-fw"></i>
				</MkButton>
			</div>
		</div>
	</div>
</div>
</template>

<script lang="ts" setup>
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { openInstanceMenu } from './common.js';
import * as os from '@/os.js';
import { navbarItemDef } from '@/navbar.js';
import MkButton from '@/components/MkButton.vue';
import { instance } from '@/instance.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { openAccountMenu as openAccountMenu_ } from '@/accounts.js';
import { $i } from '@/i.js';

const WINDOW_THRESHOLD = 1400;

const settingsWindowed = ref(window.innerWidth > WINDOW_THRESHOLD);
const menu = ref(prefer.s.menu);
// const menuDisplay = computed(store.makeGetterSetter('menuDisplay'));
const otherNavItemIndicated = computed<boolean>(() => {
	for (const def in navbarItemDef) {
		if (menu.value.includes(def)) continue;
		if (navbarItemDef[def].indicated) return true;
	}
	return false;
});

async function more(ev: MouseEvent) {
	const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkLaunchPad.vue').then(x => x.default), {
		anchorElement: ev.currentTarget ?? ev.target,
		anchor: { x: 'center', y: 'bottom' },
	}, {
		closed: () => dispose(),
	});
}

function openAccountMenu(ev: MouseEvent) {
	openAccountMenu_({
		withExtraOperation: true,
	}, ev);
}

onMounted(() => {
	window.addEventListener('resize', () => {
		settingsWindowed.value = (window.innerWidth >= WINDOW_THRESHOLD);
	}, { passive: true });
});

</script>

<style lang="scss" scoped>
.azykntjl {
	$height: 60px;
	$avatar-size: 32px;
	$avatar-margin: 8px;

	position: sticky;
	top: 0;
	z-index: 1000;
	width: 100%;
	height: $height;
	background: color(from var(--MI_THEME-bg) srgb r g b / 0.75);
	-webkit-backdrop-filter: var(--MI-blur, blur(15px));
	backdrop-filter: var(--MI-blur, blur(15px));

	> .body {
		max-width: 1380px;
		margin: 0 auto;
		display: flex;

		> .right,
		> .left {

			> .item {
				position: relative;
				font-size: 0.9em;
				display: inline-block;
				padding: 0 12px;
				line-height: $height;

				> i,
				> .avatar {
					margin-right: 0;
				}

				> i {
					left: 10px;
				}

				> .avatar {
					width: $avatar-size;
					height: $avatar-size;
					vertical-align: middle;
				}

				> .indicator {
					position: absolute;
					top: 0;
					left: 0;
					color: var(--MI_THEME-navIndicator);
					font-size: 8px;
				}

				&:hover {
					text-decoration: none;
					color: light-dark(hsl(from var(--MI_THEME-navFg) h s calc(l - 17)), hsl(from var(--MI_THEME-navFg) h s calc(l + 17)));
				}

				&.active {
					color: var(--MI_THEME-navActive);
				}
			}

			> .divider {
				display: inline-block;
				height: 16px;
				margin: 0 10px;
				border-right: solid 0.5px var(--MI_THEME-divider);
			}

			> .instance {
				display: inline-block;
				position: relative;
				width: 56px;
				height: 100%;
				vertical-align: bottom;

				> img {
					display: inline-block;
					width: 24px;
					position: absolute;
					top: 0;
					right: 0;
					bottom: 0;
					left: 0;
					margin: auto;
				}
			}

			> .post {
				display: inline-block;

				> .button {
					width: 40px;
					height: 40px;
					padding: 0;
					min-width: 0;
				}
			}

			> .account {
				display: inline-flex;
				align-items: center;
				vertical-align: top;
				margin-right: 8px;

				> .acct {
					margin-left: 8px;
				}
			}
		}

		> .right {
			margin-left: auto;
		}
	}
}
</style>
