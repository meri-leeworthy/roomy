<svelte:head>
  <title>Feature Flags — Roomy API Docs</title>
</svelte:head>

<div class="prose dark:prose-invert">
  <h1>Feature Flags</h1>

  <p class="lead text-lg text-base-600 dark:text-base-400">
    Feature flags let the appserver turn a UI surface on for everyone, for a
    handful of DIDs, or for nobody — without a deploy. The registry in code
    defines which keys exist; the read-state DB holds their state.
  </p>

  <hr />

  <h2>Identity vs. state</h2>

  <p>
    The two halves are deliberately separate:
  </p>

  <ul>
    <li>
      <strong>Identity</strong> — <code>packages/appserver/src/featureFlags.ts</code>
      exports <code>FEATURE_FLAGS</code> (the <code>key</code> +
      <code>description</code> of every flag that exists) and
      <code>FEATURE_FLAG_KEYS</code>. Adding an entry here is the only way to
      create a flag.
    </li>
    <li>
      <strong>State</strong> — two tables in the read-state DB
      (<code>packages/appserver/src/db/readStateSchema.sql</code>, schema v4):
      <code>feature_flags</code> (one row per key with
      <code>global_enabled</code>) and <code>feature_flag_assignments</code>
      (one row per <code>(flag_key, user_did)</code>). Nothing writes these
      tables except the admin procedures.
    </li>
  </ul>

  <p>
    <strong>Every flag defaults to off</strong> for every user. A flag is
    enabled for a caller when <code>global_enabled = 1</code> <em>or</em> the
    caller's DID has an assignment row.
  </p>

  <h2>Reading flags</h2>

  <p>
    <code>space.roomy.getFlags</code> returns the keys enabled for the calling
    user. It takes no parameters — flags are per-user, not per-space.
  </p>

  <pre><code>curl 'https://api.roomy.space/xrpc/space.roomy.getFlags' \
  -H 'Authorization: Bearer &lt;service-auth-jwt&gt;'

# → &#123; "flags": ["search", "pro-subscription"] &#125;</code></pre>

  <p>
    The response contains <strong>only enabled keys</strong>: a registered but
    disabled flag is simply absent, so a client check is always
    <code>flags.includes("&lt;key&gt;")</code> and never
    <code>!flags.includes(...)</code> read as "off".
  </p>

  <p>
    The app-lite client wraps this in
    <code>createFeatureFlagsQuery()</code>
    (<code>packages/app-lite/src/lib/queries/feature-flags.ts</code>) — a
    Tanstack Query cached under the <code>space.roomy.getFlags</code> query
    key, so any number of components can read it without extra round-trips.
    Components gate on <code>flagsQuery.data?.flags.includes(key) ?? false</code>.
  </p>

  <h2>Admin procedures</h2>

  <p>
    All three require the caller to be in the appserver's admin allowlist
    (<code>APPSERVER_ADMIN_DIDS</code>), and each rejects keys that aren't
    registered with a 400.
  </p>

  <table>
    <thead>
      <tr>
        <th>Endpoint</th>
        <th>Kind</th>
        <th>Effect</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><code>space.roomy.admin.getFlags</code></td>
        <td>query</td>
        <td>
          Full state of every registered flag:
          <code>key</code>, <code>description</code>,
          <code>globalEnabled</code>, <code>assignedDids</code>.
        </td>
      </tr>
      <tr>
        <td><code>space.roomy.admin.setFlag</code></td>
        <td>procedure</td>
        <td>
          Sets state along two independent dimensions. <code>all: true</code>
          flips the global row; <code>userDids: [...]</code>
          <em>replaces</em> the assignment list. Omitted fields are left
          unchanged. To turn a flag off entirely, use
          <code>clearFlag</code>.
        </td>
      </tr>
      <tr>
        <td><code>space.roomy.admin.clearFlag</code></td>
        <td>procedure</td>
        <td>
          Resets to the default: deletes the global row and every assignment
          row for that key.
        </td>
      </tr>
    </tbody>
  </table>

  <pre><code># On for everyone
