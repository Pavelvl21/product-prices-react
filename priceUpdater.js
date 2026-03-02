import db from './database.js';
import { sendTelegramMessage, formatPriceChangeNotification } from './telegramBot.js';

// ==================== ВСПОМОГАТЕЛЬНЫЕ ====================
async function insertPriceRecord(code, name, price, timestamp) {
  await db.execute({
    sql: 'INSERT INTO price_history (product_code, product_name, price, updated_at) VALUES (?, ?, ?, ?)',
    args: [code, name, price, timestamp.toISOString().slice(0, 19).replace('T', ' ')]
  });
}

// ==================== СОХРАНЕНИЕ ДАННЫХ ТОВАРА ====================
async function saveProductData(product, timestamp) {
  const code = product.code.toString();
  const price = parseFloat(product.packPrice || product.price);
  const now = timestamp || new Date();
  const today = now.toISOString().split('T')[0];

  // Определяем категорию и бренд
  let category = 'Товары';
  if (product.categories && product.categories.length > 0) {
    category = product.categories[product.categories.length - 1].name;
  }
  const brand = product.producerName || 'Без бренда';

  try {
    // Проверяем последнюю запись цены
    const lastRecord = await db.execute({
      sql: `SELECT price, updated_at FROM price_history 
            WHERE product_code = ? 
            ORDER BY updated_at DESC LIMIT 1`,
      args: [code]
    });

    // Проверяем, есть ли запись за сегодня
    const todayRecord = await db.execute({
      sql: `SELECT id FROM price_history 
            WHERE product_code = ? AND DATE(updated_at) = ? 
            LIMIT 1`,
      args: [code, today]
    });

    const lastPrice = lastRecord.rows[0]?.price;

    // Если нет записи за сегодня или цена изменилась - сохраняем
    if (todayRecord.rows.length === 0) {
      console.log(`📝 Первая запись за ${today} для ${code}`);
      await insertPriceRecord(code, product.name, price, now);
      
      // Уведомляем об изменении цены (если это не первая запись вообще)
      if (lastPrice !== undefined && Math.abs(price - lastPrice) > 0.01) {
        const notification = formatPriceChangeNotification(
          { ...product, code }, 
          lastPrice, 
          price,
          'изменилась (первая запись дня)'
        );
        await sendTelegramMessage(notification);
      }
      
    } else {
      // Если цена изменилась - сохраняем и уведомляем
      if (Math.abs(price - lastPrice) > 0.01) {
        console.log(`🔄 Цена изменилась для ${code}: ${lastPrice} → ${price}`);
        await insertPriceRecord(code, product.name, price, now);
        
        const notification = formatPriceChangeNotification(
          { ...product, code }, 
          lastPrice, 
          price
        );
        await sendTelegramMessage(notification);
        
      } else {
        console.log(`⏭️ Цена не изменилась для ${code}, пропускаем`);
      }
    }

    // Обновляем/вставляем информацию о товаре
    await db.execute({
      sql: `
        INSERT INTO products_info (code, name, last_price, link, category, brand, last_update)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name,
          last_price = excluded.last_price,
          link = excluded.link,
          category = excluded.category,
          brand = excluded.brand,
          last_update = excluded.last_update
      `,
      args: [code, product.name, price, product.link || '', category, brand, now.toISOString().slice(0, 19).replace('T', ' ')]
    });

  } catch (error) {
    console.error(`❌ Ошибка в saveProductData для ${code}:`, error);
    throw error;
  }
}

// ==================== ОБНОВЛЕНИЕ ДЛЯ НОВОГО КОДА ====================
export async function updatePricesForNewCode(code) {
  console.log(`🔄 Начинаем обновление для нового кода: ${code}`);

  try {
    const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ids: [parseInt(code)],
        isAdult: false,
        limit: 1
      }),
      method: "POST"
    });

    if (!response.ok) {
      console.error(`❌ Ошибка HTTP для кода ${code}:`, response.status);
      return;
    }

    const data = await response.json();
    const product = data.data.productCards[0];

    if (!product) {
      console.log(`📭 Нет данных для кода ${code} от API`);
      return;
    }

    const now = new Date();
    await saveProductData(product, now);
    console.log(`✅ Данные для нового кода ${code} загружены: ${product.name} - ${product.packPrice || product.price} руб.`);

  } catch (error) {
    console.error(`❌ Ошибка при загрузке данных для кода ${code}:`, error);
  }
}

