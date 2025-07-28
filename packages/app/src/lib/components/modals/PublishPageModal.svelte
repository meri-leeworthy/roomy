<script lang="ts">
  import { PageContent, RoomyEntity } from "@roomy-chat/sdk";
  import { Modal, Button } from "@fuxui/base";
  import Icon from "@iconify/svelte";
  import { co } from "jazz-tools";
  import * as wasm from "roomy-render";

  let {
    open = $bindable(false),
    page = $bindable(null),
    entity = $bindable(null),
  }: {
    open: boolean;
    page: co.loaded<typeof PageContent> | undefined | null;
    entity: co.loaded<typeof RoomyEntity> | undefined | null;
  } = $props();

  let pageName = $derived(entity?.name);

  async function publish() {
    console.log("publish", pageName, page);
    if (!pageName || !page || !entity) return;
    wasm.validateSchema({});
    open = false;
  }
</script>

<Modal bind:open>
  <form id="createSpace" class="flex flex-col gap-4" onsubmit={publish}>
    <h3
      id="dialog-title"
      class="text-base font-semibold text-base-900 dark:text-base-100"
    >
      Publish page
    </h3>
    <div class="mt-2">
      <p class="text-sm text-base-500 dark:text-base-400">
        This will generate a standalone web page from your page content, and
        make it accessible to anyone with the link.
      </p>
    </div>

    <div class="flex justify-start">
      <Button type="submit" disabled={!pageName} class="justify-start">
        <Icon icon="tabler:world" class="size-4" />
        Publish
      </Button>
    </div>
  </form>
</Modal>
