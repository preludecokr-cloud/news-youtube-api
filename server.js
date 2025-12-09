// server.js - Full Integrated Version (Fixed & Complete)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// 1. 미들웨어 설정 (필수)
// ------------------------------------------------------------
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ------------------------------------------------------------
// 2. 유틸리티 함수
// ------------------------------------------------------------
function getApiKeyFromHeader(req) {
    const auth = req.headers.authorization || '';
    if (!auth) return null;
    const parts = auth.split(' ');
    // "Bearer API_KEY" 형식 파싱
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
        return parts[1].trim();
    }
    return auth.trim();
}

// ------------------------------------------------------------
// 3. 네이버 뉴스 크롤링 로직 (랭킹 + 섹션 + 본문)
// ------------------------------------------------------------

// (1) 뉴스 본문 스크래핑
async function scrapeNewsContent(url) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            responseType: 'arraybuffer', // 인코딩 처리를 위해 버퍼로 받음
            timeout: 10000,
        });

        // EUC-KR 디코딩 (네이버 뉴스 대부분)
        const html = iconv.decode(response.data, 'euc-kr');
        const $ = cheerio.load(html);

        // 본문 추출 시도 (다양한 레이아웃 대응)
        let content = $('#dic_area').text().trim();
        if (!content) content = $('#newsEndContents').text().trim(); // 연예
        if (!content) content = $('#articeBody').text().trim();      // 스포츠/구버전
        if (!content) content = $('.go_trans').text().trim();        // 기타

        // 줄바꿈 정리
        return content.replace(/\n\s*\n/g, '\n\n').replace(/\t/g, '');
    } catch (error) {
        console.error('Content scraping error:', error.message);
        throw new Error('본문을 불러올 수 없습니다. (접근 불가 혹은 구조 변경)');
    }
}

// (2) 뉴스 리스트 스크래핑
async function scrapeNaverNews(categoryOrCode) {
    const labelToCode = {
        '정치': '100', '경제': '101', '사회': '102',
        '생활/문화': '103', '세계': '104', 'IT/과학': '105'
    };

    // --- CASE A: 랭킹 뉴스 ---
    if (categoryOrCode === '랭킹') {
        const url = 'https://news.naver.com/main/ranking/popular.naver';
        try {
            const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer' });
            const html = iconv.decode(response.data, 'euc-kr');
            const $ = cheerio.load(html);
            const news = [];
            let globalRank = 1;

            $('.rankingnews_box').each((i, box) => {
                const pressName = $(box).find('.rankingnews_name').text().trim();
                $(box).find('li').each((j, li) => {
                    if (globalRank > 50) return false;
                    
                    const $a = $(li).find('a').first();
                    const title = $a.text().trim();
                    const href = $a.attr('href');
                    const time = $(li).find('.rankingnews_time').text().trim();

                    if (title && href) {
                        news.push({
                            rank: globalRank++,
                            title: title,
                            link: href,
                            press: pressName,
                            time: time,
                            views: 'TOP랭킹'
                        });
                    }
                });
            });
            return news;
        } catch (e) {
            throw new Error('랭킹 뉴스 수집 실패: ' + e.message);
        }
    }

    // --- CASE B: 일반 섹션 뉴스 ---
    let sid = '100'; // 기본값 정치
    if (categoryOrCode && labelToCode[categoryOrCode]) sid = labelToCode[categoryOrCode];

    const url = `https://news.naver.com/main/list.naver?mode=LSD&mid=sec&sid1=${sid}`;
    
    try {
        const response = await axios.get(url, { 
            headers: { 'User-Agent': 'Mozilla/5.0' }, 
            responseType: 'arraybuffer', 
            timeout: 10000 
        });
        
        const html = iconv.decode(response.data, 'euc-kr');
        const $ = cheerio.load(html);
        const news = [];
        let rank = 1;

        $('.newsflash_body .type06_headline li, .newsflash_body .type06 li').each((i, el) => {
            if (rank > 50) return false;
            const $item = $(el);

            // 썸네일 존재 여부에 따른 제목 위치 찾기
            let $a;
            if ($item.find('dt.photo').length > 0) {
                $a = $item.find('dt').not('.photo').find('a').first();
            } else {
                $a = $item.find('dt').first().find('a');
                if ($a.length === 0) $a = $item.find('a').first();
            }

            const title = $a.text().trim();
            const href = $a.attr('href');
            if (!title || !href) return;

            const press = $item.find('.writing').text().trim();
            const time = $item.find('.date').text().trim();

            news.push({
                rank: rank++,
                title: title,
                link: href,
                press: press,
                time: time,
                views: '-'
            });
        });
        return news;
    } catch (error) {
        throw new Error('뉴스 섹션 로드 실패: ' + error.message);
    }
}

