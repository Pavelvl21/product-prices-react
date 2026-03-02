import fetch from 'node-fetch';
import db from './database.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ==================== ВСПОМОГАТЕЛЬНЫЕ ====================

async function sendMessage(chatId, text, options = {}) {
  if (!BOT_TOKEN) return false;
  
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        ...options
      })
    });
    return await res.json();
  } catch (err) {
    console.error('Telegram send error:', err);
    return false;
  }
}

async function sendWithKeyboard(chatId, text, buttons) {
  if (!BOT_TOKEN) return false;
  
  const keyboard = {
    inline_keyboard: buttons.map(b => [{
      text: b.text,
      callback_data: b.callback_data
    }])
  };

  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: keyboard
      })
    });
    return await res.json();
  } catch (err) {
    console.error('Telegram keyboard error:', err);
    return false;
  }
}

async function answerCallback(callbackId, text) {
  if (!BOT_TOKEN) return;
  
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackId,
        text: text
      })
    });
  } catch (err) {
    console.error('Callback answer error:', err);
  }
}

async function editMessageButtons(chatId, messageId) {
  if (!BOT_TOKEN) return;
  
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] }
      })
    });
  } catch (err) {
    console.error('Edit message error:', err);
  }
}

// ==================== РАБОТА С БД ====================

async function getUser(telegramId) {
  const result = await db.execute({
    sql: 'SELECT status, chat_id FROM telegram_users WHERE telegram_id = ?',
    args: [telegramId]
  });
  return result.rows[0];
}

async function saveUser(telegramId, username, firstName, lastName, chatId) {
  await db.execute({
    sql: `INSERT INTO telegram_users (telegram_id, username, first_name, last_name, chat_id, status)
          VALUES (?, ?, ?, ?, ?, 'pending')
          ON CONFLICT(telegram_id) DO UPDATE SET
            username = excluded.username,
            first_name = excluded.first_name,
            last_name = excluded.last_name,
            chat_id = excluded.chat_id,
            status = CASE 
              WHEN status = 'rejected' THEN 'pending' 
              ELSE status 
            END,
            requested_at = CURRENT_TIMESTAMP`,
    args: [telegramId, username || '', firstName || '', lastName || '', chatId]
  });
}

async function updateUserStatus(telegramId, status, approvedBy = null) {
  const approvedAt = status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL';
  await db.execute({
    sql: `UPDATE telegram_users 
          SET status = ?, 
              approved_at = ${approvedAt},
              approved_by = ?
          WHERE telegram_id = ?`,
    args: [status, approvedBy, telegramId]
  });
}

// ==================== ОБРАБОТЧИКИ ====================

async function notifyAdminAboutNewUser(userId, username, firstName, chatId) {
  const info = [
    `🆔 ID: <code>${userId}</code>`,
    `👤 Имя: ${firstName || 'не указано'}`,
    `📱 Username: ${username ? '@' + username : 'не указан'}`,
    `💬 Chat ID: <code>${chatId}</code>`,
    `🕐 ${new Date().toLocaleString('ru-RU')}`
  ].join('\n');

  await sendWithKeyboard(
    ADMIN_CHAT_ID,
    `🔔 <b>Новый запрос на доступ!</b>\n\n${info}`,
    [
      { text: '✅ Разрешить', callback_data: `approve_${userId}` },
      { text: '❌ Отклонить', callback_data: `reject_${userId}` },
      { text: '🚫 Заблокировать', callback_data: `block_${userId}` }
    ]
  );
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  const user = await getUser(userId);

  // /start всегда доступен
  if (text === '/start') {
    if (!user) {
      await saveUser(userId, username, firstName, lastName, chatId);
      await sendMessage(chatId, 
        '👋 Привет! Я бот для отслеживания цен.\n\n' +
        '📝 <b>Запрос на доступ отправлен администратору.</b>\n' +
        'Ожидайте подтверждения.'
      );
      await notifyAdminAboutNewUser(userId, username, firstName, chatId);
    } else if (user.status === 'approved') {
      await sendMessage(chatId, '👋 С возвращением! /help - список команд');
    } else if (user.status === 'pending') {
      await sendMessage(chatId, '⏳ Запрос ещё рассматривается');
    } else {
      await sendMessage(chatId, '⛔ Доступ запрещён');
    }
    return;
  }

  // Для неподтверждённых игнорируем
  if (!user || user.status !== 'approved') return;

  // Команды для подтверждённых
  if (text === '/help') {
    await sendMessage(chatId,
      '📋 <b>Команды:</b>\n\n' +
      '/start - приветствие\n' +
      '/help - это сообщение\n' +
      '/status - проверить статус'
    );
  } else if (text === '/status') {
    await sendMessage(chatId,
      `✅ <b>Статус:</b> подтверждён\n` +
      `🆔 ID: <code>${userId}</code>`
    );
  } else {
    await sendMessage(chatId, '❓ Неизвестная команда. /help');
  }
}

