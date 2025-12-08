// server.js
// News to YouTube Studio - Backend Server (Railway 배포용)
// Node.js + Express 기반, OpenAI API 연동

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();

// ============================================================
// 환경 변수에서 설정 로드
// Railway 대시보드에서 설정: OPENAI_API_KEY
// ============================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const PORT = process.env.PORT || 3000;

// ============================================================
// 미들웨어 설정
// ============================================================
app.use(cors({
    origin: '*', // 프로덕션에서는 카페24 도메인으로 제한 권장
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
        version: '1.0.0',
        apiKeyConfigured: !!OPENAI_API_KEY
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// ============================================================
// OpenAI API 호출 함수
// ============================================================
async function callOpenAI(systemPrompt, userPrompt, model = 'gpt-4o') {
    if (!OPENAI_API_KEY) {
        throw new Error('OpenAI API 키가 서버에 설정되지 않았습니다.');
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
                'Authorization': `Bearer ${OPENAI_API_KEY}`
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
        
        throw new Error('AI 처리 중 오류가 발생했습니다.');
    }
}

// ============================================================
// 네이버 뉴스 크롤링 함수
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
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 10000
        });
        
        const $ = cheerio.load(response.data);
        const news = [];
        let rank = 1;
        
        // 랭킹 뉴스 파싱
        $('.rankingnews_box').each((boxIndex, box) => {
            const pressName = $(box).find('.rankingnews_name').text().trim();
            
            $(box).find('.rankingnews_list li').each((i, item) => {
                if (rank > 50) return false; // 최대 50개
                
                const $item = $(item);
                const $link = $item.find('a');
                const title = $link.text().trim();
                const link = $link.attr('href');
                
                if (title && link) {
                    news.push({
                        rank: rank++,
                        title: title,
                        press: pressName,
                        time: '',
                        link: link.startsWith('http') ? link : `https://news.naver.com${link}`,
                        summary: '' // 나중에 AI로 요약
                    });
                }
            });
        });
        
        // 뉴스가 없으면 대체 방식 시도
        if (news.length === 0) {
            // 인기 뉴스 리스트 파싱 시도
            $('ul.commonlist li, .list_body .list_item, .ranking_list li').each((i, item) => {
                if (rank > 50) return false;
                
                const $item = $(item);
                const $link = $item.find('a').first();
                const title = $link.text().trim() || $item.find('.list_title, .title').text().trim();
                const link = $link.attr('href');
                const press = $item.find('.press, .info_press, .writing').text().trim() || '언론사';
                
                if (title && title.length > 5) {
                    news.push({
                        rank: rank++,
                        title: title.substring(0, 100),
                        press: press.substring(0, 20),
                        time: '',
                        link: link && link.startsWith('http') ? link : (link ? `https://news.naver.com${link}` : '#'),
                        summary: ''
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

// 기사 본문 크롤링 및 요약
async function getArticleSummary(articleUrl) {
    try {
        const response = await axios.get(articleUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 5000
        });
        
        const $ = cheerio.load(response.data);
        
        // 다양한 선택자로 본문 추출 시도
        let content = '';
        const selectors = [
            '#dic_area',
            '#articleBodyContents', 
            '.article_body',
            '#newsct_article',
            '.news_end',
            'article'
        ];
        
        for (const selector of selectors) {
            content = $(selector).text().trim();
            if (content && content.length > 100) break;
        }
        
        if (content && content.length > 50) {
            // 본문이 너무 길면 앞부분만
            content = content.substring(0, 1000);
            
            // AI로 요약 (API 키가 있을 경우)
            if (OPENAI_API_KEY) {
                const summary = await callOpenAI(
                    '뉴스 기사를 2~3문장으로 핵심만 요약해주세요. 한국어로 작성하세요.',
                    content,
                    'gpt-4o-mini' // 비용 절약을 위해 mini 사용
                );
                return summary;
            }
            
            // API 키 없으면 앞부분 반환
            return content.substring(0, 200) + '...';
        }
        
        return '요약을 가져올 수 없습니다.';
    } catch (error) {
        console.error('기사 요약 오류:', error.message);
        return '요약을 가져올 수 없습니다.';
    }
}

// ============================================================
// 뉴스 API 엔드포인트
// ============================================================
app.get('/api/naver-news', async (req, res) => {
    const category = req.query.category || '정치';
    const withSummary = req.query.summary === 'true';
    
    try {
        let news = await scrapeNaverNews(category);
        
        // 요약 포함 요청 시 (시간이 오래 걸릴 수 있음)
        if (withSummary && news.length > 0) {
            // 상위 10개만 요약 (시간 절약)
            const summaryPromises = news.slice(0, 10).map(async (item, index) => {
                try {
                    item.summary = await getArticleSummary(item.link);
                } catch {
                    item.summary = item.title;
                }
                return item;
            });
            
            const summarizedNews = await Promise.all(summaryPromises);
            news = [...summarizedNews, ...news.slice(10).map(n => ({ ...n, summary: n.title }))];
        } else {
            // 요약 없이 제목을 요약으로 사용
            news = news.map(n => ({ ...n, summary: n.title }));
        }
        
        res.json(news);
    } catch (error) {
        console.error('뉴스 API 오류:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// AI 기능 엔드포인트들
// ============================================================

// 대본 재구성
app.post('/api/ai/script-transform', async (req, res) => {
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

        const result = await callOpenAI(systemPrompt, text, model || 'gpt-4o');
        res.json({ script: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 구조 분석
app.post('/api/ai/structure', async (req, res) => {
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

        const result = await callOpenAI(systemPrompt, text, model || 'gpt-4o');
        res.json({ structure: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 핵심 요약
app.post('/api/ai/summary', async (req, res) => {
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

        const result = await callOpenAI(systemPrompt, text, model || 'gpt-4o');
        res.json({ summary: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 새로운 대본 작성
app.post('/api/ai/script-new', async (req, res) => {
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

        const result = await callOpenAI(systemPrompt, `주제: ${topic}`, model || 'gpt-4o');
        res.json({ script: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 제목 생성
app.post('/api/ai/titles', async (req, res) => {
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

        const result = await callOpenAI(systemPrompt, text, model || 'gpt-4o');
        
        try {
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                res.json(parsed);
            } else {
                res.json(JSON.parse(result));
            }
        } catch (parseError) {
            // 파싱 실패 시 기본 구조로 응답
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

        const result = await callOpenAI(systemPrompt, text, model || 'gpt-4o');
        
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
    console.log(`🔑 OpenAI API 키: ${OPENAI_API_KEY ? '설정됨' : '미설정'}`);
});