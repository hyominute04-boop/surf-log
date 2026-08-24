import { Redis } from '@upstash/redis';

// Upstash 통합을 Vercel에서 연결하면 KV_REST_API_URL / KV_REST_API_TOKEN 환경변수가 자동으로 들어와요.
const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

/**
 * 서핑일지 - 버셀 서버리스 API (단일 엔드포인트 /api/data)
 * GET  ?action=entries                 -> 저장된 날짜 목록
 * GET  ?action=entry&date=YYYY-MM-DD   -> 특정 날짜 기록
 * GET  ?action=boards                  -> 보드 목록
 * GET  ?action=tide&locKey=&date=&time= -> 조위 (국립해양조사원)
 * POST { action:'saveEntry', entry }
 * POST { action:'deleteEntry', date }
 * POST { action:'saveBoards', boards }
 * POST { action:'analyze', params }    -> Gemini AI 분석
 */

/**
 * surf_spot -> 조위관측소 코드 매핑 테이블.
 * 국립해양조사원은 전국 약 50개 관측소만 운영하므로, 서로 가까운 지점은
 * 같은 관측소를 참조합니다(정확한 개별 값이 아니라 근사치입니다).
 * 아래 코드는 아직 실제 관측소 코드로 확인/교체가 필요합니다 (플레이스홀더).
 */
const TIDE_STATION_MAP = {
  songjeong: 'REPLACE_WITH_BUSAN_STATION_CODE',
  dadaepo: 'REPLACE_WITH_BUSAN_STATION_CODE'
};

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { action } = req.query;

      if (action === 'entries') {
        const keys = await kv.keys('entry:*');
        return res.status(200).json({ dates: keys.map((k) => k.slice(6)) });
      }
      if (action === 'entry') {
        const entry = await kv.get('entry:' + req.query.date);
        return res.status(200).json({ entry: entry || null });
      }
      if (action === 'boards') {
        const boards = await kv.get('boards');
        return res.status(200).json({ boards: boards || null });
      }
      if (action === 'tide') {
        const tide = await getTideForSpot(req.query.locKey, req.query.date, req.query.time);
        return res.status(200).json({ tide });
      }
      return res.status(400).json({ error: 'unknown action' });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const { action } = body;

      if (action === 'saveEntry') {
        await kv.set('entry:' + body.entry.date, body.entry);
        return res.status(200).json({ ok: true });
      }
      if (action === 'deleteEntry') {
        await kv.del('entry:' + body.date);
        return res.status(200).json({ ok: true });
      }
      if (action === 'saveBoards') {
        await kv.set('boards', body.boards);
        return res.status(200).json({ ok: true });
      }
      if (action === 'analyze') {
        const result = await generateAnalysis(body.params);
        return res.status(200).json({ result });
      }
      return res.status(400).json({ error: 'unknown action' });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}

/* ---------- AI 기술노트 분석 (Gemini API) ---------- */
async function generateAnalysis(p) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았어요. Vercel 프로젝트 설정 > Environment Variables에서 추가해주세요.');
  }
  const prompt = buildPrompt(p);
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Gemini API 오류(' + r.status + '): ' + t.slice(0, 300));
  }
  const data = await r.json();
  let text = '';
  try {
    text = (data.candidates[0].content.parts || []).map((x) => x.text || '').join('');
  } catch (e) {
    throw new Error('Gemini 응답을 해석하지 못했어요.');
  }
  return text.replace(/```json|```/g, '').trim();
}

function buildPrompt(p) {
  return (
    '당신은 친절하고 경험 많은 서핑 코치입니다. 아래 서핑 세션 정보를 보고 서퍼에게 도움이 되는 기술 피드백을 작성하세요.\n\n' +
    '날짜: ' + p.date + '\n장소: ' + p.location + '\n바다 상태: ' + p.oceanText + '\n조위: ' + (p.tideText || '정보없음') + '\n' +
    '보드: ' + p.boardLabel + '\n서핑 시간: ' + p.startTime + ' ~ ' + p.endTime + '\n' +
    '서퍼가 직접 남긴 세션 메모: "' + p.techniqueInput + '"\n\n' +
    '이 정보를 참고해서, 그 지역/파도 특성이 관련 있다면 언급하며 구체적으로 분석하세요. 격려하는 코치 톤을 유지하되 핵심을 짚어주세요.\n' +
    '아래 JSON 형식으로만 응답하세요. 다른 설명, 마크다운 코드블록 없이 순수 JSON 객체만 반환하세요.\n' +
    '{"goodSigns": ["잘된 점/좋은 신호 1~3개, 짧은 문장"], "gapAnalysis": "부족했을 가능성이 있는 구간에 대한 구체적 분석 2~4문장", "nextFocus": ["다음 세션에서 시도해볼 점 1~3개, 짧은 문장"]}'
  );
}

