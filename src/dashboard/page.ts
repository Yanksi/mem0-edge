export function renderDashboardLogin(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mem0 Edge Dashboard</title></head><body><main><h1>Mem0 Edge Dashboard</h1><p>Unauthorized</p><form action="/dashboard/login" method="post"><label>Password <input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></main></body></html>`;
}

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mem0 Edge Dashboard</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #1d252b; background: #f3f5f4; }
    * { box-sizing: border-box; } body { margin: 0; min-height: 100vh; } button, input, select, textarea { font: inherit; }
    .shell { min-height: 100vh; padding-left: 208px; }
    .rail { position: fixed; inset: 0 auto 0 0; z-index: 1; width: 208px; display: grid; align-content: space-between; padding: 22px 14px; color: #d9e5e1; background: #17251f; }
    .brand { padding: 4px 10px 24px; font-weight: 700; letter-spacing: .02em; } .brand span { color: #65d6ad; }
    .nav { display: grid; gap: 4px; } .nav button { display: flex; gap: 10px; width: 100%; padding: 10px; border: 0; border-radius: 5px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
    .nav button:hover, .nav button[aria-selected="true"] { background: #28533f; color: #fff; } .nav-mark { width: 18px; text-align: center; color: #8edfc0; }
    .logout { width: 100%; padding: 9px; border: 1px solid #456255; border-radius: 5px; color: #d9e5e1; background: transparent; cursor: pointer; }
    .workspace { min-height: 100vh; padding: 28px clamp(20px, 4vw, 52px); overflow: hidden; } .topbar { display: flex; align-items: end; justify-content: space-between; gap: 18px; padding-bottom: 26px; border-bottom: 1px solid #d5dcda; }
    h1 { margin: 0; font-size: 24px; } .subtitle { margin: 6px 0 0; color: #63716c; } .user-control { min-width: min(100%, 320px); display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
    select, input { width: 100%; min-height: 40px; padding: 8px 10px; border: 1px solid #c6cfcb; border-radius: 5px; background: #fff; color: #1d252b; } .alias-row { display: flex; gap: 8px; }
    .icon-button { width: 40px; min-width: 40px; border: 1px solid #c6cfcb; border-radius: 5px; background: #fff; cursor: pointer; }
    .view { display: none; padding-top: 28px; } .view.active { display: block; } .search-form { display: flex; gap: 10px; margin-bottom: 24px; } .search-form input { flex: 1; } .primary { padding: 9px 16px; border: 0; border-radius: 5px; color: #fff; background: #176b5a; cursor: pointer; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; } h2 { margin: 0; font-size: 16px; } .muted { color: #63716c; font-size: 13px; }
    .memory-list { border-top: 1px solid #d5dcda; } .memory-row { border-bottom: 1px solid #d5dcda; } .memory-summary { width: 100%; display: grid; gap: 5px; padding: 15px 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; } .memory-summary:hover { background: #edf4f1; }
    .memory-main { font-weight: 600; line-height: 1.4; } .memory-meta { display: flex; flex-wrap: wrap; gap: 10px; color: #63716c; font-size: 12px; } .score { color: #176b5a; font-weight: 700; }
    .detail { margin-top: 16px; padding: 16px; border-left: 3px solid #65d6ad; background: #eaf2ee; white-space: pre-wrap; } .memory-detail { margin-bottom: 16px; } .detail[hidden] { display: none; } .detail dl { display: grid; grid-template-columns: 110px 1fr; gap: 8px; margin: 14px 0 0; font-size: 13px; } .detail dt { color: #63716c; } .detail dd { margin: 0; overflow-wrap: anywhere; }
    .load-more { margin-top: 16px; padding: 9px 14px; border: 1px solid #aebdb5; border-radius: 5px; background: #fff; cursor: pointer; }
    .graph { position: relative; min-height: 420px; border: 1px solid #d5dcda; background: #fff; overflow: hidden; } .graph svg { width: 100%; height: 420px; } .graph-node { cursor: pointer; } .graph-node circle { fill: #e1f3ea; stroke: #176b5a; stroke-width: 1.5; } .graph-node text { font-size: 12px; fill: #1d252b; pointer-events: none; } .graph-edge { stroke: #aebdb5; stroke-width: 1.3; } .graph-label { font-size: 10px; fill: #63716c; }
    .import-form { display: grid; gap: 16px; max-width: 760px; } .import-form label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; } textarea { width: 100%; min-height: 240px; padding: 10px; border: 1px solid #c6cfcb; border-radius: 5px; background: #fff; color: #1d252b; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; line-height: 1.4; resize: vertical; } input[type="file"] { min-height: auto; padding: 8px 0; border: 0; background: transparent; } .schema { margin: 0; padding: 12px; border: 1px solid #d5dcda; border-radius: 5px; background: #fff; color: #1d252b; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.45; overflow-x: auto; white-space: pre; }
    .empty { padding: 28px 0; color: #63716c; } .error { color: #a22727; }
    @media (max-width: 720px) { .shell { display: grid; grid-template-columns: 1fr; padding-left: 0; } .rail { position: static; width: auto; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; padding: 10px; } .brand { padding: 0; } .nav { grid-auto-flow: column; justify-content: start; } .nav button { width: auto; } .nav-mark { display: none; } .logout { width: auto; } .workspace { padding: 20px; } .topbar { display: grid; align-items: stretch; } .search-form { display: grid; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="rail">
      <div class="brand">mem<span>0</span> edge</div>
      <nav class="nav" aria-label="Memory navigation">
        <button type="button" data-view="search" aria-selected="true"><span class="nav-mark">S</span>Search memory</button>
        <button type="button" data-view="memories" aria-selected="false"><span class="nav-mark">M</span>All memories</button>
        <button type="button" data-view="graph" aria-selected="false"><span class="nav-mark">G</span>Memory graph</button>
        <button type="button" data-view="import" aria-selected="false"><span class="nav-mark">I</span>Import from Mem0</button>
      </nav>
      <form action="/dashboard/logout" method="post"><button class="logout" type="submit">Log out</button></form>
    </aside>
    <main class="workspace">
      <header class="topbar">
        <div><h1 id="page-title">Search memory</h1><p class="subtitle" id="page-subtitle">Semantic recall across a selected user profile.</p></div>
        <label class="user-control">User profile
          <div class="alias-row"><select name="user_id" id="user-select" aria-label="User profile"><option>Loading profiles...</option></select><button id="alias-button" class="icon-button" type="button" aria-label="Rename selected user">Edit</button></div>
        </label>
      </header>
      <section class="view active" id="view-search" aria-labelledby="page-title">
        <form class="search-form" id="search-form"><input name="query" placeholder="Search stored memories" autocomplete="off" required><button class="primary" type="submit">Search</button></form>
        <div class="section-head"><h2>Results</h2><span id="search-status" class="muted"></span></div><div id="search-results" class="memory-list"><p class="empty">Choose a user and search their memories.</p></div>
      </section>
      <section class="view" id="view-memories"><div class="section-head"><h2>All memories</h2><span id="memory-status" class="muted"></span></div><div id="memory-results" class="memory-list"></div><button id="load-more" class="load-more" type="button" hidden>Load more</button></section>
      <section class="view" id="view-graph"><div class="section-head"><h2>Memory graph</h2><span id="graph-status" class="muted"></span></div><div class="graph" id="graph"></div><aside class="detail" id="graph-detail" hidden></aside></section>
      <section class="view" id="view-import"><div class="section-head"><h2>Import from Mem0</h2><span id="import-status" class="muted"></span></div><form class="import-form" id="import-form"><label>Mem0 export file <input id="import-file" type="file" accept="application/json,.json"></label><label>Target user ID <input id="target-user-id" name="target_user_id" autocomplete="off" required></label><label>RawMemoryMigrationExport JSON <textarea id="export-json" name="export_json" spellcheck="false" placeholder='{"memories":[{"memory":"..."}]' required></textarea></label><button class="primary" type="submit">Queue import</button></form><div class="section-head"><h2>RawMemoryMigrationExport JSON Schema</h2></div><pre class="schema" aria-label="RawMemoryMigrationExport JSON Schema">{
  "type": "object",
  "title": "RawMemoryMigrationExport",
  "required": ["memories"],
  "properties": {
    "memories": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["memory"],
        "properties": {
          "memory": { "type": "string", "description": "The exact original memory text, preserved verbatim." },
          "created_at": { "anyOf": [{ "type": "string" }, { "type": "null" }], "description": "Original creation timestamp if available; otherwise null." },
          "updated_at": { "anyOf": [{ "type": "string" }, { "type": "null" }], "description": "Original update timestamp if available; otherwise null." }
        }
      },
      "description": "All matching memories. Preserve every source memory as a separate item. Do not merge, summarize, infer, rewrite, or omit memories."
    }
  }
}</pre></section>
    </main>
  </div>
  <script>
    const state = { userId: '', users: [], offset: 0, nextOffset: null, memories: [], targetUserIdManuallyOverridden: false };
    const labels = { search: ['Search memory', 'Semantic recall across a selected user profile.'], memories: ['All memories', 'Browse every active memory, newest first.'], graph: ['Memory graph', 'Explore entities and the relationships inferred from stored memories.'], import: ['Import from Mem0', 'Queue a RawMemoryMigrationExport for direct memory migration.'] };
    const select = document.getElementById('user-select');
    async function api(path, init) { const response = await fetch(path, init); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Request failed'); return body; }
    function selectedUser() { return state.users.find((user) => user.user_id === state.userId); }
    function profileLabel(user) { return user.alias || user.user_id; }
    function populateDetail(detail, memory) { detail.replaceChildren(); const text = document.createElement('strong'); text.textContent = memory.memory || memory.name; detail.append(text); const data = [['User ID', memory.user_id], ['Memory ID', memory.id], ['Created', memory.created_at], ['Updated', memory.updated_at], ['Metadata', JSON.stringify(memory.metadata || {}, null, 2)]]; const list = document.createElement('dl'); data.forEach(([key, value]) => { const term = document.createElement('dt'); term.textContent = key; const description = document.createElement('dd'); description.textContent = value || '-'; list.append(term, description); }); detail.append(list); }
    function setGraphDetail(memory) { const detail = document.getElementById('graph-detail'); detail.hidden = false; populateDetail(detail, memory); }
    function renderRows(target, rows, empty) { target.replaceChildren(); if (rows.length === 0) { const item = document.createElement('p'); item.className = 'empty'; item.textContent = empty; target.append(item); return; } rows.forEach((memory) => { const row = document.createElement('article'); row.className = 'memory-row'; const summary = document.createElement('button'); summary.type = 'button'; summary.className = 'memory-summary'; const content = document.createElement('span'); content.className = 'memory-main'; content.textContent = memory.memory; const meta = document.createElement('span'); meta.className = 'memory-meta'; const score = memory.score === undefined ? '' : 'Score ' + memory.score.toFixed(3); meta.textContent = [score, memory.created_at ? new Date(memory.created_at).toLocaleString() : '', memory.metadata && memory.metadata.source ? 'Source: ' + memory.metadata.source : ''].filter(Boolean).join(' | '); const detail = document.createElement('aside'); detail.className = 'detail memory-detail'; detail.hidden = true; populateDetail(detail, memory); summary.append(content, meta); summary.addEventListener('click', () => { const wasExpanded = !detail.hidden; target.querySelectorAll('.memory-detail').forEach((panel) => { panel.hidden = true; }); detail.hidden = wasExpanded; }); row.append(summary, detail); target.append(row); }); }
    async function loadUsers() { const previousUserId = state.userId; const body = await api('/dashboard/api/users'); state.users = body.results; select.replaceChildren(); if (state.users.length === 0) { state.userId = ''; const option = new Option('No stored users', ''); select.append(option); return; } state.users.forEach((user) => select.append(new Option(profileLabel(user), user.user_id))); state.userId = state.users.some((user) => user.user_id === previousUserId) ? previousUserId : state.users[0].user_id; select.value = state.userId; await loadMemories(true); }
    async function loadMemories(reset) { if (!state.userId) return; const status = document.getElementById('memory-status'); if (reset) { state.offset = 0; state.memories = []; } status.textContent = 'Loading...'; try { const body = await api('/dashboard/api/memories?user_id=' + encodeURIComponent(state.userId) + '&offset=' + state.offset); state.memories = reset ? body.results : state.memories.concat(body.results); state.nextOffset = body.next_offset ?? null; renderRows(document.getElementById('memory-results'), state.memories, 'No active memories for this user.'); document.getElementById('load-more').hidden = state.nextOffset === null; status.textContent = state.memories.length + ' loaded'; } catch (error) { status.textContent = error.message; status.className = 'muted error'; } }
    async function search(event) { event.preventDefault(); const query = String(new FormData(event.currentTarget).get('query') || ''); const status = document.getElementById('search-status'); status.textContent = 'Searching...'; try { const body = await api('/dashboard/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: state.userId, query }) }); renderRows(document.getElementById('search-results'), body.results, 'No relevant memories found.'); status.textContent = body.results.length + ' results'; } catch (error) { status.textContent = error.message; status.className = 'muted error'; } }
    async function loadGraph() { if (!state.userId) return; const graph = document.getElementById('graph'); const status = document.getElementById('graph-status'); status.textContent = 'Loading...'; try { const body = await api('/dashboard/api/graph?user_id=' + encodeURIComponent(state.userId)); const width = Math.max(graph.clientWidth || 620, 320); const height = 420; const positions = new Map(body.entities.map((entity, index) => { const angle = (Math.PI * 2 * index) / Math.max(body.entities.length, 1); return [entity.id, { x: width / 2 + Math.cos(angle) * Math.min(width * .32, 220), y: height / 2 + Math.sin(angle) * 130 }]; })); const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height); body.relationships.forEach((relationship) => { const source = positions.get(relationship.source_entity_id); const target = positions.get(relationship.target_entity_id); if (!source || !target) return; const edge = document.createElementNS(svg.namespaceURI, 'line'); edge.setAttribute('class', 'graph-edge'); edge.setAttribute('x1', source.x); edge.setAttribute('y1', source.y); edge.setAttribute('x2', target.x); edge.setAttribute('y2', target.y); svg.append(edge); }); body.entities.forEach((entity) => { const point = positions.get(entity.id); const node = document.createElementNS(svg.namespaceURI, 'g'); node.setAttribute('class', 'graph-node'); node.setAttribute('transform', 'translate(' + point.x + ' ' + point.y + ')'); const circle = document.createElementNS(svg.namespaceURI, 'circle'); circle.setAttribute('r', '28'); const text = document.createElementNS(svg.namespaceURI, 'text'); text.setAttribute('text-anchor', 'middle'); text.setAttribute('dy', '4'); text.textContent = entity.name.length > 12 ? entity.name.slice(0, 11) + '...' : entity.name; node.append(circle, text); node.addEventListener('click', () => setGraphDetail({ ...entity, memory: entity.name + ' | ' + entity.type })); svg.append(node); }); graph.replaceChildren(svg); status.textContent = body.entities.length + ' entities | ' + body.relationships.length + ' relationships'; } catch (error) { graph.textContent = error.message; status.textContent = 'Unable to load graph'; } }
    function filenameUserId(fileName) { return fileName.toLowerCase().endsWith('.json') ? fileName.slice(0, -5) : ''; }
    async function loadImportFile(event) { const file = event.currentTarget.files && event.currentTarget.files[0]; if (!file) return; const exportJson = document.getElementById('export-json'); exportJson.value = await file.text(); const target = document.getElementById('target-user-id'); const derivedUserId = filenameUserId(file.name); if (!state.targetUserIdManuallyOverridden && derivedUserId) target.value = derivedUserId; }
    async function importMem0(event) { event.preventDefault(); const status = document.getElementById('import-status'); const target = document.getElementById('target-user-id'); const exportJson = document.getElementById('export-json'); let exportData; try { exportData = JSON.parse(exportJson.value); } catch { status.textContent = 'Enter valid JSON.'; status.className = 'muted error'; return; } status.textContent = 'Queueing...'; status.className = 'muted'; try { const body = await api('/dashboard/api/imports/mem0', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: target.value, export: exportData }) }); status.textContent = body.queued + ' memories queued'; } catch (error) { status.textContent = error.message; status.className = 'muted error'; } }
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', async () => { const view = button.dataset.view; document.querySelectorAll('[data-view]').forEach((item) => item.setAttribute('aria-selected', String(item === button))); document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === 'view-' + view)); document.getElementById('page-title').textContent = labels[view][0]; document.getElementById('page-subtitle').textContent = labels[view][1]; document.getElementById('graph-detail').hidden = true; if (view === 'memories') await loadMemories(true); if (view === 'graph') await loadGraph(); }));
    select.addEventListener('change', async () => { state.userId = select.value; document.getElementById('graph-detail').hidden = true; await loadMemories(true); }); document.getElementById('search-form').addEventListener('submit', search); document.getElementById('load-more').addEventListener('click', async () => { state.offset = state.nextOffset; await loadMemories(false); }); document.getElementById('alias-button').addEventListener('click', async () => { const user = selectedUser(); if (!user) return; const alias = prompt('Alias for ' + user.user_id, user.alias || ''); if (alias === null) return; try { await api('/dashboard/api/users/' + encodeURIComponent(user.user_id) + '/alias', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias }) }); await loadUsers(); select.value = state.userId; } catch (error) { alert(error.message); } }); document.getElementById('target-user-id').addEventListener('input', () => { state.targetUserIdManuallyOverridden = true; }); document.getElementById('import-file').addEventListener('change', loadImportFile); document.getElementById('import-form').addEventListener('submit', importMem0);
    loadUsers().catch((error) => { select.replaceChildren(new Option(error.message, '')); });
  </script>
</body></html>`;
}
