require("dotenv").config();

const { execFile, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const http = require("http");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 10000);
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || "./downloads");
const MAX_FILE_BYTES = 49 * 1024 * 1024;
const CACHE_TTL = 30 * 60 * 1000;

if (!TOKEN) {
  console.error("BOT_TOKEN topilmadi. Render Environment Variables ga BOT_TOKEN qo‘shing.");
  process.exit(1);
}

const telegram = `https://api.telegram.org/bot${TOKEN}`;
const links = new Map();
const searches = new Map();
const activeChats = new Set();
let updateOffset = 0;
let polling = true;
let conflictLoggedAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanTitle(value, limit = 180) {
  return String(value || "Nomsiz media")
    .replace(/[*_`[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit) || "Nomsiz media";
}

function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "Instagram";
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "TikTok";
    if (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be"
    ) return "YouTube";
  } catch (_) {}
  return null;
}

function extractUrl(text) {
  const match = String(text).match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[),.!?]+$/, "") : null;
}

async function tg(method, body = {}, timeout = 40000) {
  const response = await fetch(`${telegram}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.description || `Telegram ${method} failed`);
    error.code = payload.error_code;
    throw error;
  }
  return payload.result;
}

async function sendFile(method, chatId, filePath, filename, fields = {}) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value));
  }
  const bytes = await fsp.readFile(filePath);
  form.append(method === "sendAudio" ? "audio" : "video", new Blob([bytes]), filename);

  const response = await fetch(`${telegram}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.description || `Telegram ${method} failed`);
    error.code = payload.error_code;
    throw error;
  }
  return payload.result;
}

function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!done) {
        done = true;
        reject(new Error(`${command} timeout`));
      }
    }, timeout);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

function ytArgs(url) {
  const args = [
    "--no-warnings",
    "--no-update",
    "--no-playlist",
    "--socket-timeout", "20",
    "--retries", "2",
    "--fragment-retries", "2",
    "--concurrent-fragments", "4",
  ];
  const cookies = process.env.YT_DLP_COOKIES_FILE || "/etc/secrets/cookies.txt";
  if (fs.existsSync(cookies)) args.push("--cookies", cookies);
  if (detectPlatform(url) === "YouTube") {
    // Do not force android: it often exposes image-only formats and causes
    // "Requested format is not available".
    args.push("--extractor-args", "youtube:player_client=web_safari");
  }
  return args;
}

async function mediaInfo(url) {
  try {
    const { stdout } = await run("yt-dlp", [
      ...ytArgs(url), "--dump-single-json", "--skip-download", url,
    ], 30000);
    const data = JSON.parse(stdout);
    return { title: cleanTitle(data.title), thumbnail: data.thumbnail };
  } catch (error) {
    console.warn("Media info olinmadi:", error.message);
    return null;
  }
}

async function findFile(prefix) {
  const names = await fsp.readdir(DOWNLOAD_DIR);
  const candidates = [];
  for (const name of names) {
    if (!name.startsWith(`${prefix}.`)) continue;
    const filePath = path.join(DOWNLOAD_DIR, name);
    const stat = await fsp.stat(filePath);
    if (stat.isFile()) candidates.push({ filePath, time: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.time - a.time);
  return candidates[0] ? candidates[0].filePath : null;
}

async function download(url, kind, height) {
  const prefix = `media-${crypto.randomBytes(8).toString("hex")}`;
  const output = path.join(DOWNLOAD_DIR, `${prefix}.%(ext)s`);
  const base = [...ytArgs(url), "-o", output];

  if (kind === "audio") {
    await run("yt-dlp", [
      ...base,
      "-f", "bestaudio/best",
      "-x", "--audio-format", "mp3", "--audio-quality", "128K",
      url,
    ], 180000);
  } else {
    const quality = Math.max(144, Math.min(Number(height) || 720, 1080));
    const format = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
    try {
      await run("yt-dlp", [
        ...base, "-f", format, "--merge-output-format", "mp4",
        "--max-filesize", "49M", url,
      ], 180000);
    } catch (firstError) {
      console.warn("Video format fallback:", firstError.message);
      await run("yt-dlp", [
        ...base, "-f", "best", "--merge-output-format", "mp4",
        "--max-filesize", "49M", url,
      ], 180000);
    }
  }

  const filePath = await findFile(prefix);
  if (!filePath) throw new Error("Fayl yaratilmagan");
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    await fsp.unlink(filePath).catch(() => {});
    throw new Error("FILE_TOO_LARGE");
  }
  return filePath;
}

function linkKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: "Video 360p", callback_data: `dl:${id}:v360` },
        { text: "Video 480p", callback_data: `dl:${id}:v480` },
      ],
      [
        { text: "Video 720p", callback_data: `dl:${id}:v720` },
        { text: "Video 1080p", callback_data: `dl:${id}:v1080` },
      ],
      [{ text: "Audio MP3", callback_data: `dl:${id}:audio` }],
    ],
  };
}

async function downloadAndSend(chatId, url, kind, height, title) {
  if (activeChats.has(chatId)) {
    await tg("sendMessage", { chat_id: chatId, text: "Bu chatda boshqa yuklash davom etmoqda." });
    return;
  }
  activeChats.add(chatId);
  const status = await tg("sendMessage", {
    chat_id: chatId,
    text: kind === "audio" ? "Audio yuklanmoqda..." : `${height || 720}p video yuklanmoqda...`,
  });
  let filePath = null;
  try {
    filePath = await download(url, kind, height);
    const filename = path.basename(filePath);
    if (kind === "audio") {
      await sendFile("sendAudio", chatId, filePath, filename, {
        title: cleanTitle(title || "YouTube audio"),
        performer: "Media Downloader",
      });
    } else {
      await sendFile("sendVideo", chatId, filePath, filename, {
        supports_streaming: "true",
        caption: cleanTitle(title || ""),
      });
    }
    await tg("deleteMessage", { chat_id: chatId, message_id: status.message_id }).catch(() => {});
  } catch (error) {
    console.error("Yuklash xatosi:", error.message);
    const message = error.message === "FILE_TOO_LARGE"
      ? "Fayl 49 MB dan katta. Pastroq sifatni tanlang."
      : "Yuklab bo‘lmadi. Video yopiq, login talab qiladigan yoki vaqtincha mavjud emas bo‘lishi mumkin.";
    await tg("editMessageText", {
      chat_id: chatId, message_id: status.message_id, text: message,
    }).catch(() => {});
  } finally {
    activeChats.delete(chatId);
    if (filePath) await fsp.unlink(filePath).catch(() => {});
  }
}

async function handleSearch(chatId, query) {
  if (!query || query.length < 2 || query.length > 120) return;
  const status = await tg("sendMessage", {
    chat_id: chatId, text: `"${cleanTitle(query)}" qidirilmoqda...`,
  });
  try {
    const { stdout } = await run("yt-dlp", [
      ...ytArgs("https://www.youtube.com"),
      "--flat-playlist", "--skip-download", "--print", "%(id)s\t%(title)s",
      `ytsearch5:${query}`,
    ], 40000);
    const results = stdout.trim().split(/\r?\n/).map((line) => {
      const [id, ...parts] = line.split("\t");
      return { id: id && id.trim(), title: cleanTitle(parts.join("\t")) };
    }).filter((item) => item.id);
    if (!results.length) throw new Error("Natija yo‘q");

    const searchId = crypto.randomBytes(5).toString("hex");
    searches.set(searchId, { results, time: Date.now() });
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: status.message_id,
      text: `Qidiruv natijalari:\n\n${results.map((x, i) => `${i + 1}. ${x.title}`).join("\n")}`,
      reply_markup: {
        inline_keyboard: results.map((x, i) => [
          { text: `${i + 1}. ${cleanTitle(x.title, 45)}`, callback_data: `pick:${searchId}:${i}` },
        ]),
      },
    });
  } catch (error) {
    console.warn("Qidiruv xatosi:", error.message);
    await tg("editMessageText", {
      chat_id: chatId, message_id: status.message_id,
      text: "Natija topilmadi. Boshqa nom bilan qayta urinib ko‘ring.",
    }).catch(() => {});
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = String(message.text || "").trim();
  if (!text) return;

  if (/^\/start(?:@\w+)?$/i.test(text)) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Salom!\n\nInstagram, TikTok yoki YouTube havolasini yuboring. Video sifati yoki Audio MP3 formatini tanlang.\n\nQo‘shiq nomini yuborsangiz, YouTube’dan qidiraman.\n/help — yordam",
    });
    return;
  }
  if (/^\/help(?:@\w+)?$/i.test(text)) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "1. Instagram, TikTok yoki YouTube havolasini yuboring.\n2. Video sifatini yoki Audio MP3 tugmasini bosing.\n3. Qidiruv uchun qo‘shiq nomini yozing.\n\nTelegram 49 MB dan katta fayllarni qabul qilmaydi.",
    });
    return;
  }
  if (/^\/mp3\s+/i.test(text)) {
    return handleSearch(chatId, text.replace(/^\/mp3\s+/i, "").trim());
  }

  const url = extractUrl(text);
  if (url) {
    const platform = detectPlatform(url);
    if (!platform) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Bu havola qo‘llab-quvvatlanmaydi. Instagram, TikTok yoki YouTube havolasini yuboring.",
      });
      return;
    }
    const id = crypto.randomBytes(5).toString("hex");
    links.set(id, { url, time: Date.now() });
    const sent = await tg("sendMessage", {
      chat_id: chatId,
      text: `${platform} havolasi aniqlandi.\nFormatni tanlang:`,
      reply_markup: linkKeyboard(id),
    });
    mediaInfo(url).then((info) => {
      if (!info) return;
      tg("editMessageText", {
        chat_id: chatId,
        message_id: sent.message_id,
        text: `${info.title}\n\nFormatni tanlang:`,
        reply_markup: linkKeyboard(id),
      }).catch(() => {});
    });
    return;
  }
  return handleSearch(chatId, text);
}

async function handleCallback(query) {
  const data = query.data || "";
  const chatId = query.message && query.message.chat.id;
  if (!chatId) return;

  if (data.startsWith("dl:")) {
    const [, id, kind] = data.split(":");
    const cached = links.get(id);
    if (!cached || Date.now() - cached.time > CACHE_TTL) {
      await tg("answerCallbackQuery", {
        callback_query_id: query.id, text: "Havola muddati tugagan.", show_alert: true,
      });
      return;
    }
    await tg("answerCallbackQuery", { callback_query_id: query.id, text: "Yuklash boshlandi..." });
    const audio = kind === "audio";
    return downloadAndSend(
      chatId, cached.url, audio ? "audio" : "video",
      audio ? undefined : Number(kind.replace("v", "")),
    );
  }

  if (data.startsWith("pick:")) {
    const [, id, indexText] = data.split(":");
    const cached = searches.get(id);
    const selected = cached && cached.results[Number(indexText)];
    if (!selected || Date.now() - cached.time > CACHE_TTL) {
      await tg("answerCallbackQuery", {
        callback_query_id: query.id, text: "Qidiruv muddati tugagan.", show_alert: true,
      });
      return;
    }
    await tg("answerCallbackQuery", { callback_query_id: query.id, text: "MP3 tayyorlanmoqda..." });
    return downloadAndSend(
      chatId,
      `https://www.youtube.com/watch?v=${selected.id}`,
      "audio",
      undefined,
      selected.title,
    );
  }
}

