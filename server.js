// server.js
// News to YouTube Studio - Backend Server (Render 배포용)
// Node.js + Express 기반, OpenAI API 연동

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const app = express();

// ============================================================
// 환경 변수에서 설정 로드 (API 키는 이제 프론트엔드에서 받습니다)
// ============================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''; 
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
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
// 헬스 체크 엔드포인트
// ============================================================
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'News to YouTube Studio API',
        version: '1.0.1',
        apiKeyConfigured: !!OPENAI_API_KEY 
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// ============================================================
// OpenAI API 호출 함수 (API Key를 인수로 받음)
// ============================================================
async function callOpenAI(systemPrompt, userPrompt, model = 'gpt-4o', apiKey) { 
    if (!apiKey) {
        throw new Error('OpenAI API 키가 설정되지 않았습니다.');
    }
    
    try {
        const response = await axios.post(OPENAI_API_URL, {
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
            timeout: 60000 // 60초 타임아웃
        });
        
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('OpenAI API 오류:', error.response?.data || error.message);
        
        if (error.response?.status === 401) {
            throw new Error('OpenAI API 키가 유효하지 않습니다.');
        } else if (error.response?.status === 429) {
            throw new Error('API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.');
        } else if (error.response?.status === 400) {
            throw new Error('잘못된 요청입니다.');
        }
        
        throw new Error('AI 처리 중 오류가 발생했습니다: ' + (error.response?.data?.error?.message || error.message));
    }
}

// ============================================================
// 네이버 뉴스 크롤링 함수 (카테고리별 랭킹 개선)
// ============================================================
async function scrapeNaverNews(category) {
    // 카테고리 코드 매핑
    const categoryMap = {
        '정치': '100',
        '경제': '101',
        '사회': '102',
        '생활/문화': '103',
        '세계': '104',
        'IT/과학': '105'
    };
    
    const sid = categoryMap[category] || '100';
    const url = `https://news.naver.com/main/ranking/popularDay.naver?mid=etc&sid1=${sid}`;
    
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                'Accept-Charset': 'utf-8'
            },
            responseType: 'arraybuffer',
            timeout: 10000
        });
        
        // 인코딩 처리: EUC-KR 또는 UTF-8
        let html;
        try {
            html = response.data.toString('utf-8');
            if (html.includes('') || html.includes('ï¿½')) {
                html = iconv.decode(response.data, 'euc-kr');
            }
        } catch (e) {
            html = iconv.decode(response.data, 'euc-kr');
        }
        
        const $ = cheerio.load(html);
        const news = [];
        let rank = 1;
        
        // 랭킹 뉴스 파싱 (카테고리별 랭킹 리스트를 명확히 타겟팅)
        $('.rankingnews_list li').each((i, item) => {
            if (rank > 50) return false; 
            
            const $item = $(item);
            const $link = $item.find('a');
            const title = $link.attr('title') || $link.text().trim(); 
            const link = $link.attr('href');
            
            const press = $item.find('.rankingnews_name, .list_press').text().trim() || '언론사';
            
            if (title && title.length > 5 && link) {
                news.push({
                    rank: rank++,
                    title: title.substring(0, 100),
                    press: press.substring(0, 20),
                    time: '', 
                    link: link.startsWith('http') ? link : `https://news.naver.com${link}`,
                    summary: title.substring(0, 100) 
                });
            }
        });
        
        // 랭킹 뉴스가 없으면 대체 방식 시도
        if (news.length === 0) {
            $('.rankingnews_box .rankingnews_list li').each((i, item) => {
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
                        time: '',
                        link: link.startsWith('http') ? link : `https://news.naver.com${link}`,
                        summary: title.substring(0, 100)
                    });
                }
            });
        }
        
        return news;
    } catch (error) {
        console.error('뉴스 크롤링 오류:', error.message);
        throw new Error('뉴스를 불러오는데 실패했습니다.');
    }
}

// 기사 본문 크롤링 및 요약 (서버측 AI 요약 기능 제거)
async function getArticleSummary(articleUrl) {
    return '요약은 AI 작업 공간에서 직접 진행해주세요.';
}

