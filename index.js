require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN topilmadi! .env faylga tokeningizni qo'shing.");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

if (process.env.PORT) {
  const http = require('http');
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot ishlayapti ✅');
  }).listen(process.env.PORT, () => {
    console.log(`🌐 Health-check server ${process.env.PORT}-portda ishga tushdi`);
  });
}

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// --- Audio kesh ---
const CACHE_FILE = path.join(DOWNLOAD_DIR, 'audio_cache.json');
let AUDIO_CACHE = {};
try { AUDIO_CACHE = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { AUDIO_CACHE = {}; }
let cacheSaveTimer = null;
function saveAudioCache() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    fs.writeFile(CACHE_FILE, JSON.stringify(AUDIO_CACHE), () => {});
  }, 500);
}

const STORAGE_CHAT_ID = process.env.STORAGE_CHAT_ID || null;
const PENDING_PREFETCH = new Map();
const URL_REGEX = /(https?:\/\/[^\s]+)/i;

function detectPlatform(url) {
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  return null;
}

bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "Salom! 👋\n\nMen Instagram, TikTok va YouTube'dan video va musiqa yuklab beraman.\n\n" +
    "📥 Havolani yuboring — Video yoki Audio tanlaysiz\n" +
    "🔎 Qo'shiq nomini yozing — qidirib beraman",
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "🤖 Buyruqlar:\n/start - Botni ishga tushirish\n/help - Yordam\n\n" +
    "📥 Havola yuboring → Video yoki Audio tugmasini bosing.\n" +
    "🔎 Qo'shiq nomini yozing → bot qidirib beradi."
  );
});

bot.onText(/^\/mp3\s+(.+)/i, async (msg, match) => {
  await handleDownload(msg.chat.id, match[1].trim(), true);
});

const LINK_CACHE = new Map();
setInterval(() => {
  const THIRTY_MIN = 30 * 60 * 1000;
  const now = Date.now();
  for (const [key, val] of LINK_CACHE) {
    if (now - val.timestamp > THIRTY_MIN) LINK_CACHE.delete(key);
  }
}, 10 * 60 * 1000);

const QUALITY_LEVELS = [360, 480, 720, 1080];

// TUZATISH 1: aria2c mavjudligini tekshiramiz — yo'q bo'lsa ishlatmaymiz
let ARIA2C_AVAILABLE = false;
exec('which aria2c', (err) => {
  ARIA2C_AVAILABLE = !err;
  console.log(ARIA2C_AVAILABLE ? '✅ aria2c mavjud — tez rejim yoqildi' : '⚠️ aria2c topilmadi — oddiy rejimda ishlaydi');
});

// TUZATISH 2: aria2c bo'lmasa uni ishlatmaymiz, shunda yt-dlp hang bo'lmaydi
function getSpeedFlags() {
  const base = '-4 -N 4 --no-update';
  if (ARIA2C_AVAILABLE) {
    return base + ' --external-downloader aria2c --external-downloader-args "-x 8 -s 8 -k 1M"';
  }
  return base; // aria2c yo'q — oddiy yt-dlp
}

const WRITABLE_COOKIES_PATH = path.join(DOWNLOAD_DIR, 'cookies.txt');
function getCookiesPath() {
  const secretPath = '/etc/secrets/cookies.txt';
  if (!fs.existsSync(secretPath)) return null;
  try {
    fs.copyFileSync(secretPath, WRITABLE_COOKIES_PATH);
    return WRITABLE_COOKIES_PATH;
  } catch (e) {
    return secretPath;
  }
}

function buildYtDlpFlags(platform) {
  const cookiesPath = getCookiesPath();
  const cookiesArg = cookiesPath ? `--cookies "${cookiesPath}"` : '';
  const extractorArgs = (platform === 'YouTube' && !cookiesPath)
    ? `--extractor-args "youtube:player_client=android,web"`
    : '';
  return `${getSpeedFlags()} ${cookiesArg} ${extractorArgs}`;
}

// TUZATISH 3: getMediaInfo parallel ishlaydi — tugmalarni KO'RSATIB BO'LGACH chaqiramiz
function getMediaInfo(url) {
  return new Promise((resolve) => {
    const cmd = `yt-dlp -4 --no-warnings --no-update --skip-download --print "%(thumbnail)s|||%(title)s" "${url}"`;
    exec(cmd, { maxBuffer: 1024 * 1024 * 10, timeout: 12000 }, (error, stdout) => {
      if (error || !stdout.trim()) { resolve(null); return; }
      const [thumbnail, ...titleParts] = stdout.trim().split('\n')[0].split('|||');
      resolve({
        thumbnail: thumbnail && thumbnail !== 'NA' ? thumbnail : null,
        title: titleParts.join('|||').trim() || 'Nomsiz'
      });
    });
  });
}

