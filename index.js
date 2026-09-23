import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '/script.js';
import { getPresetManager } from '/scripts/preset-manager.js';

const KEY = 'prompt-box';
const ALL = '__all__';
const NONE = '__uncategorized__';
const FAVORITES = '__favorites__';
const PAGE_SIZE = 60;
const presetOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const selectedNames = new Set();
let nativeSyncPending = false;
let catalog = [];
let catalogDirty = true;
let folderId = ALL;
let limit = PAGE_SIZE;
let organizing = false;
let panel;
let backdrop;
let launcher;
let presetSelect;
let selectObserver;
let placementObserver;
let observedParent;
let bootObserver;
let renderFrame = 0;
let loading = false;
let folderEditId = null;
let initialized = false;
let moveTarget = NONE;
let moveMenu;

function getState() {
    let state = extension_settings[KEY];
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        state = extension_settings[KEY] = {};
    }
    if (!Array.isArray(state.folders)) state.folders = [];
    if (!state.assignments || typeof state.assignments !== 'object' || Array.isArray(state.assignments)) state.assignments = {};
    if (!Array.isArray(state.favorites)) state.favorites = [];
    if (state.theme !== 'dark' && state.theme !== 'light') state.theme = 'light';
    return state;
}

function folders() {
    return getState().folders.filter(folder => folder && typeof folder.id === 'string' && typeof folder.name === 'string');
}

function saveState() {
    saveSettingsDebounced();
    queueNativeSync();
    scheduleRender();
}

function queueNativeSync() {
    if (nativeSyncPending) return;
    nativeSyncPending = true;
    queueMicrotask(() => {
        nativeSyncPending = false;
        if (document.activeElement !== presetSelect) syncNativeGroups();
    });
}

function observePresetSelect() {
    selectObserver.observe(presetSelect, { childList: true, subtree: true, characterData: true });
}

function syncNativeGroups() {
    if (!presetSelect?.isConnected) return;
    const state = getState();
    const groups = new Map(folders().map(folder => [folder.id, { name: folder.name, options: [] }]));
    groups.set(NONE, { name: '미분류', options: [] });
    for (const option of presetSelect.options) {
        const name = option.textContent.trim();
        const assigned = Object.hasOwn(state.assignments, name) ? state.assignments[name] : NONE;
        (groups.get(assigned) || groups.get(NONE)).options.push(option);
    }
    const desired = Array.from(groups.values()).filter(group => group.options.length);
    for (const group of desired) group.options.sort((a, b) => presetOrder.compare(a.textContent, b.textContent));
    const existing = Array.from(presetSelect.children);
    const sameStructure = existing.length === desired.length && desired.every((group, index) => {
        const node = existing[index];
        return node.tagName === 'OPTGROUP' && node.label === group.name && node.children.length === group.options.length
            && group.options.every((option, i) => node.children[i] === option);
    });
    const selected = presetSelect.selectedOptions[0];
    selectObserver.disconnect();
    try {
        for (const group of desired) {
            for (const option of group.options) {
                if (option.hasAttribute('label')) option.removeAttribute('label');
            }
        }
        if (!sameStructure) {
            const fragment = document.createDocumentFragment();
            for (const group of desired) {
                const node = document.createElement('optgroup');
                node.label = group.name;
                node.append(...group.options);
                fragment.append(node);
            }
            presetSelect.replaceChildren(fragment);
            if (selected) selected.selected = true;
            else presetSelect.selectedIndex = -1;
            catalogDirty = true;
        }
    } finally {
        observePresetSelect();
    }
}

function isOpen() {
    return panel && !panel.hidden;
}

function isDesktop() {
    return window.matchMedia('(min-width: 601px)').matches;
}

function currentName() {
    return presetSelect?.selectedOptions[0]?.textContent?.trim() || '';
}

function normalized(text) {
    return text.normalize('NFKC').toLocaleLowerCase();
}

function getCatalog() {
    if (catalogDirty) {
        catalog = Array.from(presetSelect?.options || [], option => ({
            name: option.textContent.trim(),
            value: option.value,
            search: normalized(option.textContent.trim()),
        })).filter(item => item.name);
        catalogDirty = false;
        const names = new Set(catalog.map(item => item.name));
        for (const name of selectedNames) if (!names.has(name)) selectedNames.delete(name);
    }
    return catalog;
}

