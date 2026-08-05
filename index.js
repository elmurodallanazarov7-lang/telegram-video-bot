require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN topilmadi! .env faylga tokeningizni qo'shing.");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// RENDER UCHUN UYG'OTUVCHI SERVER QISMI
if (process.env.PORT) {
  const http = require('http');
  const https = require('https'); // Ping uchun https qo'shildi

  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot ishlayapti ✅');
  }).listen(process.env.PORT, () => {
    console.log(`🌐 Health-check server ${process.env.PORT}-portda ishga tushdi`);
    
    // Har 14 daqiqada o'ziga ping yuborish (Uyg'oq tutish uchun)
    setInterval(() => {
      const RENDER_URL = 'https://telegram-video-bot-k1xp.onrender.com/'; 
      
      https.get(RENDER_URL, (res) => {
        console.log(`⏱ Uyg'otish pingi yuborildi: ${res.statusCode}`);
      }).on('error', (e) => {
        console.error(`Ping xatosi: ${e.message}`);
      });
    }, 14 * 60 * 1000); // 14 daqiqa
  });
}

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const CACHE_FILE = path.join(DOWNLOAD_DIR, 'audio_cache.json');
let AUDIO_CACHE = {};
try {
  AUDIO_CACHE = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch (e) {
  AUDIO_CACHE = {};
}
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
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    "Salom! 👋\n\n" +
    "Men Instagram, TikTok va YouTube'dan video va musiqa yuklab beraman.\n\n" +
    "📥 *Video/audio yuklash:* shunchaki havolani yuboring.\n" +
    "🔎 *Qo'shiq nomi bilan qidirish:* shunchaki qo'shiq/ijrochi nomini yozing\n\n" +
    "Masalan:\n" +
    "`https://www.tiktok.com/@user/video/123456`\n" +
    "`Ummon guruhi - Sensiz`",
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "🤖 Buyruqlar:\n" +
    "/start - Botni ishga tushirish\n" +
    "/help - Yordam"
  );
});

bot.onText(/^\/mp3\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();
  await handleDownload(chatId, url, 'audio');
});

const LINK_CACHE = new Map();
setInterval(() => {
  const THIRTY_MIN = 30 * 60 * 1000;
  const now = Date.now();
  for (const [key, val] of LINK_CACHE) {
    if (now - val.timestamp > THIRTY_MIN) LINK_CACHE.delete(key);
  }
}, 10 * 60 * 1000);

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

    bot.sendMessage(chatId, `Formatni tanlang:`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Video 360p', callback_data: `dl:${linkId}:360` },
            { text: 'Video 480p', callback_data: `dl:${linkId}:480` }
          ],
          [
            { text: 'Video 720p', callback_data: `dl:${linkId}:720` },
            { text: 'Video 1080p', callback_data: `dl:${linkId}:1080` }
          ],
          [
            { text: 'Audio MP3', callback_data: `dl:${linkId}:audio` }
          ]
        ]
      }
    });
  } else {
    await handleMusicSearch(chatId, text.trim());
  }
});

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

const SPEED_FLAGS = '-4 -N 8 --no-update';

function buildYtDlpFlags(platform) {
  const cookiesPath = getCookiesPath();
  const cookiesArg = cookiesPath ? `--cookies "${cookiesPath}"` : '';

  const extractorArgs = (platform === 'YouTube' && !cookiesPath)
    ? `--extractor-args "youtube:player_client=android,web"`
    : '';

  return `${SPEED_FLAGS} ${cookiesArg} ${extractorArgs}`;
}

