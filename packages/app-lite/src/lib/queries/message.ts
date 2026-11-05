import { createQuery } from "@tanstack/svelte-query";
import { cache, schemas } from "@roomy-space/sdk";
import { px } from "$lib/auth.svelte";
import { queryClient } from "$lib/client";
import { mayAskForReplyTarget } from "$lib/queries/room-ids";
import { roomIndex } from "$lib/queries/room-index";

const { queryKey } = cache;

export type Message = typeof schemas.queries.getMessage.Response.infer;
type MessageList = typeof schemas.queries.getMessages.Message.infer[];

/**
 * Single-message query. Hydrates from the room messages cache if the
 * message is already present, so reply previews don't trigger an extra
 * HTTP fetch when the target is on screen.
 *
 * Three guards keep a *deterministically* failing lookup from being issued:
 * one for reply targets the client can already identify as a room (below),
 * `retry: false` for the rest — a deleted message 404s and a non-message
 * target 400s, and neither becomes true by asking again — and
 * `retryOnMount: false`, without which TanStack's `shouldLoadOnMount`
 * re-issues the fetch for an errored, data-less query on every remount. A bad
 * reply target sits in the message list, so the virtualizer recycles its row
 * on scroll and each recycle would otherwise be another request. With
 * `retryOnMount: false` the lookup is asked at most once per session instead
 * of once per mount.
 */
export function createMessageQuery(
  messageId: () => string,
  roomId: () => string | undefined,
  options?: { enabled?: boolean },
) {
  return createQuery<Message>(() => {
    const target = messageId();
    const room = roomId();
    // `getMessage` resolves its argument as a message and answers `400
    // InvalidRequest "Entity <id> is not a message (no room)"` for any entity
    // without a room — and a message is the ONLY entity type that has one. A
    // reply attachment's `target` can name any entity, so a reply whose target
    // is a room asks a question whose answer can never change: a permanent 400
    // on every render of that reply.
    //
    // `mayAskForReplyTarget` carries the rule, including the half that was
    // missing: before the first room listing lands the index holds nothing, and
    // asking then is what turned a cold load into a 400 for every reply whose
    // target is a room. Reading the index reactively means the observer
    // re-evaluates when the listing arrives — a target that is a room is
    // suppressed, one that is not is asked about as before. Local data still
    // renders meanwhile, because `initialData` does not wait on `enabled`.
    const index = roomIndex();
    return {
      queryKey: queryKey("space.roomy.message.getMessage", { messageId: target }),
      enabled: (options?.enabled ?? true) && mayAskForReplyTarget(target, room, index),
      queryFn: () =>
        px().query("space.roomy.message.getMessage", { messageId: target }),
      retry: false,
      retryOnMount: false,
      initialData: () => {
        if (!room) return undefined;
        const list = queryClient.getQueryData<MessageList>(
          queryKey("space.roomy.room.getMessages", { roomId: room }),
        );
        const hit = list?.find((m) => m.id === target);
        return hit as Message | undefined;
      },
    };
  });
}