function scheduleRender() {
    if (!isOpen() || renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
        renderFrame = 0;
        if (isOpen()) render();
    });
}

function invalidateCatalog() {
    catalogDirty = true;
    queueNativeSync();
    scheduleRender();
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(text, action, className = '') {
    const node = element('button', className, text);
    node.type = 'button';
    node.dataset.action = action;
    return node;
}

function iconButton(icon, title, action) {
    const node = button('', action, 'prompt-box-icon');
    const glyph = element('i', `fa-solid ${icon}`);
    glyph.setAttribute('aria-hidden', 'true');
    node.append(glyph);
    node.title = title;
    node.setAttribute('aria-label', title);
    return node;
}

function createPanel() {
    backdrop = element('div');
    backdrop.id = 'prompt-box-backdrop';
    backdrop.hidden = true;
    backdrop.setAttribute('aria-hidden', 'true');
    panel = element('section', '', undefined);
    panel.id = 'prompt-box';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'prompt-box-title');
    panel.innerHTML = `
        <header class="prompt-box-header">
            <span class="prompt-box-mark"><i class="fa-solid fa-folder-open" aria-hidden="true"></i></span>
            <div class="prompt-box-heading"><strong id="prompt-box-title">프롬 정리함</strong><span id="prompt-box-current"></span></div>
            <button type="button" data-action="theme" id="prompt-box-theme" class="prompt-box-icon" aria-label="다크 모드로 전환"><i class="fa-solid fa-moon" aria-hidden="true"></i></button>
            <button type="button" data-action="organize" id="prompt-box-organize" aria-pressed="false">정리</button>
            <button type="button" data-action="close" class="prompt-box-icon" aria-label="프롬 정리함 닫기"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </header>
        <div class="prompt-box-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input id="prompt-box-search" type="search" autocomplete="off" placeholder="이 폴더에서 이름 검색" aria-label="프리셋 이름 검색"></div>
        <div class="prompt-box-workspace">
            <aside class="prompt-box-sidebar"><nav id="prompt-box-folders" aria-label="프리셋 폴더"></nav><button type="button" data-action="new-folder" id="prompt-box-new-folder" aria-label="새 폴더 추가" title="새 폴더 추가"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>새 폴더</span></button></aside>
            <main class="prompt-box-content">
                <div class="prompt-box-list-header"><strong id="prompt-box-folder-name"></strong><span id="prompt-box-result-count"></span><div id="prompt-box-folder-tools" hidden></div></div>
                <form id="prompt-box-folder-editor" hidden><label for="prompt-box-folder-name-input" id="prompt-box-editor-label">폴더 이름</label><div class="prompt-box-inline"><input id="prompt-box-folder-name-input" maxlength="80" required autocomplete="off"><button type="submit">저장</button><button type="button" data-action="cancel-folder">취소</button></div></form>
                <div id="prompt-box-delete-confirm" hidden><span>폴더를 삭제하면 안의 프리셋은 미분류로 이동합니다.</span><div class="prompt-box-inline"><button type="button" data-action="confirm-delete" class="prompt-box-danger">폴더 삭제</button><button type="button" data-action="cancel-delete">취소</button></div></div>
                <div id="prompt-box-list" aria-label="프리셋 목록"></div>
                <button type="button" id="prompt-box-more" data-action="more" hidden>더 보기</button>
            </main>
        </div>
        <div id="prompt-box-bulk" hidden><div class="prompt-box-bulk-selection"><span id="prompt-box-selected-count"></span><button type="button" data-action="select-results">검색 결과 선택</button><button type="button" data-action="clear-selection">선택 해제</button></div><div class="prompt-box-inline"><div class="prompt-box-dropdown"><button type="button" id="prompt-box-move-target" data-action="toggle-target" aria-label="이동할 폴더" aria-haspopup="listbox" aria-controls="prompt-box-move-menu" aria-expanded="false"><span></span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button></div><button type="button" data-action="move" id="prompt-box-move">이동</button></div></div>
        <footer><span id="prompt-box-hint">이름을 누르면 불러옵니다.</span><span id="prompt-box-status" role="status" aria-live="polite"></span></footer>`;
    const tools = panel.querySelector('#prompt-box-folder-tools');
    tools.append(iconButton('fa-pen', '폴더 이름 수정', 'rename-folder'), iconButton('fa-arrow-up', '폴더 위로', 'folder-up'), iconButton('fa-arrow-down', '폴더 아래로', 'folder-down'), iconButton('fa-trash-can', '폴더 삭제', 'delete-folder'));
    panel.addEventListener('click', handleClick);
    panel.addEventListener('change', event => {
        const name = event.target.dataset.selectName;
        if (name === undefined) return;
        if (event.target.checked) selectedNames.add(name);
        else selectedNames.delete(name);
        renderBulk();
    });
    panel.querySelector('#prompt-box-search').addEventListener('input', () => {
        limit = PAGE_SIZE;
        scheduleRender();
    });
    panel.querySelector('#prompt-box-folder-editor').addEventListener('submit', saveFolder);
    panel.querySelector('#prompt-box-folder-name-input').addEventListener('input', event => event.target.setCustomValidity(''));
    panel.querySelector('#prompt-box-move-target').addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        event.stopPropagation();
        openMoveMenu();
    });
    panel.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        const controls = Array.from(panel.querySelectorAll('#prompt-box-list .prompt-box-load, #prompt-box-list input[type="checkbox"]'));
        const index = controls.indexOf(document.activeElement);
        if (document.activeElement.id !== 'prompt-box-search' && index < 0) return;
        if (!controls.length) return;
        event.preventDefault();
        controls[(index + (event.key === 'ArrowDown' ? 1 : controls.length - 1) + controls.length) % controls.length].focus();
    });
    document.body.append(backdrop, panel);
}

