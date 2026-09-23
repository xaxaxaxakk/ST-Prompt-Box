import {extension_settings} from "/scripts/extensions.js";
import {saveSettingsDebounced, eventSource, event_types} from "/script.js";
import {getPresetManager} from "/scripts/preset-manager.js";

const KEY = "prompt-box";
const ALL = "__all__";
const NONE = "__uncategorized__";
const FAVORITES = "__favorites__";
const PAGE_SIZE = 20;
const LONG_PRESS_MS = 450;
const SHEET_GAP = 24;
const FOLDER_COLORS = [
    ["#e05d5d", "빨강"],
    ["#e8893c", "주황"],
    ["#d4a82a", "노랑"],
    ["#58a55c", "초록"],
    ["#2f9e99", "청록"],
    ["#4f86d9", "파랑"],
    ["#8a68d4", "보라"],
    ["#d45d9c", "분홍"],
];
const FAVORITE_COLOR = "#d4a82a";
const COLOR_VALUES = new Set(FOLDER_COLORS.map(([value]) => value));
const presetOrder = new Intl.Collator(undefined, {numeric: true, sensitivity: "base"});
const selectedNames = new Set();
let nativeSyncPending = false;
let catalog = [];
let catalogDirty = true;
let folderId = ALL;
let currentPage = 1;
let pageCount = 1;
let organizing = false;
let selectMode = false;
let panel;
let backdrop;
let launcher;
let presetSelect;
let selectObserver;
let placementObserver;
let observedParent;
let bootObserver;
let renderFrame = 0;
let positionFrame = 0;
let positionTimer = 0;
let fullRenderPending = false;
let renderedTree;
let scrollResetPending = false;
let searchQuery = "";
let settingsSnapshot;
let loading = false;
let loadingName = "";
let folderEditId = null;
let editColor = "";
let initialized = false;
let moveMenu;
let menuKind = "move";
let parentTarget = "";
let historyEntry = false;
let longPress = null;
let suppressClick = false;
let lastPointerType = "";
let reorder = null;
let deleting = false;

function getState() {
    let state = extension_settings[KEY];
    if (!state || typeof state !== "object" || Array.isArray(state)) {
        state = extension_settings[KEY] = {};
    }
    if (!Array.isArray(state.folders)) state.folders = [];
    if (!state.assignments || typeof state.assignments !== "object" || Array.isArray(state.assignments)) state.assignments = {};
    if (!Array.isArray(state.favorites)) state.favorites = [];
    if (!Array.isArray(state.collapsed)) state.collapsed = [];
    if (state.theme !== "dark" && state.theme !== "light") state.theme = "light";
    return state;
}

function folders() {
    return getState().folders.filter((folder) => folder && typeof folder.id === "string" && typeof folder.name === "string");
}

function colorOf(folder) {
    return COLOR_VALUES.has(folder?.color) ? folder.color : "";
}

function folderTree() {
    const byId = new Map(folders().map((folder) => [folder.id, folder]));
    const parents = new Map();
    const children = new Map([["", []], ...Array.from(byId.keys(), (id) => [id, []])]);
    for (const folder of byId.values()) {
        const seen = new Set([folder.id]);
        let parent = folder.parentId;
        while (parent && byId.has(parent) && !seen.has(parent)) {
            seen.add(parent);
            parent = byId.get(parent).parentId;
        }
        const resolved =
            parent && seen.has(parent) ? ""
            : byId.has(folder.parentId) ? folder.parentId
            : "";
        parents.set(folder.id, resolved);
        children.get(resolved).push(folder);
    }
    const ordered = [];
    const parts = new Map();
    const paths = new Map();
    const depths = new Map();
    const roots = new Map();
    const visit = (parent, path, depth, root) => {
        for (const folder of children.get(parent)) {
            const nextPath = [...path, folder.name];
            ordered.push(folder);
            parts.set(folder.id, nextPath);
            paths.set(folder.id, nextPath.join(" › "));
            depths.set(folder.id, depth);
            roots.set(folder.id, root || folder.id);
            visit(folder.id, nextPath, depth + 1, root || folder.id);
        }
    };
    visit("", [], 0, "");
    return {byId, parents, children, ordered, parts, paths, depths, roots};
}

function folderColor(id, tree) {
    return colorOf(tree.byId.get(tree.roots.get(id)));
}

function applyColor(node, color) {
    if (color) node.style.setProperty("--prompt-box-folder", color, "important");
}

function folderScope(id, tree = folderTree()) {
    const ids = new Set();
    const pending = tree.byId.has(id) ? [id] : [];
    while (pending.length) {
        const current = pending.pop();
        if (ids.has(current)) continue;
        ids.add(current);
        pending.push(...tree.children.get(current).map((folder) => folder.id));
    }
    return ids;
}

function placeSiblings(ids) {
    const state = getState();
    const members = new Set(ids);
    const byId = new Map(state.folders.filter((folder) => members.has(folder?.id)).map((folder) => [folder.id, folder]));
    const queue = ids.map((id) => byId.get(id));
    state.folders = state.folders.map((folder) => (members.has(folder?.id) ? queue.shift() : folder));
    saveState();
}

function captureSettings() {
    const state = getState();
    return {
        groups: JSON.stringify([state.folders, state.assignments, state.favorites]),
        view: JSON.stringify([state.collapsed, state.theme]),
    };
}

function savePromptSettings() {
    settingsSnapshot = captureSettings();
    saveSettingsDebounced();
}

function handleSettingsUpdated() {
    const previousSelect = presetSelect;
    mount();
    const next = captureSettings();
    const groupsChanged = next.groups !== settingsSnapshot?.groups;
    const viewChanged = next.view !== settingsSnapshot?.view;
    settingsSnapshot = next;
    if (groupsChanged) queueNativeSync();
    if (groupsChanged || viewChanged || presetSelect !== previousSelect) scheduleRender();
}

function saveState() {
    savePromptSettings();
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
    selectObserver.observe(presetSelect, {childList: true, subtree: true, characterData: true});
}

function syncNativeGroups() {
    if (!presetSelect?.isConnected) return;
    const state = getState();
    const tree = folderTree();
    const favorites = new Set(state.favorites);
    const favoriteGroup = {name: "★ 즐겨찾기", color: FAVORITE_COLOR, options: []};
    const groups = new Map(tree.ordered.map((folder) => [folder.id, {name: tree.paths.get(folder.id), color: folderColor(folder.id, tree), options: []}]));
    groups.set(NONE, {name: "미분류", color: "", options: []});
    for (const option of presetSelect.options) {
        const name = option.textContent.trim();
        if (favorites.has(name)) {
            favoriteGroup.options.push(option);
            continue;
        }
        const assigned = Object.hasOwn(state.assignments, name) ? state.assignments[name] : NONE;
        (groups.get(assigned) || groups.get(NONE)).options.push(option);
    }
    const desired = [favoriteGroup, ...groups.values()].filter((group) => group.options.length);
    for (const group of desired) group.options.sort((a, b) => presetOrder.compare(a.textContent, b.textContent));
    const existing = Array.from(presetSelect.children);
    const sameStructure =
        existing.length === desired.length &&
        desired.every((group, index) => {
            const node = existing[index];
            return node.tagName === "OPTGROUP" && node.label === group.name && node.children.length === group.options.length && group.options.every((option, i) => node.children[i] === option);
        });
    const selected = presetSelect.selectedOptions[0];
    selectObserver.disconnect();
    try {
        for (const group of desired) {
            for (const option of group.options) {
                if (option.hasAttribute("label")) option.removeAttribute("label");
            }
        }
        if (!sameStructure) {
            const fragment = document.createDocumentFragment();
            for (const group of desired) {
                const node = document.createElement("optgroup");
                node.label = group.name;
                node.append(...group.options);
                fragment.append(node);
            }
            presetSelect.replaceChildren(fragment);
            if (selected) selected.selected = true;
            else presetSelect.selectedIndex = -1;
            catalogDirty = true;
        }
        desired.forEach((group, index) => {
            const node = presetSelect.children[index];
            if (group.color) node.style.setProperty("color", group.color);
            else node.style.removeProperty("color");
        });
    } finally {
        observePresetSelect();
    }
}

function isOpen() {
    return panel && !panel.hidden;
}

function isDesktop() {
    return window.matchMedia("(min-width: 601px)").matches;
}

function editorOpen() {
    return !!panel && !panel.querySelector("#prompt-box-folder-editor").hidden;
}

