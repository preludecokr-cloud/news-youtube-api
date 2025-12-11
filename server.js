// server.js
// News to YouTube Studio - Backend Server (Render 배포용)
// OpenAI + Gemini + 네이버 뉴스/랭킹 크롤러

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

// 공통 유틸: 헤더에서 API 키 추출
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
async function callOpenAI(systemPrompt, userPrompt, model, apiKey) {
  try {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OpenAI API 키가 설정되지 않았습니다.');
    }

    const usedModel = model || 'gpt-4.1-mini';

    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: usedModel,
        messages: [
          { role: 'system', content: systemPrompt || '' },
          { role: 'user', content: userPrompt || '' },
        ],
        temperature: 0.7,
      },
      {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const content = res.data?.choices?.[0]?.message?.content?.toString().trim() || '';
    if (!content) throw new Error('OpenAI 응답이 비어 있습니다.');
    return content;
  } catch (error) {
    console.error('OpenAI Error:', error.response?.data || error.message);
    const msg = error?.response?.data?.error?.message || error.message || String(error);
    throw new Error(`OpenAI 오류: ${msg}`);
  }
}

// ==============================
// Gemini 호출
// ==============================
async function callGemini(systemPrompt, userPrompt, model, apiKey) {
  try {
    const key = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!key) {
      throw new Error('Gemini API 키를 입력해주세요.');
    }

    const usedModel = model || 'gemini-2.5-flash';
    const genAI = new GoogleGenerativeAI(key);

    const safetySettings = [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUAL_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ];

    const modelInstance = genAI.getGenerativeModel({
      model: usedModel,
      safetySettings,
    });

    const prompt = systemPrompt ? `${systemPrompt}\n\n[사용자 입력]\n${userPrompt}` : userPrompt;

    const result = await modelInstance.generateContent(prompt);
    const text = result.response.text().trim();
    if (!text) throw new Error('Gemini 응답이 비어 있습니다.');
    return text;
  } catch (error) {
    console.error('Gemini Error:', error.response?.data || error.message || error);
    const msg = error?.response?.data?.error?.message || error?.message || String(error);
    throw new Error(`Gemini 오류: ${msg}`);
  }
}

// ==============================
// 통합 AI (모델 이름에 따라 OpenAI/Gemini 선택)
// ==============================
async function callAI(systemPrompt, userPrompt, model, apiKey) {
  const m = (model || '').toLowerCase();
  if (!m || m.includes('gpt') || m.startsWith('o')) {
    return callOpenAI(systemPrompt, userPrompt, model, apiKey);
  }
  if (m.includes('gemini') || m.includes('flash')) {
    return callGemini(systemPrompt, userPrompt, model, apiKey);
  }
  return callOpenAI(systemPrompt, userPrompt, model, apiKey);
}

// 루트 / health
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'News to YouTube Studio Backend' });
});
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ============================================================
// 네이버 섹션 뉴스 크롤링 (섹션별 최신 기사)
//  - /api/naver-news?category=정치/경제/사회/세계/IT/과학/랭킹X
//  - 요약(summary), 댓글수(comments) 포함
// ============================================================
async function scrapeNaverNews(categoryOrCode) {
  const labelToCode = {
    '정치': '100',
    '경제': '101',
    '사회': '102',
    '생활/문화': '103',
    '생활': '103',
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
  console.log('[Naver] 섹션 뉴스 요청:', { categoryOrCode, sid, url });

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const html = iconv.decode(response.data, 'euc-kr');
    const $ = cheerio.load(html);

    const news = [];
    let rank = 1;

    const liItems = $('.newsflash_body .type06_headline li, .newsflash_body .type06 li');

    liItems.each((i, el) => {
      if (rank > 100) return false;

      const $li = $(el);
      const $dl = $li.find('dl');

      let $a = $dl.find('dt a').last();
      if (!$a || !$a.attr('href')) {
        $a = $li.find('a').last();
      }
      if (!$a || !$a.attr('href')) return;

      let title = ($a.text() || $a.attr('title') || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!title || title === '동영상기사') return;

      const href = $a.attr('href');
      const link = href.startsWith('http') ? href : `https://news.naver.com${href}`;

      const press =
        $dl.find('span.writing').text().trim() ||
        $li.find('.writing').text().trim() ||
        '';

      const time =
        $dl.find('span.date').text().trim() ||
        $li.find('.date').text().trim() ||
        '';

      const summary = $dl.find('dd').text().replace(/\s+/g, ' ').trim() || '';

      const commentText =
        $li.find('span[class*=comment]').text().trim() ||
        $li.find('a[class*=comment]').text().trim() ||
        '';
      const comments = commentText ? commentText.replace(/[^0-9]/g, '') || null : null;

      news.push({
        rank: rank++,
        title,
        link,
        press,
        time,
        summary,
        comments,
      });
    });

    console.log('[Naver] 섹션 뉴스 개수:', news.length);
    return news;
  } catch (error) {
    console.error('scrapeNaverNews error:', error.message);
    throw new Error('네이버 뉴스 수집 실패: ' + error.message);
  }
}