function prefetchAudio(videoId, title) {
  if (!STORAGE_CHAT_ID) return;
  if (AUDIO_CACHE[videoId] || PENDING_PREFETCH.has(videoId)) return;

  const promise = new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const fileKey = crypto.randomBytes(6).toString('hex');
    const outputTemplate = path.join(DOWNLOAD_DIR, `${fileKey}.%(ext)s`);
    const flags = buildYtDlpFlags('YouTube');
    const cmd = `yt-dlp ${flags} -f "bestaudio/best" -x --audio-format mp3 -o "${outputTemplate}" "${url}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 2048 }, async (error, stdout, stderr) => {
      if (error) {
        resolve(null);
        return;
      }
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileKey));
      if (files.length === 0) {
        resolve(null);
        return;
      }
      const filePath = path.join(DOWNLOAD_DIR, files[0]);
      try {
        const sent = await bot.sendAudio(STORAGE_CHAT_ID, filePath, { title });
        if (sent && sent.audio && sent.audio.file_id) {
          AUDIO_CACHE[videoId] = sent.audio.file_id;
          saveAudioCache();
          resolve(sent.audio.file_id);
        } else {
          resolve(null);
        }
      } catch (e) {
        resolve(null);
      } finally {
        fs.unlink(filePath, () => {});
      }
    });
  }).finally(() => PENDING_PREFETCH.delete(videoId));

  PENDING_PREFETCH.set(videoId, promise);
}

async function handleDownload(chatId, url, quality) {
  const platform = detectPlatform(url);
  if (!platform) {
    bot.sendMessage(chatId, "❌ Bu havolani tanib bo'lmadi.");
    return;
  }

  const isAudio = quality === 'audio';
  const statusMsg = await bot.sendMessage(chatId, `⏳ Yuklanmoqda...`);

  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const flags = buildYtDlpFlags(platform);

  let formatCmd = '';
  if (isAudio) {
    formatCmd = `-f "bestaudio/best" -x --audio-format mp3`; 
  } else {
    formatCmd = `-f "bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${quality}][ext=mp4]/best" --merge-output-format mp4`;
  }

  const cmd = `yt-dlp ${flags} ${formatCmd} -o "${outputTemplate}" "${url}"`;

  runAndSend(cmd, chatId, statusMsg.message_id, fileId, isAudio, `❌ Yuklab bo'lmadi. Havola noto'g'ri bo'lishi mumkin.`);
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
  const cmd = `yt-dlp -4 --no-update --extractor-args "youtube:player_client=android" --flat-playlist --skip-download --socket-timeout 8 --print "%(id)s|||%(title)s" "ytsearch10:${safeQuery}"`;

  exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, async (error, stdout) => {
    if (error || !stdout.trim()) {
      bot.editMessageText(`❌ "${query}" bo'yicha hech narsa topilmadi.`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }).catch(() => {});
      return;
    }

    const results = stdout.trim().split('\n').map(line => {
      const [id, ...titleParts] = line.split('|||');
      return { id: id.trim(), title: titleParts.join('|||').trim() || 'Nomsiz' };
    }).filter(r => r.id);

    if (results.length === 0) {
      bot.editMessageText(`❌ "${query}" bo'yicha hech narsa topilmadi.`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }).catch(() => {});
      return;
    }

    const searchId = crypto.randomBytes(4).toString('hex');
    SEARCH_CACHE.set(searchId, { results, timestamp: Date.now() });

    const listText = `🔎 *"${query}"* bo'yicha natijalar:\n\n` +
      results.map((r, i) => `${i + 1}. ${r.title}`).join('\n');

    const buttons = results.map((r, i) => ({
      text: `🎵 ${i + 1}`,
      callback_data: `pick:${searchId}:${i}`
    }));
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 5) {
      keyboard.push(buttons.slice(i, i + 5));
    }

    bot.editMessageText(listText, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {});

    prefetchAudio(results[0].id, results[0].title);
  });
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';

  if (!data.startsWith('dl:')) return;

  const [, linkId, quality] = data.split(':');
  const cached = LINK_CACHE.get(linkId);

  if (!cached) {
    bot.answerCallbackQuery(query.id, { text: '⏱ Havola muddati tugagan, qayta yuboring.', show_alert: true }).catch(() => {});
    return;
  }

  const textMap = {
    '360': '⏳ Video (360p) yuklanmoqda...',
    '480': '⏳ Video (480p) yuklanmoqda...',
    '720': '⏳ Video (720p) yuklanmoqda...',
    '1080': '⏳ Video (1080p) yuklanmoqda...',
    'audio': '⏳ Audio (MP3) yuklanmoqda...'
  };

  bot.answerCallbackQuery(query.id, { text: textMap[quality] || '⏳ Yuklanmoqda...' }).catch(() => {});
  bot.deleteMessage(chatId, query.message.message_id).catch(() => {});

  await handleDownload(chatId, cached.url, quality);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';

  if (!data.startsWith('pick:')) return;

  const [, searchId, indexStr] = data.split(':');
  const cached = SEARCH_CACHE.get(searchId);

  if (!cached) {
    bot.answerCallbackQuery(query.id, { text: '⏱ Bu qidiruv muddati tugagan, qayta qidiring.', show_alert: true }).catch(() => {});
    return;
  }

  const index = parseInt(indexStr, 10);
  const chosen = cached.results[index];
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
    bot.answerCallbackQuery(query.id, { text: `⏳ ${chosen.title} deyarli tayyor...` }).catch(() => {});
    const statusMsg = await bot.sendMessage(chatId, `⏳ "${chosen.title}" tayyorlanmoqda...`);
    const fid = await PENDING_PREFETCH.get(chosen.id);
    if (fid) {
      try {
        await bot.sendAudio(chatId, fid);
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return;
      } catch (e) { }
    }
    return await downloadAndSendPick(chatId, chosen, statusMsg.message_id);
  }

  bot.answerCallbackQuery(query.id, { text: `⏳ ${chosen.title} yuklanmoqda...` }).catch(() => {});

  const statusMsg = await bot.sendMessage(chatId, `⏳ "${chosen.title}" yuklanmoqda...`);
  return await downloadAndSendPick(chatId, chosen, statusMsg.message_id);
});