function deleteDialogOpen() {
    return !!panel && !panel.querySelector("#prompt-box-delete-dialog").hidden;
}

function currentName() {
    return presetSelect?.selectedOptions[0]?.textContent?.trim() || "";
}

function normalized(text) {
    return text.normalize("NFKC").toLocaleLowerCase();
}

function getCatalog() {
    if (catalogDirty) {
        catalog = Array.from(presetSelect?.options || [], (option) => ({
            name: option.textContent.trim(),
            value: option.value,
            search: normalized(option.textContent.trim()),
        })).filter((item) => item.name);
        catalogDirty = false;
        const names = new Set(catalog.map((item) => item.name));
        for (const name of selectedNames) if (!names.has(name)) selectedNames.delete(name);
    }
    return catalog;
}

function scheduleRender(scope = "all") {
    if (!isOpen()) return;
    if (scope !== "rows") fullRenderPending = true;
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
        renderFrame = 0;
        const full = fullRenderPending;
        fullRenderPending = false;
        if (!isOpen()) return;
        if (full || !renderedTree) render();
        else {
            renderRows(currentName(), new Set(getState().favorites), renderedTree);
            renderBulk();
        }
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

function glyph(icon) {
    const node = element("i", `fa-solid ${icon}`);
    node.setAttribute("aria-hidden", "true");
    return node;
}

function button(text, action, className = "") {
    const node = element("button", className, text);
    node.type = "button";
    node.dataset.action = action;
    return node;
}

function iconButton(icon, title, action) {
    const node = button("", action, "prompt-box-icon");
    node.append(glyph(icon));
    node.title = title;
    node.setAttribute("aria-label", title);
    return node;
}

function createPanel() {
    backdrop = element("div");
    backdrop.id = "prompt-box-backdrop";
    backdrop.hidden = true;
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.addEventListener("click", () => {
        if (!isDesktop()) closePanel(false);
    });
    panel = element("section", "", undefined);
    panel.id = "prompt-box";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "prompt-box-title");
    panel.innerHTML = `
        <header class="prompt-box-header">
            <span class="prompt-box-mark"><i class="fa-solid fa-folder-open" aria-hidden="true"></i></span>
            <div class="prompt-box-heading"><strong id="prompt-box-title">프롬 정리함</strong><span id="prompt-box-current"></span></div>
            <button type="button" data-action="theme" id="prompt-box-theme" class="prompt-box-icon" aria-label="다크 모드로 전환"><i class="fa-solid fa-moon" aria-hidden="true"></i></button>
            <button type="button" data-action="organize" id="prompt-box-organize" class="prompt-box-icon" aria-pressed="false" aria-label="폴더 관리" title="폴더 관리"><i class="fa-solid fa-gear" aria-hidden="true"></i></button>
            <button type="button" data-action="close" class="prompt-box-icon" aria-label="프롬 정리함 닫기"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </header>
        <form class="prompt-box-search" role="search"><input id="prompt-box-search" type="search" autocomplete="off" enterkeyhint="search" placeholder="이 폴더에서 이름 검색" aria-label="프리셋 이름 검색"><button type="submit" class="prompt-box-search-submit" aria-label="검색" title="검색"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i></button></form>
        <nav id="prompt-box-chips" aria-label="프리셋 폴더"></nav>
        <div class="prompt-box-workspace">
            <aside class="prompt-box-sidebar" id="prompt-box-sidebar">
                <div class="prompt-box-sidebar-header"><div><strong>폴더 관리</strong><span>폴더를 누르면 이름·상위폴더·색상을 바꿀 수 있습니다. ⋮을 끌면 순서가 바뀝니다.</span></div><button type="button" data-action="organize" class="prompt-box-icon" aria-label="폴더 관리 끝내기" title="완료"><i class="fa-solid fa-check" aria-hidden="true"></i></button></div>
                <nav id="prompt-box-folders" aria-label="프리셋 폴더"></nav>
                <button type="button" data-action="new-folder" id="prompt-box-new-folder" hidden><i class="fa-solid fa-plus" aria-hidden="true"></i><span>새 폴더</span></button>
            </aside>
            <main class="prompt-box-content">
                <div class="prompt-box-list-header"><strong id="prompt-box-folder-name"></strong><span id="prompt-box-result-count"></span><button type="button" data-action="select" id="prompt-box-select" class="prompt-box-icon" title="여러 개 골라서 이동·삭제" aria-label="여러 개 골라서 이동·삭제"><i class="fa-solid fa-list-check" aria-hidden="true"></i></button></div>
                <div id="prompt-box-list" aria-label="프리셋 목록"></div>
                <nav id="prompt-box-pagination" aria-label="프리셋 페이지">
                    <button type="button" data-action="previous-page" aria-label="이전 페이지"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>
                    <span id="prompt-box-page-numbers"></span>
                    <button type="button" data-action="next-page" aria-label="다음 페이지"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>
                </nav>
            </main>
        </div>
        <form id="prompt-box-folder-editor" aria-labelledby="prompt-box-editor-label" hidden>
            <strong id="prompt-box-editor-label">새 폴더</strong>
            <label for="prompt-box-folder-name-input" class="prompt-box-field-label">폴더 이름</label>
            <input id="prompt-box-folder-name-input" maxlength="80" required autocomplete="off">
            <label for="prompt-box-parent-target" class="prompt-box-field-label">상위폴더</label>
            <div class="prompt-box-dropdown"><button type="button" id="prompt-box-parent-target" data-action="toggle-parent" aria-label="상위폴더" aria-haspopup="listbox" aria-controls="prompt-box-parent-menu" aria-expanded="false"><span>최상위</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button></div>
            <div id="prompt-box-color-field"><span class="prompt-box-field-label" id="prompt-box-color-label">색상</span><div id="prompt-box-colors" role="radiogroup" aria-labelledby="prompt-box-color-label"></div></div>
            <div class="prompt-box-editor-actions"><button type="button" data-action="delete-folder" id="prompt-box-delete-folder" class="prompt-box-danger">삭제</button><button type="button" data-action="cancel-folder">취소</button><button type="submit" class="prompt-box-primary">저장</button></div>
            <div id="prompt-box-delete-confirm" hidden><span>이 폴더와 하위폴더를 삭제합니다. 안의 프리셋은 모두 미분류로 옮겨집니다.</span><div class="prompt-box-inline"><button type="button" data-action="confirm-delete" class="prompt-box-danger">폴더 삭제</button><button type="button" data-action="cancel-delete">취소</button></div></div>
        </form>
        <div id="prompt-box-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="prompt-box-delete-title" aria-describedby="prompt-box-delete-message" hidden>
            <strong id="prompt-box-delete-title">정말 삭제하겠습니까?</strong>
            <p id="prompt-box-delete-message"></p>
            <ul id="prompt-box-delete-names"></ul>
            <p id="prompt-box-delete-note" hidden></p>
            <div class="prompt-box-editor-actions"><button type="button" data-action="cancel-delete-presets">취소</button><button type="button" data-action="confirm-delete-presets" id="prompt-box-confirm-delete-presets" class="prompt-box-danger-primary">삭제</button></div>
        </div>
        <div id="prompt-box-bulk" hidden><span id="prompt-box-selected-count"></span><button type="button" data-action="select-results"><i class="fa-solid fa-check-double"></i></button><button type="button" data-action="clear-selection"><i class="fa-solid fa-stop"></i></button><button type="button" data-action="delete-presets" id="prompt-box-delete-presets" class="prompt-box-danger"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button><button type="button" data-action="toggle-target" id="prompt-box-move" class="prompt-box-primary" aria-haspopup="listbox" aria-controls="prompt-box-move-menu" aria-expanded="false"><i class="fa-solid fa-truck-moving"></i></button></div>
        <footer><span id="prompt-box-hint"></span><span id="prompt-box-status" role="status" aria-live="polite"></span></footer>`;
    const swatches = panel.querySelector("#prompt-box-colors");
    for (const [value, name] of [["", "없음"], ...FOLDER_COLORS]) {
        const swatch = button("", "choose-color", "prompt-box-swatch");
        swatch.dataset.color = value;
        swatch.setAttribute("role", "radio");
        swatch.title = name;
        swatch.setAttribute("aria-label", name);
        if (value) applyColor(swatch, value);
        else swatch.append(glyph("fa-ban"));
        swatches.append(swatch);
    }
    panel.addEventListener(
        "pointerdown",
        () => {
            suppressClick = false;
        },
        true,
    );
    panel.addEventListener(
        "click",
        (event) => {
            if (!suppressClick) return;
            suppressClick = false;
            event.preventDefault();
            event.stopPropagation();
        },
        true,
    );
    panel.addEventListener("click", handleClick);
    panel.addEventListener("change", (event) => {
        const name = event.target.dataset.selectName;
        if (name === undefined) return;
        if (event.target.checked) selectedNames.add(name);
        else selectedNames.delete(name);
        renderBulk();
    });
    const search = panel.querySelector("#prompt-box-search");
    panel.querySelector(".prompt-box-search").addEventListener("submit", (event) => {
        event.preventDefault();
        runSearch();
        if (!isDesktop()) search.blur();
    });
    search.addEventListener("input", () => {
        if (!search.value.trim() && searchQuery) runSearch();
    });
    panel.querySelector("#prompt-box-folder-editor").addEventListener("submit", saveFolder);
    panel.querySelector("#prompt-box-folder-name-input").addEventListener("input", (event) => event.target.setCustomValidity(""));
    panel.querySelector("#prompt-box-parent-target").addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        event.stopPropagation();
        openMoveMenu("parent");
    });
    panel.querySelector(".prompt-box-content").addEventListener("scroll", cancelLongPress, {passive: true});
    const list = panel.querySelector("#prompt-box-list");
    list.addEventListener("pointerdown", startLongPress);
    list.addEventListener("contextmenu", (event) => {
        if (lastPointerType === "touch" && event.target.closest(".prompt-box-row")) event.preventDefault();
    });
    panel.querySelector("#prompt-box-folders").addEventListener("pointerdown", startReorder);
    panel.addEventListener("keydown", (event) => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        const controls = Array.from(panel.querySelectorAll('#prompt-box-list .prompt-box-load, #prompt-box-list input[type="checkbox"]'));
        const index = controls.indexOf(document.activeElement);
        if (document.activeElement.id !== "prompt-box-search" && index < 0) return;
        if (!controls.length) return;
        event.preventDefault();
        controls[(index + (event.key === "ArrowDown" ? 1 : controls.length - 1) + controls.length) % controls.length].focus();
    });
    for (const surface of [panel, backdrop]) {
        for (const type of ["touchstart", "mousedown"]) {
            surface.addEventListener(
                type,
                (event) => {
                    event.stopPropagation();
                },
                {passive: true},
            );
        }
    }
    document.body.append(backdrop, panel);
}

