// server.js
// News to YouTube Studio - Backend Server (Render 배포용)
// OpenAI + Gemini 2.5 통합 + 네이버 카테고리/랭킹 크롤링

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// ==============================
// 미들웨어
// ==============================
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ==============================
// 공통 유틸: 헤더에서 API 키 추출
// ==============================
function getApiKeyFromHeader(req) {
  const auth = req.headers.authorization || '';
  if (!auth) return null;

  const parts = auth.split(' ');
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
    return parts[1].trim();
  }
  return auth.trim();
}

// ==============================
// OpenAI 호출
// ==============================
async function callOpenAI(system, userText, model, apiKey) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OpenAI API 키가 설정되어 있지 않습니다.');
  }

  const usedModel = model || 'gpt-4.1-mini';

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: usedModel,
        messages: [
          { role: 'system', content: system || '' },
          { role: 'user', content: userText || '' },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        timeout: 60_000,
      },
    );

    const content =
      res.data?.choices?.[0]?.message?.content?.toString().trim() || '';
    if (!content) {
      throw new Error('OpenAI 응답이 비어 있습니다.');
    }
    return content;
  } catch (err) {
    console.error('OpenAI Error:', err.response?.data || err.message);
    const msg = err?.response?.data?.error?.message || err.message || String(err);
    if (msg.includes('Incorrect API key')) {
      throw new Error('OpenAI API 키가 틀렸습니다.');
    }
    if (msg.includes('model_not_found') || msg.includes('does not exist')) {
      throw new Error('OpenAI 모델을 찾을 수 없습니다.');
    }
    throw new Error(`OpenAI 오류: ${msg}`);
  }
}

// ==============================
// Gemini 호출
// ==============================
async function callGemini(system, userText, model, apiKey) {
  const key = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error('Gemini API 키가 설정되어 있지 않습니다.');
  }

  const usedModel = model || 'gemini-1.5-flash';
  const genAI = new GoogleGenerativeAI(key);

  const safetySettings = [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUAL_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
  ];

  const modelInstance = genAI.getGenerativeModel({
    model: usedModel,
    safetySettings,
  });

  try {
    const prompt = system ? `${system}\n\n[사용자 입력]\n${userText}` : userText;
    const result = await modelInstance.generateContent(prompt);
    const text = result.response.text().trim();
    if (!text) {
      throw new Error('Gemini 응답이 비어 있습니다.');
    }
    return text;
  } catch (error) {
    console.error('Gemini Error:', error.response?.data || error.message);
    const msg = error?.response?.data?.error?.message || error?.message || String(error);
    if (msg.includes('API key')) {
      throw new Error('Gemini API 키가 틀렸습니다.');
    }
    if (msg.includes('not found') || msg.includes('404')) {
      throw new Error('Gemini 모델을 찾을 수 없습니다.');
    }
    throw new Error(`Gemini 오류: ${msg}`);
  }
}

// ==============================
// 통합 AI 호출 (모델명으로 OpenAI / Gemini 자동 분기)
// ==============================
async function callAI(system, userText, model, apiKey) {
  const m = (model || '').toLowerCase();

  if (!m || m.includes('gpt') || m.startsWith('o')) {
    return callOpenAI(system, userText, model, apiKey);
  }

  if (m.includes('gemini') || m.includes('flash')) {
    return callGemini(system, userText, model, apiKey);
  }

  // 아무것도 안 들어오면 OpenAI 기본
  return callOpenAI(system, userText, model, apiKey);
}

// ==============================
// 기본 라우트
// ==============================
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'News to YouTube Studio Backend' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ==============================
// 네이버 섹션 뉴스 크롤링
//  - /api/naver-news?category=정치/경제/사회/생활/세계/IT/과학
// ==============================
async function scrapeNaverNews(categoryOrCode) {
  const labelToCode = {
    '정치': '100',
    '경제': '101',
    '사회': '102',
    '생활/문화': '103',
    '생활': '103', // 프론트 버튼용
    '세계': '104',
    'IT/과학': '105',
  };

  let sid = '100';
  if (categoryOrCode) {
    const raw = String(categoryOrCode).trim();
    if (/^\d{3}$/.test(raw)) {
      sid = raw;
    } else if (labelToCode[raw]) {
      sid = labelToCode[raw];
    }
  }

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const date = `${yyyy}${mm}${dd}`;

  const url = `https://news.naver.com/main/list.naver?mode=LS2D&mid=shm&sid1=${sid}&sid2=000&date=${date}`;

  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'arraybuffer',
      timeout: 10_000,
    });

    const html = iconv.decode(response.data, 'euc-kr');
    const $ = cheerio.load(html);

    const news = [];
    let rank = 1;

    $('.newsflash_body .type06_headline li, .newsflash_body .type06 li').each(
      (i, el) => {
        if (rank > 100) return false; // 최대 100개

        const $item = $(el);
        const $a = $item.find('a').first();

        let title = ($a.attr('title') || '').trim();
        if (!title) title = $a.text().trim();

        const href = $a.attr('href');
        if (!title || !href) return;

        const link = href.startsWith('http')
          ? href
          : `https://news.naver.com${href}`;
        const press = $item.find('.writing').text().trim();
        const time = $item.find('.date').text().trim();

        news.push({
          rank: rank++,
          title,
          link,
          press,
          time,
          summary: title,
        });
      },
    );

    return news;
  } catch (error) {
    console.error('scrapeNaverNews error:', error.message);
    throw new Error('네이버 뉴스 수집 실패: ' + error.message);
  }
}