app.get('/api/naver-news', async (req, res) => {
  try {
    const category = req.query.category || '정치';
    const news = await scrapeNaverNews(category);
    res.json(news);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 네이버 랭킹 뉴스 (언론사별 많이본 뉴스)
//  - /api/naver-ranking
//  - 조회수(views), 댓글수(comments), 카테고리(category='랭킹')
// ============================================================
async function scrapeNaverRanking() {
  const url = 'https://news.naver.com/main/ranking/popularDay.naver';

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      responseType: 'arraybuffer',
      timeout: 10000,
    });

    const html = iconv.decode(response.data, 'euc-kr');
    const $ = cheerio.load(html);

    const news = [];
    let rank = 1;

    $('.rankingnews_box').each((_, box) => {
      const $box = $(box);
      const press =
        $box.find('.rankingnews_name').text().trim() ||
        $box.find('.rankingnews_box_title a').text().trim() ||
        '언론사 미상';

      $box.find('ul.rankingnews_list li').each((__, li) => {
        if (rank > 200) return false;

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

        const link = href.startsWith('http') ? href : `https://news.naver.com${href}`;

        const viewsText = $li.find('.list_view').text().trim();
        const timeText = $li.find('.list_time').text().trim();
        const commentText = $li.find('.list_comment').text().trim();

        const views = viewsText ? viewsText.replace(/[^0-9]/g, '') || null : null;
        const comments = commentText ? commentText.replace(/[^0-9]/g, '') || null : null;

        news.push({
          rank: rank++,
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

    console.log('[Naver] 랭킹 뉴스 개수:', news.length);
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
// AI 관련 엔드포인트 (간단 버전 / 기존 구조 유지 가능)
// ============================================================

// 1. API 키 체크
app.post('/api/ai/check-key', async (req, res) => {
  try {
    const apiKey = getApiKeyFromHeader(req);
    if (!apiKey) throw new Error('API 키가 없습니다.');
    // 간단히 성공만 응답
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
      return res.status(400).json({ error: '재구성할 텍스트를 입력해주세요.' });
    }

    const systemPrompt = `
당신은 유튜브 영상 대본을 다듬어주는 전문 편집자입니다.
- 전체 흐름은 유지하면서도, 시니어 시청자도 이해하기 쉽게 정리합니다.
- 도입부(후킹), 본문(단계적 설명), 마무리(요약 + 구독/좋아요 유도) 구조를 추천해 주세요.
- 말투는 부드럽고 설명형, 존댓말을 사용합니다.
`;

    const userPrompt = `
[콘셉트]
${concept || '정보 전달형 / 차분한 설명'}

[길이]
${lengthOption || '10~15분 분량'}

[원본 텍스트]
${text}
`;

    const result = await callAI(systemPrompt, userPrompt, model, apiKey);
    res.json({ result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// 3. 새 대본 작성 (간단 예시)
app.post('/api/ai/script-new', async (req, res) => {
  try {
    const { topic, concept, lengthOption, model } = req.body || {};
    const apiKey = getApiKeyFromHeader(req);

    if (!topic) {
      return res.status(400).json({ error: '주제를 입력해주세요.' });
    }

    const systemPrompt = `
당신은 유튜브 대본 작가입니다.
- 시니어 시청자도 이해하기 쉬운 한국어로 작성합니다.
- 초반 30초는 강하게 후킹합니다.
- 전체적으로 말하듯이, 자연스럽게 서술합니다.
`;

    const userPrompt = `
[주제]
${topic}

[콘셉트]
${concept || '설명형 / 차분한 톤'}

[길이]
${lengthOption || '10~15분 분량'}
`;

    const result = await callAI(systemPrompt, userPrompt, model, apiKey);
    res.json({ result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// (structure, titles, thumbnail 등 다른 엔드포인트는 필요 시 추가)

// 서버 시작
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