// ------------------------------------------------------------
// 4. AI 통합 호출 함수 (Gemini + OpenAI)
// ------------------------------------------------------------
async function callAI(systemPrompt, userPrompt, model, apiKey) {
    if (!apiKey) throw new Error('API 키를 입력해주세요.');
    const cleanKey = apiKey.trim();
    const lowerModel = (model || '').toLowerCase();

    // OpenAI (GPT)
    if (lowerModel.includes('gpt')) {
        try {
            const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-4o', // 혹은 model 변수 사용
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.7
            }, { 
                headers: { 'Authorization': `Bearer ${cleanKey}` } 
            });
            return resp.data.choices[0].message.content.trim();
        } catch (e) {
            const msg = e.response?.data?.error?.message || e.message;
            throw new Error('OpenAI Error: ' + msg);
        }
    }

    // Google (Gemini)
    if (lowerModel.includes('gemini') || lowerModel.includes('flash')) {
        try {
            const genAI = new GoogleGenerativeAI(cleanKey);
            // 모델명 매핑
            let targetModel = 'gemini-1.5-flash';
            if (lowerModel.includes('2.0') || lowerModel.includes('exp')) {
                targetModel = 'gemini-2.0-flash-exp';
            } else if (lowerModel.includes('pro')) {
                targetModel = 'gemini-1.5-pro';
            }

            const generativeModel = genAI.getGenerativeModel({ model: targetModel });
            
            // Gemini는 시스템 프롬프트 API가 다르므로 유저 프롬프트에 병합
            const finalPrompt = `[System Instructions]\n${systemPrompt}\n\n[User Request]\n${userPrompt}`;
            
            const result = await generativeModel.generateContent(finalPrompt);
            return result.response.text();
        } catch (e) {
            throw new Error('Gemini Error: ' + e.message);
        }
    }

    throw new Error(`지원하지 않는 모델입니다: ${model}`);
}

// ------------------------------------------------------------
// 5. API 라우트 정의 (빠짐없이 모두 포함)
// ------------------------------------------------------------

// 기본 헬스 체크
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Server is running' });
});

// [News API] 뉴스 리스트
app.get('/api/naver-news', async (req, res) => {
    try {
        const category = req.query.category || '정치';
        const news = await scrapeNaverNews(category);
        res.json(news);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// [News API] 뉴스 본문
app.post('/api/news-content', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    try {
        const content = await scrapeNewsContent(url);
        res.json({ content });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// [AI API] 요약
app.post('/api/ai/summary', async (req, res) => {
    try {
        const { text, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = "당신은 뉴스 요약 전문가입니다. 핵심 내용을 3~5줄로 요약하여 한국어로 출력하세요.";
        const summary = await callAI(system, text, model, apiKey);
        res.json({ summary });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// [AI API] 대본 재구성
app.post('/api/ai/script-transform', async (req, res) => {
    try {
        const { text, concept, lengthOption, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = `유튜브 대본 작가입니다. 다음 텍스트를 [${concept}] 컨셉, [${lengthOption}] 분량의 대본으로 재구성하세요.`;
        const script = await callAI(system, text, model, apiKey);
        res.json({ script });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// [AI API] 새 대본 작성
app.post('/api/ai/script-new', async (req, res) => {
    try {
        const { topic, concept, lengthOption, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = `유튜브 시나리오 작가입니다. 주제 '[${topic}]'에 대해 [${concept}] 스타일로 대본을 작성하세요.`;
        const script = await callAI(system, topic, model, apiKey);
        res.json({ script });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// [AI API] 구조 분석
app.post('/api/ai/structure', async (req, res) => {
    try {
        const { text, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = "텍스트 구조 분석가입니다. [도입-전개-위기-절정-결말] 혹은 [Hook-문제-해결] 구조로 분석해 한국어로 출력하세요.";
        const structure = await callAI(system, text, model, apiKey);
        res.json({ structure });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// [AI API] 제목 생성 (JSON 응답)
app.post('/api/ai/titles', async (req, res) => {
    try {
        const { text, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = `유튜브 제목 생성기입니다. JSON 형식으로만 응답하세요: {"safeTitles": ["제목1", "제목2"], "clickbaitTitles": ["자극1", "자극2"]}`;
        
        let result = await callAI(system, text, model, apiKey);
        // JSON 추출 로직 강화
        result = result.replace(/```json/gi, '').replace(/```/g, '').trim();
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result);
        
        res.json(parsed);
    } catch (e) {
        console.error(e);
        // 에러 시에도 빈 배열 반환하여 프론트엔드 에러 방지
        res.json({ safeTitles: ["오류 발생: API 키를 확인하세요"], clickbaitTitles: [] });
    }
});

// [AI API] 썸네일 카피 (JSON 응답)
app.post('/api/ai/thumbnail-copies', async (req, res) => {
    try {
        const { text, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = `썸네일 카피라이터입니다. JSON 형식으로만 응답하세요: {"emotional": [], "informational": [], "visual": []}`;
        
        let result = await callAI(system, text, model, apiKey);
        result = result.replace(/```json/gi, '').replace(/```/g, '').trim();
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result);
        
        res.json(parsed);
    } catch (e) {
        console.error(e);
        res.json({ emotional: ["오류 발생"], informational: [], visual: [] });
    }
});

// ------------------------------------------------------------
// 6. 서버 시작
// ------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});