import { co, z } from "jazz-tools";

export const PageContent = co.map({
  text: z.string(),
});

export const PageComponent = {
  schema: PageContent,
  id: "space.roomy.page.v0",
};

export const Template = co.map({
  body: z.string(),
  components: z.array(z.string()), // list of component IDs
})

export const TextFile = co.map({
  body: z.string()
})

export const RenderTheme = co.map({
  rootTemplate: Template,
  subTemplates: co.record(z.string(), Template),
  buildAssets: co.record(z.string(), TextFile),
}) // should these just be components? how will themes work in the UI?