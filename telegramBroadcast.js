// telegramBroadcast.js
import fetch from 'node-fetch';
import db from './database.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

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

// ==================== ПОЛУЧЕНИЕ ПОЛЬЗОВАТЕЛЕЙ ====================

/**
 * Получить всех подтвержденных пользователей
 * @returns {Promise<Array>} Массив пользователей с telegram_id, chat_id и категориями
 */
export async function getAllApprovedUsers() {
  try {
    const result = await db.execute({
      sql: 'SELECT telegram_id, chat_id, selected_categories FROM telegram_users WHERE status = ?',
      args: ['approved']
    });
    
    // Парсим JSON с категориями для каждого пользователя
    return result.rows.map(user => {
      try {
        user.selected_categories = JSON.parse(user.selected_categories || '[]');
      } catch {
        user.selected_categories = [];
      }
      return user;
    });
  } catch (err) {
    console.error('❌ Ошибка получения пользователей:', err);
    return [];
  }
}

/**
 * Получить пользователей, подписанных на конкретные категории
 * @param {Array} categories - Массив категорий
 * @returns {Promise<Array>} Массив подходящих пользователей
 */
export async function getUsersByCategories(categories) {
  if (!categories || categories.length === 0) return [];
  
  try {
    const allUsers = await getAllApprovedUsers();
    
    // Фильтруем пользователей, у которых есть хотя бы одна из указанных категорий
    return allUsers.filter(user => {
      const userCats = user.selected_categories || [];
      return userCats.some(cat => categories.includes(cat));
    });
  } catch (err) {
    console.error('❌ Ошибка фильтрации пользователей:', err);
    return [];
  }
}

/**
 * Получить статистику по категориям
 * @returns {Promise<Object>} Объект со статистикой
 */
export async function getSubscriberStats() {
  try {
    const users = await getAllApprovedUsers();
    
    const stats = {
      total: users.length,
      byCategory: {},
      usersWithoutCategories: 0
    };
    
    users.forEach(user => {
      const cats = user.selected_categories || [];
      if (cats.length === 0) {
        stats.usersWithoutCategories++;
      } else {
        cats.forEach(cat => {
          stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;
        });
      }
    });
    
    return stats;
  } catch (err) {
    console.error('❌ Ошибка получения статистики:', err);
    return { total: 0, byCategory: {}, usersWithoutCategories: 0 };
  }
}

// ==================== РАССЫЛКА ====================

/**
 * Отправить сообщение всем пользователям
 * @param {string} text - Текст сообщения
 * @param {Object} options - Дополнительные опции для sendMessage
 * @param {Function} onProgress - Функция обратного вызова для отслеживания прогресса
 * @returns {Promise<Object>} Результаты рассылки
 */
export async function broadcastToAll(text, options = {}, onProgress = null) {
  const users = await getAllApprovedUsers();
  
  console.log(`📣 Начинаем рассылку ${users.length} пользователям`);
  
  const results = {
    total: users.length,
    success: 0,
    failed: 0,
    blocked: 0,
    startTime: Date.now(),
    endTime: null,
    duration: null
  };
  
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    
    try {
      const sent = await sendMessage(user.chat_id, text, options);
      
      if (sent && sent.ok) {
        results.success++;
      } else {
        results.failed++;
        
        // Проверяем, не заблокировал ли пользователь бота
        if (sent?.description?.includes('blocked')) {
          results.blocked++;
          // Опционально: пометить пользователя как заблокированного
          // await markUserAsBlocked(user.telegram_id);
        }
      }
      
      // Вызываем колбэк прогресса, если передан
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: users.length,
          success: results.success,
          failed: results.failed,
          percent: Math.round(((i + 1) / users.length) * 100)
        });
      }
      
      // Задержка между сообщениями (30 в секунду = ~33ms между сообщениями)
      await new Promise(resolve => setTimeout(resolve, 35));
      
    } catch (err) {
      console.error(`❌ Ошибка отправки пользователю ${user.telegram_id}:`, err);
      results.failed++;
    }
  }
  
  results.endTime = Date.now();
  results.duration = Math.round((results.endTime - results.startTime) / 1000);
  
  console.log(`📊 Рассылка завершена за ${results.duration}с: успешно ${results.success}, ошибок ${results.failed}`);
  
  return results;
}