// ==================== МАССОВОЕ ОБНОВЛЕНИЕ ====================
export async function updateAllPrices() {
  const startTime = Date.now();
  console.log('🚀 Начинаем ускоренное обновление цен:', new Date().toLocaleString());

  try {
    // Получаем все коды из базы
    const codesResult = await db.execute('SELECT code FROM product_codes');
    const allCodes = codesResult.rows.map(row => row.code);
    
    if (allCodes.length === 0) {
      console.log('📭 Нет кодов для обновления');
      return;
    }

    console.log(`📦 Всего кодов в базе: ${allCodes.length}`);

    // Настройки пакетной обработки
    const BATCH_SIZE = 100;
    const CONCURRENT_LIMIT = 3;
    
    // Разбиваем на пачки
    const batches = [];
    for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
      batches.push(allCodes.slice(i, i + BATCH_SIZE));
    }
    
    console.log(`📊 Будет обработано ${batches.length} пачек по ${BATCH_SIZE} кодов`);

    let processedBatches = 0;
    let totalUpdated = 0;
    let totalErrors = 0;
    let totalNewRecords = 0;

    // Функция обработки одной пачки
    const processBatch = async (batch, batchIndex) => {
      const batchNum = batchIndex + 1;
      const batchStartTime = new Date();
      
      console.log(`📤 [Пачка ${batchNum}/${batches.length}] Отправка ${batch.length} кодов`);

      try {
        // Запрос к API 21vek
        const response = await fetch("https://gate.21vek.by/product-card-mini/v1/fetch", {
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
          },
          body: JSON.stringify({
            ids: batch.map(code => parseInt(code)),
            isAdult: false,
            limit: BATCH_SIZE
          }),
          method: "POST"
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const products = data.data?.productCards || [];

        console.log(`📥 [Пачка ${batchNum}] Получено ${products.length} товаров`);

        if (products.length === 0) {
          console.log(`⚠️ [Пачка ${batchNum}] Нет данных от API`);
          return { updated: 0, newRecords: 0 };
        }

        let batchNewRecords = 0;
        
        // Сохраняем каждый товар
        for (const product of products) {
          try {
            const today = new Date().toISOString().split('T')[0];
            
            // Проверяем, есть ли запись за сегодня
            const todayRecord = await db.execute({
              sql: `SELECT id FROM price_history 
                    WHERE product_code = ? AND DATE(updated_at) = ? 
                    LIMIT 1`,
              args: [product.code.toString(), today]
            });
            
            if (todayRecord.rows.length === 0) {
              batchNewRecords++;
            }
            
            await saveProductData(product, batchStartTime);
          } catch (saveError) {
            console.error(`❌ Ошибка сохранения товара ${product.code}:`, saveError.message);
          }
        }

        console.log(`✅ [Пачка ${batchNum}] Успешно обработана`);
        return { updated: products.length, newRecords: batchNewRecords };

      } catch (error) {
        console.error(`❌ [Пачка ${batchNum}] Ошибка:`, error.message);
        totalErrors++;
        return { updated: 0, newRecords: 0 };
      }
    };

    // Запускаем пачки параллельно (по CONCURRENT_LIMIT штук)
    for (let i = 0; i < batches.length; i += CONCURRENT_LIMIT) {
      const currentBatches = batches.slice(i, i + CONCURRENT_LIMIT);
      console.log(`\n🔄 Запуск группы из ${currentBatches.length} параллельных пачек`);
      
      const results = await Promise.all(
        currentBatches.map((batch, idx) => processBatch(batch, i + idx))
      );
      
      results.forEach(result => {
        totalUpdated += result.updated || 0;
        totalNewRecords += result.newRecords || 0;
      });
      
      processedBatches += currentBatches.length;
      
      console.log(`📊 Прогресс: ${processedBatches}/${batches.length} пачек`);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n🎉 Обновление завершено!');
    console.log(`⏱️  Время выполнения: ${totalTime} сек`);
    
    // Отправляем уведомление в Telegram
    const stats = {
      updated: totalUpdated,
      newRecords: totalNewRecords,
      errors: totalErrors,
      duration: totalTime,
      totalProducts: allCodes.length
    };
    
    await sendBatchUpdateNotification(stats);

  } catch (error) {
    console.error('❌ Глобальная ошибка при обновлении цен:', error);
    
    await sendTelegramMessage(`
⚠️ <b>Ошибка при массовом обновлении</b>

${error.message}

🕐 ${new Date().toLocaleString('ru-RU')}
`);
  }
}

// ==================== ОЧИСТКА СТАРЫХ ЗАПИСЕЙ ====================
export async function cleanOldRecords() {
  console.log('🧹 Очистка записей старше 90 дней...');
  try {
    const result = await db.execute({
      sql: "DELETE FROM price_history WHERE updated_at < datetime('now', '-90 days')",
      args: []
    });
    console.log(`✅ Удалено ${result.rowsAffected} старых записей`);
  } catch (err) {
    console.error('❌ Ошибка при очистке:', err);
  }
}

// ==================== УВЕДОМЛЕНИЕ О МАССОВОМ ОБНОВЛЕНИИ ====================
async function sendBatchUpdateNotification(stats) {
  const message = `
📊 Массовое обновление цен завершено

✅ Обновлено товаров: ${stats.updated}
🆕 Новых записей: ${stats.newRecords}
⚠️ Ошибок: ${stats.errors}
🕐 Время: ${stats.duration} сек.

📈 Всего товаров в базе: ${stats.totalProducts}
`;

  return sendTelegramMessage(message);
}

// ==================== НЕДЕЛЬНАЯ СТАТИСТИКА ====================
export async function sendWeeklyStats() {
  try {
    console.log('📊 Формирование недельной статистики...');
    
    // Получаем даты за последние 7 дней
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    
    // Получаем все изменения цен за неделю
    const changes = await db.execute({
      sql: `
        SELECT 
          product_code,
          product_name,
          price,
          updated_at,
          LAG(price) OVER (PARTITION BY product_code ORDER BY updated_at) as prev_price
        FROM price_history
        WHERE updated_at >= datetime(?)
        ORDER BY updated_at ASC
      `,
      args: [startStr]
    });

    // Считаем статистику
    let increases = 0;
    let decreases = 0;
    let totalIncreasePercent = 0;
    let totalDecreasePercent = 0;
    let maxIncrease = { percent: 0, name: '', code: '' };
    let maxDecrease = { percent: 0, name: '', code: '' };
    
    changes.rows.forEach(row => {
      if (row.prev_price) {
        const oldPrice = parseFloat(row.prev_price);
        const newPrice = parseFloat(row.price);
        const changePercent = ((newPrice - oldPrice) / oldPrice) * 100;
        
        if (changePercent > 0.01) { // Повышение
          increases++;
          totalIncreasePercent += changePercent;
          if (changePercent > maxIncrease.percent) {
            maxIncrease = {
              percent: changePercent,
              name: row.product_name,
              code: row.product_code
            };
          }
        } else if (changePercent < -0.01) { // Снижение
          decreases++;
          totalDecreasePercent += Math.abs(changePercent);
          if (Math.abs(changePercent) > maxDecrease.percent) {
            maxDecrease = {
              percent: Math.abs(changePercent),
              name: row.product_name,
              code: row.product_code
            };
          }
        }
      }
    });

    // Общее количество товаров
    const totalProducts = await db.execute('SELECT COUNT(*) as count FROM product_codes');
    const totalCount = totalProducts.rows[0].count;

    // Формируем сообщение
    const avgIncrease = increases > 0 ? (totalIncreasePercent / increases).toFixed(1) : '0.0';
    const avgDecrease = decreases > 0 ? (totalDecreasePercent / decreases).toFixed(1) : '0.0';
    const totalChanges = increases + decreases;

    let message = `📊 Итоги мониторинга за 7 дней\n\n`;
    message += `📈 Общая статистика:\n`;
    message += `• Всего товаров: ${totalCount}\n`;
    message += `• Изменений цен: ${totalChanges}\n\n`;
    
    message += `📊 Динамика изменений:\n`;
    message += `• 🔼 Повышение: ${increases}\n`;
    message += `  Среднее повышение: +${avgIncrease}%\n`;
    message += `• 🔻 Снижение: ${decreases}\n`;
    message += `  Среднее снижение: -${avgDecrease}%\n\n`;

    if (totalChanges > 0) {
      message += `💰 Самое большое изменение:\n`;
      if (maxIncrease.percent > 0) {
        message += `• ⬆️ ${maxIncrease.name} (код ${maxIncrease.code}): +${maxIncrease.percent.toFixed(1)}%\n`;
      }
      if (maxDecrease.percent > 0) {
        message += `• ⬇️ ${maxDecrease.name} (код ${maxDecrease.code}): -${maxDecrease.percent.toFixed(1)}%\n`;
      }
      message += `\n`;
    }

    // Форматируем даты по-мински
    const formatDate = (date) => {
      return date.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    };

    message += `🕐 Период: ${formatDate(startDate)} - ${formatDate(endDate)}`;

    // Отправляем в Telegram
    await sendTelegramMessage(message);
    console.log('✅ Недельная статистика отправлена');

  } catch (error) {
    console.error('❌ Ошибка при формировании статистики:', error);
  }
}