function runSearch() {
    searchQuery = panel.querySelector("#prompt-box-search").value.trim();
    currentPage = 1;
    scrollResetPending = true;
    scheduleRender("rows");
}

function filteredCatalog(tree = folderTree()) {
    const state = getState();
    const validIds = tree.byId;
    const scope = folderScope(folderId, tree);
    const favorites = new Set(state.favorites);
    const terms = normalized(searchQuery).split(/\s+/).filter(Boolean);
    return getCatalog().filter((item) => {
        const assigned = Object.hasOwn(state.assignments, item.name) && validIds.has(state.assignments[item.name]) ? state.assignments[item.name] : NONE;
        const included =
            folderId === ALL ||
            (folderId === FAVORITES ? favorites.has(item.name)
            : folderId === NONE ? assigned === NONE
            : scope.has(assigned));
        return included && terms.every((term) => item.search.includes(term));
    });
}

function render() {
    fullRenderPending = false;
    closeMoveMenu(!!moveMenu?.contains(document.activeElement));
    const focused = document.activeElement;
    const focusedAction = focused?.dataset.action;
    const focusedFolder = focused?.dataset.folderId;
    const state = getState();
    applyTheme();
    const tree = folderTree();
    renderedTree = tree;
    if (![ALL, NONE, FAVORITES].includes(folderId) && !tree.byId.has(folderId)) folderId = ALL;
    panel.dataset.organizing = String(organizing);
    panel.dataset.selecting = String(selectMode);
    const active = currentName();
    const current = panel.querySelector("#prompt-box-current");
    current.textContent = active ? `사용 중 · ${active}` : "선택된 프리셋이 없습니다";
    current.title = active;
    const counts = new Map(tree.ordered.map((folder) => [folder.id, 0]));
    const favoriteNames = new Set(state.favorites);
    let uncategorized = 0;
    let favoriteCount = 0;
    for (const item of getCatalog()) {
        const assigned = Object.hasOwn(state.assignments, item.name) ? state.assignments[item.name] : null;
        if (counts.has(assigned)) counts.set(assigned, counts.get(assigned) + 1);
        else uncategorized++;
        if (favoriteNames.has(item.name)) favoriteCount++;
    }
    for (const folder of [...tree.ordered].reverse()) {
        const parent = tree.parents.get(folder.id);
        if (parent) counts.set(parent, counts.get(parent) + counts.get(folder.id));
    }
    const views = [
        {id: ALL, name: "전체", count: catalog.length, icon: "fa-layer-group"},
        {id: FAVORITES, name: "즐겨찾기", count: favoriteCount, icon: "fa-star"},
        {id: NONE, name: "미분류", count: uncategorized, icon: "fa-inbox"},
    ];
    if (isDesktop() || organizing) renderFolders(tree, views, counts);
    const chips = panel.querySelector("#prompt-box-chips");
    if (!isDesktop() && !organizing) renderChips(tree, views, counts);
    else if (chips.firstChild) chips.replaceChildren();
    if (focusedFolder !== undefined) {
        Array.from(panel.querySelectorAll("#prompt-box-folders [data-action], #prompt-box-chips [data-action]"))
            .find((node) => node.dataset.folderId === focusedFolder && node.dataset.action === focusedAction)
            ?.focus({preventScroll: true});
    }
    panel.querySelector("#prompt-box-folder-name").textContent = tree.paths.get(folderId) || views.find((view) => view.id === folderId)?.name || "전체";
    const organize = panel.querySelector("#prompt-box-organize");
    organize.setAttribute("aria-pressed", String(organizing));
    organize.title = organizing ? "폴더 관리 끝내기" : "폴더 관리";
    organize.setAttribute("aria-label", organize.title);
    panel.querySelector("#prompt-box-new-folder").hidden = !organizing;
    panel.querySelector("#prompt-box-bulk").hidden = !selectMode;
    panel.querySelector("#prompt-box-select").hidden = selectMode || organizing;
    panel.querySelector("#prompt-box-hint").textContent =
        organizing ? "폴더를 클릭하면 이름, 색상 등을 변경할 수 있습니다. ⋮ 를 잡고 움직여 순서를 바꾸세요."
        : selectMode ? "프리셋을 골라 다른 폴더로 옮기거나 삭제할 수 있습니다."
        : "이름을 누르면 불러오고, 길게 누르면 여러 개를 골라 옮기거나 삭제할 수 있습니다.";
    renderRows(active, favoriteNames, tree);
    syncSidebar();
    renderBulk();
}

function folderRow(view, tree) {
    const row = element("div", "prompt-box-folder-row");
    row.dataset.folderRow = view.id;
    const isFolder = tree.byId.has(view.id);
    if (isFolder) {
        if (tree.children.get(view.id).length) {
            const expanded = !getState().collapsed.includes(view.id);
            const toggle = iconButton(expanded ? "fa-chevron-down" : "fa-chevron-right", `${view.name} ${expanded ? "접기" : "펼치기"}`, "collapse");
            toggle.classList.add("prompt-box-collapse");
            toggle.dataset.folderId = view.id;
            toggle.setAttribute("aria-expanded", String(expanded));
            row.append(toggle);
        } else row.append(element("span", "prompt-box-collapse"));
    }
    const item = button("", "folder", "prompt-box-folder");
    item.dataset.folderId = view.id;
    item.setAttribute("aria-current", String(!organizing && view.id === folderId));
    item.title = tree.paths.get(view.id) || view.name;
    item.setAttribute("aria-label", organizing && isFolder ? `${item.title} 편집` : item.title);
    if (view.icon) item.append(glyph(view.icon));
    item.append(element("span", "prompt-box-folder-label", view.name));
    row.append(item);
    const draggable = organizing && isFolder && tree.children.get(tree.parents.get(view.id)).length > 1;
    if (draggable) {
        const handle = element("span", "prompt-box-drag");
        handle.title = "끌어서 순서 변경";
        handle.append(glyph("fa-ellipsis-vertical"));
        row.append(handle);
    }
    if (!organizing) item.append(element("span", "prompt-box-count", String(view.count)));
    return row;
}

