import fetch from 'node-fetch';
import db from './database.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SECRET_KEY = process.env.SECRET_KEY;
const API_URL = process.env.API_URL || 'http://localhost:3000';

// Временное хранилище для email до сохранения
const tempEmail = new Map();

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
        disable_web_page_preview: true,
        ...options
      })
    });
    return await res.json();
  } catch (err) {
    console.error('Telegram send error:', err);
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
        text: text,
        show_alert: false
      })
    });
  } catch (err) {
    console.error('Callback answer error:', err);
  }
}

// ==================== РАБОТА С БД ПОЛЬЗОВАТЕЛЕЙ ====================

async function getUser(telegramId) {
  try {
    const result = await db.execute({
      sql: 'SELECT status, chat_id, selected_categories, email FROM telegram_users WHERE telegram_id = ?',
      args: [telegramId]
    });
    if (result.rows[0]) {
      const user = result.rows[0];
      try {
        user.selected_categories = JSON.parse(user.selected_categories || '[]');
      } catch {
        user.selected_categories = [];
      }
      return user;
    }
    return null;
  } catch (err) {
    console.error('Ошибка в getUser:', err);
    return null;
  }
}

async function saveUser(telegramId, username, firstName, lastName, chatId, email) {
  try {
    await db.execute({
      sql: `INSERT INTO telegram_users 
            (telegram_id, username, first_name, last_name, chat_id, status, selected_categories, email)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      args: [telegramId, username || '', firstName || '', lastName || '', chatId, '[]', email]
    });
  } catch (err) {
    console.error('Ошибка сохранения пользователя:', err);
  }
}

async function updateUserStatus(telegramId, status, approvedBy = null) {
  try {
    const approvedAt = status === 'approved' ? 'CURRENT_TIMESTAMP' : 'NULL';
    await db.execute({
      sql: `UPDATE telegram_users 
            SET status = ?, 
                approved_at = ${approvedAt},
                approved_by = ?
            WHERE telegram_id = ?`,
      args: [status, approvedBy, telegramId]
    });
  } catch (err) {
    console.error('Ошибка обновления статуса:', err);
  }
}

async function updateUserCategories(telegramId, categories) {
  try {
    await db.execute({
      sql: 'UPDATE telegram_users SET selected_categories = ? WHERE telegram_id = ?',
      args: [JSON.stringify(categories), telegramId]
    });
  } catch (err) {
    console.error('Ошибка обновления категорий:', err);
  }
}

// ==================== ДОБАВЛЕНИЕ EMAIL В allowed_emails ====================

async function addEmailToAllowedList(email) {
  try {
    await db.execute({
      sql: 'INSERT INTO allowed_emails (email) VALUES (?) ON CONFLICT(email) DO NOTHING',
      args: [email]
    });
    console.log(`✅ Email ${email} добавлен в allowed_emails`);
  } catch (err) {
    console.error('Ошибка добавления email в allowed_emails:', err);
  }
}

// ==================== ПОЛУЧЕНИЕ КАТЕГОРИЙ ====================

async function getAllCategories() {
  try {
    const response = await fetch(`${API_URL}/api/bot/products`, {
      headers: { 'x-bot-key': SECRET_KEY },
      timeout: 5000
    });
    if (!response.ok) return [];
    const data = await response.json();
    const cats = [...new Set(data.products.map(p => p.category || 'Без категории'))];
    return cats.sort();
  } catch {
    return [];
  }
}

// ==================== ФОРМАТИРОВАНИЕ ====================

function formatUserInfo(user) {
  return `
👤 <b>${user.first_name || '—'} ${user.last_name || ''}</b>
📱 Username: ${user.username ? '@' + user.username : '—'}
🆔 ID: <code>${user.telegram_id}</code>
📧 Email: <code>${user.email || '—'}</code>
`;
}

// ==================== УВЕДОМЛЕНИЕ АДМИНУ ====================

async function notifyAdminAboutRequest(userId) {
  const user = await getUser(userId);
  if (!user) return;

  const allCats = await getAllCategories();
  const selected = user.selected_categories || [];

  const keyboard = [];
  let row = [];

  for (const cat of allCats) {
    const isSelected = selected.includes(cat);
    row.push({
      text: (isSelected ? '✅ ' : '⬜ ') + cat,
      callback_data: `mod_cat_${userId}_${cat}`
    });
    if (row.length === 2) {
      keyboard.push([...row]);
      row = [];
    }
  }
  if (row.length) keyboard.push(row);

  keyboard.push([
    { text: '✅ Разрешить', callback_data: `mod_approve_${userId}` },
    { text: '❌ Отклонить', callback_data: `mod_reject_${userId}` }
  ]);
  keyboard.push([
    { text: '🚫 Заблокировать', callback_data: `mod_block_${userId}` }
  ]);

  const text = `🔔 <b>Новый запрос доступа</b>\n\n${formatUserInfo(user)}\n📋 Выбранные категории (можно изменить):`;

  await sendMessage(ADMIN_CHAT_ID, text, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

// ==================== ВЫБОР КАТЕГОРИЙ ПОЛЬЗОВАТЕЛЕМ ====================

async function showCategorySelection(chatId, userId) {
  const user = await getUser(userId);
  const allCats = await getAllCategories();
  const selected = user?.selected_categories || [];

  const keyboard = [];
  let row = [];

  for (const cat of allCats) {
    const isSelected = selected.includes(cat);
    row.push({
      text: (isSelected ? '✅ ' : '⬜ ') + cat,
      callback_data: `sel_cat_${userId}_${cat}`
    });
    if (row.length === 2) {
      keyboard.push([...row]);
      row = [];
    }
  }
  if (row.length) keyboard.push(row);

  keyboard.push([{
    text: '📬 Отправить запрос',
    callback_data: `send_request_${userId}`
  }]);

  const selectedText = selected.length 
    ? `\n\n✅ Уже выбрано:\n${selected.map(c => `• ${c}`).join('\n')}` 
    : '';

  await sendMessage(chatId,
    `📁 Выбери категории для отслеживания:${selectedText}`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

// ==================== ОБРАБОТЧИК СООБЩЕНИЙ ====================

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text;
  const username = message.from.username;
  const firstName = message.from.first_name;
  const lastName = message.from.last_name;

  console.log(`📨 ${text} от ${userId}`);

  const user = await getUser(userId);

  // === /start ===
  if (text === '/start') {
    if (user) {
      if (user.status === 'approved') {
        await sendMessage(chatId, '👋 С возвращением! /help');
        return;
      }
      if (user.status === 'pending') {
        await sendMessage(chatId, '⏳ Запрос ещё рассматривается');
        return;
      }
      if (user.status === 'rejected') {
        await sendMessage(chatId, '⛔ Ваш запрос был отклонён');
        return;
      }
      if (user.status === 'blocked') {
        await sendMessage(chatId, '🚫 Вы заблокированы');
        return;
      }
    }

    // Новый пользователь
    tempEmail.set(userId, { username, firstName, lastName, chatId });
    await sendMessage(chatId,
      '👋 Привет! Для доступа укажи свой корпоративный email (@patio-minsk.by)\n\n✉️ Отправь его:'
    );
    return;
  }

  // === Ожидание email ===
  if (!user && tempEmail.has(userId)) {
    const email = text.trim().toLowerCase();

    if (!email.endsWith('@patio-minsk.by')) {
      await sendMessage(chatId, '❌ Допустимы только email @patio-minsk.by');
      return;
    }

    const data = tempEmail.get(userId);
    await saveUser(userId, data.username, data.firstName, data.lastName, data.chatId, email);
    tempEmail.delete(userId);

    await sendMessage(chatId, '✅ Email принят. Теперь выбери категории.');
    await showCategorySelection(chatId, userId);
    return;
  }

  // === Если не авторизован ===
  if (!user || user.status !== 'approved') {
    await sendMessage(chatId, '❌ Сначала используй /start');
    return;
  }

  // === Команды ===
  if (text === '/help') {
    await sendMessage(chatId,
      '📋 <b>Команды:</b>\n\n' +
      '/add — выбрать категории\n' +
      '/list — показать выбранные\n' +
      '/goods — список товаров\n' +
      '/changes — изменения цен\n' +
      '/status — профиль'
    );
    return;
  }

  if (text === '/status') {
    const info = await db.execute({
      sql: 'SELECT email, username, first_name, last_name FROM telegram_users WHERE telegram_id = ?',
      args: [userId]
    });
    const row = info.rows[0] || {};
    const categories = user.selected_categories || [];
    const catText = categories.length 
      ? `\n📁 Категории:\n${categories.map(c => `• ${c}`).join('\n')}` 
      : '\n📁 Категории не выбраны';

    await sendMessage(chatId,
      `✅ <b>Статус:</b> подтверждён\n` +
      `🆔 ID: <code>${userId}</code>\n` +
      `👤 Имя: ${row.first_name || '—'} ${row.last_name || ''}\n` +
      `📱 Username: ${row.username ? '@' + row.username : '—'}\n` +
      `📧 Email: <code>${row.email || '—'}</code>${catText}`
    );
    return;
  }

  if (text === '/add') {
    await showCategorySelection(chatId, userId);
    return;
  }

  if (text === '/list') {
    const selected = user.selected_categories || [];
    if (selected.length === 0) {
      await sendMessage(chatId, '📭 Категории не выбраны. /add');
      return;
    }
    const list = selected.map(c => `• ${c}`).join('\n');
    await sendMessage(chatId, `📋 Ваши категории:\n${list}`);
    return;
  }

  // TODO: /goods, /changes (можно добавить позже)

  await sendMessage(chatId, '❓ Неизвестная команда. /help');
}

// ==================== ОБРАБОТЧИК CALLBACK ====================

async function handleCallback(query) {
  const data = query.data;
  const msg = query.message;
  const fromId = query.from.id;

  console.log('📞 Callback:', data);

  const user = await getUser(fromId);

  // === Добавление/удаление категории пользователем ===
  if (data.startsWith('sel_cat_')) {
    if (!user || user.status !== 'approved') {
      await answerCallback(query.id, '⛔ Сначала авторизуйся');
      return;
    }

    const parts = data.split('_');
    const targetUserId = parts[2];
    const category = parts.slice(3).join('_');

    if (targetUserId != fromId) {
      await answerCallback(query.id, '⛔ Это не твоя сессия');
      return;
    }

    const selected = user.selected_categories || [];
    const updated = selected.includes(category)
      ? selected.filter(c => c !== category)
      : [...selected, category];

    await updateUserCategories(fromId, updated);
    await answerCallback(query.id, `✅ ${category} ${selected.includes(category) ? 'убрана' : 'добавлена'}`);
    await showCategorySelection(msg.chat.id, fromId);
    return;
  }

  // === Отправка запроса админу ===
  if (data.startsWith('send_request_')) {
    if (!user) {
      await answerCallback(query.id, '❌ Ошибка: пользователь не найден');
      return;
    }

    await notifyAdminAboutRequest(fromId);
    await answerCallback(query.id, '📬 Запрос отправлен');
    await sendMessage(msg.chat.id, '📬 Запрос отправлен администратору. Ожидайте.');
    return;
  }

  // === Модерация (только админ) ===
  if (fromId != ADMIN_CHAT_ID) {
    await answerCallback(query.id, '⛔ Только для админа');
    return;
  }

  // === Изменение категории админом ===
  if (data.startsWith('mod_cat_')) {
    const parts = data.split('_');
    const targetUserId = parts[2];
    const category = parts.slice(3).join('_');

    const targetUser = await getUser(targetUserId);
    if (!targetUser) {
      await answerCallback(query.id, '❌ Пользователь не найден');
      return;
    }

    const selected = targetUser.selected_categories || [];
    const updated = selected.includes(category)
      ? selected.filter(c => c !== category)
      : [...selected, category];

    await updateUserCategories(targetUserId, updated);
    await answerCallback(query.id, `✅ Категория обновлена`);
    await notifyAdminAboutRequest(targetUserId); // обновить сообщение
    return;
  }

  // === Подтверждение ===
  if (data.startsWith('mod_approve_')) {
    const targetUserId = data.replace('mod_approve_', '');
    const targetUser = await getUser(targetUserId);

    if (!targetUser) {
      await answerCallback(query.id, '❌ Пользователь не найден');
      return;
    }

    if (targetUser.email) {
      await addEmailToAllowedList(targetUser.email);
    }

    await updateUserStatus(targetUserId, 'approved', 'admin');
    await answerCallback(query.id, '✅ Подтверждено');
    await sendMessage(targetUserId, '✅ Ваш запрос одобрен! /help');

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] }
      })
    });
    return;
  }

  // === Отклонение ===
  if (data.startsWith('mod_reject_')) {
    const targetUserId = data.replace('mod_reject_', '');
    await updateUserStatus(targetUserId, 'rejected', 'admin');
    await answerCallback(query.id, '❌ Отклонено');
    await sendMessage(targetUserId, '❌ Ваш запрос отклонён');

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      body: JSON.stringify({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] }
      })
    });
    return;
  }

  // === Блокировка ===
  if (data.startsWith('mod_block_')) {
    const targetUserId = data.replace('mod_block_', '');
    await updateUserStatus(targetUserId, 'blocked', 'admin');
    await answerCallback(query.id, '🚫 Заблокирован');
    await sendMessage(targetUserId, '🚫 Вы заблокированы');

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST',
      body: JSON.stringify({
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] }
      })
    });
    return;
  }

  await answerCallback(query.id, '❓ Неизвестная команда');
}

// ==================== ЭКСПОРТЫ ====================

export async function handleTelegramUpdate(update) {
  try {
    if (update.message) await handleMessage(update.message);
    if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error('❌ Update error:', err);
  }
}

export function setupBotEndpoints(app, authenticateToken) {
  app.get('/api/telegram/users', authenticateToken, async (req, res) => {
    const users = await db.execute(`
      SELECT telegram_id, username, first_name, last_name, email, status, selected_categories,
             requested_at, approved_at, approved_by
      FROM telegram_users
      ORDER BY requested_at DESC
    `);
    res.json(users.rows);
  });
}

export async function sendTelegramMessage(message) {
  return await sendMessage(ADMIN_CHAT_ID, message);
}

export function formatPriceChangeNotification(product, oldPrice, newPrice) {
  // Заглушка, можно реализовать позже
  return '';
}
