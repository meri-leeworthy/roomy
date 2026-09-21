<script lang="ts">
  import type { InviteRow } from "@roomy/design/components/modals/InviteManager.svelte";
  import InviteManager from "@roomy/design/components/modals/InviteManager.svelte";
  import { toast } from "@foxui/core";
  import { createInvitesQuery } from "$lib/queries/invites";
  import { createInvite, revokeInvite } from "$lib/mutations/invite";
  import { inviteUrl } from "$lib/share-links";

  let {
    open = $bindable(false),
    spaceId,
  }: {
    open: boolean;
    spaceId: string;
  } = $props();

  // Fetch only while the modal is open: the modal is mounted for the whole
  // lifetime of a selected space, and an unconditional query 403s on every
  // mount for members of spaces with member invites disabled.
  const invitesQuery = createInvitesQuery(() => spaceId, {
    enabled: () => open,
  });

  let creating = $state(false);

  const invites = $derived<InviteRow[]>(
    invitesQuery.data?.invites ?? [],
  );

  function urlFor(token: string): string {
    return inviteUrl(spaceId, token);
  }

  async function onCreate() {
    creating = true;
    try {
      await createInvite(spaceId);
    } finally {
      creating = false;
    }
  }

  async function onRevoke(token: string) {
    try {
      await revokeInvite(spaceId, token);
    } catch {
      // Silently fail — the manager renders the button regardless.
    }
  }

  async function onCopy(token: string) {
    try {
      await navigator.clipboard.writeText(urlFor(token));
      toast.success("Invite link copied to clipboard");
    } catch {
      // Clipboard may not be available in all contexts.
    }
  }


</script>

<InviteManager
  bind:open
  {invites}
  {creating}
  {urlFor}
  {onCreate}
  {onRevoke}
  {onCopy}
/>
