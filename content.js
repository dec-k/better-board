(() => {
  'use strict';

  const BAR_ID = 'better-board-bar';
  const HIDDEN_ATTR = 'data-bb-hidden';
  const CHILD_ATTR = 'data-bb-child';
  const CHROME_HIDDEN_ATTR = 'data-bb-chrome-hidden';

  // Firefox exposes the promise-based APIs as `browser`; Chrome and Edge as
  // `chrome`. Both return promises for the storage calls used here.
  const ext = globalThis.browser ?? globalThis.chrome;

  // GitHub ships hashed CSS-module class names. The module *prefix* is stable
  // across builds; the trailing hash is not. Match on prefix only. The card and
  // drop-zone hooks below are real attributes/classes and need no such care.
  const SEL = {
    boardView: '[class*="Board-module__boardView"]',
    columnFrame: '[class*="column-frame-module__Box__"]',
    columnTitle: 'h2[class*="column-name-module__Title"]',
    filterInput: '#filter-bar-component-input',
    filterForm: '#filter-bar-component',
    filterRow: '[class*="base-project-view-filter-input-module__Box"]',
    dropZone: '.column-drop-zone',
    card: '[data-board-card-id]',
    // Primer's tab components apply this role regardless of the hashed class
    // names used for everything else, so it survives GitHub's rebuilds.
    tabs: '[role="tablist"]'
  };

  const state = {
    enabled: true,
    hideControls: false,
    assignees: new Set(),
    hiddenColumns: new Set(),
    members: [],
    projectKey: null,
    standup: false,
    standupIndex: 0,
    // Who has already spoken. Ephemeral: a standup starts from a clean slate,
    // so this is never written to storage.
    standupDone: new Set()
  };

  // ---------------------------------------------------------------- storage

  function projectKey() {
    const m = location.pathname.match(/^\/(?:orgs|users)\/([^/]+)\/projects\/(\d+)/);
    return m ? `${m[1]}/${m[2]}` : location.pathname;
  }

  async function loadState() {
    state.projectKey = projectKey();
    const {
      enabled = true,
      hideControls = false,
      projects = {}
    } = await ext.storage.sync.get(['enabled', 'hideControls', 'projects']);
    state.enabled = enabled;
    state.hideControls = hideControls;
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
  let payloadCache = { source: null, members: new Map(), items: [], groups: [], complete: true };

  function valueOf(node, columnId) {
    const field = (node.memexProjectColumnValues || [])
      .find((v) => v.memexProjectColumnId === columnId);
    return field ? field.value : null;
  }

  function readPayload() {
    const el = document.getElementById('memex-paginated-items-data');
    const source = el ? el.textContent : '';
    if (payloadCache.source === source) return payloadCache;

    const data = readJSON('memex-paginated-items-data');
    const grouped = data ? data.groupedItems || (data.nodes ? [{ nodes: data.nodes }] : []) : [];
    const groupMeta = new Map(
      ((data && data.groups && data.groups.nodes) || []).map((g) => [g.groupId, g])
    );

    const members = new Map();
    const items = [];
    const groups = [];

    // The board only server-renders the first page of each column. When more is
    // waiting, every count derived from this is a floor rather than a total.
    let complete = true;

    for (const group of grouped) {
      if (group.pageInfo && group.pageInfo.hasNextPage) complete = false;
      const meta = groupMeta.get(group.groupId);
      groups.push({
        groupId: group.groupId,
        // `_noValue` groups carry no metadata; the column title comes from the
        // DOM instead, matched positionally.
        name: (meta && meta.groupMetadata && meta.groupMetadata.name) || null
      });

      for (const node of group.nodes || []) {
        const assignees = valueOf(node, 'Assignees') || [];
        const parent = valueOf(node, 'Parent issue');
        items.push({
          itemId: String(node.id),
          contentId: node.contentId,
          parentContentId: parent && parent.id ? parent.id : null,
          groupId: group.groupId,
          assignees: assignees.map((u) => u.login).filter(Boolean)
        });

        for (const user of assignees) {
          if (!user || !user.login || members.has(user.login)) continue;
          members.set(user.login, {
            login: user.login,
            name: user.name || user.login,
            avatarUrl: user.avatarUrl,
            fromPayload: true
          });
        }
      }
    }

    payloadCache = { source, members, items, groups, complete };
    return payloadCache;
  }

  // Maps each payload group onto the board column it renders as. Named groups
  // match by title; the unnamed "no value" group falls back to position.
  function columnNameByGroup() {
    const payload = readPayload();
    const titles = [...document.querySelectorAll(SEL.columnTitle)].map((e) => e.textContent.trim());
    const names = new Map();
    payload.groups.forEach((group, i) => {
      const matched = group.name && titles.includes(group.name) ? group.name : titles[i];
      names.set(group.groupId, matched || group.name || null);
    });
    return names;
  }

  // Counts are per visible column, so hiding Done/Canceled turns them into a
  // count of active work.
  function computeCounts() {
    const payload = readPayload();
    const columnOf = columnNameByGroup();
    const counts = new Map();
    let total = 0;

    for (const item of payload.items) {
      const column = columnOf.get(item.groupId);
      if (column && state.hiddenColumns.has(column)) continue;
      total++;
      for (const login of item.assignees) counts.set(login, (counts.get(login) || 0) + 1);
    }

    return { counts, total, complete: payload.complete };
  }

  // Members accumulate rather than being recomputed: filtering the board unmounts
  // cards, and a team row that drops people as you filter can't filter back.
  let seenMembers = new Map();

  function readMembers() {
    for (const [login, member] of readPayload().members) {
      if (!seenMembers.has(login)) seenMembers.set(login, member);
    }

    // Items loaded after the initial payload only exist in the DOM. We know
    // these people are on the board but not how much they hold, so they carry
    // no `fromPayload` flag and their chip shows no number rather than a wrong one.
    for (const img of document.querySelectorAll(
      `${SEL.boardView} img[src*="avatars.githubusercontent.com"]`
    )) {
      const login = (img.getAttribute('alt') || '').replace(/^@/, '').trim();
      if (login && !seenMembers.has(login)) {
        seenMembers.set(login, { login, name: login, avatarUrl: img.src, fromPayload: false });
      }
    }

    const { counts } = computeCounts();
    return [...seenMembers.values()].sort(
      (a, b) => (counts.get(b.login) || 0) - (counts.get(a.login) || 0) ||
        a.login.localeCompare(b.login)
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

  // -------------------------------------------------------- sub-issue nesting

  // Children are drawn under their parent by setting flex `order` on the cards
  // rather than moving them, so GitHub's own drag-and-drop and React's DOM stay
  // untouched. Only children sharing a column with their parent are nested —
  // pulling a card out of its status column would misrepresent the board.
  function childrenByParent() {
    const payload = readPayload();
    const byContentId = new Map(payload.items.map((i) => [i.contentId, i]));
    const children = new Map();

    for (const item of payload.items) {
      if (!item.parentContentId) continue;
      const parent = byContentId.get(item.parentContentId);
      if (!parent || parent.groupId !== item.groupId) continue;
      if (!children.has(parent.itemId)) children.set(parent.itemId, []);
      children.get(parent.itemId).push(item.itemId);
    }
    return children;
  }

  function clearNesting() {
    for (const card of document.querySelectorAll(`${SEL.card}[style*="order"]`)) {
      card.style.order = '';
    }
    for (const card of document.querySelectorAll(`[${CHILD_ATTR}]`)) {
      card.removeAttribute(CHILD_ATTR);
    }
  }

  function applySubIssueNesting() {
    const children = state.enabled ? childrenByParent() : new Map();
    if (!children.size) {
      clearNesting();
      return;
    }

    const allChildren = new Set();
    for (const kids of children.values()) for (const kid of kids) allChildren.add(kid);

    for (const zone of document.querySelectorAll(SEL.dropZone)) {
      const cards = [...zone.querySelectorAll(SEL.card)];
      const byItemId = new Map(cards.map((c) => [c.getAttribute('data-board-card-id'), c]));

      const ordered = [];
      const placed = new Set();
      for (const card of cards) {
        const id = card.getAttribute('data-board-card-id');
        // A child is emitted with its parent, not at its own position.
        if (allChildren.has(id) && byItemId.has(parentItemIdOf(children, id))) continue;
        ordered.push(card);
        placed.add(card);
        for (const kid of children.get(id) || []) {
          const kidCard = byItemId.get(kid);
          if (!kidCard || placed.has(kidCard)) continue;
          kidCard.setAttribute(CHILD_ATTR, '');
          ordered.push(kidCard);
          placed.add(kidCard);
        }
      }
      // Anything whose parent is not rendered here keeps its original place.
      for (const card of cards) if (!placed.has(card)) ordered.push(card);

      ordered.forEach((card, index) => {
        const want = String(index);
        if (card.style.order !== want) card.style.order = want;
        if (!allChildren.has(card.getAttribute('data-board-card-id'))) {
          card.removeAttribute(CHILD_ATTR);
        }
      });
    }
  }

  function parentItemIdOf(children, childId) {
    for (const [parentId, kids] of children) if (kids.includes(childId)) return parentId;
    return null;
  }

  // -------------------------------------------------------- standup mode

  // Finds the ancestor of `markerEl` that sits at the same nesting depth as
  // `referenceEl`'s subtree — i.e. the whole block containing the marker,
  // stopping at their nearest common ancestor. This lets the tab bar be hidden
  // without knowing its exact wrapper, since only the tablist itself has a
  // dependable selector.
  function findSectionToHide(markerEl, referenceEl) {
    const refPath = new Set();
    for (let n = referenceEl; n; n = n.parentElement) refPath.add(n);
    for (let n = markerEl; n && n.parentElement; n = n.parentElement) {
      if (refPath.has(n.parentElement)) return n;
    }
    return markerEl;
  }

  let chromeHiddenEls = [];

  // GitHub's own filter row and view tabs. Hiding them is a setting rather than
  // something standup does on its own, so it holds whatever mode the board is in
  // — and it rides on the extension being enabled at all.
  function applyChromeVisibility() {
    for (const el of chromeHiddenEls) el.removeAttribute(CHROME_HIDDEN_ATTR);
    chromeHiddenEls = [];
    if (!state.enabled || !state.hideControls) return;

    const anchor = document.querySelector(SEL.filterRow) || document.querySelector(SEL.filterForm);
    if (!anchor) return;

    const toHide = [anchor];
    const tablist = document.querySelector(SEL.tabs);
    if (tablist) toHide.push(findSectionToHide(tablist, anchor));

    for (const el of toHide) {
      el.setAttribute(CHROME_HIDDEN_ATTR, '');
      chromeHiddenEls.push(el);
    }
  }

  function applyStandupSelection() {
    const member = state.members[state.standupIndex];
    if (!member) return;
    state.assignees = new Set([member.login]);
    applyAssigneeFilter();
  }

  function enterStandup() {
    if (!state.members.length) return;
    const current = [...state.assignees][0];
    const idx = state.members.findIndex((m) => m.login === current);
    state.standupIndex = idx >= 0 ? idx : 0;
    state.standup = true;
    state.standupDone = new Set();
    applyStandupSelection();
    renderBar({ force: true });
  }

  function exitStandup() {
    state.standup = false;
    renderBar({ force: true });
  }

  function standupJump(index) {
    if (!state.members[index]) return;
    state.standupIndex = index;
    applyStandupSelection();
    renderBar({ force: true });
  }

  function standupToggleDone(login) {
    if (state.standupDone.has(login)) state.standupDone.delete(login);
    else state.standupDone.add(login);
    renderBar({ force: true });
  }

  // Space is the standup's one-handed control: this person has spoken, move on
  // to the next who hasn't. Everyone done leaves the selection where it is.
  function standupMarkDoneAndAdvance() {
    const member = state.members[state.standupIndex];
    if (!member) return;
    state.standupDone.add(member.login);

    const count = state.members.length;
    for (let step = 1; step <= count; step++) {
      const idx = (state.standupIndex + step) % count;
      if (!state.standupDone.has(state.members[idx].login)) {
        standupJump(idx);
        return;
      }
    }
    renderBar({ force: true });
  }

  function standupStep(delta) {
    if (!state.members.length) return;
    const count = state.members.length;
    state.standupIndex = (state.standupIndex + delta + count) % count;
    applyStandupSelection();
    renderBar({ force: true });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && columnsMenuOpen) {
      columnsMenuOpen = false;
      renderBar({ force: true });
    }

    if (!state.standup) return;
    const active = document.activeElement;
    const tag = active && active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (active && active.isContentEditable)) return;

    if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault();
      standupMarkDoneAndAdvance();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      standupStep(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      standupStep(-1);
    } else if (event.key === 'Escape') {
      exitStandup();
    }
  });

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

  function chip({ label, active, onClick, avatar, title, count, dim, done }) {
    const button = document.createElement('button');
    button.type = 'button';
    const classes = ['bb-chip'];
    if (avatar) classes.push('bb-chip--avatar');
    if (dim) classes.push('bb-chip--dim');
    button.className = classes.join(' ');
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
    if (count != null) {
      const badge = document.createElement('span');
      badge.className = 'bb-count';
      badge.textContent = count;
      button.append(badge);
    }
    if (done) {
      // The tick is decoration; "done" reaches assistive tech through the title.
      const check = document.createElement('span');
      check.className = 'bb-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      button.append(check);
    }
    button.addEventListener('click', onClick);
    return button;
  }

  // Board / Standup reads as a two-state mode switch rather than a pair of
  // actions, so both halves are always present and the current one is filled.
  function modeSegment({ label, icon, active, disabled, extraClass, onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = extraClass ? `bb-mode ${extraClass}` : 'bb-mode';
    button.setAttribute('aria-pressed', String(active));
    button.disabled = Boolean(disabled);
    if (icon) {
      const glyph = document.createElement('span');
      glyph.className = 'bb-mode-icon';
      glyph.textContent = icon;
      glyph.setAttribute('aria-hidden', 'true');
      button.append(glyph);
    }
    const span = document.createElement('span');
    span.textContent = label;
    button.append(span);
    button.addEventListener('click', onClick);
    return button;
  }

  let lastSignature = null;
  let columnsMenuOpen = false;

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
    const { counts, total, complete } = computeCounts();

    // A count we can only prove is a floor gets a "+" rather than a flat number.
    const more = complete ? '' : '+';
    const countOf = (member) =>
      member.fromPayload ? `${counts.get(member.login) || 0}${more}` : null;

    const signature = JSON.stringify([
      state.members.map((m) => `${m.login}:${countOf(m)}`),
      columnNames,
      [...state.assignees].sort(),
      [...state.hiddenColumns].sort(),
      state.standup,
      state.standupIndex,
      state.hideControls,
      [...state.standupDone].sort(),
      columnsMenuOpen
    ]);
    if (!force && existing && signature === lastSignature) return;
    lastSignature = signature;

    const bar = existing || document.createElement('div');
    bar.id = BAR_ID;
    bar.classList.toggle('bb-controls-hidden', state.hideControls);
    bar.replaceChildren();

    // Line the bar up with the filter input above and the columns below, both
    // of which are inset by their container's own horizontal padding.
    const anchorPadding = getComputedStyle(anchor);
    bar.style.marginLeft = anchorPadding.paddingLeft;
    bar.style.marginRight = anchorPadding.paddingRight;

    // --- left: the team, or the person under discussion
    const people = document.createElement('div');
    people.className = 'bb-row';

    if (state.standup) {
      if (state.members.length) {
        // The whole team stays on screen through the standup — everyone can see
        // who has been and who is still to come — with only the person under
        // discussion at full strength.
        state.members.forEach((member, index) => {
          const active = index === state.standupIndex;
          const done = state.standupDone.has(member.login);
          const who =
            member.name && member.name !== member.login
              ? `${member.name} (${member.login})`
              : member.login;

          people.append(
            chip({
              label: member.login,
              count: countOf(member),
              avatar: member.avatarUrl,
              active,
              dim: !active,
              done,
              title: active
                ? `${who} — ${done ? 'done; click to reopen' : 'click to mark done'}`
                : `${who}${done ? ' — done' : ''} — click to bring up`,
              onClick: () => {
                if (active) standupToggleDone(member.login);
                else standupJump(index);
              }
            })
          );
        });

        const doneCount = state.members.filter((m) => state.standupDone.has(m.login)).length;
        const meta = document.createElement('span');
        meta.className = 'bb-standup-meta';
        meta.textContent =
          doneCount === state.members.length
            ? `all ${doneCount} done · ← → to step`
            : `${doneCount} of ${state.members.length} done · space marks done · ← → to step`;
        people.append(meta);
      } else {
        const empty = document.createElement('span');
        empty.className = 'bb-empty';
        empty.textContent = 'No assignees found on this board yet.';
        people.append(empty);
      }
    } else {
      people.append(
        chip({
          label: 'Everyone',
          active: state.assignees.size === 0,
          count: `${total}${more}`,
          title: `${total}${more} item${total === 1 ? '' : 's'} in the columns currently shown`,
          onClick: () => {
            state.assignees.clear();
            applyAssigneeFilter();
            renderBar();
            saveState();
          }
        })
      );

      for (const member of state.members) {
        const who =
          member.name === member.login ? member.login : `${member.name} (${member.login})`;
        people.append(
          chip({
            label: member.login,
            count: countOf(member),
            title: member.fromPayload
              ? `${who} — ${counts.get(member.login) || 0}${more} assigned in the columns currently shown`
              : `${who} — assigned on this board`,
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
    }

    // --- right: column toggles and the mode switch
    const actions = document.createElement('div');
    actions.className = 'bb-actions';

    // Column toggles are a whole-board control, and standup is a stripped-back
    // mode — it already hides GitHub's filter row and tabs — so they step out
    // of the bar for its duration. Hidden columns stay hidden either way.
    if (!state.standup) {
      const dropdown = document.createElement('div');
      dropdown.className = 'bb-dropdown';

      const hiddenCount = state.hiddenColumns.size;
      const dropdownToggle = document.createElement('button');
      dropdownToggle.type = 'button';
      dropdownToggle.className = 'bb-columns-toggle';
      dropdownToggle.setAttribute('aria-expanded', String(columnsMenuOpen));
      dropdownToggle.title = hiddenCount
        ? `${hiddenCount} of ${columnNames.length} columns hidden`
        : 'Show or hide columns';

      const glyph = document.createElement('span');
      glyph.className = 'bb-columns-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.append(
        document.createElement('span'),
        document.createElement('span'),
        document.createElement('span')
      );

      const glyphText = document.createElement('span');
      glyphText.textContent = 'Columns';
      dropdownToggle.append(glyph, glyphText);

      if (hiddenCount) {
        const badge = document.createElement('span');
        badge.className = 'bb-columns-count';
        badge.textContent = hiddenCount;
        dropdownToggle.append(badge);
      }

      dropdownToggle.addEventListener('click', () => {
        columnsMenuOpen = !columnsMenuOpen;
        renderBar({ force: true });
      });

      const menu = document.createElement('div');
      menu.className = 'bb-dropdown-menu';
      if (!columnsMenuOpen) menu.hidden = true;

      const bulk = document.createElement('div');
      bulk.className = 'bb-dropdown-actions';

      const showAll = document.createElement('button');
      showAll.type = 'button';
      showAll.className = 'bb-dropdown-action';
      showAll.textContent = 'Show all';
      showAll.disabled = !hiddenCount;
      showAll.addEventListener('click', () => {
        state.hiddenColumns.clear();
        applyColumnVisibility();
        renderBar({ force: true });
        saveState();
      });

      const hideAll = document.createElement('button');
      hideAll.type = 'button';
      hideAll.className = 'bb-dropdown-action';
      hideAll.textContent = 'Hide all';
      hideAll.disabled = hiddenCount === columnNames.length;
      hideAll.addEventListener('click', () => {
        state.hiddenColumns = new Set(columnNames);
        applyColumnVisibility();
        renderBar({ force: true });
        saveState();
      });

      bulk.append(showAll, hideAll);
      menu.append(bulk);

      for (const name of columnNames) {
        const visible = !state.hiddenColumns.has(name);
        const item = document.createElement('label');
        item.className = 'bb-dropdown-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = visible;
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) state.hiddenColumns.delete(name);
          else state.hiddenColumns.add(name);
          applyColumnVisibility();
          renderBar({ force: true });
          saveState();
        });

        const itemLabel = document.createElement('span');
        itemLabel.textContent = name;

        item.append(checkbox, itemLabel);
        menu.append(item);
      }

      // Every control in here re-renders the bar, which detaches the node that
      // was clicked before the event reaches the document-level outside-click
      // handler — so that handler would read it as a click from outside and
      // close the menu. Stop the event at the dropdown instead, on the way up.
      dropdown.addEventListener('click', (event) => event.stopPropagation());

      dropdown.append(dropdownToggle, menu);

      const divider = document.createElement('span');
      divider.className = 'bb-divider';
      divider.setAttribute('aria-hidden', 'true');

      actions.append(dropdown, divider);
    }

    const modes = document.createElement('div');
    modes.className = 'bb-modes';
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Board mode');

    modes.append(
      modeSegment({
        label: 'Board',
        active: !state.standup,
        onClick: () => {
          if (!state.standup) return;
          columnsMenuOpen = false;
          exitStandup();
        }
      }),
      modeSegment({
        label: 'Standup',
        icon: state.standup ? '▮▮' : '▶',
        active: state.standup,
        extraClass: 'bb-mode--standup',
        disabled: !state.standup && !state.members.length,
        onClick: () => {
          if (state.standup) return;
          columnsMenuOpen = false;
          enterStandup();
        }
      })
    );

    actions.append(modes);

    bar.append(people, actions);
    if (!existing) anchor.insertAdjacentElement('afterend', bar);
  }

  document.addEventListener('click', (event) => {
    if (!columnsMenuOpen) return;
    const dropdown = document.querySelector('#better-board-bar .bb-dropdown');
    if (!dropdown || !dropdown.contains(event.target)) {
      columnsMenuOpen = false;
      renderBar({ force: true });
    }
  });

  // ----------------------------------------------------------------- boot

  // Coalesces the burst of mutations a single GitHub re-render produces. This
  // is deliberately a timer and not requestAnimationFrame: rAF never fires
  // while the tab is hidden, which would latch the pending flag and leave the
  // bar frozen until the next render after the tab came back.
  let refreshTimer = null;
  function refresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (projectKey() !== state.projectKey) {
        seenMembers = new Map();
        state.standup = false;
        state.standupIndex = 0;
        chromeHiddenEls = [];
        loadState().then(refresh);
        return;
      }
      state.members = readMembers();
      if (!state.enabled) state.standup = false;
      renderBar();
      applyColumnVisibility();
      applyChromeVisibility();
      applySubIssueNesting();
      syncAssigneesFromQuery();
    }, 50);
  }

  ext.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      state.enabled = changes.enabled.newValue;
      if (!state.enabled) state.standup = false;
    }
    if (changes.hideControls) state.hideControls = changes.hideControls.newValue;
    if (changes.enabled || changes.hideControls) refresh();
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
        if (r.type === 'attributes' && r.attributeName === CHROME_HIDDEN_ATTR) return false;
        return true;
      });
      if (external) refresh();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [HIDDEN_ATTR, CHROME_HIDDEN_ATTR]
    });
  });
})();
