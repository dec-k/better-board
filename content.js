(() => {
  'use strict';

  const BAR_ID = 'better-board-bar';
  const HIDDEN_ATTR = 'data-bb-hidden';

  // Firefox exposes the promise-based APIs as `browser`; Chrome and Edge as
  // `chrome`. Both return promises for the storage calls used here.
  const ext = globalThis.browser ?? globalThis.chrome;

  // GitHub ships hashed CSS-module class names. The module *prefix* is stable
  // across builds; the trailing hash is not. Match on prefix only.
  const SEL = {
    boardView: '[class*="Board-module__boardView"]',
    columnFrame: '[class*="column-frame-module__Box__"]',
    columnTitle: 'h2[class*="column-name-module__Title"]',
    filterInput: '#filter-bar-component-input',
    filterForm: '#filter-bar-component',
    filterRow: '[class*="base-project-view-filter-input-module__Box"]'
  };

  const state = {
    enabled: true,
    assignees: new Set(),
    hiddenColumns: new Set(),
    members: [],
    projectKey: null
  };

  // ---------------------------------------------------------------- storage

  function projectKey() {
    const m = location.pathname.match(/^\/(?:orgs|users)\/([^/]+)\/projects\/(\d+)/);
    return m ? `${m[1]}/${m[2]}` : location.pathname;
  }

  async function loadState() {
    state.projectKey = projectKey();
    const { enabled = true, projects = {} } = await ext.storage.sync.get(['enabled', 'projects']);
    state.enabled = enabled;
    const saved = projects[state.projectKey] || {};
    state.assignees = new Set(saved.assignees || []);
    state.hiddenColumns = new Set(saved.hiddenColumns || []);
  }

  async function saveState() {
    const { projects = {} } = await ext.storage.sync.get('projects');
    projects[state.projectKey] = {
      assignees: [...state.assignees],
      hiddenColumns: [...state.hiddenColumns]
    };
    await ext.storage.sync.set({ projects });
  }

  // ------------------------------------------------------------ page data

  function readJSON(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  }

  // The embedded payload is large and never changes after load, so parse it once.
  let payloadCache = { source: null, members: null };

  function membersFromPayload() {
    const el = document.getElementById('memex-paginated-items-data');
    const source = el ? el.textContent : '';
    if (payloadCache.source === source) return payloadCache.members;

    const byLogin = new Map();
    const data = readJSON('memex-paginated-items-data');
    const groups = data ? data.groupedItems || (data.nodes ? [{ nodes: data.nodes }] : []) : [];
    for (const group of groups) {
      for (const node of group.nodes || []) {
        const field = (node.memexProjectColumnValues || [])
          .find((v) => v.memexProjectColumnId === 'Assignees');
        for (const user of (field && field.value) || []) {
          if (!user || !user.login) continue;
          const existing = byLogin.get(user.login);
          if (existing) existing.count++;
          else
            byLogin.set(user.login, {
              login: user.login,
              name: user.name || user.login,
              avatarUrl: user.avatarUrl,
              count: 1
            });
        }
      }
    }

    payloadCache = { source, members: byLogin };
    return byLogin;
  }

  // Members accumulate rather than being recomputed: filtering the board unmounts
  // cards, and a team row that drops people as you filter can't filter back.
  let seenMembers = new Map();

  function readMembers() {
    for (const [login, member] of membersFromPayload()) {
      if (!seenMembers.has(login)) seenMembers.set(login, member);
    }

    // Items loaded after the initial payload only exist in the DOM.
    for (const img of document.querySelectorAll(
      `${SEL.boardView} img[src*="avatars.githubusercontent.com"]`
    )) {
      const login = (img.getAttribute('alt') || '').replace(/^@/, '').trim();
      if (login && !seenMembers.has(login)) {
        seenMembers.set(login, { login, name: login, avatarUrl: img.src, count: 0 });
      }
    }

    return [...seenMembers.values()].sort(
      (a, b) => b.count - a.count || a.login.localeCompare(b.login)
    );
  }

  function readColumnNames() {
    const names = [];
    const seen = new Set();
    const add = (name) => {
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    };

    // Only the board's own columns — a board may group by any single-select
    // field, so the project's other field options are not candidates here.
    for (const el of document.querySelectorAll(SEL.columnTitle)) add(el.textContent.trim());

    // A hidden column stays mounted, but keep its chip if GitHub unmounts it.
    for (const name of state.hiddenColumns) add(name);

    return names;
  }

  // -------------------------------------------------------- filter driving

  function tokenize(query) {
    const tokens = [];
    let current = '';
    let quoted = false;
    for (const ch of query) {
      if (ch === '"') {
        quoted = !quoted;
        current += ch;
      } else if (ch === ' ' && !quoted) {
        if (current) tokens.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }

  function buildQuery(existing, logins) {
    const kept = tokenize(existing).filter((t) => !/^-?assignee:/i.test(t));
    if (logins.length) kept.push(`assignee:${logins.join(',')}`);
    return kept.join(' ');
  }

  function applyAssigneeFilter() {
    const input = document.querySelector(SEL.filterInput);
    if (!input) return;

    const next = buildQuery(input.value, [...state.assignees]);
    if (next.trim() === input.value.trim()) return;

    // React overrides `value` on the element itself to track changes; going
    // through the native setter is what makes React notice the new query.
    // (Firefox content scripts already bypass that override via Xray vision,
    // but the descriptor is available there too, so one path covers both.)
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    );

    input.focus();
    if (setValue && setValue.set) setValue.set.call(input, next);
    else input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent('keydown', key));
    input.dispatchEvent(new KeyboardEvent('keypress', key));
    input.dispatchEvent(new KeyboardEvent('keyup', key));
    input.blur();
  }

  // Keep our chips in step when the query is edited by hand or by GitHub.
  function syncAssigneesFromQuery() {
    const input = document.querySelector(SEL.filterInput);
    if (!input) return;
    const token = tokenize(input.value).find((t) => /^assignee:/i.test(t));
    const logins = token
      ? token.slice('assignee:'.length).split(',').map((s) => s.replace(/"/g, '').trim()).filter(Boolean)
      : [];
    const changed =
      logins.length !== state.assignees.size || logins.some((l) => !state.assignees.has(l));
    if (changed) {
      state.assignees = new Set(logins);
      renderBar();
    }
  }

  // ----------------------------------------------------- column visibility

  function applyColumnVisibility() {
    for (const title of document.querySelectorAll(SEL.columnTitle)) {
      const frame = title.closest(SEL.columnFrame);
      if (!frame) continue;
      const hide = state.enabled && state.hiddenColumns.has(title.textContent.trim());
      if (hide) frame.setAttribute(HIDDEN_ATTR, '');
      else frame.removeAttribute(HIDDEN_ATTR);
    }
  }

  // ---------------------------------------------------------------- render

  function chip({ label, active, onClick, avatar, title }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bb-chip';
    button.setAttribute('aria-pressed', String(active));
    if (title) button.title = title;
    if (avatar) {
      const img = document.createElement('img');
      img.className = 'bb-avatar';
      img.src = avatar;
      img.alt = '';
      button.append(img);
    }
    const span = document.createElement('span');
    span.textContent = label;
    button.append(span);
    button.addEventListener('click', onClick);
    return button;
  }

  let lastSignature = null;

  function renderBar({ force = false } = {}) {
    const anchor = document.querySelector(SEL.filterRow) || document.querySelector(SEL.filterForm);
    const board = document.querySelector(SEL.boardView);
    const existing = document.getElementById(BAR_ID);

    if (!state.enabled || !anchor || !board) {
      if (existing) existing.remove();
      lastSignature = null;
      return;
    }

    const columnNames = readColumnNames();
    const signature = JSON.stringify([
      state.members.map((m) => m.login),
      columnNames,
      [...state.assignees].sort(),
      [...state.hiddenColumns].sort()
    ]);
    if (!force && existing && signature === lastSignature) return;
    lastSignature = signature;

    const bar = existing || document.createElement('div');
    bar.id = BAR_ID;
    bar.replaceChildren();

    // --- team members
    const people = document.createElement('div');
    people.className = 'bb-row';

    const label = document.createElement('span');
    label.className = 'bb-label';
    label.textContent = 'Team';
    people.append(label);

    people.append(
      chip({
        label: 'Everyone',
        active: state.assignees.size === 0,
        onClick: () => {
          state.assignees.clear();
          applyAssigneeFilter();
          renderBar();
          saveState();
        }
      })
    );

    for (const member of state.members) {
      people.append(
        chip({
          label: member.login,
          title: member.name === member.login ? member.login : `${member.name} (${member.login})`,
          avatar: member.avatarUrl,
          active: state.assignees.has(member.login),
          onClick: (event) => {
            // Plain click selects one person; modifier-click builds a set.
            const additive = event.metaKey || event.ctrlKey || event.shiftKey;
            if (additive) {
              if (state.assignees.has(member.login)) state.assignees.delete(member.login);
              else state.assignees.add(member.login);
            } else if (state.assignees.size === 1 && state.assignees.has(member.login)) {
              state.assignees.clear();
            } else {
              state.assignees = new Set([member.login]);
            }
            applyAssigneeFilter();
            renderBar();
            saveState();
          }
        })
      );
    }

    if (!state.members.length) {
      const empty = document.createElement('span');
      empty.className = 'bb-empty';
      empty.textContent = 'No assignees found on this board yet.';
      people.append(empty);
    }

    // --- columns
    const columns = document.createElement('div');
    columns.className = 'bb-row';

    const columnLabel = document.createElement('span');
    columnLabel.className = 'bb-label';
    columnLabel.textContent = 'Columns';
    columns.append(columnLabel);

    for (const name of columnNames) {
      const visible = !state.hiddenColumns.has(name);
      columns.append(
        chip({
          label: name,
          active: visible,
          title: visible ? `Hide "${name}"` : `Show "${name}"`,
          onClick: () => {
            if (visible) state.hiddenColumns.add(name);
            else state.hiddenColumns.delete(name);
            applyColumnVisibility();
            renderBar();
            saveState();
          }
        })
      );
    }

    if (state.hiddenColumns.size) {
      columns.append(
        chip({
          label: 'Show all',
          active: false,
          onClick: () => {
            state.hiddenColumns.clear();
            applyColumnVisibility();
            renderBar();
            saveState();
          }
        })
      );
    }

    bar.append(people, columns);
    if (!existing) anchor.insertAdjacentElement('afterend', bar);
  }

  // ----------------------------------------------------------------- boot

  let refreshQueued = false;
  function refresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      if (projectKey() !== state.projectKey) {
        seenMembers = new Map();
        loadState().then(refresh);
        return;
      }
      state.members = readMembers();
      renderBar();
      applyColumnVisibility();
      syncAssigneesFromQuery();
    });
  }

  ext.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue;
      refresh();
    }
  });

  loadState().then(() => {
    refresh();
    // GitHub Projects is a SPA and re-renders the board constantly. Ignore the
    // mutations we cause ourselves, or rendering the bar retriggers the observer.
    const observer = new MutationObserver((records) => {
      const ours = document.getElementById(BAR_ID);
      const external = records.some((r) => {
        if (ours && ours.contains(r.target)) return false;
        if (r.type === 'attributes' && r.attributeName === HIDDEN_ATTR) return false;
        return true;
      });
      if (external) refresh();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [HIDDEN_ATTR]
    });
  });
})();