// Asosiy xabar handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  if (text.startsWith('/')) return;

  const match = text.match(URL_REGEX);
  if (match) {
    const url = match[1];
    const platform = detectPlatform(url);
    if (!platform) {
      bot.sendMessage(chatId, "❌ Bu havolani tanib bo'lmadi. Instagram, TikTok yoki YouTube havolasini yuboring.");
      return;
    }

    const linkId = crypto.randomBytes(4).toString('hex');
    LINK_CACHE.set(linkId, { url, timestamp: Date.now() });

    // TUZATISH 4: AVVAL tugmalarni ko'rsatamiz — foydalanuvchi kutmaydi
    const qualityButtons = QUALITY_LEVELS.map(q => ({
      text: `🎬 ${q}p`,
      callback_data: `dl:${linkId}:v${q}`
    }));
    const keyboard = [];
    for (let i = 0; i < qualityButtons.length; i += 2) {
      keyboard.push(qualityButtons.slice(i, i + 2));
    }
    keyboard.push([{ text: '🎵 Audio (MP3)', callback_data: `dl:${linkId}:audio` }]);

    // Darhol tugmalarni yuboramiz — thumbnail kelishi kutilmaydi
    const sentMsg = await bot.sendMessage(chatId,
      `📥 *${platform}* havolasi aniqlandi.\n\nQaysi formatda yuklab olay?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );

    // KEYIN — fon rejimida thumbnail + sarlavha yuklaymiz
    // Agar muvaffaqiyatli bo'lsa, xabarni yangilaymiz
    getMediaInfo(url).then(info => {
      if (!info) return;
      const caption = `🎬 *${info.title}*\n\nQaysi formatda yuklab olay?`;
      if (info.thumbnail) {
        // Thumbnail bilan yangi xabar — eskisini o'chiramiz
        bot.sendPhoto(chatId, info.thumbnail, {
          caption,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }).then(() => {
          bot.deleteMessage(chatId, sentMsg.message_id).catch(() => {});
        }).catch(() => {
          // Thumbnail ishlamasa — matnli xabarni yangilaymiz
          bot.editMessageText(caption, {
            chat_id: chatId,
            message_id: sentMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
          }).catch(() => {});
        });
      } else {
        bot.editMessageText(caption, {
          chat_id: chatId,
          message_id: sentMsg.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }).catch(() => {});
      }
    });

  } else {
    await handleMusicSearch(chatId, text.trim());
  }
});

function prefetchAudio(videoId, title) {
  if (!STORAGE_CHAT_ID) return;
  if (AUDIO_CACHE[videoId] || PENDING_PREFETCH.has(videoId)) return;

  const promise = new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const fileKey = crypto.randomBytes(6).toString('hex');
    const outputTemplate = path.join(DOWNLOAD_DIR, `${fileKey}.%(ext)s`);
    const flags = buildYtDlpFlags('YouTube');
    const cmd = `yt-dlp ${flags} -f "bestaudio[ext=m4a]/bestaudio" -x --audio-format m4a -o "${outputTemplate}" "${url}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, async (error, stdout, stderr) => {
      if (error) { console.error(`[prefetch] xatolik:`, stderr || error.message); resolve(null); return; }
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileKey));
      if (!files.length) { resolve(null); return; }
      const filePath = path.join(DOWNLOAD_DIR, files[0]);
      try {
        const sent = await bot.sendAudio(STORAGE_CHAT_ID, filePath, { title });
        if (sent?.audio?.file_id) {
          AUDIO_CACHE[videoId] = sent.audio.file_id;
          saveAudioCache();
          resolve(sent.audio.file_id);
        } else { resolve(null); }
      } catch (e) { console.error(`[prefetch] xatolik:`, e.message); resolve(null); }
        finally { fs.unlink(filePath, () => {}); }
    });
  }).finally(() => PENDING_PREFETCH.delete(videoId));

  PENDING_PREFETCH.set(videoId, promise);
}

