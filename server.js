// server.js
// News to YouTube Studio - Backend Server (Render 배포용)
// 최종 수정: 오류 예측 방어 및 호환성 강화 버전

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// 대용량 데이터 처리를 위한 설정
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));

// ============================================================
// AI 호출 로직 (오류 방어 적용)
// ============================================================

// 1. OpenAI 호출 (기존 유지)
async function callOpenAI(systemPrompt, userPrompt, model, apiKey) {
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            temperature: 0.7
        }, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        throw new Error(`OpenAI 오류: ${error.response?.data?.error?.message || error.message}`);
    }
}

// 2. Gemini 호출 (404 Not Found 및 안전 필터 방어)
async function callGemini(systemPrompt, userPrompt, model, apiKey) {
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        
        // [방어 1] 안전 필터 무조건 해제 (뉴스/범죄 기사 처리 시 에러 방지)
        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ];

        // [방어 2] 모델명 강제 보정 (혹시 모를 오타 방지)
        let targetModel = 'gemini-2.5-flash'; // 기본값
        if (model.includes('pro')) targetModel = 'gemini-2.5-pro';
        
        // [방어 3] 시스템 지시문 분리 방식 제거 -> 프롬프트 통합 방식 사용 (404 에러 원천 차단)
        const generativeModel = genAI.getGenerativeModel({ 
            model: targetModel, 
            safetySettings: safetySettings
        });

        // 시스템 프롬프트와 유저 질문을 하나로 합침
        const finalPrompt = `
[Role & Instructions]
${systemPrompt}

[Task]
${userPrompt}
        `;

        const result = await generativeModel.generateContent(finalPrompt);
        const response = result.response;
        return response.text();
    } catch (error) {
        console.error("Gemini Error:", error);
        // 에러 메시지를 예쁘게 정리해서 반환
        if (error.message.includes('API key')) throw new Error('Gemini API 키가 틀렸습니다.');
        if (error.message.includes('not found')) throw new Error('Gemini 모델을 찾을 수 없습니다.');
        throw new Error(`Gemini 오류: ${error.message}`);
    }
}

// 3. 통합 호출기
async function callAI(systemPrompt, userPrompt, model, apiKey) {
    if (!apiKey) throw new Error('API 키를 입력해주세요.');
    const cleanKey = apiKey.trim(); // 공백 제거

    if (model.toLowerCase().includes('gpt')) {
        return await callOpenAI(systemPrompt, userPrompt, model, cleanKey);
    } else if (model.toLowerCase().includes('gemini') || model.toLowerCase().includes('flash')) {
        return await callGemini(systemPrompt, userPrompt, model, cleanKey);
    } else {
        throw new Error(`지원하지 않는 모델입니다: ${model}`);
    }
}

// ============================================================
// 기본 기능 및 뉴스 크롤링
// ============================================================

app.get('/', (req, res) => res.json({ status: 'ok', service: 'News API (Final Version)' }));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

async function scrapeNaverNews(category) {
    const categoryMap = { '정치': '100', '경제': '101', '사회': '102', '생활/문화': '103', '세계': '104', 'IT/과학': '105' };
    const sid = categoryMap[category] || '100';
    try {
        const response = await axios.get(`https://news.naver.com/main/ranking/popularDay.naver?mid=etc&sid1=${sid}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer', timeout: 10000
        });
        const html = iconv.decode(response.data, 'euc-kr');
        const $ = cheerio.load(html);
        const news = [];
        let rank = 1;
        $('.rankingnews_list li, .rankingnews_box .rankingnews_list li').each((i, item) => {
            if (rank > 50) return false;
            const $item = $(item);
            const title = $item.find('a').first().attr('title') || $item.find('a').first().text().trim();
            const link = $item.find('a').first().attr('href');
            if (title && link) news.push({ rank: rank++, title, link: link.startsWith('http') ? link : `https://news.naver.com${link}`, summary: title });
        });
        return news;
    } catch (error) { throw new Error('뉴스 불러오기 실패: ' + error.message); }
}

app.get('/api/naver-news', async (req, res) => {
    try { res.json(await scrapeNaverNews(req.query.category || '정치')); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// AI API 엔드포인트 (JSON 파싱 강화)
// ============================================================

// 1. 키 체크
app.post('/api/ai/check-key', async (req, res) => {
    try {
        await callAI('System', 'test', req.body.model, req.headers.authorization?.split(' ')[1]);
        res.json({ status: 'ok', message: 'API 키 확인 완료' });
    } catch (e) { res.status(401).json({ error: e.message }); }
});

// 2. 대본 재구성
app.post('/api/ai/script-transform', async (req, res) => {
    const { text, concept, lengthOption, model } = req.body;
    const system = `당신은 유능한 유튜브 작가입니다. 다음 조건에 맞춰 대본을 재구성하세요.\n- 콘셉트: ${concept}\n- 분량: ${lengthOption}\n- 언어: 한국어`;
    try { res.json({ script: await callAI(system, text, model, req.headers.authorization?.split(' ')[1]) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. 구조 분석
app.post('/api/ai/structure', async (req, res) => {
    try { res.json({ structure: await callAI('텍스트 구조 분석가입니다.', req.body.text, req.body.model, req.headers.authorization?.split(' ')[1]) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. 요약
app.post('/api/ai/summary', async (req, res) => {
    try { res.json({ summary: await callAI('3줄 요약 전문가입니다.', req.body.text, req.body.model, req.headers.authorization?.split(' ')[1]) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. 새 대본
app.post('/api/ai/script-new', async (req, res) => {
    const { topic, concept, lengthOption, model } = req.body;
    const system = `유튜브 작가입니다. 주제:${topic}, 콘셉트:${concept}, 분량:${lengthOption}.`;
    try { res.json({ script: await callAI(system, topic, model, req.headers.authorization?.split(' ')[1]) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. 제목 생성 (JSON 깨짐 방지)
app.post('/api/ai/titles', async (req, res) => {
    const system = `유튜브 제목 전문가입니다. 반드시 아래 JSON 형식으로만 응답하세요.\n{"safeTitles": ["제목1",...], "clickbaitTitles": ["제목1",...]}`;
    try {
        let result = await callAI(system, req.body.text, req.body.model, req.headers.authorization?.split(' ')[1]);
        // 마크다운 코드블럭 제거
        result = result.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        res.json(JSON.parse(jsonMatch ? jsonMatch[0] : result));
    } catch (e) { res.json({ safeTitles: ["AI 응답 오류: 다시 시도해주세요"], clickbaitTitles: [] }); }
});

// 7. 썸네일 카피 (JSON 깨짐 방지)
app.post('/api/ai/thumbnail-copies', async (req, res) => {
    const system = `썸네일 카피 전문가입니다. 반드시 아래 JSON 형식으로만 응답하세요.\n{"emotional": ["카피1",...], "informational": ["카피1",...], "visual": ["카피1",...]}`;
    try {
        let result = await callAI(system, req.body.text, req.body.model, req.headers.authorization?.split(' ')[1]);
        result = result.replace(/```json/g, '').replace(/```/g, '').trim();
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        res.json(JSON.parse(jsonMatch ? jsonMatch[0] : result));
    } catch (e) { res.json({ emotional: ["AI 응답 오류"], informational: [], visual: [] }); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));