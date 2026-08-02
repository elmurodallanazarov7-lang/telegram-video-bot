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

// Render "Web Service" sifatida deploy qilinsa, portga ulanish talab qilinadi.
// Agar PORT o'zgaruvchisi mavjud bo'lsa, oddiy health-check server ochamiz.
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

// --- Audio kesh: YouTube video ID -> Telegram file_id -------------------
// Bir marta yuklangan qo'shiq ikkinchi so'ralganda qayta yuklanmaydi,
// Telegramning o'z serveridagi faylga file_id orqali darhol havola qilinadi.
const CACHE_FILE = path.join(DOWNLOAD_DIR, 'audio_cache.json');
let AUDIO_CACHE = {};
try {
  AUDIO_CACHE = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch (e) {
  AUDIO_CACHE = {};
}
let cacheSaveTimer = null;
function saveAudioCache() {
  // Debounce qilib yozamiz — ketma-ket yuklashlarda diskga ortiqcha yozmaslik uchun
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    fs.writeFile(CACHE_FILE, JSON.stringify(AUDIO_CACHE), () => {});
  }, 500);
}

// Havolani matndan topish uchun regex
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
    "📥 *Video yuklash:* shunchaki havolani yuboring\n" +
    "🎵 *Faqat musiqa (mp3) kerak bo'lsa:* havola oldiga /mp3 yozing\n" +
    "🔎 *Qo'shiq nomi bilan qidirish:* shunchaki qo'shiq/ijrochi nomini yozing\n\n" +
    "Masalan:\n" +
    "`https://www.tiktok.com/@user/video/123456`\n" +
    "`/mp3 https://youtu.be/dQw4w9WgXcQ`\n" +
    "`Ummon guruhi - Sensiz`",
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "🤖 Buyruqlar:\n" +
    "/start - Botni ishga tushirish\n" +
    "/help - Yordam\n\n" +
    "📥 Video yuklash uchun shunchaki linkni yuboring.\n" +
    "🎵 Faqat audio/musiqa kerak bo'lsa, link oldiga /mp3 qo'shing.\n" +
    "🔎 Havola o'rniga qo'shiq nomini yozsangiz, bot uni o'zi qidirib topib, mp3 qilib yuboradi."
  );
});

// /mp3 <link> — faqat audio (musiqa) yuklab olish
bot.onText(/^\/mp3\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();
  await handleDownload(chatId, url, true);
});

// Oddiy xabar — link bo'lsa yuklab beradi, aks holda qo'shiq nomi sifatida qidiradi
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.startsWith('/')) return; // buyruqlar yuqorida alohida ishlanadi

  const match = text.match(URL_REGEX);
  if (match) {
    await handleDownload(chatId, match[1], false);
  } else {
    await handleMusicSearch(chatId, text.trim());
  }
});

// Render'ning Secret Files papkasi (/etc/secrets/) faqat o'qish uchun — yt-dlp esa
// cookies faylini yangilab qayta yozishga urinadi. Shu sabab uni yoziladigan joyga nusxalaymiz.
const WRITABLE_COOKIES_PATH = path.join(DOWNLOAD_DIR, 'cookies.txt');
function getCookiesPath() {
  const secretPath = '/etc/secrets/cookies.txt';
  if (!fs.existsSync(secretPath)) return null;
  try {
    fs.copyFileSync(secretPath, WRITABLE_COOKIES_PATH);
    return WRITABLE_COOKIES_PATH;
  } catch (e) {
    console.error('cookies.txt nusxalashda xatolik:', e);
    return secretPath; // fallback, lekin write xatosi chiqishi mumkin
  }
}

// Tezlik uchun umumiy flaglar:
// -4            IPv6 timeoutlarining oldini olish (cloud hostinglarda odatiy sabab)
// -N 4          fragmentlarni (DASH) parallel yuklash
// --no-update   avtomatik versiya tekshiruvini o'chirish
const SPEED_FLAGS = '-4 -N 8 --no-update';

function buildYtDlpFlags(platform) {
  const cookiesPath = getCookiesPath();
  const cookiesArg = cookiesPath ? `--cookies "${cookiesPath}"` : '';

  // Cookies mavjud bo'lsa, standart web client yetarli va formatlar to'liq keladi.
  // Cookies bo'lmasa, android client bot-tekshiruvini chetlab o'tishga yordam berishi mumkin.
  const extractorArgs = (platform === 'YouTube' && !cookiesPath)
    ? `--extractor-args "youtube:player_client=android,web"`
    : '';

  return `${SPEED_FLAGS} ${cookiesArg} ${extractorArgs}`;
}