/**
 * Отправить сообщение пользователям по категориям
 * @param {string} text - Текст сообщения
 * @param {Array} categories - Массив категорий
 * @param {Object} options - Дополнительные опции для sendMessage
 * @returns {Promise<Object>} Результаты рассылки
 */
export async function broadcastToCategories(text, categories, options = {}) {
  const users = await getUsersByCategories(categories);
  
  if (users.length === 0) {
    console.log('📭 Нет пользователей для выбранных категорий');
    return {
      total: 0,
      success: 0,
      failed: 0,
      categories: categories
    };
  }
  
  console.log(`📣 Начинаем рассылку по категориям ${users.length} пользователям`);
  
  const results = {
    total: users.length,
    success: 0,
    failed: 0,
    categories: categories,
    startTime: Date.now(),
    endTime: null,
    duration: null
  };
  
  for (const user of users) {
    try {
      const sent = await sendMessage(user.chat_id, text, options);
      if (sent && sent.ok) {
        results.success++;
      } else {
        results.failed++;
      }
      await new Promise(resolve => setTimeout(resolve, 35));
    } catch (err) {
      console.error(`❌ Ошибка отправки пользователю ${user.telegram_id}:`, err);
      results.failed++;
    }
  }
  
  results.endTime = Date.now();
  results.duration = Math.round((results.endTime - results.startTime) / 1000);
  
  return results;
}

/**
 * Отправить тестовое сообщение админу
 * @param {string} text - Текст сообщения
 * @returns {Promise<boolean>} Успешность отправки
 */
export async function sendTestMessage(text) {
  if (!ADMIN_CHAT_ID) {
    console.error('❌ ADMIN_CHAT_ID не задан');
    return false;
  }
  
  const result = await sendMessage(ADMIN_CHAT_ID, 
    `🧪 <b>ТЕСТОВОЕ СООБЩЕНИЕ</b>\n\n${text}`
  );
  
  return result?.ok || false;
}

// ==================== ФОРМАТИРОВАНИЕ ОТЧЕТОВ ====================

/**
 * Форматировать результаты рассылки для отправки в Telegram
 * @param {Object} results - Результаты рассылки
 * @param {string} type - Тип рассылки (all/categories)
 * @returns {string} Отформатированное сообщение
 */
export function formatBroadcastResults(results, type = 'all') {
  const lines = [
    '✅ <b>РАССЫЛКА ЗАВЕРШЕНА</b>',
    '════════════════════',
    ''
  ];
  
  if (type === 'categories' && results.categories) {
    lines.push(`📁 <b>Категории:</b> ${results.categories.join(', ')}`);
  }
  
  lines.push(
    `👥 <b>Всего получателей:</b> ${results.total}`,
    `✅ <b>Успешно доставлено:</b> ${results.success}`,
    `❌ <b>Ошибок:</b> ${results.failed}`,
    `🚫 <b>Заблокировали бота:</b> ${results.blocked || 0}`,
    ''
  );
  
  if (results.duration) {
    lines.push(`⏱ <b>Время выполнения:</b> ${results.duration} сек.`);
  }
  
  if (results.success > 0) {
    const percent = Math.round((results.success / results.total) * 100);
    lines.push(`📊 <b>Доставляемость:</b> ${percent}%`);
  }
  
  return lines.join('\n');
}

/**
 * Форматировать статистику подписчиков
 * @param {Object} stats - Статистика из getSubscriberStats
 * @returns {string} Отформатированное сообщение
 */
export function formatSubscriberStats(stats) {
  const lines = [
    '📊 <b>СТАТИСТИКА ПОДПИСЧИКОВ</b>',
    '══════════════════════',
    '',
    `👥 <b>Всего пользователей:</b> ${stats.total}`,
    `📭 <b>Без категорий:</b> ${stats.usersWithoutCategories}`,
    ''
  ];
  
  if (Object.keys(stats.byCategory).length > 0) {
    lines.push('<b>По категориям:</b>');
    
    const sorted = Object.entries(stats.byCategory)
      .sort((a, b) => b[1] - a[1]);
    
    sorted.forEach(([cat, count]) => {
      const percent = Math.round((count / stats.total) * 100);
      lines.push(`  • ${cat}: ${count} (${percent}%)`);
    });
  }
  
  return lines.join('\n');
}

