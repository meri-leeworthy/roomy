<!--
MIT License

Copyright (c) Florian https://github.com/flo-bit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->
<script lang="ts" module>
	import type { ButtonProps } from '../button/Button.svelte';
	import type { ThemeMode } from '../../../utils/index.js';

	export type ThemeToggleProps = ButtonProps;
</script>

<script lang="ts">
	import Button from '../button/Button.svelte';
	import { cn } from '../../../utils/index.js';
	import {
		applyThemeMode,
		initSystemThemeListener,
		nextThemeMode,
		readThemeMode,
	} from '../../../utils/index.js';

	let {
		class: className,
		ref = $bindable(null),
		...restProps
	}: ThemeToggleProps = $props();

	let themeMode = $state<ThemeMode>('system');

	function toggleTheme() {
		themeMode = nextThemeMode(themeMode);
		applyThemeMode(themeMode);
	}

	// Initialize theme mode on mount and live-follow the OS preference while
	// the mode is "system".
	$effect(() => {
		themeMode = readThemeMode();
		return initSystemThemeListener();
	});
</script>

<Button
	variant="link"
	onclick={toggleTheme}
	class={cn(
		'theme-toggle focus-visible:outline-base-900 dark:focus-visible:outline-base-100 flex items-center justify-center rounded-2xl focus-visible:outline-2',
		className
	)}
	bind:ref
	{...restProps}
	size="icon"
>
	<svg
		xmlns="http://www.w3.org/2000/svg"
		fill="none"
		viewBox="0 0 24 24"
		stroke-width="1.5"
		stroke="currentColor"
		class="size-5! transition-colors duration-500"
		class:block={themeMode === 'light'}
		class:hidden={themeMode !== 'light'}
	>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
		/>
	</svg>
	<svg
		xmlns="http://www.w3.org/2000/svg"
		fill="none"
		viewBox="0 0 24 24"
		stroke-width="1.5"
		stroke="currentColor"
		class="size-5! transition-colors duration-500 dark:text-white"
		class:block={themeMode === 'dark'}
		class:hidden={themeMode !== 'dark'}
	>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"
		/>
	</svg>
	<svg
		xmlns="http://www.w3.org/2000/svg"
		fill="none"
		viewBox="0 0 24 24"
		stroke-width="1.5"
		stroke="currentColor"
		class="size-5! transition-colors duration-500"
		class:block={themeMode === 'system'}
		class:hidden={themeMode !== 'system'}
	>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25"
		/>
	</svg>

	<span class="sr-only">Toggle theme</span>
</Button>

<noscript>
	<style>
		.theme-toggle {
			display: none;
		}
	</style>
</noscript>