function folderNode(folder, tree, counts) {
    const node = element("div", "prompt-box-node");
    node.dataset.nodeId = folder.id;
    node.append(folderRow({id: folder.id, name: folder.name, count: counts.get(folder.id)}, tree));
    const kids = tree.children.get(folder.id);
    if (kids.length && !getState().collapsed.includes(folder.id)) {
        const list = element("div", "prompt-box-children");
        for (const child of kids) list.append(folderNode(child, tree, counts));
        node.append(list);
    }
    return node;
}

function renderFolders(tree, views, counts) {
    const sections = [];
    if (!organizing) {
        const fixed = element("div", "prompt-box-views");
        for (const view of views) fixed.append(folderRow(view, tree));
        sections.push(fixed);
    }
    const groups = element("div", "prompt-box-groups");
    const currentRoot = tree.roots.get(folderId);
    for (const root of tree.children.get("")) {
        const node = folderNode(root, tree, counts);
        node.classList.add("prompt-box-group");
        node.classList.toggle("prompt-box-group-current", !organizing && currentRoot === root.id);
        applyColor(node, colorOf(root));
        groups.append(node);
    }
    if (organizing && !tree.ordered.length) groups.append(element("div", "prompt-box-empty", "아직 폴더가 없습니다. 아래 새 폴더 버튼으로 만들 수 있습니다."));
    sections.push(groups);
    panel.querySelector("#prompt-box-folders").replaceChildren(...sections);
}

function chip(view, options = {}) {
    const node = button("", "folder", "prompt-box-chip");
    node.dataset.folderId = view.id;
    node.setAttribute("aria-current", String(view.id === folderId));
    node.classList.toggle("prompt-box-chip-active", view.id === folderId || !!options.contains);
    node.title = options.title || view.name;
    if (options.color) {
        node.classList.add("prompt-box-chip-colored");
        applyColor(node, options.color);
    }
    if (view.icon) node.append(glyph(view.icon));
    node.append(element("span", "prompt-box-chip-label", view.name), element("span", "prompt-box-count", String(view.count)));
    return node;
}

