// app.js - Layout Update Version

document.addEventListener('DOMContentLoaded', () => {
    // ... (기본 설정 및 API URL 등은 동일) ...
    const API_BASE_URL = 'https://news-youtube-api.onrender.com';
    const STORAGE_KEYS = { apiKey: 'studio_red_api_key', model: 'studio_red_model' };
    window.appData = { news: [], currentCategory: '랭킹' }; // 카테고리 기본값

    // --- DOM 요소 ---
    const getEl = (id) => document.getElementById(id);
    const getAll = (sel) => document.querySelectorAll(sel);

    const ui = {
        // [뉴스 섹션 변경 요소]
        categoryButtons: getAll('.cat-btn'), // 버튼 그룹
        loadNewsBtn: getEl('loadNewsBtn'),
        newsList: getEl('newsList'),
        selectAllBtn: getEl('selectAllBtn'),
        mergeSelectedBtn: getEl('mergeSelectedBtn'),
        mergedSummary: getEl('mergedSummary'),
        
        // ... (나머지 기존 요소들 유지) ...
        navItems: getAll('.nav-item[data-target]'),
        sections: getAll('.content-section'),
        pageTitle: getEl('pageTitle'),
        settingsModal: getEl('settingsModal'),
        openSettingsBtn: getEl('openSettingsBtn'),
        closeSettingsBtn: getEl('closeSettingsBtn'),
        saveApiBtn: getEl('saveApiBtn'),
        apiKeyInput: getEl('apiKeyInput'),
        modelSelect: getEl('modelSelect'),
        apiStatusBadge: getEl('apiStatusBadge'),
        themeToggle: getEl('themeToggle'),
        
        // 대본, 구조분석 등 다른 섹션 요소들도 기존 코드 그대로 유지...
        scriptInput: getEl('scriptInput'), conceptSelect: getEl('conceptSelect'), lengthSelect: getEl('lengthSelect'), transformBtn: getEl('transformBtn'), transformResult: getEl('transformResult'), transformLoading: getEl('transformLoading'), copyTransformBtn: getEl('copyTransformBtn'),
        newScriptBtn: getEl('newScriptBtn'), topicInput: getEl('topicInput'), newConceptSelect: getEl('newConceptSelect'), newLengthSelect: getEl('newLengthSelect'), newScriptResult: getEl('newScriptResult'), newScriptLoading: getEl('newScriptLoading'), copyNewScriptBtn: getEl('copyNewScriptBtn'),
        analysisInput: getEl('analysisInput'), structureBtn: getEl('structureBtn'), structureResult: getEl('structureResult'), analysisLoading: getEl('analysisLoading'), copyStructureBtn: getEl('copyStructureBtn'),
        titleInput: getEl('titleInput'), titleBtn: getEl('titleBtn'), titleLoading: getEl('titleLoading'), safeTitlesList: getEl('safeTitlesList'), clickbaitTitlesList: getEl('clickbaitTitlesList'), copySafeTitlesBtn: getEl('copySafeTitlesBtn'), copyClickbaitTitlesBtn: getEl('copyClickbaitTitlesBtn'),
        thumbnailInput: getEl('thumbnailInput'), copyLengthSelect: getEl('copyLengthSelect'), thumbnailBtn: getEl('thumbnailBtn'), thumbnailLoading: getEl('thumbnailLoading'), emotionalList: getEl('emotionalList'), informationalList: getEl('informationalList'), visualList: getEl('visualList'), toast: getEl('toast')
    };

    function init() {
        loadSettings();
        updateApiStatus();
        attachEventListeners();
    }

    function loadSettings() {
        const key = localStorage.getItem(STORAGE_KEYS.apiKey);
        if(key && ui.apiKeyInput) ui.apiKeyInput.value = key;
    }
    
    function updateApiStatus() {
        const key = localStorage.getItem(STORAGE_KEYS.apiKey);
        if(!ui.apiStatusBadge) return;
        if(key) { ui.apiStatusBadge.className = 'status-badge success'; ui.apiStatusBadge.innerHTML = '<i class="ri-check-line"></i> API 연결됨'; }
        else { ui.apiStatusBadge.className = 'status-badge warning'; ui.apiStatusBadge.innerHTML = '<i class="ri-alert-line"></i> API 키 필요'; }
    }

    // --- 이벤트 리스너 ---
    function attachEventListeners() {
        // 1. 카테고리 버튼 클릭 이벤트 (신규 추가)
        ui.categoryButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                // UI 업데이트
                ui.categoryButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                // 상태 업데이트
                window.appData.currentCategory = btn.dataset.value;
                // (선택사항) 버튼 누르면 바로 로딩하려면 아래 주석 해제
                // handleLoadNews();
            });
        });

        // 뉴스 로딩
        if(ui.loadNewsBtn) ui.loadNewsBtn.addEventListener('click', handleLoadNews);
        if(ui.selectAllBtn) ui.selectAllBtn.addEventListener('click', handleSelectAllNews);
        if(ui.mergeSelectedBtn) ui.mergeSelectedBtn.addEventListener('click', handleMergeNews);

        // ... (나머지 기존 이벤트 리스너들은 그대로 유지) ...
        if(ui.navItems) ui.navItems.forEach(btn => btn.addEventListener('click', handleNavClick));
        if(ui.openSettingsBtn) ui.openSettingsBtn.addEventListener('click', () => ui.settingsModal.classList.remove('hidden'));
        if(ui.closeSettingsBtn) ui.closeSettingsBtn.addEventListener('click', () => ui.settingsModal.classList.add('hidden'));
        if(ui.saveApiBtn) ui.saveApiBtn.addEventListener('click', saveSettings);
        if(ui.transformBtn) ui.transformBtn.addEventListener('click', handleTransformScript);
        if(ui.newScriptBtn) ui.newScriptBtn.addEventListener('click', handleNewScript);
        if(ui.structureBtn) ui.structureBtn.addEventListener('click', handleStructureAnalysis);
        if(ui.titleBtn) ui.titleBtn.addEventListener('click', handleTitleGeneration);
        if(ui.thumbnailBtn) ui.thumbnailBtn.addEventListener('click', handleThumbnailGeneration);
    }

    // --- 뉴스 로딩 핸들러 (수정됨) ---
    async function handleLoadNews() {
        setLoading(ui.newsList, true, 'spinner');
        try {
            // 버튼에서 선택된 카테고리 값 사용
            const category = window.appData.currentCategory || '정치';
            const data = await callApi(`/api/naver-news?category=${encodeURIComponent(category)}`);
            
            if(!data || data.length === 0) {
                ui.newsList.innerHTML = '<div class="empty-state">뉴스가 없습니다.</div>';
                return;
            }
            
            window.appData.news = data;
            
            // 그리드 형태에 맞게 렌더링
            ui.newsList.innerHTML = data.map((item, idx) => `
                <div class="news-item" onclick="toggleCheckbox(${idx})">
                    <div class="news-info">
                        <span class="news-rank">${item.rank}</span>
                        <div style="flex:1; overflow:hidden;">
                            <span class="news-title">${escapeHtml(item.title)}</span>
                            <div style="font-size:0.75rem; color:#64748b; margin-top:4px;">${item.press || ''}</div>
                        </div>
                    </div>
                    <input type="checkbox" class="news-check" id="check-${idx}" data-idx="${idx}" onclick="event.stopPropagation()">
                </div>
            `).join('');
        } catch(e) {
            ui.newsList.innerHTML = `<div class="empty-state error">오류: ${e.message}</div>`;
        }
    }

    // --- 공통 함수 (기존 유지) ---
    function handleNavClick(e) {
        const btn = e.currentTarget;
        ui.navItems.forEach(i => i.classList.remove('active'));
        btn.classList.add('active');
        const targetId = btn.dataset.target;
        ui.sections.forEach(sec => sec.classList.remove('active'));
        document.getElementById(targetId).classList.add('active');
        ui.pageTitle.textContent = btn.querySelector('span').textContent;
    }

    function saveSettings() {
        const key = ui.apiKeyInput.value.trim();
        if(!key) { showToast('API 키 입력 필요'); return; }
        localStorage.setItem(STORAGE_KEYS.apiKey, key);
        updateApiStatus();
        ui.settingsModal.classList.add('hidden');
        showToast('저장 완료');
    }

    async function callApi(endpoint, method = 'GET', body = null) {
        const key = localStorage.getItem(STORAGE_KEYS.apiKey);
        if(endpoint.includes('/ai/') && !key) { ui.settingsModal.classList.remove('hidden'); throw new Error('API 키 필요'); }
        const headers = { 'Content-Type': 'application/json' };
        if(key) headers['Authorization'] = `Bearer ${key}`;
        const options = { method, headers };
        if(body) { body.model = localStorage.getItem(STORAGE_KEYS.model) || 'gemini-2.5-flash'; options.body = JSON.stringify(body); }
        try {
            const res = await fetch(`${API_BASE_URL}${endpoint}`, options);
            const data = await res.json();
            if(!res.ok) throw new Error(data.error || '오류');
            return data;
        } catch(err) { console.error(err); throw err; }
    }

    function handleSelectAllNews() {
        const checks = document.querySelectorAll('.news-check');
        const allChecked = Array.from(checks).every(c => c.checked);
        checks.forEach(c => c.checked = !allChecked);
    }

    function handleMergeNews() {
        const checks = document.querySelectorAll('.news-check:checked');
        if(checks.length === 0) { showToast('선택된 기사 없음'); return; }
        const summaries = Array.from(checks).map(chk => {
            const item = window.appData.news[chk.dataset.idx];
            return `[${item.rank}위] ${item.title}`;
        }).join('\n');
        ui.mergedSummary.value = summaries;
    }
    
    // 나머지 AI 핸들러들 (handleTransformScript, handleNewScript 등)은 이전 코드와 동일하게 유지...
    // (지면상 생략했으나 실제 적용 시엔 이전 app.js의 해당 함수들을 포함해야 합니다.)
    async function handleTransformScript() { /* ... */ }
    async function handleNewScript() { /* ... */ }
    async function handleStructureAnalysis() { /* ... */ }
    async function handleTitleGeneration() { /* ... */ }
    async function handleThumbnailGeneration() { /* ... */ }

    // 유틸
    window.toggleCheckbox = (idx) => { const chk = document.getElementById(`check-${idx}`); if(chk) chk.checked = !chk.checked; };
    function showToast(msg) { ui.toast.textContent = msg; ui.toast.classList.remove('hidden'); setTimeout(() => ui.toast.classList.add('hidden'), 3000); }
    function setLoading(el, isLoading, type) { if(!el) return; if(type==='spinner') el.innerHTML = isLoading ? '<div class="spinner"></div>' : ''; else isLoading ? el.classList.remove('hidden') : el.classList.add('hidden'); }
    function escapeHtml(t) { return t ? t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : ''; }

    init();
});