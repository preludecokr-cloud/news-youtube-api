// server.js
// News to YouTube Studio - Backend Server (Render 배포용)
// Gemini 호환성 강화 버전 (시스템 프롬프트 통합)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));

// ============================================================
// AI 호출 함수
// ============================================================

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

async function callGemini(systemPrompt, userPrompt, model, apiKey) {
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        
        // 안전 필터 해제
        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ];

        // [수정 핵심] systemInstruction 속성을 제거하고, 프롬프트에 직접 합칩니다.
        // 이렇게 하면 "모델을 찾을 수 없음" 에러가 해결됩니다.
        const generativeModel = genAI.getGenerativeModel({ 
            model: model, // 예: gemini-1.5-flash
            safetySettings: safetySettings
        });

        // 시스템 프롬프트를 유저 질문 앞단에 붙여서 전송 (가장 안전한 방법)
        const finalPrompt = `[System Instructions]\n${systemPrompt}\n\n[User Request]\n${userPrompt}`;

        const result = await generativeModel.generateContent(finalPrompt);
        const response = result.response;
        return response.text();
    } catch (error) {
        console.error("Gemini Error Details:", error); // Render 로그 확인용
        throw new Error(`Gemini 상세 오류: ${error.message}`);
    }
}

async function callAI(systemPrompt, userPrompt, model, apiKey) {
    if (!apiKey) throw new Error('API 키가 없습니다.');
    const cleanKey = apiKey.trim();
    
    // 모델명 로그 출력 (디버깅용)
    console.log(`[AI Request] Model: ${model}`);

    if (model.toLowerCase().includes('gpt')) {
        return await callOpenAI(systemPrompt, userPrompt, model, cleanKey);
    } else if (model.toLowerCase().includes('gemini')) {
        // 혹시 모를 모델명 오타 방지 (강제 매핑)
        let targetModel = model;
        if (model.includes('flash')) targetModel = 'gemini-1.5-flash';
        else if (model.includes('pro')) targetModel = 'gemini-1.5-pro';
        
        return await callGemini(systemPrompt, userPrompt, targetModel, cleanKey);
    } else {
        throw new Error('지원하지 않는 AI 모델입니다.');
    }
}

// ------------------------------------------------------------
// 아래부터는 기존 코드와 동일 (뉴스 크롤링 및 API 엔드포인트)
// ------------------------------------------------------------

app.get('/', (req, res) => res.json({ status: 'ok', service: 'News API (Robust Mode)' }));
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
    } catch (error) { throw new Error('뉴스 크롤링 실패'); }
}

app.get('/api/naver-news', async (req, res) => {
    try { res.json(await scrapeNaverNews(req.query.category || '정치')); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

// API 엔드포인트
app.post('/api/ai/check-key', async (req, res) => {
    try {
        await callAI('System', 'test', req.body.model, req.headers.authorization?.split(' ')[1]);
        res.json({ status: 'ok', message: 'API 키가 유효합니다.' });
    } catch (e) { res.status(401).json({ error: e.message }); }
});

app.post('/api/ai/script-transform', async (req, res) => {
    const { text, concept, lengthOption, model } = req.body;
    const system = `유튜브 대본 작가입니다. 콘셉트:${concept}, 분량:${lengthOption}. 한국어로 재구성하세요.`;
    try { res.json({ script: await callAI(system, text, model, req.headers.authorization?.split(' ')[1]) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/structure', async (req, res) => {
    try { res.json({ structure: await callAI('구조 분석가입니다.', req.body.text, req.body.model, req.headers.authorization?.split(' ')[1]) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/summary', async (req, res) => {
    try { res.json({ summary: await callAI('3줄 요약 전문가입니다.', req.body.text, req.body.model, req.headers.authorization?.split(' ')[1]) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/script-new', async (req, res) => {
    const { topic, concept, lengthOption, model } = req.body;
    const system = `유튜브 대본 작가입니다. 주제:${topic}, 콘셉트:${concept}, 분량:${lengthOption}.`;
    try { res.json({ script: await callAI(system, topic, model, req.headers.authorization?.split(' ')[1]) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/titles', async (req, res) => {
    const system = `제목 전문가입니다. {"safeTitles": [], "clickbaitTitles": []} JSON 포맷으로 응답하세요.`;
    try {
        let result = await callAI(system, req.body.text, req.body.model, req.headers.authorization?.split(' ')[1]);
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        res.json(JSON.parse(jsonMatch ? jsonMatch[0] : result));
    } catch (e) { res.json({ safeTitles: ["에러 발생: 내용을 확인하세요"], clickbaitTitles: [] }); }
});

app.post('/api/ai/thumbnail-copies', async (req, res) => {
    const system = `썸네일 카피 전문가입니다. {"emotional": [], "informational": [], "visual": []} JSON 포맷으로 응답하세요.`;
    try {
        let result = await callAI(system, req.body.text, req.body.model, req.headers.authorization?.split(' ')[1]);
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        res.json(JSON.parse(jsonMatch ? jsonMatch[0] : result));
    } catch (e) { res.json({ emotional: ["에러 발생"], informational: [], visual: [] }); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));