function renderChips(tree, views, counts) {
    const box = panel.querySelector("#prompt-box-chips");
    const previous = new Map(Array.from(box.children, (row) => [row.dataset.key, row.scrollLeft]));
    const currentRoot = tree.roots.get(folderId);
    const top = element("div", "prompt-box-chip-row");
    top.dataset.key = "top";
    for (const view of views) top.append(chip(view));
    for (const root of tree.children.get("")) {
        top.append(chip({id: root.id, name: root.name, count: counts.get(root.id)}, {color: colorOf(root), contains: currentRoot === root.id}));
    }
    const rows = [top];
    if (currentRoot && tree.children.get(currentRoot).length) {
        const sub = element("div", "prompt-box-chip-row prompt-box-chip-sub");
        sub.dataset.key = `sub:${currentRoot}`;
        const color = colorOf(tree.byId.get(currentRoot));
        sub.append(chip({id: currentRoot, name: "모두", count: counts.get(currentRoot)}, {color, title: `${tree.paths.get(currentRoot)} 전체`}));
        for (const folder of tree.ordered) {
            if (folder.id === currentRoot || tree.roots.get(folder.id) !== currentRoot) continue;
            sub.append(chip({id: folder.id, name: tree.parts.get(folder.id).slice(1).join(" › "), count: counts.get(folder.id)}, {color, title: tree.paths.get(folder.id)}));
        }
        rows.push(sub);
    }
    box.replaceChildren(...rows);
    for (const row of rows) {
        if (previous.has(row.dataset.key)) row.scrollLeft = previous.get(row.dataset.key);
        const active = row.querySelector(".prompt-box-chip-active");
        if (!active) continue;
        if (active.offsetLeft < row.scrollLeft) row.scrollLeft = active.offsetLeft - 12;
        else if (active.offsetLeft + active.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = active.offsetLeft + active.offsetWidth - row.clientWidth + 12;
    }
}

function applyTheme() {
    if (!panel) return;
    const dark = getState().theme === "dark";
    panel.dataset.theme = dark ? "dark" : "light";
    const toggle = panel.querySelector("#prompt-box-theme");
    const title = dark ? "라이트 모드로 전환" : "다크 모드로 전환";
    toggle.title = title;
    toggle.setAttribute("aria-label", title);
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.firstElementChild.className = `fa-solid ${dark ? "fa-sun" : "fa-moon"}`;
}

function renderPagination() {
    const pager = panel.querySelector("#prompt-box-pagination");
    pager.dataset.single = String(pageCount <= 1);
    pager.querySelector('[data-action="previous-page"]').disabled = currentPage === 1;
    pager.querySelector('[data-action="next-page"]').disabled = currentPage === pageCount;
    const numbers = panel.querySelector("#prompt-box-page-numbers");
    const focusedPage = numbers.contains(document.activeElement) ? document.activeElement.dataset.page : undefined;
    const pages = new Set([1, pageCount]);
    const start = Math.max(1, Math.min(currentPage - 1, pageCount - 2));
    for (let page = start; page <= Math.min(pageCount, start + 2); page++) pages.add(page);
    const fragment = document.createDocumentFragment();
    let previous = 0;
    for (const page of [...pages].sort((a, b) => a - b)) {
        if (previous && page > previous + 1) {
            const gap = element("span", "prompt-box-page-gap", "…");
            gap.setAttribute("aria-hidden", "true");
            fragment.append(gap);
        }
        const item = button(String(page), "page");
        item.dataset.page = String(page);
        item.setAttribute("aria-label", `${page}페이지`);
        if (page === currentPage) item.setAttribute("aria-current", "page");
        fragment.append(item);
        previous = page;
    }
    numbers.replaceChildren(fragment);
    if (focusedPage !== undefined) {
        const target = Array.from(numbers.children).find((node) => node.dataset.page === focusedPage) || numbers.querySelector('[aria-current="page"]');
        target?.focus({preventScroll: true});
    }
}

function renderRows(active, favoriteNames, tree) {
    const matching = filteredCatalog(tree);
    pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
    const nextPage = Math.max(1, Math.min(currentPage, pageCount));
    if (nextPage !== currentPage) scrollResetPending = true;
    currentPage = nextPage;
    const start = (currentPage - 1) * PAGE_SIZE;
    const shown = matching.slice(start, start + PAGE_SIZE);
    const focused = document.activeElement;
    const focusName = focused?.dataset.favoriteName;
    const list = panel.querySelector("#prompt-box-list");
    const fragment = document.createDocumentFragment();
    const state = getState();
    for (const item of shown) {
        const row = element("div", "prompt-box-row");
        row.classList.toggle("prompt-box-current-row", item.name === active);
        let entry;
        if (selectMode) {
            entry = element("label", "prompt-box-choice");
            const checkbox = element("input");
            checkbox.type = "checkbox";
            checkbox.dataset.selectName = item.name;
            checkbox.checked = selectedNames.has(item.name);
            entry.append(checkbox);
        } else {
            entry = button("", "load", "prompt-box-load");
            entry.dataset.name = item.name;
            if (item.name === active) entry.setAttribute("aria-current", "true");
            entry.disabled = loading;
        }
        const copy = element("span", "prompt-box-row-copy");
        const title = element("span", "prompt-box-row-name", item.name);
        title.title = item.name;
        const meta = element("span", "prompt-box-row-meta");
        const assigned = Object.hasOwn(state.assignments, item.name) ? state.assignments[item.name] : null;
        if (tree.byId.has(assigned)) {
            const parts = tree.parts.get(assigned);
            applyColor(meta, folderColor(assigned, tree));
            meta.append(element("span", "prompt-box-path-root", parts[0]));
            if (parts.length > 1) meta.append(` › ${parts.slice(1).join(" › ")}`);
        } else meta.append("미분류");
        if (item.name === active) meta.append(" · 사용 중");
        copy.append(title, meta);
        entry.append(copy);
        if (loading && item.name === loadingName) {
            row.classList.add("prompt-box-loading-row");
            entry.setAttribute("aria-busy", "true");
            entry.append(glyph("fa-spinner fa-spin-pulse prompt-box-spinner"));
        }
        const favorite = iconButton("fa-star", favoriteNames.has(item.name) ? "즐겨찾기 해제" : "즐겨찾기 추가", "favorite");
        favorite.dataset.favoriteName = item.name;
        favorite.setAttribute("aria-label", `${item.name} ${favorite.title}`);
        favorite.setAttribute("aria-pressed", String(favoriteNames.has(item.name)));
        row.append(entry, favorite);
        fragment.append(row);
    }
    if (!matching.length)
        fragment.append(
            element(
                "div",
                "prompt-box-empty",
                searchQuery ? "검색 결과가 없습니다. 다른 폴더나 다른 이름으로 검색해 보세요."
                : folderId === FAVORITES ? "별을 누르면 자주 쓰는 프리셋을 여기에 모을 수 있습니다."
                : "이 폴더에는 프리셋이 없습니다. 프리셋을 길게 눌러 이 폴더로 옮길 수 있습니다.",
            ),
        );
    list.replaceChildren(fragment);
    if (scrollResetPending) {
        scrollResetPending = false;
        panel.querySelector(".prompt-box-content").scrollTop = 0;
    }
    panel.querySelector("#prompt-box-result-count").textContent = `${matching.length}개`;
    renderPagination();
    if (focusName !== undefined)
        Array.from(list.querySelectorAll("[data-favorite-name]"))
            .find((node) => node.dataset.favoriteName === focusName)
            ?.focus({preventScroll: true});
}

function renderBulk() {
    panel.querySelector("#prompt-box-selected-count").textContent = `${selectedNames.size}개 선택`;
    panel.querySelector("#prompt-box-move").disabled = !selectedNames.size;
    panel.querySelector("#prompt-box-delete-presets").disabled = !selectedNames.size;
}

function deletionTargets() {
    const active = currentName();
    const names = getCatalog()
        .map((item) => item.name)
        .filter((name) => selectedNames.has(name));
    return {names: names.filter((name) => name !== active), skipped: names.includes(active) ? active : ""};
}

function openDeleteDialog() {
    if (!selectedNames.size) return;
    closeMoveMenu();
    const {names, skipped} = deletionTargets();
    const dialog = panel.querySelector("#prompt-box-delete-dialog");
    dialog.querySelector("#prompt-box-delete-message").textContent = names.length ? `선택한 프리셋 ${names.length}개를 실리태번에서 완전히 삭제합니다. 삭제한 프리셋은 되돌릴 수 없습니다.` : "사용 중인 프리셋은 삭제할 수 없습니다. 다른 프리셋을 불러온 뒤 삭제할 수 있습니다.";
    const list = dialog.querySelector("#prompt-box-delete-names");
    const shown = names.slice(0, 8).map((name) => element("li", "", name));
    if (names.length > shown.length) shown.push(element("li", "prompt-box-delete-more", `외 ${names.length - shown.length}개`));
    list.replaceChildren(...shown);
    list.hidden = !names.length;
    const note = dialog.querySelector("#prompt-box-delete-note");
    note.hidden = !skipped || !names.length;
    note.textContent = skipped ? `사용 중인 프리셋(${skipped})은 삭제 목록에서 제외했습니다.` : "";
    const confirm = dialog.querySelector("#prompt-box-confirm-delete-presets");
    confirm.hidden = !names.length;
    confirm.textContent = `${names.length}개 삭제`;
    dialog.hidden = false;
    panel.dataset.dialogOpen = "true";
    dialog.querySelector('[data-action="cancel-delete-presets"]').focus({preventScroll: true});
}

function hideDeleteDialog(restoreFocus = false) {
    if (!panel) return;
    panel.querySelector("#prompt-box-delete-dialog").hidden = true;
    delete panel.dataset.dialogOpen;
    if (restoreFocus) panel.querySelector("#prompt-box-delete-presets").focus({preventScroll: true});
}

async function deleteSelectedPresets() {
    if (deleting) return;
    const {names} = deletionTargets();
    if (!names.length) return;
    const manager = getPresetManager("openai");
    const dialog = panel.querySelector("#prompt-box-delete-dialog");
    const confirm = dialog.querySelector("#prompt-box-confirm-delete-presets");
    const buttons = Array.from(dialog.querySelectorAll("button"));
    if (!manager) {
        dialog.querySelector("#prompt-box-delete-message").textContent = "프리셋을 삭제할 준비가 되지 않았습니다.";
        return;
    }
    deleting = true;
    buttons.forEach((node) => {
        node.disabled = true;
    });
    let removed = 0;
    const failed = [];
    for (const [index, name] of names.entries()) {
        confirm.textContent = `삭제 중… ${index + 1}/${names.length}`;
        try {
            if (await manager.deletePreset(name)) {
                removed++;
                selectedNames.delete(name);
                await eventSource.emit(event_types.PRESET_DELETED, {apiId: "openai", name});
            } else failed.push(name);
        } catch (error) {
            console.error("[프롬 정리함] 프리셋 삭제 실패", name, error);
            failed.push(name);
        }
    }
    savePromptSettings();
    deleting = false;
    buttons.forEach((node) => {
        node.disabled = false;
    });
    hideDeleteDialog();
    selectMode = false;
    selectedNames.clear();
    panel.querySelector("#prompt-box-status").textContent = failed.length ? `${removed}개 삭제했습니다. ${failed.length}개는 삭제하지 못했습니다.` : `${removed}개 삭제했습니다.`;
    scheduleRender();
}

function syncParentTarget(tree = folderTree()) {
    if (!tree.byId.has(parentTarget)) parentTarget = "";
    const name = tree.paths.get(parentTarget) || "최상위";
    const trigger = panel.querySelector("#prompt-box-parent-target");
    trigger.firstElementChild.textContent = name;
    trigger.setAttribute("aria-label", `상위폴더: ${name}`);
    trigger.title = name;
    syncColorField();
}

function syncColorField() {
    panel.querySelector("#prompt-box-color-field").hidden = !!parentTarget;
    for (const swatch of panel.querySelectorAll(".prompt-box-swatch")) {
        swatch.setAttribute("aria-checked", String(swatch.dataset.color === editColor));
    }
}

function menuTrigger() {
    return panel.querySelector(menuKind === "parent" ? "#prompt-box-parent-target" : "#prompt-box-move");
}

function closeMoveMenu(restoreFocus = false) {
    if (!moveMenu) return;
    moveMenu.remove();
    moveMenu = null;
    delete panel.dataset.menuOpen;
    const trigger = menuTrigger();
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus({preventScroll: true});
}

function positionMoveMenu() {
    if (!moveMenu) return;
    if (!isDesktop()) {
        moveMenu.style.cssText = "";
        return;
    }
    const trigger = menuTrigger().getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    const width = Math.max(trigger.width, 240);
    const above = trigger.top - bounds.top - 12;
    const below = bounds.bottom - trigger.bottom - 12;
    const placeAbove = above > below;
    moveMenu.style.setProperty("max-height", `${Math.max(0, Math.min(260, placeAbove ? above : below))}px`, "important");
    moveMenu.style.setProperty("width", `${width}px`, "important");
    moveMenu.style.setProperty("left", `${Math.min(trigger.left - bounds.left, bounds.width - width - 12) - panel.clientLeft}px`, "important");
    moveMenu.style.setProperty("top", `${(placeAbove ? trigger.top - moveMenu.offsetHeight - 6 : trigger.bottom + 6) - bounds.top - panel.clientTop}px`, "important");
}

function openMoveMenu(kind = "move") {
    if (moveMenu) return;
    if (kind === "move" && !selectedNames.size) return;
    menuKind = kind;
    const tree = folderTree();
    if (kind === "parent") syncParentTarget(tree);
    const trigger = menuTrigger();
    moveMenu = element("div", "prompt-box-dropdown-menu");
    moveMenu.id = kind === "parent" ? "prompt-box-parent-menu" : "prompt-box-move-menu";
    moveMenu.setAttribute("role", "listbox");
    const label = kind === "parent" ? "상위폴더" : `${selectedNames.size}개를 옮길 폴더`;
    moveMenu.setAttribute("aria-label", label);
    moveMenu.append(element("div", "prompt-box-menu-title", label));
    const excluded = kind === "parent" ? folderScope(folderEditId, tree) : new Set();
    const options = [kind === "parent" ? {id: "", name: "최상위", depth: 0} : {id: NONE, name: "미분류", depth: 0}, ...tree.ordered.filter((folder) => !excluded.has(folder.id)).map((folder) => ({id: folder.id, name: folder.name, depth: tree.depths.get(folder.id) + 1}))];
    for (const option of options) {
        const row = button("", kind === "parent" ? "choose-parent" : "choose-target", "prompt-box-dropdown-option");
        row.dataset.targetId = option.id;
        row.dataset.depth = String(Math.min(option.depth, 4));
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(kind === "parent" && option.id === parentTarget));
        row.tabIndex = -1;
        row.title = tree.paths.get(option.id) || option.name;
        if (tree.byId.has(option.id)) applyColor(row, folderColor(option.id, tree));
        row.append(element("span", "", option.name), glyph("fa-check"));
        moveMenu.append(row);
    }
    moveMenu.addEventListener("keydown", (event) => {
        const rows = Array.from(moveMenu.querySelectorAll('[role="option"]'));
        const index = rows.indexOf(document.activeElement);
        let next;
        if (event.key === "ArrowDown") next = (index + 1) % rows.length;
        else if (event.key === "ArrowUp") next = (index - 1 + rows.length) % rows.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = rows.length - 1;
        else if (event.key === "Tab") closeMoveMenu(true);
        if (next !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            rows[next].focus({preventScroll: true});
            revealOption(rows[next]);
        }
    });
    panel.append(moveMenu);
    panel.dataset.menuOpen = "true";
    trigger.setAttribute("aria-expanded", "true");
    positionMoveMenu();
    const selected = moveMenu.querySelector('[aria-selected="true"]') || moveMenu.querySelector('[role="option"]');
    selected?.focus({preventScroll: true});
    if (selected) revealOption(selected);
}

