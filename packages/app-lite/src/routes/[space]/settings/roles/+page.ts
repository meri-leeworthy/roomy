import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

// The Roles settings page is now Permissions. Deep links to the old route
// redirect there so bookmarks keep working.
export const load: PageLoad = ({ params }) => {
  throw redirect(307, `/${params.space}/settings/permissions`);
};
