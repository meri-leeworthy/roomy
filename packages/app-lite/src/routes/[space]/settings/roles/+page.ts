import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

// The "Roles" settings page was renamed to "Permissions". Redirect any
// deep links to the new route so bookmarks / old URLs keep working.
export const load: PageLoad = ({ params }) => {
  throw redirect(307, `/${params.space}/settings/permissions`);
};
