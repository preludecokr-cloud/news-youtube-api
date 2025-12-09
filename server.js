// server.js
// News to YouTube Studio - Backend Server (Render 배포용)
// OpenAI + Gemini 2.5 통합, 네이버 카테고리 코드(100~105) 매핑 + 방탄 로그 버전

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

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

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================
// 공통 유틸
// ============================================================

function getApiKeyFromHeader(req) {
  const auth = req.headers.authorization || '';
  if (!auth) return null;

  const parts = auth.split(' ');
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
    return parts[1].trim();
  }

  // 혹시 Bearer 없이 바로 키만 들어올 경우 대비
  return auth.trim();
}

// ============================================================
// OpenAI 호출
// ============================================================
async function callOpenAI(systemPrompt, userPrompt, model, apiKey) {
  try {
    const url = 'https://api.openai.com/v1/chat/completions';

    const response = await axios.post(
      url,
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        timeout: 30000
      }
    );

    const text =
      response.data?.choices?.[0]?.message?.content?.trim() ||
      '';

    return text;
  } catch (error) {
    console.error('OpenAI Error:', error.response?.data || error.message);
    const msg = error.response?.data?.error?.message || error.message;
    throw new Error(`OpenAI 오류: ${msg}`);
  }
}

// ============================================================
// Gemini 2.5 호출
// ============================================================
async function callGemini(systemPrompt, userPrompt, model, apiKey) {
  try {
    if (!apiKey) {
      throw new Error('Gemini API 키를 입력해주세요.');
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    // 안전 필터 해제 (뉴스/범죄 기사 등에서도 막히지 않도록)
    const safetySettings = [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_NONE
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_NONE
      }
    ];

    // 모델명 보정 (1.5 → 2.5 계열 강제 사용)
    let targetModel = 'gemini-2.5-flash';
    const lower = (model || '').toLowerCase();

    if (lower.includes('pro')) {
      targetModel = 'gemini-2.5-pro';
    } else if (lower.includes('flash')) {
      targetModel = 'gemini-2.5-flash';
    }

    console.log('[Gemini] UI model:', model, '-> 사용 모델:', targetModel);

    const generativeModel = genAI.getGenerativeModel({
      model: targetModel,
      safetySettings
    });

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
    console.error('Gemini Error:', error);
    const msg = error?.message || String(error);

    if (msg.includes('API key')) {
      throw new Error('Gemini API 키가 틀렸습니다.');
    }
    if (msg.includes('not found') || msg.includes('404')) {
      throw new Error('Gemini 모델을 찾을 수 없습니다.');
    }

    throw new Error(`Gemini 오류: ${msg}`);
  }
}

// ============================================================
// 통합 AI 호출기
// ============================================================
async function callAI(systemPrompt, userPrompt, model, apiKey) {
  if (!apiKey) {
    throw new Error('API 키를 입력해주세요.');
  }

  const cleanKey = apiKey.trim();
  const lowerModel = (model || '').toLowerCase();

  if (lowerModel.includes('gpt')) {
    // OpenAI 계열
    return await callOpenAI(systemPrompt, userPrompt, model, cleanKey);
  }

  if (lowerModel.includes('gemini') || lowerModel.includes('flash')) {
    // Gemini 계열
    return await callGemini(systemPrompt, userPrompt, model, cleanKey);
  }

  throw new Error(`지원하지 않는 모델입니다: ${model}`);
}

