/**
 * Reactive state for the room settings modal (`EditRoomModal`).
 *
 * The modal is rendered exactly once (by `SpaceSidebar`) but has two entry
 * points: the sidebar's edit mode, and the ellipsis button in the navbar next
 * to the room name. Both open that single instance by writing the target here,
 * so the two openers cannot drift — federated handling, thread-vs-channel
 * classification and the permission editor all stay in one place.
 *
 * Mirrors the store shape used by `mobile-sidebar.svelte.ts` /
 * `server-bar.svelte.ts` so `bind:open={editRoomModal.open}` works.
 */

export type EditRoomTarget =
  | { room: string }
  | { categoryId: string; categoryName: string };

let open = $state(false);
let target = $state<EditRoomTarget | null>(null);

export const editRoomModal = {
  get open() {
    return open;
  },
  set open(v: boolean) {
    open = v;
  },
  /**
   * The room/category being edited. Kept after the modal closes (rather than
   * nulled) so the closing dialog can still render its content while it
   * animates out.
   */
  get target() {
    return target;
  },
  /** Point the modal at a room (channel/thread) or category and open it. */
  openFor(next: EditRoomTarget) {
    target = next;
    open = true;
  },
};
