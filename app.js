// app.js
// News to YouTube Studio - Frontend (카페24 호스팅용)
// Railway 백엔드 API와 연동

// ============================================================
// ⚠️ 중요: Render 배포 후 아래 URL을 실제 URL로 변경하세요!
// ============================================================
const API_BASE_URL = 'https://news-youtube-api.onrender.com'; // ← Render URL로 변경 필요!

// ============================================================
// 설정 및 전역 변수
// ============================================================
const STORAGE_KEYS = {
    model: 'nts_model',
    apiKey: 'nts_apiKey', // 🔑 추가
    mergedSummary: 'nts_mergedSummary',
    scriptInput: 'nts_scriptInput',
    transformResult: 'nts_transformResult',
    analysisInput: 'nts_analysisInput',
    structureResult: 'nts_structureResult',
    summaryResult: 'nts_summaryResult',
    topicInput: 'nts_topicInput',
    newScriptResult: 'nts_newScriptResult',
    titleInput: 'nts_titleInput',
    thumbnailInput: 'nts_thumbnailInput'
};

let newsData = [];

// ============================================================
// DOM 요소 참조
// ============================================================
const elements = {
    // 설정
    modelSelect: document.getElementById('modelSelect'),
    apiKeyInput: document.getElementById('apiKeyInput'), // 🔑 추가
    apiStatus: document.getElementById('apiStatus'),
    checkApiKeyBtn: document.getElementById('checkApiKeyBtn'), // 🔑 추가
    keyStatusIndicator: document.getElementById('keyStatusIndicator'), // 🔑 추가
    
    // 뉴스 섹션
    categorySelect: document.getElementById('categorySelect'),
    loadNewsBtn: document.getElementById('loadNewsBtn'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    mergeSelectedBtn: document.getElementById('mergeSelectedBtn'),
    newsLoading: document.getElementById('newsLoading'),
    newsList: document.getElementById('newsList'),
    mergedSummary: document.getElementById('mergedSummary'),
    copySummaryBtn: document.getElementById('copySummaryBtn'),
    
    // 탭 1: 대본 재구성
    scriptInput: document.getElementById('scriptInput'),
    conceptSelect: document.getElementById('conceptSelect'),
    customConcept: document.getElementById('customConcept'),
    lengthSelect: document.getElementById('lengthSelect'),
    transformBtn: document.getElementById('transformBtn'),
    transformLoading: document.getElementById('transformLoading'),
    transformResult: document.getElementById('transformResult'),
    copyTransformBtn: document.getElementById('copyTransformBtn'),
    
    // 탭 2: 구조 분석
    analysisInput: document.getElementById('analysisInput'),
    structureBtn: document.getElementById('structureBtn'),
    summaryBtn: document.getElementById('summaryBtn'),
    analysisLoading: document.getElementById('analysisLoading'),
    structureResult: document.getElementById('structureResult'),
    summaryResult: document.getElementById('summaryResult'),
    copyStructureBtn: document.getElementById('copyStructureBtn'),
    copySummaryResultBtn: document.getElementById('copySummaryResultBtn'),
    
    // 탭 3: 새 대본
    topicInput: document.getElementById('topicInput'),
    newConceptSelect: document.getElementById('newConceptSelect'),
    newLengthSelect: document.getElementById('newLengthSelect'),
    newScriptBtn: document.getElementById('newScriptBtn'),
    newScriptLoading: document.getElementById('newScriptLoading'),
    newScriptResult: document.getElementById('newScriptResult'),
    copyNewScriptBtn: document.getElementById('copyNewScriptBtn'),
    
    // 탭 4: 제목 생성
    titleInput: document.getElementById('titleInput'),
    titleBtn: document.getElementById('titleBtn'),
    titleLoading: document.getElementById('titleLoading'),
    safeTitlesList: document.getElementById('safeTitlesList'),
    clickbaitTitlesList: document.getElementById('clickbaitTitlesList'),
    copySafeTitlesBtn: document.getElementById('copySafeTitlesBtn'),
    copyClickbaitTitlesBtn: document.getElementById('copyClickbaitTitlesBtn'),
    
    // 탭 5: 썸네일 카피
    thumbnailInput: document.getElementById('thumbnailInput'),
    copyLengthSelect: document.getElementById('copyLengthSelect'),
    thumbnailBtn: document.getElementById('thumbnailBtn'),
    thumbnailLoading: document.getElementById('thumbnailLoading'),
    emotionalList: document.getElementById('emotionalList'),
    informationalList: document.getElementById('informationalList'),
    visualList: document.getElementById('visualList'),
    
    // 공통
    errorMessage: document.getElementById('errorMessage'),
    toast: document.getElementById('toast')
};

// ============================================================
// 유틸리티 함수
// ============================================================

function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorMessage.classList.remove('hidden');
    setTimeout(() => {
        elements.errorMessage.classList.add('hidden');
    }, 4000);
}