function revealOption(row) {
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < moveMenu.scrollTop) moveMenu.scrollTop = top;
    else if (bottom > moveMenu.scrollTop + moveMenu.clientHeight) moveMenu.scrollTop = bottom - moveMenu.clientHeight;
}

function preloadFont() {
    document.fonts?.load('400 13px "Pretendard"').catch(() => {});
}

function hideFolderEditor(restoreFocus = false) {
    closeMoveMenu();
    const editedId = folderEditId;
    folderEditId = null;
    panel.querySelector("#prompt-box-folder-editor").hidden = true;
    panel.querySelector("#prompt-box-delete-confirm").hidden = true;
    delete panel.dataset.editorOpen;
    if (!restoreFocus) return;
    const row = editedId && Array.from(panel.querySelectorAll("#prompt-box-folders .prompt-box-folder")).find((node) => node.dataset.folderId === editedId);
    (row || panel.querySelector(organizing ? "#prompt-box-new-folder" : "#prompt-box-organize"))?.focus({preventScroll: true});
}

function editFolder(id) {
    closeMoveMenu();
    folderEditId = id;
    const tree = folderTree();
    parentTarget = id ? tree.parents.get(id) || "" : "";
    editColor = id ? colorOf(tree.byId.get(id)) : "";
    syncParentTarget(tree);
    panel.querySelector("#prompt-box-editor-label").textContent = id ? "폴더 편집" : "새 폴더";
    const input = panel.querySelector("#prompt-box-folder-name-input");
    input.value = tree.byId.get(id)?.name || "";
    input.setCustomValidity("");
    panel.querySelector("#prompt-box-delete-folder").hidden = !id;
    panel.querySelector("#prompt-box-delete-confirm").hidden = true;
    panel.querySelector("#prompt-box-folder-editor").hidden = false;
    panel.dataset.editorOpen = "true";
    if (!isDesktop()) panel.querySelector("#prompt-box-parent-target").focus({preventScroll: true});
    else {
        input.focus({preventScroll: true});
        input.select();
    }
}

function saveFolder(event) {
    event.preventDefault();
    const input = panel.querySelector("#prompt-box-folder-name-input");
    const name = input.value.trim();
    const tree = folderTree();
    if (parentTarget && (!tree.byId.has(parentTarget) || folderScope(folderEditId, tree).has(parentTarget))) {
        input.setCustomValidity("유효한 상위폴더를 선택하세요.");
        input.reportValidity();
        return;
    }
    if (!name || tree.ordered.some((folder) => folder.id !== folderEditId && tree.parents.get(folder.id) === parentTarget && normalized(folder.name) === normalized(name))) {
        input.setCustomValidity(name ? "같은 상위폴더 안에 같은 이름의 폴더가 있습니다." : "폴더 이름을 입력하세요.");
        input.reportValidity();
        return;
    }
    const color = parentTarget ? "" : editColor;
    const state = getState();
    if (folderEditId) {
        const folder = state.folders.find((folder) => folder.id === folderEditId);
        if (!folder) return;
        if (folder.name === name && tree.parents.get(folder.id) === parentTarget && colorOf(folder) === color) {
            hideFolderEditor(true);
            return;
        }
        folder.name = name;
        folder.parentId = parentTarget;
        if (color) folder.color = color;
        else delete folder.color;
    } else {
        const folder = {id: globalThis.crypto?.randomUUID?.() || `folder_${Date.now()}_${Math.random().toString(36).slice(2)}`, name, parentId: parentTarget};
        if (color) folder.color = color;
        state.folders.push(folder);
        if (parentTarget) state.collapsed = state.collapsed.filter((id) => id !== parentTarget);
    }
    hideFolderEditor();
    saveState();
}

function moveSelected(target) {
    if (target !== NONE && !folders().some((folder) => folder.id === target)) return;
    const state = getState();
    const names = new Set(getCatalog().map((item) => item.name));
    let changed = 0;
    for (const name of selectedNames) {
        if (!names.has(name)) continue;
        if (target === NONE) {
            if (!Object.hasOwn(state.assignments, name)) continue;
            delete state.assignments[name];
        } else {
            if (Object.hasOwn(state.assignments, name) && state.assignments[name] === target) continue;
            Object.defineProperty(state.assignments, name, {value: target, enumerable: true, configurable: true, writable: true});
        }
        changed++;
    }
    selectedNames.clear();
    selectMode = false;
    const destination = target === NONE ? "미분류" : folderTree().paths.get(target);
    panel.querySelector("#prompt-box-status").textContent = changed ? `${changed}개 → ${destination}` : "이미 그 폴더에 있습니다.";
    if (changed) saveState();
    else scheduleRender();
}

function exitSelectMode() {
    selectMode = false;
    selectedNames.clear();
    scheduleRender();
}

function setOrganizing(value) {
    organizing = value;
    selectMode = false;
    selectedNames.clear();
    hideFolderEditor();
    scheduleRender();
}

async function loadPreset(name) {
    if (loading) return;
    const item = getCatalog().find((item) => item.name === name);
    if (!item) return;
    if (name === currentName()) {
        if (!isDesktop()) closePanel();
        return;
    }
    const manager = getPresetManager("openai");
    if (!manager) {
        panel.querySelector("#prompt-box-status").textContent = "프리셋을 불러올 준비가 되지 않았습니다.";
        return;
    }
    loading = true;
    loadingName = name;
    scheduleRender();
    try {
        await manager.selectPreset(item.value);
        if (!isDesktop()) closePanel();
        else panel.querySelector("#prompt-box-status").textContent = "프리셋을 불러왔습니다.";
    } catch (error) {
        panel.querySelector("#prompt-box-status").textContent = "불러오지 못했습니다. 다시 시도하세요.";
        console.error("[프롬 정리함] 프리셋 불러오기 실패", error);
    } finally {
        loading = false;
        loadingName = "";
        scheduleRender();
    }
}

function startLongPress(event) {
    lastPointerType = event.pointerType;
    if (organizing || selectMode || loading || event.button > 0) return;
    const entry = event.target.closest(".prompt-box-load");
    if (!entry) return;
    cancelLongPress();
    longPress = {name: entry.dataset.name, x: event.clientX, y: event.clientY, id: event.pointerId, timer: setTimeout(fireLongPress, LONG_PRESS_MS)};
    window.addEventListener("pointermove", trackLongPress, {passive: true});
    window.addEventListener("pointerup", cancelLongPress);
    window.addEventListener("pointercancel", cancelLongPress);
}

function trackLongPress(event) {
    if (longPress && event.pointerId === longPress.id && Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > 10) cancelLongPress();
}

function cancelLongPress() {
    if (!longPress) return;
    clearTimeout(longPress.timer);
    longPress = null;
    window.removeEventListener("pointermove", trackLongPress);
    window.removeEventListener("pointerup", cancelLongPress);
    window.removeEventListener("pointercancel", cancelLongPress);
}

function fireLongPress() {
    const name = longPress?.name;
    cancelLongPress();
    if (!name || !isOpen()) return;
    suppressClick = true;
    window.addEventListener(
        "pointerup",
        () =>
            setTimeout(() => {
                suppressClick = false;
            }, 400),
        {once: true},
    );
    selectMode = true;
    selectedNames.add(name);
    navigator.vibrate?.(12);
    render();
}