curl -X POST 'https://api.roomy.space/xrpc/space.roomy.admin.setFlag' \
  -H 'Authorization: Bearer &lt;admin-jwt&gt;' -H 'Content-Type: application/json' \
  -d '&#123; "flag": "search", "all": true &#125;'

# Off globally, on for two DIDs (the list replaces any previous assignments)
curl -X POST 'https://api.roomy.space/xrpc/space.roomy.admin.setFlag' \
  -H 'Authorization: Bearer &lt;admin-jwt&gt;' -H 'Content-Type: application/json' \
  -d '&#123; "flag": "search", "all": false,
        "userDids": ["did:plc:alice", "did:plc:bob"] &#125;'

# Back to default
curl -X POST 'https://api.roomy.space/xrpc/space.roomy.admin.clearFlag' \
  -H 'Authorization: Bearer &lt;admin-jwt&gt;' -H 'Content-Type: application/json' \
  -d '&#123; "flag": "search" &#125;'</code></pre>

  <p>
    The admin surface is also exposed in this site's
    <a href="/playground">Playground</a> (flag toggles and per-DID assignment
    inputs) and via the raw <a href="/endpoints/space/roomy/admin/getFlags">endpoint pages</a>.
  </p>

  <h2>Adding a flag</h2>

  <ol>
    <li>
      <strong>Register it.</strong> Add a
      <code>&#123; key, description &#125;</code> entry to
      <code>FEATURE_FLAGS</code> in
      <code>packages/appserver/src/featureFlags.ts</code>. The key is both the
      XRPC identifier and the DB primary key — treat it as stable, since
      renaming it orphans the existing state rows.
    </li>
    <li>
      <strong>Gate the surface.</strong> In app-lite, read the flag through
      <code>createFeatureFlagsQuery()</code> and branch on
      <code>flags.includes("&lt;key&gt;")</code>. Make sure the flag-off path is
      what you want, since it is the state every user is in until an admin acts.
    </li>
    <li>
      <strong>Make sure the client may ask.</strong> Flags are read over
      <code>space.roomy.getFlags</code>, which is already listed in
      <code>APPSERVER_RPCS</code> (<code>packages/app-lite/src/lib/config.ts</code>)
      and therefore in the OAuth scope. A brand-new flag needs no scope change;
      a brand-new <em>endpoint</em> does.
    </li>
    <li>
      <strong>Roll it out.</strong> Assign a few DIDs with
      <code>setFlag</code>, then flip <code>all: true</code> when it's proven.
    </li>
  </ol>

  <h2>Removing a flag</h2>

  <p>
    A flag whose behaviour has shipped permanently should be un-gated: delete
    the <code>includes()</code> checks and the now-unused flag query, then
    delete the registry entry. De-registration is safe — both
    <code>getEnabledFlagsForUser</code> and
    <code>getAllFlagState</code> filter the DB rows through
    <code>FEATURE_FLAGS</code>, so any leftover
    <code>feature_flags</code> / <code>feature_flag_assignments</code> rows for
    a removed key become inert. They can be reclaimed with
    <code>clearFlag</code> before the entry is deleted, or simply left in place.
  </p>

  <p>
    Note the ordering constraint: once the registry entry is gone,
    <code>setFlag</code> / <code>clearFlag</code> reject that key with a 400, so
    there is no way to clear its state afterwards through the API.
  </p>

  <h2>What flags are not</h2>

  <ul>
    <li>
      <strong>Not a security boundary.</strong> The appserver does not consult
      flags when authorizing events; a gate is a UI affordance. Enforce real
      restrictions in handlers (<code>requireRoomRead</code>,
      <code>requireAdmin</code>, <code>checkWriteAuth</code>, …).
    </li>
    <li>
      <strong>Not per-space.</strong> <code>getFlags</code> takes no space
      argument, so a flag can't be enabled for one community only.
    </li>
    <li>
      <strong>Not persistent client state.</strong> The client reads flags from
      the appserver; there is no local override or build-time flag file.
    </li>
  </ul>
</div>