/* ---------- 조위 (국립해양조사원 공공데이터 API) ---------- */
async function getTideForSpot(locKey, dateStr, targetTime) {
  const stationCode = TIDE_STATION_MAP[locKey];
  if (!stationCode) {
    throw new Error('이 지역은 아직 조위 자동조회를 지원하지 않아요.');
  }
  const cacheKey = 'tide_' + stationCode + '_' + dateStr;
  let dayData = await kv.get(cacheKey);
  if (!dayData) {
    dayData = await fetchTideDay(stationCode, dateStr);
    await kv.set(cacheKey, dayData, { ex: 21600 }); // 6시간 캐시
  }
  return pickNearest(dayData, targetTime, stationCode);
}

async function fetchTideDay(stationCode, dateStr) {
  const serviceKey = process.env.KHOA_SERVICE_KEY;
  if (!serviceKey) {
    throw new Error('KHOA_SERVICE_KEY 환경변수가 설정되지 않았어요. Vercel 프로젝트 설정 > Environment Variables에서 추가해주세요.');
  }
  const dateParam = dateStr.replace(/-/g, '');
  const url =
    'https://apis.data.go.kr/1192136/surveyTideLevel/GetSurveyTideLevelApiService' +
    '?serviceKey=' + serviceKey +
    '&ObsCode=' + encodeURIComponent(stationCode) +
    '&Date=' + dateParam +
    '&resultType=json';
  const r = await fetch(url);
  const body = await r.text();
  if (!r.ok) {
    throw new Error('조위 데이터를 가져오지 못했습니다 (HTTP ' + r.status + '). 다시 시도해주세요.');
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    throw new Error('조위 데이터를 가져오지 못했습니다(응답 해석 실패). 원문: ' + body.slice(0, 300));
  }

  let items = null;
  try { items = data.response.body.items.item; } catch (e) {}
  if (!items && data.result) items = data.result.data || data.result.items;
  if (!items && Array.isArray(data)) items = data;
  if (!items) {
    throw new Error('조위 데이터를 가져오지 못했습니다(예상과 다른 응답 구조). 원문 일부: ' + body.slice(0, 400));
  }
  if (!Array.isArray(items)) items = [items];

  return { stationCode, date: dateStr, fetchedAt: new Date().toISOString(), raw: items };
}

function pickNearest(dayData, targetTime, stationCode) {
  const items = dayData.raw;
  const targetMinutes = timeToMinutes(targetTime);
  let best = null;
  let bestDiff = Infinity;
  for (const it of items) {
    const timeStr = it.record_time || it.tph_time || it.obs_time || it.time || it.data_time || it.date_time || '';
    const m = extractMinutes(timeStr);
    if (m === null) continue;
    const diff = Math.abs(m - targetMinutes);
    if (diff < bestDiff) { bestDiff = diff; best = it; }
  }
  if (!best) {
    throw new Error('조위 데이터를 가져오지 못했습니다(시간 필드를 인식하지 못함). 재시도하거나 응답 구조를 확인해주세요.');
  }
  const tideLevel = best.tide_level != null ? best.tide_level : (best.sea_lvl != null ? best.sea_lvl : best.value);
  const type = best.data_type || best.record_type || best.actual_or_predicted || '확인필요';
  return {
    stationCode,
    date: dayData.date,
    tideLevel,
    matchedTime: best.record_time || best.tph_time || best.obs_time || best.time || null,
    matchedTimeDiffMinutes: bestDiff,
    actualOrPredicted: type,
    fetchedAt: dayData.fetchedAt
  };
}
function timeToMinutes(t) {
  const parts = String(t).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
function extractMinutes(timeStr) {
  if (!timeStr) return null;
  const m = String(timeStr).match(/(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}