function startReorder(event) {
    const handle = event.target.closest(".prompt-box-drag");
    if (!handle || !organizing || reorder || event.button > 0) return;
    const node = handle.closest(".prompt-box-node");
    const siblings = Array.from(node.parentElement.children).filter((child) => child.classList.contains("prompt-box-node"));
    if (siblings.length < 2) return;
    event.preventDefault();
    const nav = panel.querySelector("#prompt-box-folders");
    const navTop = nav.getBoundingClientRect().top;
    const boxes = siblings.map((sibling) => {
        const rect = sibling.getBoundingClientRect();
        return {top: rect.top - navTop + nav.scrollTop, height: rect.height};
    });
    const from = siblings.indexOf(node);
    const gap = boxes[1].top - boxes[0].top - boxes[0].height;
    reorder = {node, nav, siblings, boxes, from, to: from, gap, pointerId: event.pointerId, startY: event.clientY - navTop + nav.scrollTop};
    window.addEventListener("pointermove", moveReorder);
    window.addEventListener("pointerup", endReorder);
    window.addEventListener("pointercancel", endReorder);
    try {
        handle.setPointerCapture(event.pointerId);
    } catch {}
    node.dataset.dragging = "true";
    panel.dataset.reordering = "true";
}

function moveReorder(event) {
    if (!reorder || event.pointerId !== reorder.pointerId) return;
    const {nav, boxes, from, siblings, gap} = reorder;
    const bounds = nav.getBoundingClientRect();
    if (event.clientY < bounds.top + 36) nav.scrollTop -= 8;
    else if (event.clientY > bounds.bottom - 36) nav.scrollTop += 8;
    const dy = event.clientY - bounds.top + nav.scrollTop - reorder.startY;
    const center = boxes[from].top + boxes[from].height / 2 + dy;
    let to = from;
    while (to > 0 && center < boxes[to - 1].top + boxes[to - 1].height / 2) to--;
    while (to < boxes.length - 1 && center > boxes[to + 1].top + boxes[to + 1].height / 2) to++;
    reorder.to = to;
    const shift = boxes[from].height + gap;
    siblings.forEach((sibling, index) => {
        let offset = 0;
        if (index === from) offset = dy;
        else if (from < to && index > from && index <= to) offset = -shift;
        else if (from > to && index >= to && index < from) offset = shift;
        if (offset) sibling.style.setProperty("transform", `translateY(${offset}px)`, "important");
        else sibling.style.removeProperty("transform");
    });
}

function endReorder(event) {
    if (!reorder || (event && event.pointerId !== reorder.pointerId)) return;
    const {node, siblings, from, to} = reorder;
    reorder = null;
    window.removeEventListener("pointermove", moveReorder);
    window.removeEventListener("pointerup", endReorder);
    window.removeEventListener("pointercancel", endReorder);
    for (const sibling of siblings) sibling.style.removeProperty("transform");
    delete node.dataset.dragging;
    delete panel.dataset.reordering;
    if (event?.type !== "pointerup" || from === to) return;
    const ids = siblings.map((sibling) => sibling.dataset.nodeId);
    ids.splice(to, 0, ...ids.splice(from, 1));
    placeSiblings(ids);
}

function dismissLayer() {
    if (moveMenu) {
        closeMoveMenu(true);
        return true;
    }
    if (deleteDialogOpen()) {
        if (!deleting) hideDeleteDialog(true);
        return true;
    }
    if (editorOpen()) {
        hideFolderEditor(true);
        return true;
    }
    if (selectMode) {
        exitSelectMode();
        return true;
    }
    if (organizing) {
        setOrganizing(false);
        return true;
    }
    return false;
}

function onPopState() {
    if (!isOpen() || !historyEntry) return;
    if (dismissLayer()) {
        history.pushState({promptBox: true}, "");
        return;
    }
    historyEntry = false;
    closePanel();
}

function handleClick(event) {
    const control = event.target.closest("[data-action]");
    if (!control || !panel.contains(control)) return;
    const state = getState();
    const action = control.dataset.action;
    if (action === "close") closePanel();
    else if (action === "toggle-target") {
        if (moveMenu) closeMoveMenu();
        else openMoveMenu();
    } else if (action === "toggle-parent") {
        if (moveMenu) closeMoveMenu();
        else openMoveMenu("parent");
    } else if (action === "choose-parent") {
        parentTarget = control.dataset.targetId;
        syncParentTarget();
        panel.querySelector("#prompt-box-folder-name-input").setCustomValidity("");
        closeMoveMenu(true);
    } else if (action === "choose-target") {
        closeMoveMenu();
        moveSelected(control.dataset.targetId);
    } else if (action === "choose-color") {
        editColor = control.dataset.color;
        syncColorField();
    } else if (action === "theme") {
        state.theme = state.theme === "dark" ? "light" : "dark";
        applyTheme();
        savePromptSettings();
    } else if (action === "organize") setOrganizing(!organizing);
    else if (action === "select") {
        selectMode = true;
        scheduleRender();
    } else if (action === "folder") {
        const id = control.dataset.folderId;
        if (organizing && folderTree().byId.has(id)) {
            editFolder(id);
            return;
        }
        folderId = id;
        currentPage = 1;
        scrollResetPending = true;
        scheduleRender();
    } else if (action === "collapse") {
        const id = control.dataset.folderId;
        state.collapsed = state.collapsed.includes(id) ? state.collapsed.filter((item) => item !== id) : [...state.collapsed, id];
        savePromptSettings();
        scheduleRender();
    } else if (action === "favorite") {
        const name = control.dataset.favoriteName;
        state.favorites = state.favorites.includes(name) ? state.favorites.filter((item) => item !== name) : [...state.favorites, name];
        saveState();
    } else if (action === "load") void loadPreset(control.dataset.name);
    else if (["page", "previous-page", "next-page"].includes(action)) {
        const requested = action === "page" ? Number(control.dataset.page) : currentPage + (action === "next-page" ? 1 : -1);
        if (!Number.isInteger(requested) || requested < 1 || requested > pageCount || requested === currentPage) return;
        currentPage = requested;
        scrollResetPending = true;
        scheduleRender("rows");
    } else if (action === "new-folder") editFolder(null);
    else if (action === "cancel-folder") hideFolderEditor(true);
    else if (action === "delete-folder") panel.querySelector("#prompt-box-delete-confirm").hidden = false;
    else if (action === "cancel-delete") panel.querySelector("#prompt-box-delete-confirm").hidden = true;
    else if (action === "confirm-delete") {
        const removed = folderScope(folderEditId);
        state.folders = state.folders.filter((folder) => !removed.has(folder.id));
        state.collapsed = state.collapsed.filter((id) => !removed.has(id));
        for (const name of Object.keys(state.assignments)) if (removed.has(state.assignments[name])) delete state.assignments[name];
        if (removed.has(folderId)) folderId = NONE;
        hideFolderEditor();
        saveState();
    } else if (action === "select-results") {
        filteredCatalog().forEach((item) => selectedNames.add(item.name));
        scheduleRender();
    } else if (action === "clear-selection") exitSelectMode();
    else if (action === "delete-presets") openDeleteDialog();
    else if (action === "cancel-delete-presets") hideDeleteDialog(true);
    else if (action === "confirm-delete-presets") void deleteSelectedPresets();
}

function syncSidebar() {
    const mobile = !isDesktop();
    panel.querySelector("#prompt-box-sidebar").inert = mobile && !organizing;
    panel.querySelector(".prompt-box-content").inert = mobile && organizing;
}

function setPositionStyle(node, property, value) {
    if (node.style.getPropertyValue(property) !== value) {
        node.style.setProperty(property, value, "important");
    }
}

function positionPanel() {
    if (!isOpen() || !launcher?.isConnected) return;
    const mobile = !isDesktop();
    if (panel.dataset.sheet !== String(mobile)) {
        panel.dataset.sheet = String(mobile);
        scheduleRender();
    }
    syncSidebar();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth;
    const height = viewport?.height || window.innerHeight;
    backdrop.hidden = false;
    panel.setAttribute("aria-modal", "true");
    const bounds = backdrop.getBoundingClientRect();
    const origin = {
        left: bounds.left - (parseFloat(backdrop.style.left) || 0),
        top: bounds.top - (parseFloat(backdrop.style.top) || 0),
    };
    setPositionStyle(backdrop, "width", `${width}px`);
    setPositionStyle(backdrop, "height", `${height}px`);
    setPositionStyle(backdrop, "left", `${left - origin.left}px`);
    setPositionStyle(backdrop, "top", `${top - origin.top}px`);
    const panelWidth = mobile ? width : Math.min(1000, width - 32);
    const panelHeight = Math.max(0, mobile ? height - SHEET_GAP : Math.min(720, height - 32));
    setPositionStyle(panel, "max-height", `${panelHeight}px`);
    setPositionStyle(panel, "height", `${panelHeight}px`);
    setPositionStyle(panel, "width", `${panelWidth}px`);
    setPositionStyle(panel, "left", `${left + (width - panelWidth) / 2 - origin.left}px`);
    setPositionStyle(panel, "top", `${top + (mobile ? height - panelHeight : (height - panelHeight) / 2) - origin.top}px`);
    positionMoveMenu();
}