// ============================================================
// 기본 라우트 / 헬스체크
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'News to YouTube Studio Backend'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ============================================================
// 네이버 뉴스 크롤링 (카테고리 코드/라벨 모두 지원) 방탄 버전
// ============================================================
async function scrapeNaverNews(categoryOrCode) {
  // 네이버 sid1 코드 매핑
  const labelToCode = {
    '정치': '100',
    '경제': '101',
    '사회': '102',
    '생활/문화': '103',
    '세계': '104',
    'IT/과학': '105'
  };

  let sid = '100'; // 기본값: 정치
  let raw = '';

  if (categoryOrCode != null && categoryOrCode !== undefined) {
    raw = String(categoryOrCode).trim();

    // 100~105 숫자 코드 형식 그대로 들어오는 경우
    if (/^\d{3}$/.test(raw)) {
      sid = raw;
    } else if (labelToCode[raw]) {
      // '정치', '경제', '세계' 같은 한글 라벨이 온 경우
      sid = labelToCode[raw];
    } else {
      // 혹시 모를 변형 라벨 대비 (예: "세계 " / "세계뉴스" / "세계 카테고리")
      if (raw.includes('세계')) sid = '104';
      else if (raw.includes('정치')) sid = '100';
      else if (raw.includes('경제')) sid = '101';
      else if (raw.includes('사회')) sid = '102';
      else if (raw.includes('생활')) sid = '103';
      else if (raw.includes('IT') || raw.includes('과학')) sid = '105';
    }
  }

  console.log('[Naver] 요청 category:', categoryOrCode, '→ raw:', raw, '→ sid1:', sid);

  try {
    const response = await axios.get(
      `https://news.naver.com/main/ranking/popularDay.naver?mid=etc&sid1=${sid}`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        responseType: 'arraybuffer',
        timeout: 10000
      }
    );

    const html = iconv.decode(response.data, 'euc-kr');
    const $ = cheerio.load(html);
    const news = [];
    let rank = 1;

    $('.rankingnews_list li, .rankingnews_box .rankingnews_list li').each(
      (i, el) => {
        if (rank > 50) return false; // 최대 50개까지만

        const $item = $(el);
        const $a = $item.find('a').first();

        let title = ($a.attr('title') || '').trim();
        if (!title) title = $a.text().trim();

        const href = $a.attr('href');
        if (!title || !href) return;

        const link = href.startsWith('http')
          ? href
          : `https://news.naver.com${href}`;

        const press = $item.find('.rankingnews_name').text().trim() || '';
        const time = $item.find('.rankingnews_time').text().trim() || '';

        news.push({
          rank: rank++,
          title,
          link,
          press,
          time,
          summary: title // 기본 요약은 제목으로 세팅
        });
      }
    );

    return news;
  } catch (error) {
    console.error('scrapeNaverNews error:', error.message);
    throw new Error('뉴스 불러오기 실패: ' + error.message);
  }
}

