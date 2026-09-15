<script lang="ts">
  import ToolbarShell from "@roomy/design/components/content/thread/message/ToolbarShell.svelte";
  import { messagingState } from "./messaging-state.svelte";
  import { addReaction } from "$lib/mutations/reaction";
  import type { Message } from "$lib/queries/messages";

  type Props = {
    spaceId: string;
    roomId: string;
    message: Message;
    mergeWithPrevious?: boolean;
    canEdit: boolean;
    canDelete: boolean;
    /** Space admin only — renders the Move action. */
    canMove: boolean;
    keepToolbarOpen?: boolean;
    onForward: (messages: Message[]) => void;
    onStartEdit: (messageId: string) => void;
    /** Requests the delete confirmation (owned by ChatArea). */
    onRequestDelete: () => void;
    /** Requests the move picker for this message (owned by the route page). */
    onMove: (messages: Message[]) => void;
  };

  let {
    spaceId,
    roomId,
    message,
    mergeWithPrevious = false,
    canEdit,
    canDelete,
    canMove,
    keepToolbarOpen = $bindable(false),
    onForward,
    onStartEdit,
    onRequestDelete,
    onMove,
  }: Props = $props();

  function onToggleReaction(emoji: string) {
    addReaction(spaceId, roomId, message.id, emoji);
  }

  function onReply() {
    messagingState.setReplyTo(message);
  }

  function onStartThreading() {
    messagingState.startThreading(message);
  }

  function onSelect() {
    messagingState.startSelectMode(message);
  }

  function onEdit() {
    onStartEdit(message.id);
  }

  function onDelete() {
    onRequestDelete();
  }
</script>

<ToolbarShell
  {canEdit}
  {canDelete}
  {canMove}
  {mergeWithPrevious}
  bind:keepToolbarOpen
  {onToggleReaction}
  {onEdit}
  {onDelete}
  {onStartThreading}
  {onSelect}
  {onReply}
  onForward={() => onForward([message])}
  onMove={() => onMove([message])}
/>
