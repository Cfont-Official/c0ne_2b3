import express from "express";
import fetch from "node-fetch";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmet());
app.use(express.json());
app.use(cors({ origin: (origin, cb) => cb(null, true) }));

app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use(express.static(path.join(__dirname, "public")));

function extractYtInitialData(html) {
  const markers = ["var ytInitialData =", "window[\"ytInitialData\"] =", "window.ytInitialData ="];
  let start = -1;
  for (const m of markers) {
    const idx = html.indexOf(m);
    if (idx !== -1) {
      start = html.indexOf("{", idx + m.length);
      break;
    }
  }
  if (start === -1) return null;

  let i = start, depth = 0, inString = false, prevChar = null;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '"' && prevChar !== "\\") inString = !inString;
    else if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const jsonText = html.slice(start, i + 1);
          try { return JSON.parse(jsonText); } catch { return null; }
        }
      }
    }
    prevChar = ch;
  }
  return null;
}

function extractVideos(initialData) {
  const results = [];
  try {
    const contents = initialData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
    if (!Array.isArray(contents)) return results;
    for (const section of contents) {
      const items = section?.itemSectionRenderer?.contents || [];
      for (const it of items) {
        const vr = it.videoRenderer;
        if (!vr) continue;
        const videoId = vr.videoId;
        const title = Array.isArray(vr.title?.runs) ? vr.title.runs.map(r => r.text).join("") : vr.title?.simpleText || "";
        const thumbnails = (vr.thumbnail?.thumbnails || []).map(t => t.url);
        const thumb = thumbnails.length ? thumbnails[thumbnails.length - 1] : null;
        const lengthText = vr.lengthText?.simpleText || null;
        const channel = vr.ownerText?.runs?.[0]?.text || null;
        results.push({
          videoId,
          title,
          thumbnail: thumb,
          length: lengthText,
          channel,
          embed: videoId ? `https://www.youtube-nocookie.com/embed/${videoId}` : null,
          watch: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null
        });
      }
    }
  } catch (err) {
    console.error("extractVideos error", err);
  }
  return results;
}

app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "missing q parameter" });

    const max = Math.min(50, parseInt(req.query.max || "12"));
    const safe = (req.query.safe || "true") === "true";

    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.youtube.com/"
      },
      redirect: "follow"
    });

    if (!r.ok) return res.status(r.status).json({ error: `YouTube fetch failed: ${r.status}` });

    const html = await r.text();
    const initialData = extractYtInitialData(html);
    if (!initialData) return res.status(500).json({ error: "Could not extract data" });

    let videos = extractVideos(initialData);
    const blacklist = ["porn", "nude", "nsfw", "sex", "xxx", "adult", "erotic"];
    if (safe) {
      videos = videos.filter(v => {
        const text = (v.title + " " + (v.channel || "")).toLowerCase();
        return !blacklist.some(b => text.includes(b));
      });
    }
    videos = videos.slice(0, max);
    res.json({ query: q, count: videos.length, results: videos });
  } catch (err) {
    res.status(500).json({ error: "server error", detail: err.message });
  }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