async function handleDownload(chatId, url, audioOnly, height) {
  const platform = detectPlatform(url);
  if (!platform) {
    bot.sendMessage(chatId, "❌ Bu havolani tanib bo'lmadi.");
    return;
  }

  const statusMsg = await bot.sendMessage(chatId,
    `⏳ ${platform}'dan ${audioOnly ? 'musiqa' : (height ? height + 'p video' : 'video')} yuklanmoqda...`
  );

  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const flags = buildYtDlpFlags(platform);

  const videoFormat = height
    ? `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/mp4/best`
    : `mp4/best`;

  const cmd = audioOnly
    ? `yt-dlp ${flags} -f "bestaudio[ext=m4a]/bestaudio" -x --audio-format m4a -o "${outputTemplate}" "${url}"`
    : `yt-dlp ${flags} -f "${videoFormat}" --merge-output-format mp4 -o "${outputTemplate}" "${url}"`;

  runAndSend(cmd, chatId, statusMsg.message_id, fileId, audioOnly,
    `❌ Yuklab bo'lmadi. Havola noto'g'ri yoki video mavjud emas.`);
}

const SEARCH_CACHE = new Map();
setInterval(() => {
  const THIRTY_MIN = 30 * 60 * 1000;
  const now = Date.now();
  for (const [key, val] of SEARCH_CACHE) {
    if (now - val.timestamp > THIRTY_MIN) SEARCH_CACHE.delete(key);
  }
}, 10 * 60 * 1000);

async function handleMusicSearch(chatId, query) {
  if (!query || query.length < 2) return;
  const statusMsg = await bot.sendMessage(chatId, `🔎 "${query}" qidirilmoqda...`);
  const safeQuery = query.replace(/"/g, '');

  // TUZATISH 5: socket-timeout qisqartirildi, natijalar 5ga tushirildi (tezroq)
  const cmd = `yt-dlp -4 --no-update --extractor-args "youtube:player_client=android" ` +
    `--flat-playlist --skip-download --socket-timeout 6 ` +
    `--print "%(id)s|||%(title)s" "ytsearch8:${safeQuery}"`;

  const t0 = Date.now();
  exec(cmd, { maxBuffer: 1024 * 1024 * 20, timeout: 20000 }, async (error, stdout) => {
    console.log(`[qidiruv] "${query}": ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (error || !stdout.trim()) {
      bot.editMessageText(`❌ "${query}" bo'yicha hech narsa topilmadi.`, {
        chat_id: chatId, message_id: statusMsg.message_id
      }).catch(() => {});
      return;
    }

    const results = stdout.trim().split('\n').map(line => {
      const [id, ...titleParts] = line.split('|||');
      return { id: id.trim(), title: titleParts.join('|||').trim() || 'Nomsiz' };
    }).filter(r => r.id);

    if (!results.length) {
      bot.editMessageText(`❌ "${query}" bo'yicha hech narsa topilmadi.`, {
        chat_id: chatId, message_id: statusMsg.message_id
      }).catch(() => {});
      return;
    }

    const searchId = crypto.randomBytes(4).toString('hex');
    SEARCH_CACHE.set(searchId, { results, timestamp: Date.now() });

    const listText = `🔎 *"${query}"* natijalari:\n\n` +
      results.map((r, i) => `${i + 1}. ${r.title}`).join('\n');

    const buttons = results.map((r, i) => ({
      text: `🎵 ${i + 1}`,
      callback_data: `pick:${searchId}:${i}`
    }));
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 5) keyboard.push(buttons.slice(i, i + 5));

    bot.editMessageText(listText, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {});

    prefetchAudio(results[0].id, results[0].title);
  });
}

// Callback handler — havola uchun
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  if (!data.startsWith('dl:')) return;

  const [, linkId, kind] = data.split(':');
  const cached = LINK_CACHE.get(linkId);
  if (!cached) {
    bot.answerCallbackQuery(query.id, { text: '⏱ Havola muddati tugagan, qayta yuboring.', show_alert: true }).catch(() => {});
    return;
  }

  const isAudio = kind === 'audio';
  const height = isAudio ? null : parseInt(kind.replace('v', ''), 10);

  bot.answerCallbackQuery(query.id, { text: isAudio ? '⏳ Audio yuklanmoqda...' : `⏳ ${height}p yuklanmoqda...` }).catch(() => {});
  bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
  await handleDownload(chatId, cached.url, isAudio, height);
});