function downloadAndSendPick(chatId, chosen, statusMessageId) {
  const url = `https://www.youtube.com/watch?v=${chosen.id}`;
  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const flags = buildYtDlpFlags('YouTube');
  const cmd = `yt-dlp ${flags} -f "bestaudio/best" -x --audio-format mp3 -o "${outputTemplate}" "${url}"`;

  const t0 = Date.now();
  return runAndSend(cmd, chatId, statusMessageId, fileId, true, `❌ "${chosen.title}" yuklab bo'lmadi.`, chosen.id, chosen.title, t0);
}

function runAndSend(cmd, chatId, statusMessageId, fileId, audioOnly, errorText, cacheKey, cacheTitle, t0) {
  const startedAt = t0 || Date.now();
  
  exec(cmd, { maxBuffer: 1024 * 1024 * 2048 }, async (error, stdout, stderr) => {
    if (error) {
      bot.editMessageText(errorText, {
        chat_id: chatId,
        message_id: statusMessageId
      }).catch(() => {});
      return;
    }

    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileId));
    if (files.length === 0) {
      bot.editMessageText("❌ Fayl topilmadi.", { chat_id: chatId, message_id: statusMessageId }).catch(() => {});
      return;
    }

    const filePath = path.join(DOWNLOAD_DIR, files[0]);

    try {
      if (audioOnly) {
        const sent = await bot.sendAudio(chatId, filePath, cacheTitle ? { title: cacheTitle } : {});
        
        if (cacheKey && sent && sent.audio && sent.audio.file_id) {
          AUDIO_CACHE[cacheKey] = sent.audio.file_id;
          saveAudioCache();
        }
      } else {
        await bot.sendVideo(chatId, filePath, {}, { filename: files[0], contentType: 'video/mp4' });
      }
      await bot.deleteMessage(chatId, statusMessageId).catch(() => {});
    } catch (sendErr) {
      bot.sendMessage(chatId, "❌ Faylni yuborishda xatolik yuz berdi (fayl hajmi oshib ketgan bo'lishi mumkin).");
    } finally {
      fs.unlink(filePath, () => {}); 
    }
  });
}

bot.on('polling_error', (error) => {});
console.log("🤖 Bot ishga tushdi...");
