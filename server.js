// server.js - Final Verified Version

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 설정
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// [유틸] 헤더에서 API 키 추출
function getApiKeyFromHeader(req) {
  const auth = req.headers.authorization || '';
  if (!auth) return null;
  const parts = auth.split(' ');
  return (parts.length === 2 && /^Bearer$/i.test(parts[0])) ? parts[1].trim() : auth.trim();
}

// ------------------------------------------------------------
// 1. 네이버 뉴스 본문 스크래핑 (기능 보강됨)
// ------------------------------------------------------------
async function scrapeNewsContent(url) {
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      responseType: 'arraybuffer',
      timeout: 10000,
    });
    
    // 인코딩 감지 및 디코딩 (대부분 euc-kr이나, 일부 utf-8일 수 있음)
    const html = iconv.decode(response.data, 'euc-kr');
    const $ = cheerio.load(html);

    // 다양한 뉴스 본문 셀렉터 시도 (일반, 연예, 스포츠, 포토 등)
    let content = $('#dic_area').text().trim();
    if (!content) content = $('#newsEndContents').text().trim();
    if (!content) content = $('#articeBody').text().trim();
    if (!content) content = $('.go_trans').text().trim();

    // 불필요한 연속 줄바꿈 및 공백 제거
    return content.replace(/\n\s*\n/g, '\n\n').replace(/\t/g, '');
  } catch (error) {
    console.error('Content scraping error:', error.message);
    throw new Error('본문을 불러올 수 없습니다. (삭제되었거나 접근 불가)');
  }
}

// ------------------------------------------------------------
// 2. 네이버 뉴스 리스트 수집 (랭킹 + 섹션 통합)
// ------------------------------------------------------------
async function scrapeNaverNews(categoryOrCode) {
  const labelToCode = {
    '정치': '100', '경제': '101', '사회': '102',
    '생활/문화': '103', '세계': '104', 'IT/과학': '105'
  };

  // (A) 랭킹 뉴스
  if (categoryOrCode === '랭킹') {
    const url = 'https://news.naver.com/main/ranking/popular.naver';
    try {
      const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer' });
      const html = iconv.decode(response.data, 'euc-kr');
      const $ = cheerio.load(html);
      const news = [];
      let globalRank = 1;

      // 언론사별 박스 (.rankingnews_box)
      $('.rankingnews_box').each((i, box) => {
        const pressName = $(box).find('.rankingnews_name').text().trim();
        $(box).find('li').each((j, li) => {
          if (globalRank > 50) return false; // 최대 50개 제한
          
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
               views: 'TOP랭킹' // 랭킹 페이지는 조회수 대신 랭킹 표시
             });
          }
        });
      });
      return news;
    } catch (e) {
      throw new Error('랭킹 뉴스 수집 실패: ' + e.message);
    }
  }

  // (B) 일반 섹션 뉴스
  let sid = '100'; // 기본값 정치
  if (categoryOrCode && labelToCode[categoryOrCode]) sid = labelToCode[categoryOrCode];

  const url = `https://news.naver.com/main/list.naver?mode=LSD&mid=sec&sid1=${sid}`;
  try {
    const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer', timeout: 10000 });
    const html = iconv.decode(response.data, 'euc-kr');
    const $ = cheerio.load(html);
    const news = [];
    let rank = 1;

    // 헤드라인(.type06_headline) + 일반(.type06) 통합 수집
    $('.newsflash_body .type06_headline li, .newsflash_body .type06 li').each((i, el) => {
      if (rank > 50) return false;
      const $item = $(el);
      
      // 썸네일(dt.photo) 존재 여부에 따른 제목(a tag) 위치 찾기
      let $a;
      if ($item.find('dt.photo').length > 0) {
          $a = $item.find('dt').not('.photo').find('a').first();
      } else {
          $a = $item.find('dt').first().find('a');
          if ($a.length === 0) $a = $item.find('a').first();
      }

      const title = $a.text().trim();
      const href = $a.attr('href');
      if (!title || !href) return; // 제목/링크 없으면 스킵

      const press = $item.find('.writing').text().trim();
      const time = $item.find('.date').text().trim();

      news.push({
        rank: rank++,
        title: title,
        link: href,
        press: press,
        time: time,
        views: '-' // 섹션 리스트에는 조회수 없음
      });
    });
    return news;
  } catch (error) {
    throw new Error('뉴스 섹션 로드 실패: ' + error.message);
  }
}