// ==================== ДЛЯ ИНТЕГРАЦИИ С PRICE UPDATER ====================

/**
 * Уведомить пользователей об изменении цены
 * @param {Object} product - Объект товара
 * @param {number} oldPrice - Старая цена
 * @param {number} newPrice - Новая цена
 * @param {Function} formatFunction - Функция форматирования сообщения
 * @returns {Promise<number>} Количество отправленных уведомлений
 */
export async function notifyPriceChange(product, oldPrice, newPrice, formatFunction) {
  // Получаем категорию товара
  const category = product.category;
  if (!category) return 0;
  
  // Находим пользователей, подписанных на эту категорию
  const users = await getUsersByCategories([category]);
  if (users.length === 0) return 0;
  
  // Форматируем сообщение
  const message = formatFunction(product, oldPrice, newPrice);
  
  console.log(`💰 Уведомляем ${users.length} пользователей об изменении цены ${product.code}`);
  
  let sentCount = 0;
  for (const user of users) {
    try {
      await sendMessage(user.chat_id, message);
      sentCount++;
      await new Promise(resolve => setTimeout(resolve, 35));
    } catch (err) {
      console.error(`❌ Ошибка уведомления пользователя ${user.telegram_id}:`, err);
    }
  }
  
  return sentCount;
}

// ==================== ПЛАНИРОВЩИК РАССЫЛОК ====================

/**
 * Класс для планирования отложенных рассылок
 */
export class BroadcastScheduler {
  constructor() {
    this.scheduledJobs = new Map();
  }
  
  /**
   * Запланировать рассылку
   * @param {string} jobId - Уникальный ID задачи
   * @param {Date} executeAt - Время выполнения
   * @param {string} text - Текст сообщения
   * @param {Array} categories - Категории (null для всех)
   * @param {Object} options - Опции отправки
   */
  schedule(jobId, executeAt, text, categories = null, options = {}) {
    const now = Date.now();
    const delay = executeAt.getTime() - now;
    
    if (delay < 0) {
      throw new Error('Нельзя запланировать рассылку в прошлом');
    }
    
    // Отменяем предыдущую задачу с таким же ID, если есть
    if (this.scheduledJobs.has(jobId)) {
      clearTimeout(this.scheduledJobs.get(jobId));
    }
    
    const timeout = setTimeout(async () => {
      console.log(`⏰ Выполнение запланированной рассылки: ${jobId}`);
      
      let results;
      if (categories && categories.length > 0) {
        results = await broadcastToCategories(text, categories, options);
      } else {
        results = await broadcastToAll(text, options);
      }
      
      // Уведомляем админа о завершении
      if (ADMIN_CHAT_ID) {
        const report = formatBroadcastResults(results, categories ? 'categories' : 'all');
        await sendMessage(ADMIN_CHAT_ID, report);
      }
      
      this.scheduledJobs.delete(jobId);
    }, delay);
    
    this.scheduledJobs.set(jobId, timeout);
    
    return {
      jobId,
      executeAt,
      delay: Math.round(delay / 1000 / 60), // в минутах
      type: categories ? 'categories' : 'all'
    };
  }
  
  /**
   * Отменить запланированную рассылку
   * @param {string} jobId - ID задачи
   */
  cancel(jobId) {
    if (this.scheduledJobs.has(jobId)) {
      clearTimeout(this.scheduledJobs.get(jobId));
      this.scheduledJobs.delete(jobId);
      return true;
    }
    return false;
  }
  
  /**
   * Получить список запланированных рассылок
   */
  listScheduled() {
    const jobs = [];
    for (const [jobId, timeout] of this.scheduledJobs) {
      jobs.push({
        jobId,
        // Не можем получить время выполнения из timeout, храните отдельно если нужно
      });
    }
    return jobs;
  }
}

// Создаем и экспортируем экземпляр планировщика
export const broadcastScheduler = new BroadcastScheduler();
