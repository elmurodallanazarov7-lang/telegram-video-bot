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
    "🎵 *Faqat musiqa (mp3) kerak bo'lsa:* havola oldiga /mp3 yozing\n\n" +
    "Masalan:\n" +
    "`https://www.tiktok.com/@user/video/123456`\n" +
    "`/mp3 https://youtu.be/dQw4w9WgXcQ`",
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "🤖 Buyruqlar:\n" +
    "/start - Botni ishga tushirish\n" +
    "/help - Yordam\n\n" +
    "Video yuklash uchun shunchaki linkni yuboring.\n" +
    "Faqat audio/musiqa kerak bo'lsa, link oldiga /mp3 qo'shing."
  );
});

// /mp3 <link> — faqat audio (musiqa) yuklab olish
bot.onText(/^\/mp3\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();
  await handleDownload(chatId, url, true);
});

// Oddiy xabar — ichida link bo'lsa video sifatida yuklaydi
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.startsWith('/')) return; // buyruqlar yuqorida alohida ishlanadi

  const match = text.match(URL_REGEX);
  if (!match) return;

  await handleDownload(chatId, match[1], false);
});

async function handleDownload(chatId, url, audioOnly) {
  const platform = detectPlatform(url);
  if (!platform) {
    bot.sendMessage(chatId, "❌ Bu havolani tanib bo'lmadi. Instagram, TikTok yoki YouTube havolasini yuboring.");
    return;
  }

  const statusMsg = await bot.sendMessage(chatId, `⏳ ${platform}'dan ${audioOnly ? 'musiqa' : 'video'} yuklanmoqda...`);

  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);

  // yt-dlp orqali yuklab olish (tizimda o'rnatilgan bo'lishi kerak)
  const cmd = audioOnly
    ? `yt-dlp -x --audio-format mp3 -o "${outputTemplate}" "${url}"`
    : `yt-dlp -f "mp4/best" -o "${outputTemplate}" "${url}"`;

  exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, async (error, stdout, stderr) => {
    if (error) {
      console.error(stderr);
      bot.editMessageText("❌ Yuklab bo'lmadi. Havola noto'g'ri yoki video mavjud emas bo'lishi mumkin.", {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }).catch(() => {});
      return;
    }

    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileId));
    if (files.length === 0) {
      bot.editMessageText("❌ Fayl topilmadi.", { chat_id: chatId, message_id: statusMsg.message_id }).catch(() => {});
      return;
    }

    const filePath = path.join(DOWNLOAD_DIR, files[0]);

    try {
      if (audioOnly) {
        await bot.sendAudio(chatId, filePath);
      } else {
        await bot.sendVideo(chatId, filePath, {}, { filename: files[0], contentType: 'video/mp4' });
      }
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    } catch (sendErr) {
      console.error(sendErr);
      bot.sendMessage(chatId, "❌ Faylni yuborishda xatolik yuz berdi (fayl juda katta bo'lishi mumkin, Telegram limiti 50MB).");
    } finally {
      fs.unlink(filePath, () => {}); // vaqtinchalik faylni tozalash
    }
  });
}

console.log("🤖 Bot ishga tushdi...");
