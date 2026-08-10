<script lang="ts" module>
  import type { Message } from "$lib/queries/messages";

  export type MessageContextReplying = {
    kind: "replying";
    replyTo: { id: string };
  };

  export type MessageContextThreading = {
    kind: "threading";
    selectedMessages: Message[];
  };

  export type MessageContext = MessageContextReplying | MessageContextThreading;
</script>

<script lang="ts">
  import { getContext } from "svelte";
  import MessageContextReply from "./MessageContextReply.svelte";
  import { messageContentToPlaintext } from "./messagePreview";

  type Props = {
    context: MessageContext;
    roomId: string;
  };

  let { context, roomId }: Props = $props();

  const scrollToMessage = getContext<(id: string) => void>("scrollToMessage");
</script>

<button
  onclick={() => {
    if (context.kind === "replying") {
      scrollToMessage?.(context.replyTo.id);
    }
  }}
  class="cursor-pointer flex gap-2 text-sm text-start items-center pl-2 pr-4 py-1 w-full"
>
  {#if context.kind === "replying"}
    <MessageContextReply replyToId={context.replyTo.id} {roomId} />
  {:else if context.kind === "threading"}
    {@const first = context.selectedMessages[0]}
    <div class="line-clamp-1 overflow-hidden italic">
      {@html messageContentToPlaintext(first?.content ?? "", first?.mimeType)}
    </div>
  {/if}
</button>
