<script lang="ts">
  import { Button, Prose } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { PageContent, RoomyAccount, RoomyEntity } from "@roomy-chat/sdk";
  import { AccountCoState, CoState } from "jazz-tools/svelte";
  import { RichTextEditor } from "@fuxui/text";
  import PublishPageModal from "$lib/components/modals/PublishPageModal.svelte";

  let { objectId, spaceId: _ }: { objectId: string; spaceId: string } =
    $props();

  const page = $derived(new CoState(PageContent, objectId));
  const entity = $derived(new CoState(RoomyEntity, objectId));

  $effect(() => {
    if (entity.current) {
      console.log(entity.current.toJSON());
    }
    if (page.current) {
      console.log(page.current.toJSON());
    }
  });

  const me = new AccountCoState(RoomyAccount, {
    resolve: {
      profile: {
        newJoinedSpacesTest: true,
      },
    },
  });

  let isEditing = $state(false);
  let publishPageModal = $state(false);

  let editingContent = $state("hello");
</script>

<div class="max-w-4xl mx-auto w-full px-4 py-8">
  {#if page.current && me.current?.canWrite(page.current)}
    <div class="flex justify-end mb-4 gap-2">
      {#if isEditing}
        <Button
          onclick={() => {
            isEditing = false;
            if (page.current) {
              console.log(editingContent);
              page.current.text = editingContent;
            }
          }}
        >
          <Icon icon="tabler:check" />
          Save
        </Button>
      {:else}
        <Button onclick={() => (publishPageModal = true)}>
          <Icon icon="tabler:world" />
          Publish
        </Button>
        <Button
          variant="secondary"
          onclick={() => {
            if (page.current) {
              editingContent = page.current.text;
            }
            isEditing = true;
          }}
        >
          <Icon icon="tabler:pencil" />
          Edit
        </Button>
      {/if}
    </div>
  {/if}

  <Prose>
    {#if isEditing}
      <RichTextEditor
        content={editingContent}
        onupdate={(_c, ctx) => {
          editingContent = ctx.editor.getHTML();
        }}
      />
    {:else}
      {@html page.current?.text || "Empty page..."}
    {/if}
  </Prose>
</div>

<PublishPageModal
  bind:open={publishPageModal}
  bind:page={page.current}
  bind:entity={entity.current}
/>