function filteredCatalog() {
    const state = getState();
    const validIds = new Set(folders().map(folder => folder.id));
    const favorites = new Set(state.favorites);
    const terms = normalized(panel.querySelector('#prompt-box-search').value.trim()).split(/\s+/).filter(Boolean);
    return getCatalog().filter(item => {
        const assigned = Object.hasOwn(state.assignments, item.name) && validIds.has(state.assignments[item.name]) ? state.assignments[item.name] : NONE;
        const included = folderId === ALL || (folderId === FAVORITES ? favorites.has(item.name) : assigned === folderId);
        return included && terms.every(term => item.search.includes(term));
    });
}

function render() {
    closeMoveMenu(!!moveMenu?.contains(document.activeElement));
    const state = getState();
    applyTheme();
    const folderList = folders();
    if (![ALL, NONE, FAVORITES].includes(folderId) && !folderList.some(folder => folder.id === folderId)) folderId = ALL;
    const active = currentName();
    const current = panel.querySelector('#prompt-box-current');
    current.textContent = active ? `사용 중 · ${active}` : '프리셋을 골라 불러오세요';
    current.title = active;
    const counts = new Map(folderList.map(folder => [folder.id, 0]));
    const favoriteNames = new Set(state.favorites);
    let uncategorized = 0;
    let favoriteCount = 0;
    for (const item of getCatalog()) {
        const assigned = Object.hasOwn(state.assignments, item.name) ? state.assignments[item.name] : null;
        if (counts.has(assigned)) counts.set(assigned, counts.get(assigned) + 1);
        else uncategorized++;
        if (favoriteNames.has(item.name)) favoriteCount++;
    }
    const views = [
        { id: ALL, name: '전체', count: catalog.length },
        { id: FAVORITES, name: '즐겨찾기', count: favoriteCount },
        { id: NONE, name: '미분류', count: uncategorized },
        ...folderList.map(folder => ({ ...folder, count: counts.get(folder.id) })),
    ];
    const navigation = document.createDocumentFragment();
    for (const view of views) {
        const item = button('', 'folder', 'prompt-box-folder');
        item.dataset.folderId = view.id;
        item.setAttribute('aria-current', String(view.id === folderId));
        item.title = view.name;
        item.append(element('span', 'prompt-box-folder-label', view.name), element('span', 'prompt-box-count', String(view.count)));
        navigation.append(item);
    }
    panel.querySelector('#prompt-box-folders').replaceChildren(navigation);
    panel.querySelector('#prompt-box-folder-name').textContent = views.find(view => view.id === folderId)?.name || '전체';
    panel.querySelector('#prompt-box-organize').textContent = organizing ? '완료' : '정리';
    panel.querySelector('#prompt-box-organize').setAttribute('aria-pressed', String(organizing));
    panel.querySelector('#prompt-box-bulk').hidden = !organizing;
    const folderIndex = folderList.findIndex(folder => folder.id === folderId);
    panel.querySelector('#prompt-box-folder-tools').hidden = !organizing || folderIndex < 0;
    panel.querySelector('[data-action="folder-up"]').disabled = folderIndex <= 0;
    panel.querySelector('[data-action="folder-down"]').disabled = folderIndex < 0 || folderIndex === folderList.length - 1;
    panel.querySelector('#prompt-box-hint').textContent = organizing ? '분류를 바꿔도 현재 프리셋은 유지됩니다.' : '이름을 누르면 불러옵니다.';
    renderRows(active, favoriteNames);
    syncMoveTarget();
    renderBulk();
}

