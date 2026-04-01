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
      "suggestion": "修正案または対応方法"
    }
  ],
  "overallComment": "総評（2〜3文）"
}

判定基準:
- NG: 明確な法令違反の可能性が高い表現（疾病の治療・予防・改善の標榜、医薬品的効能効果、根拠のない最上級表現など）
- CAUTION: グレーゾーンまたは条件次第で問題となる表現
- INFO: 注意事項・推奨事項`;
}

// テキストチェック
app.post('/api/check', async (req, res) => {
  const { adText, lawScope } = req.body;
  if (!adText || !lawScope) return res.status(400).json({ error: '広告文と法令を指定してください。' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'APIキーが未設定です。' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: buildSystemPrompt(lawScope),
        messages: [{ role: 'user', content: `以下の広告文をチェックしてください:\n\n${adText}` }]
      })
    });
    if (!response.ok) { const err = await response.json().catch(() => ({})); return res.status(response.status).json({ error: err.error?.message || 'APIエラー' }); }
    const data = await response.json();
    const raw = data.content.map(b => b.text || '').join('');
    res.json(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch (e) { res.status(500).json({ error: 'サーバーエラーが発生しました。' }); }
});

// URLからテキスト取得してチェック
app.post('/api/check-url', async (req, res) => {
  const { url, lawScope } = req.body;
  if (!url || !lawScope) return res.status(400).json({ error: 'URLと法令を指定してください。' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'APIキーが未設定です。' });

  try {
    const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!pageRes.ok) return res.status(400).json({ error: 'URLにアクセスできませんでした。' });
    const html = await pageRes.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);

    if (!text) return res.status(400).json({ error: 'ページからテキストを取得できませんでした。' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: buildSystemPrompt(lawScope),
        messages: [{ role: 'user', content: `以下のウェブページの内容をチェックしてください:\n\n${text}` }]
      })
    });
    if (!response.ok) { const err = await response.json().catch(() => ({})); return res.status(response.status).json({ error: err.error?.message || 'APIエラー' }); }
    const data = await response.json();
    const raw = data.content.map(b => b.text || '').join('');
    res.json(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch (e) { res.status(500).json({ error: 'URLの取得に失敗しました。' }); }
});

// PDFアップロードしてチェック
app.post('/api/check-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDFファイルを選択してください。' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'APIキーが未設定です。' });

  const lawScope = req.body.lawScope;
  if (!lawScope) return res.status(400).json({ error: '法令を指定してください。' });

  try {
    const base64 = req.file.buffer.toString('base64');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: buildSystemPrompt(lawScope),
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
            { type: 'text', text: 'このPDFに含まれる広告文・製品説明をチェックしてください。' }
          ]
        }]
      })
    });
    if (!response.ok) { const err = await response.json().catch(() => ({})); return res.status(response.status).json({ error: err.error?.message || 'APIエラー' }); }
    const data = await response.json();
    const raw = data.content.map(b => b.text || '').join('');
    res.json(JSON.parse(raw.replace(/```json|```/g, '').trim()));
  } catch (e) { res.status(500).json({ error: 'PDFの処理に失敗しました。' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