// ============================================================
// 뉴스 API 엔드포인트
// ============================================================
app.get('/api/naver-news', async (req, res) => {
    const category = req.query.category || '정치';
    
    try {
        let news = await scrapeNaverNews(category);
        res.json(news);
    } catch (error) {
        console.error('뉴스 API 오류:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// AI 기능 엔드포인트들
// ============================================================

// 🔑 키 유효성 검사 엔드포인트
app.post('/api/ai/check-key', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1]; 
    const { model } = req.body;
    
    if (!apiKey) {
        return res.status(400).json({ error: 'API 키가 입력되지 않았습니다.' });
    }
    
    try {
        // 가장 간단하고 저렴한 요청을 실행하여 키 유효성만 체크
        await callOpenAI(
            '당신은 키 검사 전문가입니다. 이 문장을 1단어로 한국어로 요약하세요.',
            '키가 유효한지 확인해주세요.',
            model || 'gpt-4o-mini', 
            apiKey
        );
        
        res.json({ status: 'ok', message: 'API 키가 유효합니다.' });
    } catch (error) {
        // callOpenAI에서 던져진 오류를 401 상태로 클라이언트에 전달
        res.status(401).json({ error: error.message });
    }
});


// 대본 재구성
app.post('/api/ai/script-transform', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1]; // 🔑 헤더에서 키 추출
    const { text, concept, lengthOption, model } = req.body;
    
    if (!text) {
        return res.status(400).json({ error: '텍스트를 입력해주세요.' });
    }
    
    try {
        const systemPrompt = `당신은 유튜브 영상 대본 전문 작가입니다. 
주어진 텍스트를 유튜브 영상 대본으로 재구성해주세요.
- 콘셉트: ${concept || '일반'}
- 목표 분량: ${lengthOption || '자유'}
- 구어체로 자연스럽게 작성
- 장면 전환, 강조 포인트 등을 [괄호]로 표시
- 시청자의 흥미를 끌 수 있는 도입부 작성
- 핵심 내용을 명확하게 전달
- 한국어로 작성`;

        const result = await callOpenAI(systemPrompt, text, model || 'gpt-4o', apiKey); 
        res.json({ script: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 구조 분석
app.post('/api/ai/structure', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1]; // 🔑 헤더에서 키 추출
    const { text, model } = req.body;
    
    if (!text) {
        return res.status(400).json({ error: '텍스트를 입력해주세요.' });
    }
    
    try {
        const systemPrompt = `당신은 텍스트 구조 분석 전문가입니다.
주어진 텍스트의 구조를 분석하고 다음을 제공해주세요:
1. 도입-본론-결론 구분
2. 각 섹션의 핵심 내용 한 줄 요약
3. 논리 흐름 분석
4. 강점과 보완점
한국어로 작성해주세요.`;

        const result = await callOpenAI(systemPrompt, text, model || 'gpt-4o', apiKey); 
        res.json({ structure: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 핵심 요약
app.post('/api/ai/summary', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1]; // 🔑 헤더에서 키 추출
    const { text, model } = req.body;
    
    if (!text) {
        return res.status(400).json({ error: '텍스트를 입력해주세요.' });
    }
    
    try {
        const systemPrompt = `당신은 뉴스 요약 전문가입니다.
주어진 텍스트를 3~5줄로 핵심만 요약해주세요.
- 가장 중요한 정보 우선
- 불필요한 수식어 제거
- 객관적이고 명확하게 작성
한국어로 작성해주세요.`;

        const result = await callOpenAI(systemPrompt, text, model || 'gpt-4o', apiKey); 
        res.json({ summary: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 새로운 대본 작성
app.post('/api/ai/script-new', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1]; // 🔑 헤더에서 키 추출
    const { topic, concept, lengthOption, model } = req.body;
    
    if (!topic) {
        return res.status(400).json({ error: '주제를 입력해주세요.' });
    }
    
    try {
        const systemPrompt = `당신은 유튜브 영상 대본 전문 작가입니다.
다음 조건으로 완전히 새로운 유튜브 대본을 작성해주세요:
- 콘셉트: ${concept || '해설형'}
- 목표 분량: ${lengthOption || '5분'}
- 구조: 도입-전개-클라이맥스-마무리
- 시청자 참여 유도 요소 포함
- 구어체, 친근한 톤
- [장면 지시], [효과음], [자막] 등 표시
한국어로 작성해주세요.`;

        const result = await callOpenAI(systemPrompt, `주제: ${topic}`, model || 'gpt-4o', apiKey); 
        res.json({ script: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 제목 생성
app.post('/api/ai/titles', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1]; // 🔑 헤더에서 키 추출
    const { text, model } = req.body;
    
    if (!text) {
        return res.status(400).json({ error: '텍스트를 입력해주세요.' });
    }
    
    try {
        const systemPrompt = `당신은 유튜브 제목 전문가입니다.
주어진 내용을 바탕으로 두 종류의 제목을 각각 5개씩 생성해주세요:

1. 안정적인 제목 (정보 중심): 
- 정확하고 신뢰감 있는 톤
- 핵심 정보를 명확하게 전달
- 과장 없이 사실 기반

2. 자극적인 제목 (클릭 유도형):
- 호기심 자극
- 감정적 반응 유도
- 단, 과도한 선정성은 피함

반드시 아래 JSON 형식으로만 응답해주세요:
{"safeTitles": ["제목1", "제목2", "제목3", "제목4", "제목5"], "clickbaitTitles": ["제목1", "제목2", "제목3", "제목4", "제목5"]}`;

        const result = await callOpenAI(systemPrompt, text, model || 'gpt-4o', apiKey); 
        
        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                res.json(parsed);
            } else {
                res.json(JSON.parse(result));
            }
        } catch (parseError) {
            res.json({
                safeTitles: [result],
                clickbaitTitles: [result]
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 썸네일 카피 생성
app.post('/api/ai/thumbnail-copies', async (req, res) => {
    const apiKey = req.headers.authorization?.split(' ')[1]; // 🔑 헤더에서 키 추출
    const { text, lengthOption, model } = req.body;
    
    if (!text) {
        return res.status(400).json({ error: '텍스트를 입력해주세요.' });
    }
    
    try {
        const systemPrompt = `당신은 유튜브 썸네일 카피 전문가입니다.
주어진 내용을 바탕으로 세 종류의 썸네일 카피를 각각 5개씩 생성해주세요:
- 길이: ${lengthOption || '짧게(2~4단어)'}

1. 감성자극형 (emotional): 감정을 건드리는 문구 (놀람, 분노, 공감 등)
2. 정보전달형 (informational): 핵심 정보를 압축한 문구
3. 시각자극형 (visual): 강렬한 단어, 숫자, 느낌표, 이모지 강조

반드시 아래 JSON 형식으로만 응답해주세요:
{"emotional": ["카피1", "카피2", "카피3", "카피4", "카피5"], "informational": ["카피1", "카피2", "카피3", "카피4", "카피5"], "visual": ["카피1", "카피2", "카피3", "카피4", "카피5"]}`;

        const result = await callOpenAI(systemPrompt, text, model || 'gpt-4o', apiKey); 
        
        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                res.json(parsed);
            } else {
                res.json(JSON.parse(result));
            }
        } catch (parseError) {
            res.json({
                emotional: [result],
                informational: [result],
                visual: [result]
            });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 에러 핸들링
// ============================================================
app.use((err, req, res, next) => {
    console.error('서버 오류:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

// ============================================================
// 서버 시작
// ============================================================
app.listen(PORT, () => {
    console.log(`✅ News to YouTube Studio API 서버 시작`);
    console.log(`📍 포트: ${PORT}`);
    console.log(`🔑 OpenAI API 키: ${OPENAI_API_KEY ? '설정됨 (레거시)' : '미설정 (프론트엔드 입력 사용)'}`); 
});