function applyTheme() {
    if (!panel) return;
    const dark = getState().theme === 'dark';
    panel.dataset.theme = dark ? 'dark' : 'light';
    const toggle = panel.querySelector('#prompt-box-theme');
    const title = dark ? '라이트 모드로 전환' : '다크 모드로 전환';
    toggle.title = title;
    toggle.setAttribute('aria-label', title);
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.firstElementChild.className = `fa-solid ${dark ? 'fa-sun' : 'fa-moon'}`;
}

function renderRows(active, favoriteNames) {
    const matching = filteredCatalog();
    const shown = matching.slice(0, limit);
    const focused = document.activeElement;
    const focusName = focused?.dataset.favoriteName;
    const list = panel.querySelector('#prompt-box-list');
    const fragment = document.createDocumentFragment();
    const state = getState();
    const folderNames = new Map(folders().map(folder => [folder.id, folder.name]));
    for (const item of shown) {
        const row = element('div', 'prompt-box-row');
        row.classList.toggle('prompt-box-current-row', item.name === active);
        let entry;
        if (organizing) {
            entry = element('label', 'prompt-box-choice');
            const checkbox = element('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.selectName = item.name;
            checkbox.checked = selectedNames.has(item.name);
            entry.append(checkbox);
        } else {
            entry = button('', 'load', 'prompt-box-load');
            entry.dataset.name = item.name;
            if (item.name === active) entry.setAttribute('aria-current', 'true');
            entry.disabled = loading;
        }
        const copy = element('span', 'prompt-box-row-copy');
        const title = element('span', 'prompt-box-row-name', item.name);
        title.title = item.name;
        const assigned = Object.hasOwn(state.assignments, item.name) ? state.assignments[item.name] : null;
        const details = [folderNames.get(assigned) || '미분류'];
        if (item.name === active) details.push('사용 중');
        copy.append(title, element('span', 'prompt-box-row-meta', details.join(' · ')));
        entry.append(copy);
        const favorite = iconButton('fa-star', favoriteNames.has(item.name) ? '즐겨찾기 해제' : '즐겨찾기 추가', 'favorite');
        favorite.dataset.favoriteName = item.name;
        favorite.setAttribute('aria-label', `${item.name} ${favorite.title}`);
        favorite.setAttribute('aria-pressed', String(favoriteNames.has(item.name)));
        row.append(entry, favorite);
        fragment.append(row);
    }
    if (!matching.length) fragment.append(element('div', 'prompt-box-empty', panel.querySelector('#prompt-box-search').value ? '검색 결과가 없습니다. 폴더를 바꾸거나 다른 이름으로 검색해 보세요.' : folderId === FAVORITES ? '별을 눌러 자주 쓰는 프리셋을 모아보세요.' : '이 폴더에는 프리셋이 없습니다. 정리에서 프리셋을 옮길 수 있어요.'));
    list.replaceChildren(fragment);
    panel.querySelector('#prompt-box-result-count').textContent = `${matching.length}개`;
    const more = panel.querySelector('#prompt-box-more');
    more.hidden = matching.length <= shown.length;
    more.textContent = `더 보기 · ${shown.length} / ${matching.length}`;
    if (focusName !== undefined) Array.from(list.querySelectorAll('[data-favorite-name]')).find(node => node.dataset.favoriteName === focusName)?.focus({ preventScroll: true });
}

function renderBulk() {
    panel.querySelector('#prompt-box-selected-count').textContent = `${selectedNames.size}개 선택`;
    panel.querySelector('#prompt-box-move').disabled = !selectedNames.size;
    panel.querySelector('[data-action="clear-selection"]').disabled = !selectedNames.size;
}

function syncMoveTarget() {
    const name = folders().find(folder => folder.id === moveTarget)?.name;
    if (!name) moveTarget = NONE;
    const trigger = panel.querySelector('#prompt-box-move-target');
    trigger.firstElementChild.textContent = name || '미분류';
    trigger.setAttribute('aria-label', `이동할 폴더: ${name || '미분류'}`);
    trigger.title = name || '미분류';
}

function closeMoveMenu(restoreFocus = false) {
    if (!moveMenu) return;
    moveMenu.remove();
    moveMenu = null;
    const trigger = panel.querySelector('#prompt-box-move-target');
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
}

function positionMoveMenu() {
    if (!moveMenu) return;
    const trigger = panel.querySelector('#prompt-box-move-target').getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    moveMenu.style.setProperty('max-height', `${Math.max(0, Math.min(260, trigger.top - bounds.top - 14))}px`, 'important');
}

function openMoveMenu() {
    if (moveMenu || !organizing) return;
    syncMoveTarget();
    const trigger = panel.querySelector('#prompt-box-move-target');
    moveMenu = element('div', 'prompt-box-dropdown-menu');
    moveMenu.id = 'prompt-box-move-menu';
    moveMenu.setAttribute('role', 'listbox');
    moveMenu.setAttribute('aria-label', '이동할 폴더');
    const options = [{ id: NONE, name: '미분류' }, ...folders()];
    for (const option of options) {
        const row = button('', 'choose-target', 'prompt-box-dropdown-option');
        row.dataset.targetId = option.id;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(option.id === moveTarget));
        row.tabIndex = -1;
        row.title = option.name;
        const check = element('i', 'fa-solid fa-check');
        check.setAttribute('aria-hidden', 'true');
        row.append(element('span', '', option.name), check);
        moveMenu.append(row);
    }
    moveMenu.addEventListener('keydown', event => {
        const rows = Array.from(moveMenu.children);
        const index = rows.indexOf(document.activeElement);
        let next;
        if (event.key === 'ArrowDown') next = (index + 1) % rows.length;
        else if (event.key === 'ArrowUp') next = (index - 1 + rows.length) % rows.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = rows.length - 1;
        else if (event.key === 'Tab') closeMoveMenu(true);
        if (next !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            rows[next].focus({ preventScroll: true });
            rows[next].scrollIntoView({ block: 'nearest' });
        }
    });
    trigger.parentElement.append(moveMenu);
    trigger.setAttribute('aria-expanded', 'true');
    positionMoveMenu();
    const selected = moveMenu.querySelector('[aria-selected="true"]');
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: 'nearest' });
}

