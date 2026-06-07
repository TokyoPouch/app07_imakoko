import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/organize-memory
// 環境変数: GEMINI_API_KEY
// 役割: 直近10件の記録 + 現在の人生テーマをGeminiに渡し
//       深い「人生テーマ」として再整理したリストを返す
// v3.1: カテゴリ抽出 → 人生テーマ抽出に改訂
// ============================================================

const MODELS_TO_TRY = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

// ── モデル試行ヘルパー ─────────────────────────────────────────
async function tryGenerateContent(ai, modelList, generateConfig) {
  let lastErr;
  for (const model of modelList) {
    try {
      console.log(`[organize-memory] trying model: ${model}`);
      const response = await ai.models.generateContent({ model, ...generateConfig });
      console.log(`[organize-memory] model OK: ${model}`);
      return { response, usedModel: model };
    } catch (err) {
      const errMsg = err.message || '';
      const isNotFound = /not found|404|invalid model|unknown model/i.test(errMsg);
      console.warn(`[organize-memory] model "${model}" failed:`, errMsg);
      lastErr = err;
      if (isNotFound) continue;
      throw err;
    }
  }
  throw lastErr || new Error('All models failed');
}

// ── ローカルフォールバック（人生テーマ風キーワードマッチング） ──
// キーワード → 人生テーマへのマッピング
const LOCAL_LIFE_THEME_MAP = [
  {
    keys: ['ミャンマー', 'mpants', '民族衣装', '遠州織', '和織', '反物', '布', '染め', '着物', '縫い', '刺繍', '綿', '伝統布', 'テキスタイル'],
    theme: '文化や布の魅力を未来へ残したい'
  },
  {
    keys: ['認知症', '物忘れ', '記憶', '忘れる', 'Future Me', 'futureme', '思い出', '過去の自分'],
    theme: '忘れることと自分らしさを考え続けている'
  },
  {
    keys: ['AI', 'Gemini', 'ChatGPT', 'GPT', 'LLM', '生成AI', '人工知能', 'Web3', 'ブロックチェーン', 'blockchain', 'NFT', 'crypto'],
    theme: 'AIと人の関係を探求している'
  },
  {
    keys: ['写真', '昔の写真', '思い出', '記録', '手帳', 'ログ', 'アーカイブ'],
    theme: '思い出を未来へ残したい'
  },
  {
    keys: ['ものづくり', '工芸', 'クラフト', 'DIY', '制作', '作家', 'アトリエ', '工房'],
    theme: 'ものづくりを通して人とつながりたい'
  },
  {
    keys: ['介護', '高齢', '福祉', 'ケア', '支援', 'サポート', 'バリアフリー'],
    theme: '誰もが自分らしく生きられる社会をつくりたい'
  },
  {
    keys: ['プログラミング', 'コード', '開発', 'エンジニア', 'アプリ', 'deploy', 'vercel', 'github'],
    theme: '技術で人の暮らしをよくしたい'
  },
  {
    keys: ['音楽', 'くるり', 'K-pop', 'kpop', 'spotify', 'プレイリスト', 'ライブ', 'コンサート', 'バンド', 'ジャズ', 'Jazz'],
    theme: '音楽と感情の関係を探り続けている'
  },
  {
    keys: ['旅行', '旅', '海外', '観光', 'ホテル', 'フライト', '文化交流', '異文化'],
    theme: '旅で出会う文化と人に魅せられている'
  },
  {
    keys: ['映画', 'cinema', 'Netflix', 'アニメ', 'ドラマ', '脚本', '物語', 'ストーリー'],
    theme: '物語が人に与える力を信じている'
  },
  {
    keys: ['本', '読書', '漫画', '小説', '書籍', '作家', '文学'],
    theme: '言葉と物語に自分を重ねている'
  },
  {
    keys: ['起業', 'ビジネス', '販売', 'ショップ', 'ブランド', '事業', 'サービス', 'launch'],
    theme: '自分のビジョンを形にして届けたい'
  },
];

/**
 * ローカルフォールバック：記録 + 既存テーマから人生テーマを抽出する
 * @param {string[]} currentThemes - 現在の人生テーマ文字列配列
 * @param {Array}    recentEntries - 直近の記録
 * @returns {string[]} 人生テーマの文字列配列（最大10件）
 */
