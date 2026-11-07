const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '../.env');
const env = fs.readFileSync(envPath, 'utf8');
const l = env.split('\n').find(x => x.startsWith('GEMINI_API_KEY'));
if (!l) {
  console.error('No GEMINI_API_KEY found');
  process.exit(1);
}
const key = l.split('=')[1].trim().replace(/^["']|["']$/g, '');

const chunksFile = path.resolve(__dirname, 'data/agrisense_knowledge_chunks.jsonl');
const lines = fs.readFileSync(chunksFile, 'utf8').trim().split('\n');
const chunks = lines.map(line => JSON.parse(line));

const outPath = path.resolve(__dirname, 'data/embedded_chunks.json');
let existing = {};
if (fs.existsSync(outPath)) {
  try {
    const list = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    list.forEach(item => { existing[item.chunk_id] = item; });
    console.log(`Found ${Object.keys(existing).length} already embedded chunks.`);
  } catch (e) {}
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getEmbeddingWithRetry(text, retries = 5, backoff = 2000) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${encodeURIComponent(key)}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text }] },
          outputDimensionality: 768
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const data = await res.json();
      if (res.status === 429 || data.error?.code === 429 || (data.error?.message && data.error.message.includes('Resource exhausted'))) {
        console.log(`\n[429 Quota] Waiting ${backoff / 1000}s before retry...`);
        await delay(backoff);
        backoff *= 1.5;
        continue;
      }

      if (!res.ok) {
        throw new Error(data.error?.message || `HTTP ${res.status}`);
      }

      if (!data.embedding?.values) {
        throw new Error('No embedding vector in response');
      }

      return data.embedding.values;
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`\n[Attempt ${attempt} error: ${err.message}] Retrying in ${backoff / 1000}s...`);
      await delay(backoff);
      backoff *= 1.5;
    }
  }
}

async function run() {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (existing[c.chunk_id]) {
      console.log(`[${i + 1}/${chunks.length}] ${c.chunk_id} already embedded.`);
      continue;
    }

    process.stdout.write(`[${i + 1}/${chunks.length}] Embedding ${c.chunk_id} (${c.disease_bn})... `);
    const embedding = await getEmbeddingWithRetry(c.text);
    existing[c.chunk_id] = {
      chunk_id: c.chunk_id,
      crop: c.crop_en,
      disease: c.disease_en,
      disease_bn: c.disease_bn,
      content: c.text,
      metadata: c.metadata,
      embedding: embedding
    };
    fs.writeFileSync(outPath, JSON.stringify(Object.values(existing), null, 2), 'utf8');
    console.log(`OK (dim=${embedding.length})`);
    await delay(500);
  }

  console.log(`\nAll ${Object.keys(existing).length} chunks successfully embedded into ${outPath}`);
}

run().catch(console.error);