// Callback handler — qidiruv uchun
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  if (!data.startsWith('pick:')) return;

  const [, searchId, indexStr] = data.split(':');
  const cached = SEARCH_CACHE.get(searchId);
  if (!cached) {
    bot.answerCallbackQuery(query.id, { text: '⏱ Qidiruv muddati tugagan, qayta qidiring.', show_alert: true }).catch(() => {});
    return;
  }

  const chosen = cached.results[parseInt(indexStr, 10)];
  if (!chosen) {
    bot.answerCallbackQuery(query.id, { text: '❌ Topilmadi.', show_alert: true }).catch(() => {});
    return;
  }

  const cachedFileId = AUDIO_CACHE[chosen.id];
  if (cachedFileId) {
    bot.answerCallbackQuery(query.id, { text: `✅ ${chosen.title}` }).catch(() => {});
    const statusMsg = await bot.sendMessage(chatId, `📤 "${chosen.title}" yuborilmoqda...`);
    try {
      await bot.sendAudio(chatId, cachedFileId);
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return;
    } catch (e) {
      delete AUDIO_CACHE[chosen.id];
      saveAudioCache();
    }
  }

  if (PENDING_PREFETCH.has(chosen.id)) {
    bot.answerCallbackQuery(query.id, { text: `⏳ Deyarli tayyor...` }).catch(() => {});
    const statusMsg = await bot.sendMessage(chatId, `⏳ "${chosen.title}" tayyorlanmoqda...`);
    const fid = await PENDING_PREFETCH.get(chosen.id);
    if (fid) {
      try {
        await bot.sendAudio(chatId, fid);
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return;
      } catch (e) { /* fallback */ }
    }
    return await downloadAndSendPick(chatId, chosen, statusMsg.message_id);
  }

  bot.answerCallbackQuery(query.id, { text: `⏳ Yuklanmoqda...` }).catch(() => {});
  const statusMsg = await bot.sendMessage(chatId, `⏳ "${chosen.title}" yuklanmoqda...`);
  return await downloadAndSendPick(chatId, chosen, statusMsg.message_id);
});

function downloadAndSendPick(chatId, chosen, statusMessageId) {
  const url = `https://www.youtube.com/watch?v=${chosen.id}`;
  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const flags = buildYtDlpFlags('YouTube');
  const cmd = `yt-dlp ${flags} -f "bestaudio[ext=m4a]/bestaudio" -x --audio-format m4a -o "${outputTemplate}" "${url}"`;
  const t0 = Date.now();
  return runAndSend(cmd, chatId, statusMessageId, fileId, true,
    `❌ "${chosen.title}" yuklab bo'lmadi.`, chosen.id, chosen.title, t0);
}

function runAndSend(cmd, chatId, statusMessageId, fileId, audioOnly, errorText, cacheKey, cacheTitle, t0) {
  const startedAt = t0 || Date.now();
  exec(cmd, { maxBuffer: 1024 * 1024 * 50, timeout: 120000 }, async (error, stdout, stderr) => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (error) {
      console.error(`[xato] ${elapsed}s dan keyin:`, stderr || error.message);
      bot.editMessageText(errorText, { chat_id: chatId, message_id: statusMessageId }).catch(() => {});
      return;
    }

    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileId));
    if (!files.length) {
      bot.editMessageText("❌ Fayl topilmadi.", { chat_id: chatId, message_id: statusMessageId }).catch(() => {});
      return;
    }

    const filePath = path.join(DOWNLOAD_DIR, files[0]);
    const sizeMb = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);
    console.log(`[yuklash] ${elapsed}s | ${sizeMb}MB | ${cacheTitle || fileId}`);

    try {
      if (audioOnly) {
        const sent = await bot.sendAudio(chatId, filePath, cacheTitle ? { title: cacheTitle } : {});
        if (cacheKey && sent?.audio?.file_id) {
          AUDIO_CACHE[cacheKey] = sent.audio.file_id;
          saveAudioCache();
        }
      } else {
        await bot.sendVideo(chatId, filePath, {}, { filename: files[0], contentType: 'video/mp4' });
      }
      await bot.deleteMessage(chatId, statusMessageId).catch(() => {});
    } catch (sendErr) {
      console.error(sendErr);
      bot.sendMessage(chatId, "❌ Faylni yuborishda xatolik (fayl 50MB dan katta bo'lishi mumkin).");
    } finally {
      fs.unlink(filePath, () => {});
    }
  });
}

console.log("🤖 Bot ishga tushdi...");
console.log(STORAGE_CHAT_ID ? `📦 Ombor: ${STORAGE_CHAT_ID}` : "⚠️ STORAGE_CHAT_ID yo'q — prefetch o'chirilgan");