function hideFolderEditor() {
    folderEditId = null;
    panel.querySelector('#prompt-box-folder-editor').hidden = true;
    panel.querySelector('#prompt-box-delete-confirm').hidden = true;
}

function editFolder(id) {
    hideFolderEditor();
    folderEditId = id;
    panel.querySelector('#prompt-box-editor-label').textContent = id ? '폴더 이름 수정' : '새 폴더';
    const input = panel.querySelector('#prompt-box-folder-name-input');
    input.value = folders().find(folder => folder.id === id)?.name || '';
    input.setCustomValidity('');
    panel.querySelector('#prompt-box-folder-editor').hidden = false;
    input.focus();
    input.select();
}

function saveFolder(event) {
    event.preventDefault();
    const input = panel.querySelector('#prompt-box-folder-name-input');
    const name = input.value.trim();
    if (!name || folders().some(folder => folder.id !== folderEditId && normalized(folder.name) === normalized(name))) {
        input.setCustomValidity(name ? '같은 이름의 폴더가 있습니다.' : '폴더 이름을 입력하세요.');
        input.reportValidity();
        return;
    }
    const state = getState();
    if (folderEditId) {
        const folder = state.folders.find(folder => folder.id === folderEditId);
        if (!folder) return;
        if (folder.name === name) {
            hideFolderEditor();
            return;
        }
        folder.name = name;
    } else {
        const folder = { id: globalThis.crypto?.randomUUID?.() || `folder_${Date.now()}_${Math.random().toString(36).slice(2)}`, name };
        state.folders.push(folder);
        folderId = folder.id;
    }
    hideFolderEditor();
    saveState();
}

