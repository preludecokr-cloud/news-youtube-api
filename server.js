// server.js
// News to YouTube Studio - Backend Server (Render 배포용)
// Node.js + Express 기반, OpenAI & Google Gemini 연동

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
// 구글 Gemini 라이브러리 추가
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// 미들웨어 설정
// ============================================================
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// ============================================================
// AI 호출 처리기 (OpenAI vs Gemini 분기 처리)
// ============================================================

// 1. OpenAI 호출 함수
async function callOpenAI(systemPrompt, userPrompt, model, apiKey) {
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.7,
            max_tokens: 4000
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}` 
            },
            timeout: 60000
        });
        return response.data.choices[0].message.content;
    } catch (error) {
        if (error.response?.status === 401) throw new Error('OpenAI API 키가 유효하지 않습니다.');
        throw new Error(`OpenAI 오류: ${error.response?.data?.error?.message || error.message}`);
    }
}

// 2. Google Gemini 호출 함수
async function callGemini(systemPrompt, userPrompt, model, apiKey) {
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const generativeModel = genAI.getGenerativeModel({ model: model });

        // Gemini는 System Prompt를 프롬프트 앞단에 붙여서 전송
        const finalPrompt = `${systemPrompt}\n\n----------------\n\n${userPrompt}`;

        const result = await generativeModel.generateContent(finalPrompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        if (error.message.includes('API key not valid')) throw new Error('Google API 키가 유효하지 않습니다.');
        throw new Error(`Gemini 오류: ${error.message}`);
    }
}

// 3. 통합 AI 호출 함수 (모델명에 따라 자동 분기)
async function callAI(systemPrompt, userPrompt, model, apiKey) {
    if (!apiKey) throw new Error('API 키가 입력되지 않았습니다.');

    // 모델명에 'gpt'가 포함되면 OpenAI, 'gemini'가 포함되면 Google
    if (model.toLowerCase().includes('gpt')) {
        return await callOpenAI(systemPrompt, userPrompt, model, apiKey);
    } else if (model.toLowerCase().includes('gemini')) {
        return await callGemini(systemPrompt, userPrompt, model, apiKey);
    } else {
        throw new Error('지원하지 않는 AI 모델입니다.');
    }
}

// ============================================================
// 헬스 체크
// ============================================================
app.get('/', (req, res) => res.json({ status: 'ok', service: 'News to YouTube Studio API (OpenAI & Gemini)' }));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ============================================================
// 네이버 뉴스 크롤링
// ============================================================
async function scrapeNaverNews(category) {
    const categoryMap = { '정치': '100', '경제': '101', '사회': '102', '생활/문화': '103', '세계': '104', 'IT/과학': '105' };
    const sid = categoryMap[category] || '100';
    const url = `https://news.naver.com/main/ranking/popularDay.naver?mid=etc&sid1=${sid}`;
    
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

        $('.rankingnews_list li, .rankingnews_box .rankingnews_list li').each((i, item) => {
            if (rank > 50) return false;
            const $item = $(item);
            const $link = $item.find('a').first();
            const title = $link.attr('title') || $link.text().trim();
            const link = $link.attr('href');
            const press = $item.find('.rankingnews_name, .list_press').text().trim() || '언론사';
            
            if (title && title.length > 5 && link) {
                news.push({
                    rank: rank++,
                    title: title.substring(0, 100),
                    press: press.substring(0, 20),
                    link: link.startsWith('http') ? link : `https://news.naver.com${link}`,
                    summary: title
                });
            }
        });
        return news;
    } catch (error) {
        throw new Error('뉴스 불러오기 실패');
    }
}

app.get('/api/naver-news', async (req, res) => {
    try {
        let news = await scrapeNaverNews(req.query.category || '정치');
        res.json(news);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// AI API 엔드포인트
// ============================================================

// 1. 키 유효성 검사
app.post('/api/ai/check-key', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1];
    const { model } = req.body; 

    try {
        // [중요] callAI 함수를 통해 모델에 맞게 분기됨
        await callAI('System', 'test', model, apiKey);
        res.json({ status: 'ok', message: 'API 키가 유효합니다.' });
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

// 2. 대본 재구성
app.post('/api/ai/script-transform', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1];
    const { text, concept, lengthOption, model } = req.body;
    
    if (!text) return res.status(400).json({ error: '텍스트 없음' });

    const system = `당신은 유튜브 영상 대본 전문 작가입니다. 
    콘셉트: ${concept}, 분량: ${lengthOption}. 
    주어진 텍스트를 유튜브 대본으로 재구성해주세요. 한국어로 작성.`;

    try {
        const result = await callAI(system, text, model, apiKey);
        res.json({ script: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. 구조 분석
app.post('/api/ai/structure', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1];
    const { text, model } = req.body;
    
    const system = `당신은 텍스트 분석가입니다. 도입-본론-결론 구조, 핵심 요약, 논리 흐름을 분석해주세요.`;
    
    try {
        const result = await callAI(system, text, model, apiKey);
        res.json({ structure: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. 핵심 요약
app.post('/api/ai/summary', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1];
    const { text, model } = req.body;
    
    const system = `뉴스 요약 전문가입니다. 3~5줄로 핵심만 요약하세요.`;
    
    try {
        const result = await callAI(system, text, model, apiKey);
        res.json({ summary: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. 새 대본 작성
app.post('/api/ai/script-new', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1];
    const { topic, concept, lengthOption, model } = req.body;
    
    const system = `유튜브 작가입니다. 주제: ${topic}, 콘셉트: ${concept}, 분량: ${lengthOption}으로 대본을 작성하세요.`;
    
    try {
        const result = await callAI(system, `주제: ${topic}`, model, apiKey);
        res.json({ script: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. 제목 생성
app.post('/api/ai/titles', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1];
    const { text, model } = req.body;
    
    const system = `유튜브 제목 전문가입니다. 안정적 제목 5개, 자극적 제목 5개를 JSON으로 반환하세요.
    형식: {"safeTitles": [...], "clickbaitTitles": [...]}`;

    try {
        let result = await callAI(system, text, model, apiKey);
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) result = jsonMatch[0];
        
        try {
            res.json(JSON.parse(result));
        } catch {
            res.json({ safeTitles: [result], clickbaitTitles: [] }); 
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. 썸네일 카피 생성
app.post('/api/ai/thumbnail-copies', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1];
    const { text, lengthOption, model } = req.body;

    const system = `썸네일 카피 전문가입니다. 길이: ${lengthOption}.
    감성형, 정보형, 시각자극형 각 5개씩 JSON으로 반환.
    형식: {"emotional": [], "informational": [], "visual": []}`;

    try {
        let result = await callAI(system, text, model, apiKey);
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) result = jsonMatch[0];
        
        try {
            res.json(JSON.parse(result));
        } catch {
            res.json({ emotional: [result], informational: [], visual: [] });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));