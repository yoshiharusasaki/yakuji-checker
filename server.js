const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function buildSystemPrompt(lawScope) {
  return `あなたは日本の薬事法規に精通した専門家です。健康食品・サプリメントの広告文を分析し、以下の法令への適合性を厳密にチェックします。

チェック対象法令: ${lawScope}

以下のJSON形式のみで回答してください（マークダウンや説明文は不要）:

{
  "verdict": "NG" | "CAUTION" | "OK",
  "verdictReason": "総合判定の理由（1〜2文）",
  "ngCount": 数値,
  "cautionCount": 数値,
  "issues": [
    {
      "level": "NG" | "CAUTION" | "INFO",
      "law": "該当法令名",
      "title": "問題のタイトル（20文字以内）",
      "quote": "問題となる広告文の引用",
      "reason": "なぜ問題なのか（具体的に）",
      "suggestion": "修正の方向性（1〜2文）",
      "alternatives": ["代替表現例1", "代替表現例2", "代替表現例3"]
    }
  ],
  "overallComment": "総評（2〜3文）"
}

判定基準:
- NG: 明確な法令違反の可能性が高い表現（疾病の治療・予防・改善の標榜、医薬品的効能効果、根拠のない最上級表現など）
- CAUTION: グレーゾーンまたは条件次第で問題となる表現
- INFO: 注意事項・推奨事項

alternatives（代替表現例）について:
- 問題のある表現を法令に適合した形に言い換えた具体的な文例を3つ提示してください
- 機能性表示食品・特定保健用食品の届出がない一般食品の場合は、身体の構造・機能に関わる表現を避け、「サポート」「気になる方に」「毎日の習慣に」などの表現を活用してください
- あくまで参考案であり、最終的な法的判断は専門家が行う旨を念頭に置いてください`;
}

function buildDesignPrompt(lawScope) {
  return `あなたは日本の薬事法規と広告デザイン規制に精通した専門家です。健康食品・サプリメントのパッケージ・広告デザインを画像として分析し、視覚的な観点から法令適合性をチェックします。

チェック対象法令: ${lawScope}

以下のJSON形式のみで回答してください（マークダウンや説明文は不要）:

{
  "verdict": "NG" | "CAUTION" | "OK",
  "verdictReason": "総合判定の理由（1〜2文）",
  "ngCount": 数値,
  "cautionCount": 数値,
  "issues": [
    {
      "level": "NG" | "CAUTION" | "INFO",
      "law": "該当法令名",
      "title": "問題のタイトル（20文字以内）",
      "quote": "問題となる表示・デザイン要素の説明",
      "reason": "なぜ問題なのか（具体的に）",
      "suggestion": "改善の方向性（1〜2文）",
      "alternatives": ["改善案1", "改善案2", "改善案3"]
    }
  ],
  "overallComment": "総評（2〜3文）"
}

デザイン評価の観点:
- 打消し表示の文字サイズ・視認性（強調表示に対して十分な大きさか）
- 強調表示と打消し表示の位置関係（近接しているか）
- 文字色と背景色のコントラスト（景品表示法上の視認性要件）
- 過度な強調表現（最大・最強・No.1等）の視覚的な目立ちやすさ
- ビフォーアフター画像の使用有無と適切性
- 医薬品を想起させるデザイン要素（白衣・医療機器等のビジュアル）
- 効果を暗示する図表・グラフの適切性
- 文字情報も含めた薬機法・景品表示法上の問題表現`;
}

async function callClaude(messages, lawScope, isDesign = false) {
  const systemPrompt = isDesign ? buildDesignPrompt(lawScope) : buildSystemPrompt(lawScope);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: systemPrompt, messages })
  });
  if (!response.ok) { const err = await response.json().catch(() => ({})); throw new Error(err.error?.message || 'APIエラー'); }
  const data = await response.json();
  const raw = data.content.map(b => b.text || '').join('');
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

// テキストチェック
app.post('/api/check', async (req, res) => {
  const { adText, lawScope } = req.body;
  if (!adText || !lawScope) return res.status(400).json({ error: '広告文と法令を指定してください。' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'APIキーが未設定です。' });
  try {
    const result = await callClaude([{ role: 'user', content: `以下の広告文をチェックしてください:\n\n${adText}` }], lawScope);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message || 'サーバーエラーが発生しました。' }); }
});

// URLチェック
app.post('/api/check-url', async (req, res) => {
  const { url, lawScope } = req.body;
  if (!url || !lawScope) return res.status(400).json({ error: 'URLと法令を指定してください。' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'APIキーが未設定です。' });
  try {
    const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!pageRes.ok) return res.status(400).json({ error: 'URLにアクセスできませんでした。' });
    const html = await pageRes.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: 'ページからテキストを取得できませんでした。' });
    const result = await callClaude([{ role: 'user', content: `以下のウェブページの内容をチェックしてください:\n\n${text}` }], lawScope);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message || 'URLの取得に失敗しました。' }); }
});

// PDFチェック（テキスト＋デザイン）
app.post('/api/check-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDFファイルを選択してください。' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'APIキーが未設定です。' });
  const { lawScope, mode } = req.body;
  if (!lawScope) return res.status(400).json({ error: '法令を指定してください。' });
  const isDesign = mode === 'design';
  try {
    const base64 = req.file.buffer.toString('base64');
    const userText = isDesign
      ? 'このPDFのデザイン・レイアウト・視覚的要素および文字情報を総合的に評価してください。'
      : 'このPDFに含まれる広告文・製品説明をチェックしてください。';
    const result = await callClaude([{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: userText }
      ]
    }], lawScope, isDesign);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message || 'PDFの処理に失敗しました。' }); }
});

// 画像デザインチェック
app.post('/api/check-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '画像ファイルを選択してください。' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'APIキーが未設定です。' });
  const { lawScope } = req.body;
  if (!lawScope) return res.status(400).json({ error: '法令を指定してください。' });
  try {
    const base64 = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype;
    const result = await callClaude([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'この広告・パッケージ画像のデザイン・レイアウト・視覚的要素および文字情報を総合的に評価してください。' }
      ]
    }], lawScope, true);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message || '画像の処理に失敗しました。' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