function showToast(message = '복사되었습니다!') {
    elements.toast.textContent = message;
    elements.toast.classList.remove('hidden');
    setTimeout(() => {
        elements.toast.classList.add('hidden');
    }, 2000);
}

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast();
    } catch (err) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast();
    }
}

function saveToLocalStorage(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (err) {
        console.warn('localStorage 저장 실패:', err);
    }
}

function getFromLocalStorage(key) {
    try {
        return localStorage.getItem(key);
    } catch (err) {
        return null;
    }
}

function restoreFromLocalStorage() {
    try {
        const savedModel = getFromLocalStorage(STORAGE_KEYS.model);
        if (savedModel) {
            elements.modelSelect.value = savedModel;
        }
        
        // 🔑 API Key 복원 로직 추가
        const savedApiKey = getFromLocalStorage(STORAGE_KEYS.apiKey);
        if (savedApiKey) {
            elements.apiKeyInput.value = savedApiKey;
        }
        
        const fieldsToRestore = [
            { el: elements.mergedSummary, key: STORAGE_KEYS.mergedSummary },
            { el: elements.scriptInput, key: STORAGE_KEYS.scriptInput },
            { el: elements.transformResult, key: STORAGE_KEYS.transformResult },
            { el: elements.analysisInput, key: STORAGE_KEYS.analysisInput },
            { el: elements.structureResult, key: STORAGE_KEYS.structureResult },
            { el: elements.summaryResult, key: STORAGE_KEYS.summaryResult },
            { el: elements.topicInput, key: STORAGE_KEYS.topicInput },
            { el: elements.newScriptResult, key: STORAGE_KEYS.newScriptResult },
            { el: elements.titleInput, key: STORAGE_KEYS.titleInput },
            { el: elements.thumbnailInput, key: STORAGE_KEYS.thumbnailInput }
        ];
        
        fieldsToRestore.forEach(({ el, key }) => {
            const saved = getFromLocalStorage(key);
            if (saved && el) {
                el.value = saved;
            }
        });
    } catch (err) {
        console.warn('localStorage 복원 실패:', err);
    }
}