async function poll() {
  while (polling) {
    try {
      const updates = await tg("getUpdates", {
        offset: updateOffset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      }, 40000);
      for (const update of updates) {
        updateOffset = update.update_id + 1;
        try {
          if (update.message) await handleMessage(update.message);
          if (update.callback_query) await handleCallback(update.callback_query);
        } catch (error) {
          console.error("Update xatosi:", error.message);
        }
      }
    } catch (error) {
      if (error.code === 409) {
        if (Date.now() - conflictLoggedAt > 60000) {
          conflictLoggedAt = Date.now();
          console.error("409 Conflict: BOT_TOKEN bilan boshqa bot nusxasi ham ishlayapti. Eski Render/Docker service’ni to‘xtating.");
        }
        await sleep(15000);
      } else {
        console.error("Polling xatosi:", error.message);
        await sleep(3000);
      }
    }
  }
}

async function start() {
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
  try {
    await execFileAsync("yt-dlp", ["--version"]);
    await execFileAsync("ffmpeg", ["-version"]);
  } catch (error) {
    console.error("yt-dlp yoki ffmpeg topilmadi:", error.message);
    process.exit(1);
  }

  await tg("deleteWebhook", { drop_pending_updates: false }).catch((error) => {
    console.warn("Webhook tozalanmadi:", error.message);
  });
  console.log("Telegram downloader ishga tushdi.");
  console.log(`Health server: port ${PORT}`);
  poll();
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("Telegram downloader ishlayapti");
});

server.listen(PORT, "0.0.0.0");
start().catch((error) => {
  console.error("Bot ishga tushmadi:", error);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`${signal}: bot to‘xtatilmoqda`);
  polling = false;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
