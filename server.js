// server.js
// News to YouTube Studio - Backend Server (Render 배포용)
// OpenAI + Gemini 2.5 통합 + 네이버 카테고리 매핑 (섹션별 기사)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ------------------------------------------------------------
// 공통 유틸: 헤더에서 API 키 추출
// ------------------------------------------------------------
function getApiKeyFromHeader(req) {
  const auth = req.headers.authorization || '';
  if (!auth) return null;

  const parts = auth.split(' ');
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
    return parts[1].trim();
  }
  return auth.trim();
}

// ============================================================
// OpenAI 호출
// ============================================================
async function callOpenAI(systemPrompt, userPrompt, model, apiKey) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 30000,
      }
    );

    return response.data?.choices?.[0]?.message?.content?.trim() || '';
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

    // 안전 필터 완화
    const safetySettings = [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ];

    // 모델명 보정 (UI에서 어떤 문자열 보내도 2.5 계열로 매핑)
    let targetModel = 'gemini-2.5-flash';
    const lower = (model || '').toLowerCase();
    if (lower.includes('pro')) {
      targetModel = 'gemini-2.5-pro';
    } else if (lower.includes('flash')) {
      targetModel = 'gemini-2.5-flash';
    }

    const generativeModel = genAI.getGenerativeModel({
      model: targetModel,
      safetySettings,
    });

    const finalPrompt = `
You are a helpful assistant for a Korean YouTube creator.

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
// 통합 AI 호출
// ============================================================
async function callAI(systemPrompt, userPrompt, model, apiKey) {
  if (!apiKey) throw new Error('API 키를 입력해주세요.');

  const cleanKey = apiKey.trim();
  const lowerModel = (model || '').toLowerCase();

  if (lowerModel.includes('gpt')) {
    return await callOpenAI(systemPrompt, userPrompt, model, cleanKey);
  }
  if (lowerModel.includes('gemini') || lowerModel.includes('flash')) {
    return await callGemini(systemPrompt, userPrompt, model, cleanKey);
  }

  throw new Error(`지원하지 않는 모델입니다: ${model}`);
}

// ============================================================
// 기본 라우트
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'News to YouTube Studio Backend' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ============================================================
// 네이버 뉴스 크롤링 (섹션별 최신 기사)
//  - categoryOrCode: '세계' 또는 '104' 둘 다 지원
// ============================================================
async function scrapeNaverNews(categoryOrCode) {
  const labelToCode = {
    '정치': '100',
    '경제': '101',
    '사회': '102',
    '생활/문화': '103',
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
  const dateStr = `${yyyy}${mm}${dd}`;

  const url = `https://news.naver.com/main/list.naver?mode=LSD&mid=sec&sid1=${sid}&date=${dateStr}`;
  console.log('[Naver] 요청 category:', categoryOrCode, '→ sid1:', sid, 'url:', url);

  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const html = iconv.decode(response.data, 'euc-kr');
    const $ = cheerio.load(html);

    const news = [];
    let rank = 1;

    // 섹션 기사 리스트 수집 (헤드라인 + 일반 기사)
    $('.newsflash_body .type06_headline li, .newsflash_body .type06 li').each((i, el) => {
      if (rank > 50) return false; // 최대 50개

      const $item = $(el);
      const $a = $item.find('a').first();

      let title = ($a.attr('title') || '').trim();
      if (!title) title = $a.text().trim();

      const href = $a.attr('href');
      if (!title || !href) return;

      const link = href.startsWith('http') ? href : `https://news.naver.com${href}`;
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
    });

    return news;
  } catch (error) {
    console.error('scrapeNaverNews error:', error.message);
    throw new Error('뉴스 불러오기 실패: ' + error.message);
  }
}