// ------------------------------------------------------------
// 3. AI 통합 호출 함수 (Gemini 2.5/Pro + OpenAI)
// ------------------------------------------------------------
async function callAI(systemPrompt, userPrompt, model, apiKey) {
  if (!apiKey) throw new Error('API 키를 입력해주세요.');
  const cleanKey = apiKey.trim();
  const lowerModel = (model || '').toLowerCase();

  // OpenAI
  if (lowerModel.includes('gpt')) {
    try {
        const resp = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o', // 모델명 고정 혹은 파라미터 사용
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            temperature: 0.7
        }, { headers: { 'Authorization': `Bearer ${cleanKey}` } });
        return resp.data.choices[0].message.content.trim();
    } catch (e) { throw new Error('OpenAI Error: ' + (e.response?.data?.error?.message || e.message)); }
  }
  
  // Gemini (Google)
  if (lowerModel.includes('gemini') || lowerModel.includes('flash')) {
      try {
        const genAI = new GoogleGenerativeAI(cleanKey);
        // 모델 매핑: UI에서 보낸 값에 따라 실제 모델명 매핑
        let targetModel = 'gemini-1.5-flash';
        if (lowerModel.includes('2.0') || lowerModel.includes('exp')) targetModel = 'gemini-2.0-flash-exp';
        
        const generativeModel = genAI.getGenerativeModel({ model: targetModel });
        // Gemini는 System prompt를 별도 파라미터 혹은 프롬프트 결합으로 처리
        const finalPrompt = `[Role]\n${systemPrompt}\n\n[Task]\n${userPrompt}`;
        const result = await generativeModel.generateContent(finalPrompt);
        return result.response.text();
      } catch (e) { throw new Error('Gemini Error: ' + e.message); }
  }
  throw new Error(`지원하지 않는 모델입니다: ${model}`);
}

// ------------------------------------------------------------
// 4. API 라우트 정의
// ------------------------------------------------------------
app.get('/', (req, res) => res.json({ status: 'ok', message: 'News Studio API Running' }));

// (1) 뉴스 관련
app.get('/api/naver-news', async (req, res) => {
  try {
    const category = req.query.category || '정치';
    const news = await scrapeNaverNews(category);
    res.json(news);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/news-content', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL 파라미터가 없습니다.' });
    try {
        const content = await scrapeNewsContent(url);
        res.json({ content });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// (2) AI 관련 (요약, 대본, 구조, 제목, 썸네일)
app.post('/api/ai/summary', async (req, res) => {
    try {
        const { text, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = `당신은 전문 뉴스 에디터입니다. 기사 내용을 3~5줄 이내의 핵심 요약문으로 작성하세요. 한국어로 출력합니다.`;
        const summary = await callAI(system, text, model, apiKey);
        res.json({ summary });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/script-transform', async (req, res) => {
    try {
        const { text, concept, lengthOption, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = `유튜브 대본 작가입니다. 입력된 내용을 바탕으로 [${concept}] 스타일, [${lengthOption}] 분량의 대본을 작성하세요.`;
        const script = await callAI(system, text, model, apiKey);
        res.json({ script });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/script-new', async (req, res) => {
    try {
        const { topic, concept, lengthOption, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = `유튜브 시나리오 작가입니다. 주제 '[${topic}]'에 대해 [${concept}] 컨셉으로 대본을 처음부터 작성하세요.`;
        const script = await callAI(system, topic, model, apiKey);
        res.json({ script });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/structure', async (req, res) => {
    try {
        const { text, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = `텍스트 구조 분석가입니다. 내용을 [Hook - 문제 - 해결/전개 - 결론 - CTA] 구조로 분석해 한국어로 출력하세요.`;
        const structure = await callAI(system, text, model, apiKey);
        res.json({ structure });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 제목 생성 (JSON 응답 보장 로직 추가)
app.post('/api/ai/titles', async (req, res) => {
    try {
        const { text, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = `유튜브 제목 장인입니다. 반드시 아래 JSON 포맷으로만 응답하세요.
        Format: {"safeTitles": ["제목1", "제목2"], "clickbaitTitles": ["자극1", "자극2"]}`;
        
        let result = await callAI(system, text, model, apiKey);
        
        // 마크다운 코드블럭 제거 및 공백 정리
        result = result.replace(/```json/gi, '').replace(/```/g, '').trim();
        const jsonMatch = result.match(/\{[\s\S]*\}/); // 중괄호 안의 내용만 추출
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result);
        
        res.json(parsed);
    } catch(e) { 
        console.error('Title Error:', e);
        res.json({ safeTitles: ["AI 응답 오류 발생"], clickbaitTitles: ["다시 시도해주세요"] }); 
    }
});

// 썸네일 카피 (JSON 응답 보장)
app.post('/api/ai/thumbnail-copies', async (req, res) => {
    try {
        const { text, model } = req.body;
        const apiKey = getApiKeyFromHeader(req);
        const system = `썸네일 카피라이터입니다. 반드시 아래 JSON 포맷으로만 응답하세요.
        Format: {"emotional": ["감성1"], "informational": ["정보1"], "visual": ["시각1"]}`;
        
        let result = await callAI(system, text, model, apiKey);
        
        result = result.replace(/```json/gi, '').replace(/```/g, '').trim();
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result);
        
        res.json(parsed);
    } catch(e) { 
        res.json({ emotional: ["오류 발생"], informational: [], visual: [] }); 
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));