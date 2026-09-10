<script lang="ts" module>
  import { defineMeta } from "@storybook/addon-svelte-csf";
  import PricingTiers from "./PricingTiers.svelte";

  const { Story } = defineMeta({
    title: "Marketing/PricingTiers",
    component: PricingTiers,
  });
</script>

<Story name="Default" />
<Story name="Free Active" args={{ activeTier: "Free" }} />
<Story name="Pro Active" args={{ activeTier: "Pro" }} />