app.get('/api/naver-news', async (req, res) => {
  try {
    const category = req.query.category || '정치'; // '세계' 또는 '104' 둘 다 OK
    const news = await scrapeNaverNews(category);
    res.json(news);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 네이버 랭킹 뉴스 (언론사별 많이 본 뉴스)
// ============================================================
async function scrapeNaverRanking() {
  const url = 'https://news.naver.com/main/ranking/popularDay.naver';

  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const html = iconv.decode(response.data, 'euc-kr');
    const $ = cheerio.load(html);

    const news = [];
    let rank = 1;

    $('.rankingnews_box').each((_, box) => {
      const $box = $(box);
      const press = $box.find('.rankingnews_name').text().trim();

      $box.find('ul.rankingnews_list li').each((__, li) => {
        const $li = $(li);
        const $a = $li.find('a').first();

        const rawTitle = $a.text() || $a.attr('title') || '';
        const title = rawTitle.trim().replace(/\s+/g, ' ');
        const href = $a.attr('href');

        if (!title || !href) return;

        const link = href.startsWith('http') ? href : `https://news.naver.com${href}`;
        const views = $li.find('.list_view').text().trim() || null;
        const time = $li.find('.list_time').text().trim() || '';

        news.push({
          rank: rank++,
          title,
          link,
          press,
          views,
          time,
          summary: title,
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

// ============================================================
// 네이버 뉴스 기사 본문 크롤링
// ============================================================
async function scrapeArticleBody(url) {
  const fullUrl = url.startsWith('http') ? url : `https://news.naver.com${url}`;

  try {
    const response = await axios.get(fullUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const html = iconv.decode(response.data, 'euc-kr');
    const $ = cheerio.load(html);

    const title =
      $('h2#title_area, h2.media_end_head_headline, h3#articleTitle').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      '';

    let $body = $('#dic_area').first();
    if (!$body || !$body.length) $body = $('#newsct_article').first();
    if (!$body || !$body.length) $body = $('#articeBody').first();
    if (!$body || !$body.length) $body = $('#articleBodyContents').first();

    let bodyHtml = '';
    let bodyText = '';

    if ($body && $body.length) {
      $body
        .find(
          'script, style, iframe, .ad_related, .promotion, .media_end_copyright, #spiLayer, .cbox_news'
        )
        .remove();
      bodyHtml = $body.html() || '';
      bodyText = $body.text().replace(/\s+/g, ' ').trim();
    }

    return { title, bodyHtml, bodyText, url: fullUrl };
  } catch (error) {
    console.error('scrapeArticleBody error:', error.message);
    throw new Error('기사 본문 불러오기 실패: ' + error.message);
  }
}

app.post('/api/naver-article', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: '기사 URL 이 필요합니다.' });
    }
    const data = await scrapeArticleBody(url);
    res.json(data);
  } catch (e) {
    console.error('naver-article error:', e);
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
    res.status(400).json({ error: e.message });
  }
});

// 2. 요약
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

// 3. 콘텐츠 변환 (요약 → 유튜브용 스크립트 등)
app.post('/api/ai/transform', async (req, res) => {
  try {
    const { text, transformType, tone, extraInstruction, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res.status(400).json({ error: '변환할 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 유튜브 콘텐츠를 기획/편집하는 전문가입니다.
입력된 텍스트(뉴스 요약, 기사 등)를 아래 옵션에 맞게 유튜브용 스크립트로 변환하세요.

- 변환 타입: ${transformType || 'yt-long'}
- 톤 & 스타일: ${tone || 'neutral'}
- 추가 지시사항: ${extraInstruction || '없음'}
`;

    const script = await callAI(system, text, model, apiKey);
    res.json({ script });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. 기존 대본 구조 분석
app.post('/api/ai/structure', async (req, res) => {
  try {
    const { text, depth, element, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res.status(400).json({ error: '분석할 대본을 입력해주세요.' });
    }

    const system = `
당신은 유튜브 영상 시나리오 구조를 분석하는 전문가입니다.
주어진 스크립트를 아래 기준에 맞춰 분석하고, 한국어로 결과를 작성하세요.

- 분석 깊이: ${depth || 'basic'}  (basic/detailed/timeline)
- 중점 요소: ${element || 'hooks'} (hooks/conflicts/info)
`;

    const analysis = await callAI(system, text, model, apiKey);
    res.json({ analysis });
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
당신은 유튜브 영상 제목과 썸네일 문구를 기획하는 전문가입니다.
입력된 내용을 기반으로, 클릭률(CTR)을 높일 수 있는 다양한 스타일의 제목과 썸네일용 짧은 카피를 생성하세요.

아래 JSON 형식으로만 응답하세요. 모든 텍스트는 한국어로 작성합니다.
{
  "titles": ["제목1", "제목2", ...],
  "clickbaitTitles": ["썸네일용 짧은 문구1", "썸네일용 짧은 문구2", ...]
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
      console.error('Title JSON parse error:', err, result);
      return res.json({
        titles: [],
        clickbaitTitles: [],
      });
    }

    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 7. 썸네일 카피 + 이미지 프롬프트
app.post('/api/ai/thumbnails', async (req, res) => {
  try {
    const { text, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!text) {
      return res.status(400).json({ error: '썸네일을 만들 기반 텍스트를 입력해주세요.' });
    }

    const system = `
당신은 유튜브 썸네일 카피와 이미지 콘셉트를 동시에 기획하는 전문가입니다.
입력된 내용을 바탕으로 다음 세 가지 유형의 카피를 생성하세요.

1) emotional: 감정 자극형 (공포, 분노, 호기심, 놀라움 등 강한 감정 유발)
2) informational: 정보 전달형 (핵심 키워드 위주, 쉽게 이해되는 문구)
3) visual: 이미지 상상 자극형 (화면에 어떤 장면이 나오면 좋을지 상상되게 만드는 문구)

각 배열에는 3~5개 내외의 카피를 담으세요.

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
        visual: [],
      });
    }

    res.json(parsed);
  } catch (e) {
    console.error('Thumbnail endpoint error:', e);
    res.json({
      emotional: ['AI 응답 오류'],
      informational: [],
      visual: [],
    });
  }
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