async function handleCallback(query) {
  const data = query.data;
  const message = query.message;
  const fromId = query.from.id;

  // Только админ может нажимать кнопки
  if (fromId != ADMIN_CHAT_ID) {
    await answerCallback(query.id, '⛔ Нет прав');
    return;
  }

  if (data.startsWith('approve_')) {
    const userId = data.replace('approve_', '');
    const user = await getUser(userId);
    
    if (user) {
      await updateUserStatus(userId, 'approved', 'admin');
      await editMessageButtons(message.chat.id, message.message_id);
      await sendMessage(ADMIN_CHAT_ID, `✅ Пользователь ${userId} подтверждён`);
      await sendMessage(user.chat_id, 
        '✅ <b>Доступ подтверждён!</b>\n\nТеперь вы можете пользоваться ботом.\n/help'
      );
    }
  } else if (data.startsWith('reject_')) {
    const userId = data.replace('reject_', '');
    const user = await getUser(userId);
    
    if (user) {
      await updateUserStatus(userId, 'rejected', 'admin');
      await editMessageButtons(message.chat.id, message.message_id);
      await sendMessage(ADMIN_CHAT_ID, `❌ Пользователь ${userId} отклонён`);
      await sendMessage(user.chat_id, '⛔ <b>Доступ отклонён</b>');
    }
  } else if (data.startsWith('block_')) {
    const userId = data.replace('block_', '');
    const user = await getUser(userId);
    
    if (user) {
      await updateUserStatus(userId, 'blocked', 'admin');
      await editMessageButtons(message.chat.id, message.message_id);
      await sendMessage(ADMIN_CHAT_ID, `🚫 Пользователь ${userId} заблокирован`);
      await sendMessage(user.chat_id, '🚫 <b>Вы заблокированы</b>');
    }
  }

  await answerCallback(query.id, '✅ Готово');
}

// ==================== ПУБЛИЧНЫЙ API ====================

export async function handleTelegramUpdate(update) {
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error('Update error:', err);
  }
}

export function setupBotEndpoints(app, authenticateToken) {
  // Получить список пользователей Telegram
  app.get('/api/telegram/users', authenticateToken, async (req, res) => {
    const users = await db.execute(`
      SELECT telegram_id, username, first_name, last_name, status,
             requested_at, approved_at, approved_by
      FROM telegram_users
      ORDER BY 
        CASE status
          WHEN 'pending' THEN 1
          WHEN 'approved' THEN 2
          ELSE 3
        END,
        requested_at DESC
    `);
    res.json(users.rows);
  });

  // Установить вебхук
  app.post('/api/telegram/set-webhook', authenticateToken, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL обязателен' });

    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${url}/api/telegram/webhook`
    );
    const data = await response.json();
    res.json(data);
  });

  // Информация о вебхуке
  app.get('/api/telegram/webhook-info', authenticateToken, async (req, res) => {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
    );
    const data = await response.json();
    res.json(data);
  });
}

// ==================== ОТПРАВКА УВЕДОМЛЕНИЙ ====================

export async function sendTelegramMessage(message) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.log('⚠️ Telegram не настроен');
    return false;
  }
  return sendMessage(ADMIN_CHAT_ID, message);
}

export function formatPriceChangeNotification(product, oldPrice, newPrice, changeType = 'изменилась') {
  const change = newPrice - oldPrice;
  const percent = ((change / oldPrice) * 100).toFixed(1);
  const emoji = change < 0 ? '🔻' : '📈';
  const sign = change > 0 ? '+' : '';
  
  const link = product.link ? `\n<a href="${product.link}">🔗 Ссылка</a>` : '';

  return `
<b>${emoji} Цена ${changeType}!</b>

<b>${product.name}</b>
Код: <code>${product.code}</code>

Старая: ${oldPrice.toFixed(2)} руб.
Новая: ${newPrice.toFixed(2)} руб.
Изменение: ${sign}${change.toFixed(2)} руб. (${sign}${percent}%)${link}

🕐 ${new Date().toLocaleString('ru-RU')}
`;
}
