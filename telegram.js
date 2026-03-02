// telegram.js - Модуль для отправки уведомлений в Telegram
import fetch from 'node-fetch';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Проверка настроек Telegram
const isTelegramConfigured = () => {
  return TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID;
};

// Отправка сообщения в Telegram
export async function sendTelegramMessage(message) {
  if (!isTelegramConfigured()) {
    console.log('⚠️ Telegram не настроен, пропускаем уведомление');
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Ошибка отправки в Telegram:', error);
      return false;
    }

    console.log('✅ Уведомление отправлено в Telegram');
    return true;

  } catch (error) {
    console.error('❌ Ошибка при отправке в Telegram:', error);
    return false;
  }
}

// Форматирование уведомления об изменении цены
export function formatPriceChangeNotification(product, oldPrice, newPrice, changeType = 'изменилась') {
  const change = newPrice - oldPrice;
  const changePercent = ((change / oldPrice) * 100).toFixed(1);
  const emoji = change < 0 ? '🔻' : '📈';
  const sign = change > 0 ? '+' : '';
  
  // Формируем ссылку на товар (если есть)
  const productLink = product.link 
    ? `\n<a href="${product.link}">🔗 Ссылка на товар</a>`
    : '';

  return `
<b>${emoji} Цена ${changeType}!</b>

<b>${product.name}</b>
Код товара: <code>${product.code}</code>

Старая цена: ${formatPrice(oldPrice)} руб.
Новая цена: ${formatPrice(newPrice)} руб.
Изменение: ${sign}${formatPrice(change)} руб. (${sign}${changePercent}%)${productLink}

🕐 ${new Date().toLocaleString('ru-RU')}
`;
}

// Форматирование цены
function formatPrice(price) {
  return price.toFixed(2).replace('.', ',');
}

// Уведомление о массовом обновлении
export async function sendBatchUpdateNotification(stats) {
  const message = `
📊 <b>Массовое обновление цен завершено</b>

✅ Обновлено товаров: ${stats.updated}
🆕 Новых записей: ${stats.newRecords}
⚠️ Ошибок: ${stats.errors}
🕐 Время: ${stats.duration} сек.

📈 Всего товаров в базе: ${stats.totalProducts}
`;

  return sendTelegramMessage(message);
}