function buildLocalLifeThemes(currentThemes, recentEntries) {
  const safeExisting = Array.isArray(currentThemes) ? currentThemes : [];
  const safeEntries  = Array.isArray(recentEntries) ? recentEntries : [];

  // テーマ出現回数カウント用マップ
  const countMap = {};

  // 既存テーマをベースに取り込む
  for (const theme of safeExisting) {
    if (typeof theme === 'string' && theme.trim()) {
      countMap[theme.trim()] = (countMap[theme.trim()] || 0) + 2; // 既存は重みを高く
    }
  }

  // 記録からキーワードで人生テーマを抽出
  for (const entry of safeEntries) {
    const text = ((entry.memo || '') + ' ' + (entry.url || '')).trim();
    if (!text) continue;
    const lower = text.toLowerCase();

    for (const group of LOCAL_LIFE_THEME_MAP) {
      for (const kw of group.keys) {
        if (lower.includes(kw.toLowerCase())) {
          countMap[group.theme] = (countMap[group.theme] || 0) + 1;
          break;
        }
      }
    }
  }

  // 出現回数降順でソートし、最大10件の文字列配列を返す
  return Object.entries(countMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([theme]) => theme);
}

// ============================================================
// HANDLER
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // currentMemory は文字列配列 or オブジェクト配列のどちらでも受け付ける
  const { currentMemory = [], recentEntries = [] } = req.body || {};

  // currentMemory を文字列配列に正規化
  let currentThemes = [];
  if (Array.isArray(currentMemory)) {
    currentThemes = currentMemory
      .map(t => (typeof t === 'string' ? t : (t && t.theme ? t.theme : null)))
      .filter(Boolean);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[organize-memory] GEMINI_API_KEY is not set → local fallback');
    const themes = buildLocalLifeThemes(currentThemes, recentEntries);
    return res.status(200).json({ themes });
  }

  // ── プロンプト構築（v3.1: 人生テーマ抽出プロンプト） ──────────
  const safeRecent = Array.isArray(recentEntries) ? recentEntries.slice(0, 10) : [];

  const userPrompt = `あなたは、ユーザーの過去の記録からその人の本質を理解するAIエージェント「Future Me」の記憶整理システムです。

【目的】
提供された「現在の人生テーマ」と「直近10件の記録」を深く分析し、単なる趣味や一時的なカテゴリ（映画、音楽、写真など）ではなく、その人が何年も繰り返し考えている深い「人生テーマ」を抽出・再整理してください。

【テーマの抽出基準】
良い例：
・文化を未来へ残したい
・忘れることと記憶を考え続けている
・AIと人の関係を探求している
・ものづくりを通して人とつながりたい
・自分らしさを未来に残したい

悪い例：
・映画
・音楽
・写真
・読書
・日記
・食べ物

【統合・整理のルール】
1. 既存のテーマと新しく抽出したテーマを比較してください。
2. 完全に同じ、またはほぼ同じ意味のテーマは重複して追加せず、1つにまとめてください。
3. 一般カテゴリではなく、ユーザーの関心の奥にある意味に言い換えてください。
4. 全体で最大10個に厳選してください。
5. 記録に根拠がないテーマは作らないでください。

【出力フォーマット】
必ず以下のJSONフォーマットのみを返してください。
前置きや説明文は禁止です。
バッククォートによるマークダウン装飾も禁止です。
純粋なJSON文字列のみを出力してください。

{"themes": ["文化を未来へ残したい", "忘れることと記憶を考え続けている"]}

【入力データ】
■現在の人生テーマメモリー:
${JSON.stringify(currentThemes)}

■直近10件の記録:
${JSON.stringify(safeRecent)}`;

  // ── Gemini API 呼び出し ─────────────────────────────────────
  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log('[organize-memory] prompt length:', userPrompt.length);

    const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
      contents: userPrompt,
      config: {
        // スキーマ: themes は文字列の配列（シンプル化）
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            themes: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['themes']
        },
        maxOutputTokens: 800,
        temperature: 0.5,
      },
    });

    console.log(`[organize-memory] response.text (${usedModel}):`, response.text);

    let effectiveRaw = (response.text || '').trim();

    // response.text が空なら candidates から直接取得
    if (!effectiveRaw) {
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (parts && parts.length > 0) {
          effectiveRaw = parts.map(p => p.text || '').join('').trim();
        }
      } catch (e) {
        console.warn('[organize-memory] candidates access failed:', e.message);
      }
    }

    if (!effectiveRaw) {
      throw new Error('Empty response from Gemini');
    }

    // マークダウンコードブロックが含まれる場合は除去
    effectiveRaw = effectiveRaw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(effectiveRaw);
    } catch {
      throw new Error('JSON parse failed: ' + effectiveRaw.slice(0, 100));
    }

    // themes が文字列配列であることを保証
    let themes = [];
    if (Array.isArray(parsed.themes)) {
      themes = parsed.themes
        .filter(t => typeof t === 'string' && t.trim())
        .map(t => t.trim())
        .slice(0, 10);
    }

    console.log('[organize-memory] Gemini success, themes count:', themes.length);
    return res.status(200).json({ themes });

  } catch (err) {
    console.warn('[organize-memory] API error → local fallback:', err.message || err);
    const themes = buildLocalLifeThemes(currentThemes, recentEntries);
    return res.status(200).json({ themes });
  }
}