function moveSelected() {
    const target = moveTarget;
    if (target !== NONE && !folders().some(folder => folder.id === target)) return;
    const state = getState();
    const names = new Set(getCatalog().map(item => item.name));
    let changed = 0;
    for (const name of selectedNames) {
        if (!names.has(name)) continue;
        if (target === NONE) {
            if (!Object.hasOwn(state.assignments, name)) continue;
            delete state.assignments[name];
        } else {
            if (Object.hasOwn(state.assignments, name) && state.assignments[name] === target) continue;
            Object.defineProperty(state.assignments, name, { value: target, enumerable: true, configurable: true, writable: true });
        }
        changed++;
    }
    selectedNames.clear();
    panel.querySelector('#prompt-box-status').textContent = changed ? `${changed}개 이동했습니다.` : '분류가 이미 같습니다.';
    if (changed) saveState();
    else scheduleRender();
}

async function loadPreset(name) {
    if (loading) return;
    const item = getCatalog().find(item => item.name === name);
    if (!item) return;
    if (name === currentName()) {
        if (!isDesktop()) closePanel();
        return;
    }
    const manager = getPresetManager('openai');
    if (!manager) {
        panel.querySelector('#prompt-box-status').textContent = '프리셋을 불러올 준비가 되지 않았습니다.';
        return;
    }
    loading = true;
    scheduleRender();
    try {
        await manager.selectPreset(item.value);
        if (!isDesktop()) closePanel();
        else panel.querySelector('#prompt-box-status').textContent = '프리셋을 불러왔습니다.';
    } catch (error) {
        panel.querySelector('#prompt-box-status').textContent = '불러오지 못했습니다. 다시 시도해 주세요.';
        console.error('[prompt-box] Failed to load preset', error);
    } finally {
        loading = false;
        scheduleRender();
    }
}

function handleClick(event) {
    const control = event.target.closest('[data-action]');
    if (!control || !panel.contains(control)) return;
    const state = getState();
    const action = control.dataset.action;
    if (action === 'close') closePanel();
    else if (action === 'toggle-target') {
        if (moveMenu) closeMoveMenu();
        else openMoveMenu();
    } else if (action === 'choose-target') {
        moveTarget = control.dataset.targetId;
        syncMoveTarget();
        closeMoveMenu(true);
    }
    else if (action === 'theme') {
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        applyTheme();
        saveSettingsDebounced();
    }
    else if (action === 'organize') {
        organizing = !organizing;
        selectedNames.clear();
        hideFolderEditor();
        scheduleRender();
    } else if (action === 'folder') {
        folderId = control.dataset.folderId;
        limit = PAGE_SIZE;
        hideFolderEditor();
        panel.querySelector('.prompt-box-content').scrollTop = 0;
        scheduleRender();
    } else if (action === 'favorite') {
        const name = control.dataset.favoriteName;
        state.favorites = state.favorites.includes(name) ? state.favorites.filter(item => item !== name) : [...state.favorites, name];
        saveState();
    } else if (action === 'load') void loadPreset(control.dataset.name);
    else if (action === 'more') {
        limit += PAGE_SIZE;
        scheduleRender();
    } else if (action === 'new-folder') {
        organizing = true;
        render();
        editFolder(null);
    }
    else if (action === 'rename-folder') editFolder(folderId);
    else if (action === 'cancel-folder' || action === 'cancel-delete') hideFolderEditor();
    else if (action === 'delete-folder') {
        hideFolderEditor();
        panel.querySelector('#prompt-box-delete-confirm').hidden = false;
    } else if (action === 'confirm-delete') {
        state.folders = state.folders.filter(folder => folder.id !== folderId);
        for (const name of Object.keys(state.assignments)) if (state.assignments[name] === folderId) delete state.assignments[name];
        folderId = NONE;
        hideFolderEditor();
        saveState();
    } else if (action === 'folder-up' || action === 'folder-down') {
        const index = state.folders.findIndex(folder => folder.id === folderId);
        const next = index + (action === 'folder-up' ? -1 : 1);
        if (index < 0 || next < 0 || next >= state.folders.length) return;
        [state.folders[index], state.folders[next]] = [state.folders[next], state.folders[index]];
        saveState();
    } else if (action === 'select-results') {
        filteredCatalog().forEach(item => selectedNames.add(item.name));
        scheduleRender();
    } else if (action === 'clear-selection') {
        selectedNames.clear();
        scheduleRender();
    } else if (action === 'move') moveSelected();
}

