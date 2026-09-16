/**
 * Input-device signal for keyboard behaviour.
 *
 * A touch-primary device has no Shift/Cmd key: its software keyboard's Return
 * is the only newline the user can produce, so bare Enter must not be bound to
 * an action the device cannot otherwise reach around. `(pointer: coarse)` is
 * this repo's existing test for that device class (ChatMessage's tap toolbar,
 * ReactionBar's long-press, ChatInputArea's autofocus) — a media query rather
 * than user-agent sniffing, so a touchscreen laptop reports the pointer the
 * user is actually driving it with.
 *
 * The pure decision lives here so it is unit-testable without a DOM; the live
 * media query is built by the caller (`ChatInput.svelte`).
 */
export const TOUCH_PRIMARY_QUERY = "(pointer: coarse)";

/**
 * Whether bare Enter submits the editor's content.
 *
 * An explicit choice always wins: the forward-message composer binds Enter to
 * nothing and says so at its call site. Only the default — no explicit
 * choice — follows the device.
 */
export function resolveSendOnEnter(
  explicit: boolean | undefined,
  isTouchPrimary: boolean,
): boolean {
  return explicit ?? !isTouchPrimary;
}