async function handleDownload(chatId, url, audioOnly) {
  const platform = detectPlatform(url);
  if (!platform) {
    bot.sendMessage(chatId, "❌ Bu havolani tanib bo'lmadi. Instagram, TikTok yoki YouTube havolasini yuboring.");
    return;
  }

  const statusMsg = await bot.sendMessage(chatId, `⏳ ${platform}'dan ${audioOnly ? 'musiqa' : 'video'} yuklanmoqda...`);

  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const flags = buildYtDlpFlags(platform);

  const cmd = audioOnly
    ? `yt-dlp ${flags} -x --audio-format mp3 -o "${outputTemplate}" "${url}"`
    : `yt-dlp ${flags} -f "mp4/best" -o "${outputTemplate}" "${url}"`;

  runAndSend(cmd, chatId, statusMsg.message_id, fileId, true, `❌ Yuklab bo'lmadi. Havola noto'g'ri yoki video mavjud emas bo'lishi mumkin.`);
}

// Qidiruv natijalarini vaqtincha saqlash (tugma bosilganda foydalanish uchun)
const SEARCH_CACHE = new Map(); // searchId -> [{id, title}, ...]
setInterval(() => {
  const THIRTY_MIN = 30 * 60 * 1000;
  const now = Date.now();
  for (const [key, val] of SEARCH_CACHE) {
    if (now - val.timestamp > THIRTY_MIN) SEARCH_CACHE.delete(key);
  }
}, 10 * 60 * 1000);

// Qo'shiq nomi bo'yicha YouTube'dan 10 ta natija topib, tugmalar bilan ko'rsatish
async function handleMusicSearch(chatId, query) {
  if (!query || query.length < 2) return;

  const statusMsg = await bot.sendMessage(chatId, `🔎 "${query}" qidirilmoqda...`);

  const safeQuery = query.replace(/"/g, '');
  // Qidiruv bosqichida ham -4 va android client ishlatamiz — bu YouTube javobini
  // sezilarli tezlashtiradi (kamroq metama'lumot, kamroq cheklov, IPv6 timeout yo'q).
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

    // Tugmalarni 5 tadan qatorlarga bo'lib joylashtirish
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
  });
}

// Tugma bosilganda — tanlangan qo'shiqni yuklab yuborish
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

  // Kesh bo'lsa — qayta yuklamasdan, Telegram'ning o'zidagi faylni darhol jo'natamiz
  const cachedFileId = AUDIO_CACHE[chosen.id];
  if (cachedFileId) {
    bot.answerCallbackQuery(query.id, { text: `✅ ${chosen.title}` }).catch(() => {});
    const statusMsg = await bot.sendMessage(chatId, `📤 "${chosen.title}" yuborilmoqda...`);
    try {
      await bot.sendAudio(chatId, cachedFileId);
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return;
    } catch (e) {
      // file_id eskirgan/yaroqsiz bo'lsa, keshdan o'chirib qayta yuklaymiz
      delete AUDIO_CACHE[chosen.id];
      saveAudioCache();
    }
  }

  bot.answerCallbackQuery(query.id, { text: `⏳ ${chosen.title} yuklanmoqda...` }).catch(() => {});

  const statusMsg = await bot.sendMessage(chatId, `⏳ "${chosen.title}" yuklanmoqda...`);

  const url = `https://www.youtube.com/watch?v=${chosen.id}`;
  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const flags = buildYtDlpFlags('YouTube');
  // MUHIM: -x --audio-format mp3 OLIB TASHLANDI — bu ffmpeg orqali qayta kodlashni
  // talab qilib, eng sekin qadam edi. Buning o'rniga eng yaxshi audio formatni
  // (odatda m4a/opus) TO'G'RIDAN-TO'G'RI yuklaymiz, konvertatsiyasiz.
  // Telegram bu formatlarni sendAudio orqali muammosiz qabul qiladi.
  const cmd = `yt-dlp ${flags} -f "bestaudio/best" -o "${outputTemplate}" "${url}"`;

  runAndSend(cmd, chatId, statusMsg.message_id, fileId, true, `❌ "${chosen.title}" yuklab bo'lmadi.`, chosen.id, chosen.title);
});

function runAndSend(cmd, chatId, statusMessageId, fileId, audioOnly, errorText, cacheKey, cacheTitle) {
  exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, async (error, stdout, stderr) => {
    if (error) {
      console.error(stderr);
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
        // Keyingi safar shu qo'shiq so'ralganda qayta yuklamasdan darhol jo'natish uchun saqlaymiz
        if (cacheKey && sent && sent.audio && sent.audio.file_id) {
          AUDIO_CACHE[cacheKey] = sent.audio.file_id;
          saveAudioCache();
        }
      } else {
        await bot.sendVideo(chatId, filePath, {}, { filename: files[0], contentType: 'video/mp4' });
      }
      await bot.deleteMessage(chatId, statusMessageId).catch(() => {});
    } catch (sendErr) {
      console.error(sendErr);
      bot.sendMessage(chatId, "❌ Faylni yuborishda xatolik yuz berdi (fayl juda katta bo'lishi mumkin, Telegram limiti 50MB).");
    } finally {
      fs.unlink(filePath, () => {}); // vaqtinchalik faylni tozalash
    }
  });
}

console.log("🤖 Bot ishga tushdi...");