function schedulePosition() {
    if (!isOpen()) return;
    clearTimeout(positionTimer);
    positionTimer = 0;
    if (!isDesktop()) {
        if (positionFrame) cancelAnimationFrame(positionFrame);
        positionFrame = 0;
        positionTimer = setTimeout(() => {
            positionTimer = 0;
            queuePosition();
        }, 120);
        return;
    }
    queuePosition();
}

function queuePosition() {
    if (positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
        positionFrame = 0;
        positionPanel();
    });
}

function revealCurrent() {
    const content = panel.querySelector(".prompt-box-content");
    const row = panel.querySelector(".prompt-box-current-row");
    content.scrollTop = row ? Math.max(0, row.offsetTop - (content.clientHeight - row.offsetHeight) / 2) : 0;
}

function handleOutside(event) {
    if (moveMenu) {
        if (!moveMenu.contains(event.target) && !menuTrigger().contains(event.target)) closeMoveMenu();
    } else if (event.target === panel && deleteDialogOpen()) {
        if (!deleting) hideDeleteDialog(true);
    } else if (event.target === panel && editorOpen()) hideFolderEditor();
}

function handleEscape(event) {
    if (event.key === "Tab" && isDesktop() && !moveMenu) {
        const scope =
            deleteDialogOpen() ? panel.querySelector("#prompt-box-delete-dialog")
            : editorOpen() ? panel.querySelector("#prompt-box-folder-editor")
            : panel;
        const controls = Array.from(scope.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')).filter((node) => node.getClientRects().length);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (first && (!scope.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last))) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        }
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (!dismissLayer() && !isDesktop()) closePanel();
}

function openPanel() {
    mount();
    if (!panel) createPanel();
    clearTimeout(positionTimer);
    positionTimer = 0;
    panel.dataset.preparing = "true";
    panel.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    panel.querySelector("#prompt-box-status").textContent = "";
    positionPanel();
    searchQuery = panel.querySelector("#prompt-box-search").value.trim();
    const active = currentName();
    const index = filteredCatalog().findIndex((item) => item.name === active);
    currentPage = index >= 0 ? Math.floor(index / PAGE_SIZE) + 1 : 1;
    render();
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    revealCurrent();
    delete panel.dataset.preparing;
    if (isDesktop()) panel.querySelector("#prompt-box-search").focus({preventScroll: true});
    else panel.querySelector('[data-action="close"]').focus({preventScroll: true});
    document.addEventListener("pointerdown", handleOutside);
    document.addEventListener("keydown", handleEscape, true);
    window.addEventListener("resize", schedulePosition);
    window.addEventListener("scroll", schedulePosition, {passive: true});
    window.visualViewport?.addEventListener("resize", schedulePosition);
    window.visualViewport?.addEventListener("scroll", schedulePosition);
    if (!isDesktop() && !historyEntry) {
        history.pushState({promptBox: true}, "");
        historyEntry = true;
    }
    window.addEventListener("popstate", onPopState);
}

function closePanel(restoreFocus = true) {
    if (!panel) return;
    clearTimeout(positionTimer);
    positionTimer = 0;
    closeMoveMenu();
    cancelLongPress();
    endReorder();
    panel.hidden = true;
    delete panel.dataset.preparing;
    backdrop.hidden = true;
    launcher?.setAttribute("aria-expanded", "false");
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    fullRenderPending = false;
    organizing = false;
    selectMode = false;
    selectedNames.clear();
    hideFolderEditor();
    hideDeleteDialog();
    document.removeEventListener("pointerdown", handleOutside);
    document.removeEventListener("keydown", handleEscape, true);
    window.removeEventListener("resize", schedulePosition);
    window.removeEventListener("scroll", schedulePosition);
    window.visualViewport?.removeEventListener("resize", schedulePosition);
    window.visualViewport?.removeEventListener("scroll", schedulePosition);
    if (positionFrame) cancelAnimationFrame(positionFrame);
    positionFrame = 0;
    window.removeEventListener("popstate", onPopState);
    if (historyEntry) {
        historyEntry = false;
        history.back();
    }
    if (restoreFocus && launcher?.isConnected) launcher.focus({preventScroll: true});
}

function mount() {
    const select = document.getElementById("settings_preset_openai");
    if (!select?.parentElement) return false;
    if (presetSelect !== select) {
        presetSelect?.removeEventListener("change", scheduleRender);
        presetSelect?.removeEventListener("blur", queueNativeSync);
        selectObserver?.disconnect();
        presetSelect = select;
        catalogDirty = true;
        selectObserver = new MutationObserver(invalidateCatalog);
        observePresetSelect();
        select.addEventListener("change", scheduleRender);
        select.addEventListener("blur", queueNativeSync);
        queueNativeSync();
    }
    if (!launcher) {
        launcher = element("div", "menu_button menu_button_icon");
        launcher.title = "프롬 정리함";
        launcher.setAttribute("aria-label", "프롬 정리함");
        launcher.setAttribute("role", "button");
        launcher.tabIndex = 0;
        launcher.append(glyph("fa-fw fa-folder-open"));
        launcher.id = "prompt-box-button";
        launcher.setAttribute("aria-haspopup", "dialog");
        launcher.setAttribute("aria-controls", "prompt-box");
        launcher.setAttribute("aria-expanded", "false");
        launcher.addEventListener("click", () => {
            if (!isOpen()) openPanel();
            else if (!isDesktop()) closePanel();
            else panel.querySelector('[data-action="close"]').focus({preventScroll: true});
        });
        launcher.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            launcher.click();
        });
    }
    const saveButton = document.getElementById("update_oai_preset");
    if (saveButton?.parentElement) {
        if (launcher.nextElementSibling !== saveButton) saveButton.before(launcher);
    } else if (launcher.parentElement !== select.parentElement) select.after(launcher);
    const parent = document.getElementById("openai_api-presets") || select.parentElement;
    if (observedParent !== parent) {
        placementObserver?.disconnect();
        observedParent = parent;
        placementObserver = new MutationObserver(() => {
            if (!presetSelect?.isConnected || !launcher?.isConnected) {
                mount();
                scheduleRender();
            }
        });
        placementObserver.observe(parent, {childList: true, subtree: true});
    }
    return true;
}

function initialize() {
    if (initialized) return;
    initialized = true;
    settingsSnapshot = captureSettings();
    preloadFont();
    const on = (type, callback) => {
        if (type) eventSource.on(type, callback);
    };
    on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        mount();
        scheduleRender();
    });
    on(event_types.APP_READY, () => {
        mount();
        preloadFont();
    });
    on(event_types.SETTINGS_UPDATED, handleSettingsUpdated);
    on(event_types.PRESET_RENAMED, ({apiId, oldName, newName}) => {
        if (apiId !== "openai") return;
        const state = getState();
        let changed = false;
        if (Object.hasOwn(state.assignments, oldName)) {
            Object.defineProperty(state.assignments, newName, {value: state.assignments[oldName], enumerable: true, writable: true, configurable: true});
            delete state.assignments[oldName];
            changed = true;
        }
        if (state.favorites.includes(oldName)) {
            state.favorites = [...new Set(state.favorites.map((name) => (name === oldName ? newName : name)))];
            changed = true;
        }
        if (selectedNames.delete(oldName)) selectedNames.add(newName);
        invalidateCatalog();
        if (changed) saveState();
    });
    on(event_types.PRESET_DELETED, ({apiId, name}) => {
        if (apiId !== "openai") return;
        const state = getState();
        const changed = Object.hasOwn(state.assignments, name) || state.favorites.includes(name);
        delete state.assignments[name];
        state.favorites = state.favorites.filter((item) => item !== name);
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
        bootObserver.observe(document.body, {childList: true, subtree: true});
    }
}

if (!globalThis["prompt-box-loaded"]) {
    globalThis["prompt-box-loaded"] = true;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, {once: true});
    else initialize();
}
