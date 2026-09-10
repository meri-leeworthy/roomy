/**
 * Live search term + navbar placeholder shared between the navbar SearchBar
 * (which owns the search input on the search result pages) and
 * SearchResultsList (which debounces the term and runs the queries).
 *
 * The URL `?q=` remains the seed: the search pages re-seed this state from
 * the query string on mount / when it changes, so back/forward and deep
 * links keep working.
 */
export const searchTerm = $state({
  /** The term currently typed in the navbar search bar. */
  input: "",
  /** Placeholder text for the navbar search bar on search pages — the
   *  page's title ("Search <space>", "Search in <room>", …). */
  placeholder: "Search",
});
