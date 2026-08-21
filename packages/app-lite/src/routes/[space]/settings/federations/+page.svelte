<script lang="ts">
  import { page } from "$app/state";
  import { queryClient } from "$lib/client";
  import { createSpaceMetadataQuery } from "$lib/queries/space-metadata";
  import { createRolesQuery } from "$lib/queries/roles";
  import { createFeatureFlagsQuery } from "$lib/queries/feature-flags";
  import {
    createFederationRequestsQuery,
    createFederationOutgoingQuery,
    createFederationIncomingQuery,
    createFederationGrantsQuery,
  } from "$lib/queries/federation";
  import {
    respondFederation,
    removeFederation,
    setRoomPermission,
    setReceiverPermission,
  } from "$lib/mutations/federation";
  import Button from "@roomy/design/components/ui/button/Button.svelte";
  import ToggleGroup from "@roomy/design/components/ui/toggle-group/ToggleGroup.svelte";
  import {
    IconLoading,
    IconShare,
    IconCheck,
    IconX,
  } from "@roomy/design/icons";

  const spaceId = $derived(page.params.space!);

  const flagsQuery = createFeatureFlagsQuery();
  const federationEnabled = $derived(
    flagsQuery.data?.flags.includes("channel-federation") ?? false,
  );

  const metaQuery = createSpaceMetadataQuery(() => spaceId);
  const isAdmin = $derived(metaQuery.data?.isAdmin ?? false);

  const requestsQuery = createFederationRequestsQuery(() => spaceId, { enabled: () => federationEnabled && isAdmin });
  const outgoingQuery = createFederationOutgoingQuery(() => spaceId, { enabled: () => federationEnabled && isAdmin });
  const incomingQuery = createFederationIncomingQuery(() => spaceId, { enabled: () => federationEnabled && isAdmin });
  const grantsQuery = createFederationGrantsQuery(() => spaceId, { enabled: () => federationEnabled && isAdmin });
  const rolesQuery = createRolesQuery(() => spaceId);



  // Channel name map from the sidebar metadata (own + federated).
  const roomNames = $derived.by(() => {
    const meta = metaQuery.data;
    const map = new Map<string, string>();
    for (const cat of meta?.sidebar.categories ?? []) {
      for (const ch of cat.channels ?? []) map.set(ch.id, ch.name ?? ch.id);
    }
    for (const ch of meta?.sidebar.orphans ?? []) map.set(ch.id, ch.name ?? ch.id);
    return map;
  });

  // Own channels of this space (excludes federated channels shown in orphans).
  const ownChannels = $derived.by(() => {
    const meta = metaQuery.data;
    const out: { id: string; name: string }[] = [];
    for (const cat of meta?.sidebar.categories ?? []) {
      for (const ch of cat.channels ?? []) out.push({ id: ch.id, name: ch.name ?? ch.id });
    }
    for (const ch of meta?.sidebar.orphans ?? []) {
      if (!ch.federated) out.push({ id: ch.id, name: ch.name ?? ch.id });
    }
    return out;
  });

  // Federated channels into this space, grouped by origin space.
  const federatedChannelsByOrigin = $derived.by(() => {
    const meta = metaQuery.data;
    const map = new Map<string, { id: string; name: string }[]>();
    for (const ch of meta?.sidebar.orphans ?? []) {
      if (ch.federated) {
        const list = map.get(ch.federated.originSpaceId) ?? [];
        list.push({ id: ch.id, name: ch.name ?? ch.id });
        map.set(ch.federated.originSpaceId, list);
      }
    }
    return map;
  });

  function originGrantOf(b: string, roomId: string): string {
    const g = grantsQuery.data?.originGrants?.find(
      (x) => x.federatingSpaceDid === b && x.roomId === roomId,
    );
    return g?.permission ?? "none";
  }
  function receiverGrantOf(origin: string, roomId: string, grantee: string): string {
    const g = grantsQuery.data?.receiverGrants?.find(
      (x) => x.originSpaceId === origin && x.roomId === roomId && x.grantee === grantee,
    );
    return g?.permission ?? "none";
  }

  const roles = $derived(rolesQuery.data?.roles ?? []);

  let busy = $state<string | null>(null);
  const isBusy = (key: string) => busy === key;

  const GRANT_OPTIONS = [
    { label: "Off", value: "none" },
    { label: "Read", value: "read" },
    { label: "Read + write", value: "readwrite" },
  ];

  async function refresh() {
    for (const nsid of [
      "space.roomy.federation.getGrants",
      "space.roomy.federation.getRequests",
      "space.roomy.federation.getIncoming",
      "space.roomy.federation.getOutgoing",
    ]) {
      await queryClient.invalidateQueries({ queryKey: [nsid] });
    }
    await queryClient.invalidateQueries({ queryKey: ["space.roomy.space.getMetadata"] });
  }

  async function onRespond(b: string, approve: boolean) {
    busy = `respond:${b}`;
    try {
      await respondFederation(spaceId, { federatingSpaceDid: b, approve });
      await refresh();
    } finally {
      busy = null;
    }
  }
  async function onRemove(b: string) {
    if (!confirm(`Remove the federation with ${b}? All shared channel access will be revoked.`)) return;
    busy = `remove:${b}`;
    try {
      await removeFederation(spaceId, b);
      await refresh();
    } finally {
      busy = null;
    }
  }
  async function onOriginGrant(b: string, roomId: string, permission: string) {
    busy = `og:${b}:${roomId}`;
    try {
      await setRoomPermission(spaceId, {
        federatingSpaceDid: b,
        roomId,
        permission: permission === "none" ? null : (permission as "read" | "readwrite"),
      });
      await refresh();
    } finally {
      busy = null;
    }
  }
  async function onReceiverGrant(origin: string, roomId: string, grantee: string, permission: string) {
    busy = `rg:${roomId}:${grantee}`;
    try {
      await setReceiverPermission(spaceId, {
        originSpaceId: origin,
        roomId,
        grantee,
        kind: "role",
        permission: permission === "none" ? null : (permission as "read" | "readwrite"),
      });
      await refresh();
    } finally {
      busy = null;
    }
  }

  const pending = $derived(requestsQuery.data?.requests ?? []);
  const outgoingActive = $derived(
    (outgoingQuery.data?.federations ?? []).filter((f) => f.status === "active"),
  );
  const incomingActive = $derived(
    (incomingQuery.data?.federations ?? []).filter((f) => f.status === "active"),
  );