// 실제 API 엔드포인트
app.get('/api/naver-news', async (req, res) => {
  try {
    const category = req.query.category || '100'; // 기본: 정치
    const news = await scrapeNaverNews(category);
    res.json(news);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// AI API 엔드포인트
// ============================================================

// 1. API 키 유효성 검사
app.post('/api/ai/check-key', async (req, res) => {
  try {
    const apiKey = getApiKeyFromHeader(req);
    const { model } = req.body || {};

    if (!apiKey) {
      return res.status(400).json({ error: 'API 키를 입력해주세요.' });
    }
    if (!model) {
      return res.status(400).json({ error: '모델을 선택해주세요.' });
    }

    await callAI('System check', 'ping', model, apiKey);
    res.json({ status: 'ok', message: 'API 키 확인 완료' });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// 2. 기존 기사/텍스트 → 대본 재구성
app.post('/api/ai/script-transform', async (req, res) => {
  try {
    const { text, concept, lengthOption, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res
        .status(400)
        .json({ error: '재구성할 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 유능한 유튜브 대본 작가입니다.
다음 조건에 맞춰 자연스러운 한국어 유튜브 내레이션 대본으로 재구성하세요.

- 콘셉트: ${concept || '기본'}
- 분량: ${lengthOption || '기본'}
- 대상: 일반 시청자
- 스타일: 말하듯이, 흥미를 유도하면서도 정보는 정확하게
`;

    const script = await callAI(system, text, model, apiKey);
    res.json({ script });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. 구조 분석
app.post('/api/ai/structure', async (req, res) => {
  try {
    const { text, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res.status(400).json({ error: '분석할 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 텍스트 구조 분석 전문가입니다.
입력된 텍스트를 다음 항목으로 분석해 주세요.

- Hook / 도입
- 문제 제기
- 핵심 정보 / 스토리 전개
- 클라이맥스 / 반전
- 결론 / 마무리
- 콜투액션(구독/좋아요/댓글 유도 등)

각 항목을 제목 + 간단 설명 형식으로, 한국어로 출력하세요.
`;

    const structure = await callAI(system, text, model, apiKey);
    res.json({ structure });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. 요약
app.post('/api/ai/summary', async (req, res) => {
  try {
    const { text, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res.status(400).json({ error: '요약할 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 뉴스/스크립트 요약 전문가입니다.
핵심 메시지가 잘 전달되도록 3~5줄로 한국어 요약을 작성하세요.
`;

    const summary = await callAI(system, text, model, apiKey);
    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5. 새 대본 생성 (키워드/토픽 기반)
app.post('/api/ai/script-new', async (req, res) => {
  try {
    const { topic, concept, lengthOption, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!topic) {
      return res.status(400).json({ error: '주제/키워드를 입력해주세요.' });
    }

    const system = `
당신은 유능한 유튜브 시나리오 작가입니다.
아래 조건에 맞는 완전한 영상 대본을 한국어로 작성하세요.

- 주제: ${topic}
- 콘셉트: ${concept || '정보전달'}
- 분량: ${lengthOption || '10분 내외'}
- 대상 시청자: 일반 성인
- 형식: 도입 → 본론(여러 소제목) → 마무리 → 콜투액션(구독/좋아요 유도)
`;

    const script = await callAI(system, topic, model, apiKey);
    res.json({ script });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6. 제목 생성 (JSON 반환)
app.post('/api/ai/titles', async (req, res) => {
  try {
    const { text, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res.status(400).json({ error: '제목을 만들 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 유튜브 제목 카피라이팅 전문가입니다.

아래 JSON 형식으로만 응답하세요. 한국어로 작성합니다.
{
  "safeTitles": ["제목1", "제목2", ...],
  "clickbaitTitles": ["제목1", "제목2", ...]
}
`;

    let result = await callAI(system, text, model, apiKey);

    // 마크다운 코드블럭 제거 및 JSON 부분만 추출
    result = result.replace(/```json/gi, '').replace(/```/g, '').trim();
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : result;

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      console.error('Titles JSON parse error:', err, result);
      return res.json({
        safeTitles: ['AI 응답 오류: 다시 시도해주세요'],
        clickbaitTitles: []
      });
    }

    res.json(parsed);
  } catch (e) {
    console.error('Titles endpoint error:', e);
    res.json({
      safeTitles: ['AI 응답 오류: 다시 시도해주세요'],
      clickbaitTitles: []
    });
  }
});

// 7. 썸네일 카피 (JSON 반환)
app.post('/api/ai/thumbnail-copies', async (req, res) => {
  try {
    const { text, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res
        .status(400)
        .json({ error: '썸네일 카피를 만들 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 유튜브 썸네일 카피라이팅 전문가입니다.

아래 JSON 형식으로만 응답하세요. 모든 카피는 한국어로 작성합니다.
{
  "emotional": ["감정 자극형 카피1", "감정 자극형 카피2", ...],
  "informational": ["정보 전달형 카피1", "정보 전달형 카피2", ...],
  "visual": ["이미지 상상 자극형 카피1", "이미지 상상 자극형 카피2", ...]
}
`;

    let result = await callAI(system, text, model, apiKey);

    result = result.replace(/```json/gi, '').replace(/```/g, '').trim();
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : result;

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      console.error('Thumbnail JSON parse error:', err, result);
      return res.json({
        emotional: ['AI 응답 오류'],
        informational: [],
        visual: []
      });
    }

    res.json(parsed);
  } catch (e) {
    console.error('Thumbnail endpoint error:', e);
    res.json({
      emotional: ['AI 응답 오류'],
      informational: [],
      visual: []
    });
  }
});

// ============================================================
// 서버 시작
// ============================================================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