function positionPanel() {
    if (!isOpen() || !launcher?.isConnected) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    const mobile = !isDesktop();
    backdrop.hidden = mobile;
    panel.setAttribute('aria-modal', String(!mobile));
    if (!mobile) {
        backdrop.style.setProperty('width', `${width}px`, 'important');
        backdrop.style.setProperty('height', `${height}px`, 'important');
        backdrop.style.setProperty('left', '0px', 'important');
        backdrop.style.setProperty('top', '0px', 'important');
        const backgroundRect = backdrop.getBoundingClientRect();
        backdrop.style.setProperty('left', `${left - backgroundRect.left}px`, 'important');
        backdrop.style.setProperty('top', `${top - backgroundRect.top}px`, 'important');
    }
    panel.style.setProperty('max-height', `${height - (mobile ? 0 : 32)}px`, 'important');
    panel.style.setProperty('height', `${mobile ? height : Math.min(720, height - 32)}px`, 'important');
    panel.style.setProperty('width', `${mobile ? width : Math.min(1000, width - 32)}px`, 'important');
    panel.style.setProperty('left', '0px', 'important');
    panel.style.setProperty('top', '0px', 'important');
    const rect = panel.getBoundingClientRect();
    panel.style.setProperty('left', `${left + (width - rect.width) / 2 - rect.left}px`, 'important');
    panel.style.setProperty('top', `${top + (height - rect.height) / 2 - rect.top}px`, 'important');
    positionMoveMenu();
}

function handleOutside(event) {
    if (moveMenu && !panel.querySelector('.prompt-box-dropdown').contains(event.target)) closeMoveMenu();
    if (!isDesktop() && !panel.contains(event.target) && !launcher.contains(event.target)) closePanel(false);
}

function handleEscape(event) {
    if (event.key === 'Tab' && isDesktop() && !moveMenu) {
        const controls = Array.from(panel.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]'))
            .filter(node => node.getClientRects().length);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (first && (!panel.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last))) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        }
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (moveMenu) closeMoveMenu(true);
    else if (!isDesktop()) closePanel();
}

function openPanel() {
    mount();
    if (!panel) createPanel();
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    panel.querySelector('#prompt-box-status').textContent = '';
    render();
    positionPanel();
    if (!window.matchMedia('(max-width: 600px)').matches) panel.querySelector('#prompt-box-search').focus({ preventScroll: true });
    else panel.querySelector('[data-action="close"]').focus({ preventScroll: true });
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('keydown', handleEscape, true);
    window.addEventListener('resize', positionPanel);
    window.addEventListener('scroll', positionPanel, { passive: true });
    window.visualViewport?.addEventListener('resize', positionPanel);
    window.visualViewport?.addEventListener('scroll', positionPanel);
}

function closePanel(restoreFocus = true) {
    if (!panel) return;
    closeMoveMenu();
    panel.hidden = true;
    backdrop.hidden = true;
    launcher?.setAttribute('aria-expanded', 'false');
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    organizing = false;
    selectedNames.clear();
    hideFolderEditor();
    document.removeEventListener('pointerdown', handleOutside);
    document.removeEventListener('keydown', handleEscape, true);
    window.removeEventListener('resize', positionPanel);
    window.removeEventListener('scroll', positionPanel);
    window.visualViewport?.removeEventListener('resize', positionPanel);
    window.visualViewport?.removeEventListener('scroll', positionPanel);
    if (restoreFocus && launcher?.isConnected) launcher.focus({ preventScroll: true });
}