app.get('/api/naver-news', async (req, res) => {
  try {
    const { category } = req.query;
    const news = await scrapeNaverNews(category || '정치');
    res.json(news);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==============================
// 네이버 랭킹 뉴스 (언론사별 많이본 뉴스)
//  - /api/naver-ranking
// ==============================
async function scrapeNaverRanking() {
  const url = 'https://news.naver.com/main/ranking/popularDay.naver';

  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'arraybuffer',
      timeout: 10_000,
    });

    const html = iconv.decode(response.data, 'euc-kr');
    const $ = cheerio.load(html);

    const news = [];
    let globalRank = 1;

    $('.rankingnews_box').each((_, box) => {
      const $box = $(box);

      const press =
        $box.find('.rankingnews_name').text().trim() ||
        $box.find('.rankingnews_box_title a').text().trim() ||
        '언론사 미상';

      $box.find('ul.rankingnews_list li').each((__, li) => {
        if (globalRank > 200) return false; // 최대 200개

        const $li = $(li);
        const $a = $li.find('a').first();

        const rawTitle =
          $li.find('.list_title').text() ||
          $a.text() ||
          $a.attr('title') ||
          '';
        const title = rawTitle.trim().replace(/\s+/g, ' ');
        const href = $a.attr('href') || '';
        if (!title || !href) return;

        const link = href.startsWith('http')
          ? href
          : `https://news.naver.com${href}`;

        const viewsText = $li.find('.list_view').text().trim(); // "조회 12,345"
        const timeText = $li.find('.list_time').text().trim();
        const commentText = $li.find('.list_comment').text().trim(); // "댓글 23"

        const views = viewsText.replace(/[^0-9,]/g, '') || null;
        const comments = commentText.replace(/[^0-9]/g, '') || null;

        news.push({
          rank: globalRank++,
          title,
          link,
          press,
          category: '랭킹',
          views,
          time: timeText,
          comments,
        });
      });
    });

    return news;
  } catch (error) {
    console.error('scrapeNaverRanking error:', error.message);
    throw new Error('랭킹 뉴스 불러오기 실패: ' + error.message);
  }
}