function toggleLoading(loadingElement, show) {
    if (show) {
        loadingElement.classList.remove('hidden');
    } else {
        loadingElement.classList.add('hidden');
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================
// API 관련 함수
// ============================================================

async function checkServerConnection() {
    try {
        const response = await fetch(`${API_BASE_URL}/health`, {
            method: 'GET',
            timeout: 5000
        });
        
        if (response.ok) {
            elements.apiStatus.textContent = '🟢 서버 연결됨';
            elements.apiStatus.classList.add('connected');
            elements.apiStatus.classList.remove('error');
            return true;
        }
    } catch (error) {
        console.error('서버 연결 실패:', error);
    }
    
    elements.apiStatus.textContent = '🔴 서버 연결 실패';
    elements.apiStatus.classList.add('error');
    elements.apiStatus.classList.remove('connected');
    return false;
}

async function apiRequest(endpoint, method = 'GET', body = null) {
    const apiKey = elements.apiKeyInput.value.trim(); // 🔑 입력된 API 키 가져오기
    
    // AI 관련 엔드포인트 호출 시 키 유효성 검사
    if (endpoint.startsWith('/api/ai/') && !apiKey) { 
         throw new Error('OpenAI API 키를 입력해주세요.'); 
    }
    
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}` // 🔑 Authorization 헤더에 포함
        }
    };
    
    if (body) {
        options.body = JSON.stringify(body);
    }
    
    try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
        const data = await response.json();
        
        if (!response.ok) {
            // 서버에서 명시적으로 오류 메시지를 반환한 경우
            throw new Error(data.error || `API 오류 (${response.status}): ${data.message || '알 수 없는 오류'}`);
        }
        
        return data;
    } catch (error) {
        if (error.name === 'TypeError') {
            throw new Error('서버에 연결할 수 없습니다. 네트워크를 확인해주세요.');
        }
        throw error;
    }
}

// 🔑 키 유효성 검사 함수
async function checkApiKeyValidity() {
    const apiKey = elements.apiKeyInput.value.trim();
    
    if (!apiKey) {
        showError('API 키를 먼저 입력해주세요.');
        return;
    }
    
    elements.keyStatusIndicator.classList.remove('hidden', 'connected', 'error');
    elements.keyStatusIndicator.textContent = '🔄 확인 중...';
    elements.checkApiKeyBtn.disabled = true;
    
    try {
        // 백엔드의 새로운 키 체크 엔드포인트 호출 (가장 저렴한 모델 사용)
        await apiRequest('/api/ai/check-key', 'POST', { model: 'gpt-4o-mini' });
        
        elements.keyStatusIndicator.textContent = '✅ 키 유효함!';
        elements.keyStatusIndicator.classList.add('connected');
        showToast('API 키가 유효합니다.');
        return true;
        
    } catch (error) {
        let message = error.message;
        
        if (message.includes('유효하지 않습니다')) {
            message = '❌ 유효하지 않은 키입니다. (401 오류)';
        } else if (message.includes('API 키를 입력해주세요')) {
             message = '❌ 키를 입력해주세요.';
        } else {
             message = `❌ 서버 오류: ${message.substring(0, 30)}...`;
        }
        
        elements.keyStatusIndicator.textContent = message;
        elements.keyStatusIndicator.classList.add('error');
        showError(message);
        return false;
    } finally {
        elements.checkApiKeyBtn.disabled = false;
        elements.keyStatusIndicator.classList.remove('hidden');
    }
}


// ============================================================
// 뉴스 관련 함수
// ============================================================

async function loadNews() {
    const category = elements.categorySelect.value;
    
    toggleLoading(elements.newsLoading, true);
    elements.newsList.innerHTML = '';
    elements.loadNewsBtn.disabled = true;
    
    try {
        // AI 요약 기능은 서버에서 제거되었으므로, 뉴스 목록만 요청
        newsData = await apiRequest(`/api/naver-news?category=${encodeURIComponent(category)}`);
        renderNewsList(newsData);
    } catch (error) {
        showError(error.message);
    } finally {
        toggleLoading(elements.newsLoading, false);
        elements.loadNewsBtn.disabled = false;
    }
}

function renderNewsList(news) {
    if (!news || news.length === 0) {
        elements.newsList.innerHTML = '<div class="no-news">뉴스를 불러올 수 없습니다.</div>';
        return;
    }
    
    elements.newsList.innerHTML = news.map((item, index) => `
        <div class="news-item" data-index="${index}">
            <div class="news-item-check">
                <input type="checkbox" id="news-${index}" data-index="${index}">
            </div>
            <div class="news-item-content">
                <div>
                    <span class="news-item-rank">${item.rank}위</span>
                    <span class="news-item-title">${escapeHtml(item.title)}</span>
                </div>
                <div class="news-item-meta">
                    <span>${escapeHtml(item.press || '')}</span>
                    <span>${escapeHtml(item.time || '')}</span>
                </div>
                <div class="news-item-summary">${escapeHtml(item.summary || item.title)}</div>
            </div>
            <div>
                <a href="${escapeHtml(item.link)}" target="_blank" rel="noopener" class="news-item-link">기사 보기 →</a>
            </div>
        </div>
    `).join('');
}

function selectAllNews() {
    document.querySelectorAll('.news-item input[type="checkbox"]').forEach(cb => {
        cb.checked = true;
    });
}

function deselectAllNews() {
    document.querySelectorAll('.news-item input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
    });
}

function mergeSelectedSummaries() {
    const checkedBoxes = document.querySelectorAll('.news-item input[type="checkbox"]:checked');
    
    if (checkedBoxes.length === 0) {
        showError('선택된 기사가 없습니다.');
        return;
    }
    
    const summaries = [];
    checkedBoxes.forEach(cb => {
        const index = parseInt(cb.dataset.index);
        if (newsData[index]) {
            summaries.push(`[${newsData[index].rank}위] ${newsData[index].title}\n${newsData[index].summary || newsData[index].title}`);
        }
    });
    
    const merged = summaries.join('\n\n---\n\n');
    elements.mergedSummary.value = merged;
    saveToLocalStorage(STORAGE_KEYS.mergedSummary, merged);
}

// ============================================================
// AI 기능 함수들
// ============================================================

async function runScriptTransform() {
    const text = elements.scriptInput.value.trim();
    
    if (!text) {
        showError('재구성할 텍스트를 입력해주세요.');
        return;
    }
    
    let concept = elements.conceptSelect.value;
    if (concept === 'custom') {
        concept = elements.customConcept.value.trim() || '일반';
    }
    const lengthOption = elements.lengthSelect.value;
    const model = elements.modelSelect.value;
    
    toggleLoading(elements.transformLoading, true);
    elements.transformBtn.disabled = true;
    
    try {
        const data = await apiRequest('/api/ai/script-transform', 'POST', {
            text,
            concept,
            lengthOption,
            model
        });
        
        elements.transformResult.value = data.script;
        saveToLocalStorage(STORAGE_KEYS.transformResult, data.script);
    } catch (error) {
        showError(error.message);
    } finally {
        toggleLoading(elements.transformLoading, false);
        elements.transformBtn.disabled = false;
    }
}

async function runStructureAnalysis() {
    const text = elements.analysisInput.value.trim();
    
    if (!text) {
        showError('분석할 텍스트를 입력해주세요.');
        return;
    }
    
    const model = elements.modelSelect.value;
    
    toggleLoading(elements.analysisLoading, true);
    elements.structureBtn.disabled = true;
    
    try {
        const data = await apiRequest('/api/ai/structure', 'POST', { text, model });
        elements.structureResult.value = data.structure;
        saveToLocalStorage(STORAGE_KEYS.structureResult, data.structure);
    } catch (error) {
        showError(error.message);
    } finally {
        toggleLoading(elements.analysisLoading, false);
        elements.structureBtn.disabled = false;
    }
}

async function runSummary() {
    const text = elements.analysisInput.value.trim();
    
    if (!text) {
        showError('요약할 텍스트를 입력해주세요.');
        return;
    }
    
    const model = elements.modelSelect.value;
    
    toggleLoading(elements.analysisLoading, true);
    elements.summaryBtn.disabled = true;
    
    try {
        const data = await apiRequest('/api/ai/summary', 'POST', { text, model });
        elements.summaryResult.value = data.summary;
        saveToLocalStorage(STORAGE_KEYS.summaryResult, data.summary);
    } catch (error) {
        showError(error.message);
    } finally {
        toggleLoading(elements.analysisLoading, false);
        elements.summaryBtn.disabled = false;
    }
}

async function runNewScript() {
    const topic = elements.topicInput.value.trim();
    
    if (!topic) {
        showError('주제/키워드를 입력해주세요.');
        return;
    }
    
    const concept = elements.newConceptSelect.value;
    const lengthOption = elements.newLengthSelect.value;
    const model = elements.modelSelect.value;
    
    toggleLoading(elements.newScriptLoading, true);
    elements.newScriptBtn.disabled = true;
    
    try {
        const data = await apiRequest('/api/ai/script-new', 'POST', {
            topic,
            concept,
            lengthOption,
            model
        });
        
        elements.newScriptResult.value = data.script;
        saveToLocalStorage(STORAGE_KEYS.newScriptResult, data.script);
    } catch (error) {
        showError(error.message);
    } finally {
        toggleLoading(elements.newScriptLoading, false);
        elements.newScriptBtn.disabled = false;
    }
}

async function runTitleGeneration() {
    const text = elements.titleInput.value.trim();
    
    if (!text) {
        showError('제목 생성 기준 텍스트를 입력해주세요.');
        return;
    }
    
    const model = elements.modelSelect.value;
    
    toggleLoading(elements.titleLoading, true);
    elements.titleBtn.disabled = true;
    
    try {
        const data = await apiRequest('/api/ai/titles', 'POST', { text, model });
        renderTitles(data.safeTitles || [], elements.safeTitlesList);
        renderTitles(data.clickbaitTitles || [], elements.clickbaitTitlesList);
    } catch (error) {
        showError(error.message);
    } finally {
        toggleLoading(elements.titleLoading, false);
        elements.titleBtn.disabled = false;
    }
}

function renderTitles(titles, container) {
    if (!titles || titles.length === 0) {
        container.innerHTML = '<li><span class="title-text">결과가 없습니다.</span></li>';
        return;
    }
    
    container.innerHTML = titles.map(title => `
        <li>
            <span class="title-text">${escapeHtml(title)}</span>
            <button class="copy-item-btn" onclick="copyToClipboard('${escapeHtml(title).replace(/'/g, "\\'")}')">📋</button>
        </li>
    `).join('');
}

async function runThumbnailCopyGeneration() {
    const text = elements.thumbnailInput.value.trim();
    
    if (!text) {
        showError('썸네일 카피 생성 기준 텍스트를 입력해주세요.');
        return;
    }
    
    const lengthOption = elements.copyLengthSelect.value;
    const model = elements.modelSelect.value;
    
    toggleLoading(elements.thumbnailLoading, true);
    elements.thumbnailBtn.disabled = true;
    
    try {
        const data = await apiRequest('/api/ai/thumbnail-copies', 'POST', {
            text,
            lengthOption,
            model
        });
        
        renderCopies(data.emotional || [], elements.emotionalList);
        renderCopies(data.informational || [], elements.informationalList);
        renderCopies(data.visual || [], elements.visualList);
        
        // 전체 복사용 데이터 저장
        elements.emotionalList.dataset.copies = JSON.stringify(data.emotional || []);
        elements.informationalList.dataset.copies = JSON.stringify(data.informational || []);
        elements.visualList.dataset.copies = JSON.stringify(data.visual || []);
    } catch (error) {
        showError(error.message);
    } finally {
        toggleLoading(elements.thumbnailLoading, false);
        elements.thumbnailBtn.disabled = false;
    }
}

function renderCopies(copies, container) {
    if (!copies || copies.length === 0) {
        container.innerHTML = '<li><span class="copy-text">결과가 없습니다.</span></li>';
        return;
    }
    
    container.innerHTML = copies.map(copy => `
        <li>
            <span class="copy-text">${escapeHtml(copy)}</span>
            <button class="copy-item-btn" onclick="copyToClipboard('${escapeHtml(copy).replace(/'/g, "\\'")}')">📋</button>
        </li>
    `).join('');
}

// ============================================================
// 탭 전환 함수
// ============================================================

function initTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanels.forEach(p => p.classList.remove('active'));
            
            btn.classList.add('active');
            const tabId = btn.dataset.tab;
            document.getElementById(tabId).classList.add('active');
        });
    });
}

// ============================================================
// 이벤트 리스너 설정
// ============================================================

function initEventListeners() {
    // 모델 선택 저장
    elements.modelSelect.addEventListener('change', () => {
        saveToLocalStorage(STORAGE_KEYS.model, elements.modelSelect.value);
    });
    
    // 🔑 API Key 입력 시 저장 (키 입력 시 바로 로컬스토리지에 저장되도록 수정)
    elements.apiKeyInput.addEventListener('input', () => {
        saveToLocalStorage(STORAGE_KEYS.apiKey, elements.apiKeyInput.value.trim());
    });
    
    // 🔑 키 유효성 검사 버튼
    elements.checkApiKeyBtn.addEventListener('click', checkApiKeyValidity);
    
    // 뉴스 섹션
    elements.loadNewsBtn.addEventListener('click', loadNews);
    elements.selectAllBtn.addEventListener('click', selectAllNews);
    elements.deselectAllBtn.addEventListener('click', deselectAllNews);
    elements.mergeSelectedBtn.addEventListener('click', mergeSelectedSummaries);
    elements.copySummaryBtn.addEventListener('click', () => {
        copyToClipboard(elements.mergedSummary.value);
    });
    
    // 탭 1: 대본 재구성
    elements.conceptSelect.addEventListener('change', () => {
        if (elements.conceptSelect.value === 'custom') {
            elements.customConcept.classList.remove('hidden');
        } else {
            elements.customConcept.classList.add('hidden');
        }
    });
    elements.transformBtn.addEventListener('click', runScriptTransform);
    elements.copyTransformBtn.addEventListener('click', () => {
        copyToClipboard(elements.transformResult.value);
    });
    
    // 탭 2: 구조 분석
    elements.structureBtn.addEventListener('click', runStructureAnalysis);
    elements.summaryBtn.addEventListener('click', runSummary);
    elements.copyStructureBtn.addEventListener('click', () => {
        copyToClipboard(elements.structureResult.value);
    });
    elements.copySummaryResultBtn.addEventListener('click', () => {
        copyToClipboard(elements.summaryResult.value);
    });
    
    // 탭 3: 새 대본
    elements.newScriptBtn.addEventListener('click', runNewScript);
    elements.copyNewScriptBtn.addEventListener('click', () => {
        copyToClipboard(elements.newScriptResult.value);
    });
    
    // 탭 4: 제목 생성
    elements.titleBtn.addEventListener('click', runTitleGeneration);
    elements.copySafeTitlesBtn.addEventListener('click', () => {
        const titles = Array.from(elements.safeTitlesList.querySelectorAll('.title-text'))
            .map(el => el.textContent).join('\n');
        copyToClipboard(titles);
    });
    elements.copyClickbaitTitlesBtn.addEventListener('click', () => {
        const titles = Array.from(elements.clickbaitTitlesList.querySelectorAll('.title-text'))
            .map(el => el.textContent).join('\n');
        copyToClipboard(titles);
    });
    
    // 탭 5: 썸네일 카피
    elements.thumbnailBtn.addEventListener('click', runThumbnailCopyGeneration);
    document.querySelector('.copy-emotional').addEventListener('click', () => {
        const copies = JSON.parse(elements.emotionalList.dataset.copies || '[]');
        copyToClipboard(copies.join('\n'));
    });
    document.querySelector('.copy-informational').addEventListener('click', () => {
        const copies = JSON.parse(elements.informationalList.dataset.copies || '[]');
        copyToClipboard(copies.join('\n'));
    });
    document.querySelector('.copy-visual').addEventListener('click', () => {
        const copies = JSON.parse(elements.visualList.dataset.copies || '[]');
        copyToClipboard(copies.join('\n'));
    });
    
    // textarea 자동 저장
    const textareaToStorage = [
        { el: elements.mergedSummary, key: STORAGE_KEYS.mergedSummary },
        { el: elements.scriptInput, key: STORAGE_KEYS.scriptInput },
        { el: elements.transformResult, key: STORAGE_KEYS.transformResult },
        { el: elements.analysisInput, key: STORAGE_KEYS.analysisInput },
        { el: elements.structureResult, key: STORAGE_KEYS.structureResult },
        { el: elements.summaryResult, key: STORAGE_KEYS.summaryResult },
        { el: elements.newScriptResult, key: STORAGE_KEYS.newScriptResult },
        { el: elements.titleInput, key: STORAGE_KEYS.titleInput },
        { el: elements.thumbnailInput, key: STORAGE_KEYS.thumbnailInput }
    ];
    
    textareaToStorage.forEach(({ el, key }) => {
        if (el) {
            el.addEventListener('input', () => {
                saveToLocalStorage(key, el.value);
            });
        }
    });
    
    elements.topicInput.addEventListener('input', () => {
        saveToLocalStorage(STORAGE_KEYS.topicInput, elements.topicInput.value);
    });
}

// ============================================================
// 초기화
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initEventListeners();
    restoreFromLocalStorage();
    checkServerConnection();
    
    console.log('✅ News to YouTube Studio 초기화 완료');
    console.log('📡 API 서버:', API_BASE_URL);
});