function mount() {
    const select = document.getElementById('settings_preset_openai');
    if (!select?.parentElement) return false;
    if (presetSelect !== select) {
        presetSelect?.removeEventListener('change', scheduleRender);
        presetSelect?.removeEventListener('blur', queueNativeSync);
        selectObserver?.disconnect();
        presetSelect = select;
        catalogDirty = true;
        selectObserver = new MutationObserver(invalidateCatalog);
        observePresetSelect();
        select.addEventListener('change', scheduleRender);
        select.addEventListener('blur', queueNativeSync);
        queueNativeSync();
    }
    if (!launcher) {
        launcher = element('div', 'menu_button menu_button_icon');
        launcher.title = '프롬 정리함';
        launcher.setAttribute('aria-label', '프롬 정리함');
        launcher.setAttribute('role', 'button');
        launcher.tabIndex = 0;
        const icon = element('i', 'fa-fw fa-solid fa-folder-open');
        icon.setAttribute('aria-hidden', 'true');
        launcher.append(icon);
        launcher.id = 'prompt-box-button';
        launcher.setAttribute('aria-haspopup', 'dialog');
        launcher.setAttribute('aria-controls', 'prompt-box');
        launcher.setAttribute('aria-expanded', 'false');
        launcher.addEventListener('click', () => {
            if (!isOpen()) openPanel();
            else if (!isDesktop()) closePanel();
            else panel.querySelector('[data-action="close"]').focus({ preventScroll: true });
        });
        launcher.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            launcher.click();
        });
    }
    const saveButton = document.getElementById('update_oai_preset');
    if (saveButton?.parentElement) {
        if (launcher.nextElementSibling !== saveButton) saveButton.before(launcher);
    } else if (launcher.parentElement !== select.parentElement) select.after(launcher);
    const parent = document.getElementById('openai_api-presets') || select.parentElement;
    if (observedParent !== parent) {
        placementObserver?.disconnect();
        observedParent = parent;
        placementObserver = new MutationObserver(() => {
            if (!presetSelect?.isConnected || !launcher?.isConnected) {
                mount();
                scheduleRender();
            }
        });
        placementObserver.observe(parent, { childList: true, subtree: true });
    }
    return true;
}

function initialize() {
    if (initialized) return;
    initialized = true;
    getState();
    const on = (type, callback) => { if (type) eventSource.on(type, callback); };
    on(event_types.OAI_PRESET_CHANGED_AFTER, () => { mount(); scheduleRender(); });
    on(event_types.APP_READY, mount);
    on(event_types.SETTINGS_UPDATED, () => { mount(); queueNativeSync(); scheduleRender(); });
    on(event_types.PRESET_RENAMED, ({ apiId, oldName, newName }) => {
        if (apiId !== 'openai') return;
        const state = getState();
        let changed = false;
        if (Object.hasOwn(state.assignments, oldName)) {
            Object.defineProperty(state.assignments, newName, { value: state.assignments[oldName], enumerable: true, writable: true, configurable: true });
            delete state.assignments[oldName];
            changed = true;
        }
        if (state.favorites.includes(oldName)) {
            state.favorites = [...new Set(state.favorites.map(name => name === oldName ? newName : name))];
            changed = true;
        }
        if (selectedNames.delete(oldName)) selectedNames.add(newName);
        invalidateCatalog();
        if (changed) saveState();
    });
    on(event_types.PRESET_DELETED, ({ apiId, name }) => {
        if (apiId !== 'openai') return;
        const state = getState();
        const changed = Object.hasOwn(state.assignments, name) || state.favorites.includes(name);
        delete state.assignments[name];
        state.favorites = state.favorites.filter(item => item !== name);
        selectedNames.delete(name);
        invalidateCatalog();
        if (changed) saveState();
    });
    if (!mount()) {
        bootObserver = new MutationObserver(() => {
            if (mount()) {
                bootObserver.disconnect();
                bootObserver = null;
            }
        });
        bootObserver.observe(document.body, { childList: true, subtree: true });
    }
}

if (!globalThis['prompt-box-loaded']) {
    globalThis['prompt-box-loaded'] = true;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
}