</script>

{#if !federationEnabled}
  <div class="py-12 text-center text-sm text-base-500 dark:text-base-400">
    Channel federation is not enabled on this space yet.
  </div>
{:else if !isAdmin}
  <div class="py-12 text-center text-sm text-base-500 dark:text-base-400">
    Only space admins can manage federations.
  </div>
{:else}
  <div class="space-y-10 max-w-2xl">
    <!-- Pending requests -->
    <section class="space-y-3">
      <h2 class="text-base font-semibold text-base-900 dark:text-base-100">
        Pending requests
      </h2>
      {#if requestsQuery.isPending && pending.length === 0}
        <IconLoading class="animate-spin" />
      {:else if pending.length === 0}
        <p class="text-sm text-base-400">No pending federation requests.</p>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each pending as req (req.federatingSpaceDid)}
            <li class="rounded-2xl border border-base-200 dark:border-base-800 p-3 flex flex-col gap-2">
              <div class="flex items-center gap-2">
                <IconShare class="size-4 shrink-0 text-accent-500" />
                <span class="text-sm font-medium text-base-900 dark:text-base-100 truncate">
                  {req.federatingSpaceDid}
                </span>
              </div>
              <p class="text-xs text-base-400">
                Requested {new Date(req.requestedAt).toLocaleString()} by {req.requestedByDid}
                {#if req.message}<br />“{req.message}”{/if}
              </p>
              <div class="flex gap-2 justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isBusy(`respond:${req.federatingSpaceDid}`)}
                  onclick={() => onRespond(req.federatingSpaceDid, false)}
                >
                  <IconX class="size-4" /> Reject
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isBusy(`respond:${req.federatingSpaceDid}`)}
                  onclick={() => onRespond(req.federatingSpaceDid, true)}
                >
                  <IconCheck class="size-4" /> Approve
                </Button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Outgoing: channels this space shares with other spaces -->
    <section class="space-y-3">
      <h2 class="text-base font-semibold text-base-900 dark:text-base-100">
        Channels shared with other spaces
      </h2>
      {#if outgoingActive.length === 0}
        <p class="text-sm text-base-400">
          No active federations. Approve a pending request above to begin sharing channels.
        </p>
      {:else}
        <ul class="flex flex-col gap-3">
          {#each outgoingActive as f (f.federatingSpaceDid)}
            <li class="rounded-2xl border border-base-200 dark:border-base-800 p-3">
              <div class="flex items-center justify-between gap-2 mb-2">
                <span class="text-sm font-semibold text-base-900 dark:text-base-100 truncate">
                  {f.federatingSpaceDid}
                </span>
                <Button variant="ghost" size="sm" class="text-red-600" disabled={isBusy(`remove:${f.federatingSpaceDid}`)} onclick={() => onRemove(f.federatingSpaceDid)}>
                  Remove
                </Button>
              </div>
              <div class="flex flex-col gap-2">
                {#each ownChannels as ch}
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-sm text-base-700 dark:text-base-300 truncate">{ch.name}</span>
                    <ToggleGroup
                      name={`og:${f.federatingSpaceDid}:${ch.id}`}
                      value={originGrantOf(f.federatingSpaceDid, ch.id)}
                      options={GRANT_OPTIONS}
                      onchange={(v) => onOriginGrant(f.federatingSpaceDid, ch.id, v)}
                    />
                  </div>
                {/each}
                {#if ownChannels.length === 0}
                  <p class="text-sm text-base-400">No channels to share.</p>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Incoming: channels federated into this space + receiver grants -->
    <section class="space-y-3">
      <h2 class="text-base font-semibold text-base-900 dark:text-base-100">
        Channels federated into this space
      </h2>
      {#if incomingActive.length === 0}
        <p class="text-sm text-base-400">
          No spaces have federated channels into this space yet.
        </p>
      {:else}
        <ul class="flex flex-col gap-3">
          {#each incomingActive as f (f.originSpaceDid)}
            {@const fedChannels = federatedChannelsByOrigin.get(f.originSpaceDid) ?? []}
            <li class="rounded-2xl border border-base-200 dark:border-base-800 p-3">
              <div class="text-sm font-semibold text-base-900 dark:text-base-100 mb-2">
                {f.originSpaceDid}
              </div>
              {#if fedChannels.length === 0}
                <p class="text-sm text-base-400">
                  This space hasn't granted any channels yet. As soon as a channel is shared, you can grant your roles access below.
                </p>
              {:else if roles.length === 0}
                <p class="text-sm text-base-400">
                  No roles to grant access to. Create a role in Permissions first.
                </p>
              {:else}
                <div class="flex flex-col gap-3">
                  {#each fedChannels as ch}
                    <div class="rounded-xl bg-base-50 dark:bg-base-900/40 p-2">
                      <div class="text-xs font-semibold text-base-700 dark:text-base-300 mb-1 truncate">
                        {ch.name} <span class="text-base-400 font-normal">({roomNames.get(ch.id) ?? ch.id})</span>
                      </div>
                      <div class="flex flex-col gap-1.5">
                        {#each roles as role}
                          <div class="flex items-center justify-between gap-3">
                            <span class="text-sm text-base-700 dark:text-base-300 truncate">
                              {role.name ?? role.id}
                            </span>
                            <ToggleGroup
                              name={`rg:${ch.id}:${role.id}`}
                              value={receiverGrantOf(f.originSpaceDid, ch.id, role.id)}
                              options={GRANT_OPTIONS}
                              onchange={(v) => onReceiverGrant(f.originSpaceDid, ch.id, role.id, v)}
                            />
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
{/if}