app.get('/api/naver-ranking', async (req, res) => {
  try {
    const news = await scrapeNaverRanking();
    res.json(news);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==============================
// AI API 엔드포인트
// ==============================

// 1. API 키 유효성 검사 (단순: 키 존재 여부만 체크)
app.post('/api/ai/check-key', async (req, res) => {
  try {
    const apiKey = getApiKeyFromHeader(req);
    if (!apiKey) {
      return res.status(400).json({ ok: false, error: 'API 키가 없습니다.' });
    }
    return res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 2. 대본 재구성
app.post('/api/ai/script-transform', async (req, res) => {
  try {
    const { text, instruction, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res
        .status(400)
        .json({ error: '재구성할 대본 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 유튜브 영상 대본 전문 편집자입니다.
사용자가 제공한 원본 대본을 기반으로, 지시사항(instruction)에 맞게 구조를 정리하고 가독성을 높인 한국어 대본을 작성하세요.

요구사항:
- 말투는 자연스럽고, 영상에서 바로 읽을 수 있게 작성
- 불필요한 반복/군더더기 제거
- 도입/본론/정리 흐름이 자연스럽게 이어지게 구성
- 타임코드나 장면 전환 표시가 필요하면 괄호로 간단히 표현

반드시 한국어로 작성하세요.
`;

    const userText = `
[지시사항]
${instruction || '(별도 지시사항 없음)'}

[원본 대본]
${text}
`;

    const result = await callAI(system, userText, model, apiKey);
    res.json({ result });
  } catch (e) {
    console.error('script-transform error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 3. 새 대본 작성
app.post('/api/ai/script-new', async (req, res) => {
  try {
    const { topic, style, length, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!topic) {
      return res
        .status(400)
        .json({ error: '대본을 작성할 주제를 입력해주세요.' });
    }

    const system = `
당신은 유튜브 영상 대본 작가입니다.
시니어 시청자도 이해하기 쉬운, 친절한 톤의 한국어 대본을 작성하세요.

요구사항:
- 도입에서 시청자의 호기심을 강하게 끌어올 것
- 본문에서는 핵심 정보를 단계별로 설명
- 마무리에서는 요약 + 다음 행동(구독/다음 영상 유도 등) 제안
- 자막처럼 읽기 좋은 길이로 문장을 나눌 것
`;

    const userText = `
[주제]
${topic}

[스타일]
${style || '설명형, 친절한 말투'}

[길이]
${length || '10~15분 분량'}
`;

    const result = await callAI(system, userText, model, apiKey);
    res.json({ script: result });
  } catch (e) {
    console.error('script-new error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 4. 구조 분석
app.post('/api/ai/structure', async (req, res) => {
  try {
    const { text, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res
        .status(400)
        .json({ error: '분석할 대본 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 유튜브 콘텐츠 기획자입니다.
아래 대본의 구조를 분석하여, 섹션별로 어떤 역할을 하는지 정리하세요.

요구사항:
- "도입", "문제 제기", "해결책", "사례/예시", "정리/마무리" 등으로 구분
- 각 섹션별 핵심 메시지 2~3줄 요약
- 시니어 시청자 관점에서 좋은 점 / 아쉬운 점도 간단히 코멘트
반드시 한국어로 작성하세요.
`;

    const result = await callAI(system, text, model, apiKey);
    res.json({ structure: result });
  } catch (e) {
    console.error('structure error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 5. 요약
app.post('/api/ai/summary', async (req, res) => {
  try {
    const { text, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res
        .status(400)
        .json({ error: '요약할 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 유튜브 영상 요약 전문가입니다.
아래 내용을 기반으로 5~8줄 정도의 요약본을 만들어, 영상 설명란에 넣기 좋은 형태로 작성하세요.
반드시 한국어로 작성하세요.
`;

    const result = await callAI(system, text, model, apiKey);
    res.json({ summary: result });
  } catch (e) {
    console.error('summary error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 6. 제목 생성 (JSON 반환: safeTitles / clickbaitTitles)
app.post('/api/ai/titles', async (req, res) => {
  try {
    const { text, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res
        .status(400)
        .json({ error: '제목을 만들 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 유튜브 영상 제목 카피라이터입니다.

다음 JSON 형식으로만 응답하세요. 설명 문장은 절대 쓰지 마세요.
모든 문자열은 한국어로 작성합니다.

{
  "safeTitles": ["제목1", "제목2", "제목3", "제목4", "제목5"],
  "clickbaitTitles": ["제목1", "제목2", "제목3", "제목4", "제목5"]
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
      console.error('titles JSON parse error:', err, jsonText);
      return res.status(500).json({
        error: 'AI 응답(JSON) 파싱에 실패했습니다.',
        raw: result,
      });
    }

    res.json({
      safeTitles: parsed.safeTitles || [],
      clickbaitTitles: parsed.clickbaitTitles || [],
    });
  } catch (e) {
    console.error('titles endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 7. 썸네일 카피 생성 (감정/정보/비주얼 3종 JSON)
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
당신은 유튜브 썸네일 카피 전문 카피라이터입니다.

다음 JSON 형식으로만 응답하세요. 설명 문장은 절대 쓰지 마세요.
모든 문자열은 한국어로 작성합니다.

{
  "emotional": ["감정 자극형 카피1", "감정 자극형 카피2", "감정 자극형 카피3", "감정 자극형 카피4", "감정 자극형 카피5"],
  "informational": ["정보 전달형 카피1", "정보 전달형 카피2", "정보 전달형 카피3", "정보 전달형 카피4", "정보 전달형 카피5"],
  "visual": ["이미지 상상 자극형 카피1", "이미지 상상 자극형 카피2", "이미지 상상 자극형 카피3", "이미지 상상 자극형 카피4", "이미지 상상 자극형 카피5"]
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
      console.error('thumbnail-copies JSON parse error:', err, jsonText);
      return res.status(500).json({
        error: 'AI 응답(JSON) 파싱에 실패했습니다.',
        raw: result,
      });
    }

    res.json({
      emotional: parsed.emotional || [],
      informational: parsed.informational || [],
      visual: parsed.visual || [],
    });
  } catch (e) {
    console.error('thumbnail endpoint error:', e);
    res.status(500).json({
      emotional: ['AI 응답 오류'],
      informational: [],
      visual: [],
    });
  }
});

// ==============================
// 서버 시작
// ==============================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
