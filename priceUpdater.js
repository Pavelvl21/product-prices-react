import db from './database.js';
import { sendTelegramMessage, formatPriceChangeNotification } from './telegramBot.js';
import { notifyProductSubscribers } from './telegramBroadcast.js';

async function insertPriceRecord(code, name, price, timestamp) {
  await db.execute({
    sql: 'INSERT INTO price_history (product_code, product_name, price, updated_at) VALUES (?, ?, ?, ?)',
    args: [code, name, price, timestamp.toISOString().slice(0, 19).replace('T', ' ')]
  });
}

async function saveProductData(product, timestamp) {
  const code = product.code.toString();
  
  const realPrice = parseFloat(product.packPrice || product.price);
  const basePrice = product.price ? parseFloat(product.price) : null;
  const packPrice = product.packPrice ? parseFloat(product.packPrice) : null;
  
  const now = timestamp || new Date();
  const today = now.toISOString().split('T')[0];

  const monthly_payment = product.monthly_payment || null;
  const no_overpayment_max_months = product.no_overpayment_max_months || null;

  let category = 'Товары';
  if (product.categories && product.categories.length > 0) {
    category = product.categories[product.categories.length - 1].name;
  }
  const brand = product.producerName || 'Без бренда';

  try {
    const lastRecord = await db.execute({
      sql: `SELECT price, updated_at FROM price_history 
            WHERE product_code = ? 
            ORDER BY updated_at DESC LIMIT 1`,
      args: [code]
    });

    const todayRecord = await db.execute({
      sql: `SELECT id FROM price_history 
            WHERE product_code = ? AND DATE(updated_at) = ? 
            LIMIT 1`,
      args: [code, today]
    });

    const lastPrice = lastRecord.rows[0]?.price;

    const productWithPrices = {
      ...product,
      code,
      category,
      realPrice,
      basePrice,
      packPrice
    };

    // Проверяем, есть ли товар в мониторинге
    const monitoringCheck = await db.execute({
      sql: 'SELECT 1 FROM user_shelf WHERE product_code = ? LIMIT 1',
      args: [code]
    });
    
    const isMonitored = monitoringCheck.rows.length > 0;

    if (todayRecord.rows.length === 0) {
      // Первая запись за сегодня
      if (lastPrice !== undefined && Math.abs(realPrice - lastPrice) > 0.01) {
        await insertPriceRecord(code, product.name, realPrice, now);
        
        if (isMonitored && lastPrice !== undefined) {
          const notification = formatPriceChangeNotification(
            productWithPrices, 
            lastPrice, 
            realPrice
          );
          
  await notifyProductSubscribers(
    code,                         // productCode
    productWithPrices,            // productData (объект с name, basePrice, packPrice и т.д.)
    lastPrice,                    // oldPrice
    realPrice,                    // newPrice
    formatPriceChangeNotification  // formatFunction
  );
        }
      } else {
        await insertPriceRecord(code, product.name, realPrice, now);
      }
      
    } else {
      if (lastPrice !== undefined && Math.abs(realPrice - lastPrice) > 0.01) {
        await insertPriceRecord(code, product.name, realPrice, now);
        
        if (isMonitored) {
          const notification = formatPriceChangeNotification(
            productWithPrices, 
            lastPrice, 
            realPrice
          );
          
  await notifyProductSubscribers(
    code,                         // productCode
    productWithPrices,            // productData (объект с name, basePrice, packPrice и т.д.)
    lastPrice,                    // oldPrice
    realPrice,                    // newPrice
    formatPriceChangeNotification  // formatFunction
  );
        }
      }
    }

    // Сохраняем в products_info
const nameLower = product.name ? product.name.toLowerCase() : '';

await db.execute({
  sql: `
    INSERT INTO products_info (
      code, name, last_price, base_price, packPrice,
      monthly_payment, no_overpayment_max_months,
      link, category, brand, last_update,
      name_lower
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      name = excluded.name,
      last_price = excluded.last_price,
      base_price = excluded.base_price,
      packPrice = excluded.packPrice,
      monthly_payment = excluded.monthly_payment,
      no_overpayment_max_months = excluded.no_overpayment_max_months,
      link = excluded.link,
      category = excluded.category,
      brand = excluded.brand,
      last_update = excluded.last_update,
      name_lower = excluded.name_lower
  `,
  args: [
    code, 
    product.name, 
    realPrice,
    basePrice,
    packPrice,
    monthly_payment,
    no_overpayment_max_months,
    product.link || '', 
    category, 
    brand, 
    now.toISOString().slice(0, 19).replace('T', ' '),
    nameLower
  ]
});

  } catch (error) {
    console.error(`❌ Критическая ошибка при сохранении товара ${code}:`, error.message);
    throw error;
  }
}

export async function updatePricesForNewCode(code) {
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
      return;
    }

    const data = await response.json();
    const product = data.data.productCards[0];

    if (!product) {
      return;
    }

    const now = new Date();
    
    const partlyPayResponse = await fetch("https://gate.21vek.by/partly-pay/v2/products.calculate", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ 
        data: { 
          products: [{
            code: parseInt(code),
            price: parseFloat(product.packPrice || product.price)
          }]
        } 
      })
    });

    if (partlyPayResponse.ok) {
      const partlyPayResult = await partlyPayResponse.json();
      if (partlyPayResult.data && partlyPayResult.data[0]) {
        product.monthly_payment = partlyPayResult.data[0].monthly_payment;
        product.no_overpayment_max_months = partlyPayResult.data[0].no_overpayment_max_months;
      }
    }

    await saveProductData(product, now);

  } catch (error) {
    console.error(`❌ Критическая ошибка при загрузке кода ${code}:`, error.message);
  }
}

export async function updateAllPrices() {
  const startTime = Date.now();
  console.log(`\n🚀 Запуск планового обновления цен: ${new Date().toLocaleString('ru-RU')}`);

  try {
    const codesResult = await db.execute('SELECT code FROM product_codes');
    const allCodes = codesResult.rows.map(row => row.code);
    
    if (allCodes.length === 0) {
      console.log('📭 Нет кодов для обновления');
      return;
    }

    const BATCH_SIZE = 100;
    const CONCURRENT_LIMIT = 2;
    
    const batches = [];
    for (let i = 0; i < allCodes.length; i += BATCH_SIZE) {
      batches.push(allCodes.slice(i, i + BATCH_SIZE));
    }

    let processedBatches = 0;
    let totalProcessed = 0;
    let totalChanged = 0;
    let totalNewRecords = 0;
    let totalErrors = 0;

    const processBatch = async (batch, batchIndex) => {
      const batchNum = batchIndex + 1;
      const batchStartTime = new Date();
      
      let batchProcessed = 0;
      let batchChanged = 0;
      let batchNewRecords = 0;
      let batchErrors = 0;
      
      let requestDelay = 100; // стартовая задержка 100ms

      for (const code of batch) {
        try {
          batchProcessed++;
          
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
            batchErrors++;
            continue;
          }

          const data = await response.json();
          const product = data.data.productCards[0];

          if (!product) {
            batchErrors++;
            continue;
          }
          
          // Получаем данные рассрочки
          try {
            const partlyPayResponse = await fetch("https://gate.21vek.by/partly-pay/v2/products.calculate", {
              method: "POST",
              headers: {
                "accept": "application/json",
                "content-type": "application/json"
              },
              body: JSON.stringify({ 
                data: { 
                  products: [{
                    code: parseInt(code),
                    price: parseFloat(product.packPrice || product.price)
                  }]
                } 
              })
            });

            if (partlyPayResponse.ok) {
              const partlyPayResult = await partlyPayResponse.json();
              if (partlyPayResult.data && partlyPayResult.data[0]) {
                product.monthly_payment = partlyPayResult.data[0].monthly_payment;
                product.no_overpayment_max_months = partlyPayResult.data[0].no_overpayment_max_months;
              }
            }
          } catch (error) {
            // Игнорируем ошибки рассрочки
          }
          
          await saveProductData(product, batchStartTime);
          
          // Умная задержка между запросами
          await new Promise(resolve => setTimeout(resolve, requestDelay));
          
          // Плавно возвращаем задержку к базовой при успехах
          if (requestDelay > 100) {
            requestDelay = Math.max(requestDelay - 5, 100);
          }
          
        } catch (error) {
          batchErrors++;
          // При ошибке увеличиваем задержку
          requestDelay = Math.min(requestDelay + 20, 500);
          await new Promise(resolve => setTimeout(resolve, requestDelay));
        }
      }

      return { 
        processed: batchProcessed, 
        changed: 0, // Не отслеживаем
        newRecords: 0,
        errors: batchErrors 
      };
    };

    for (let i = 0; i < batches.length; i += CONCURRENT_LIMIT) {
      const currentBatches = batches.slice(i, i + CONCURRENT_LIMIT);
      
      const results = await Promise.all(
        currentBatches.map((batch, idx) => processBatch(batch, i + idx))
      );
      
      results.forEach(result => {
        totalProcessed += result.processed || 0;
        totalErrors += result.errors || 0;
      });
      
      processedBatches += currentBatches.length;
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`✅ Плановое обновление завершено за ${totalTime} сек`);
    console.log(`📊 Обработано: ${totalProcessed} товаров, ошибок: ${totalErrors}`);

  } catch (error) {
    console.error('\n❌ КРИТИЧЕСКАЯ ОШИБКА ПРИ ОБНОВЛЕНИИ ЦЕН:', error.message);
    
    await sendTelegramMessage(`
⚠️ <b>Критическая ошибка при массовом обновлении</b>

${error.message}

🕐 ${new Date().toLocaleString('ru-RU')}
`);
  }
}

export async function cleanOldRecords() {
  try {
    const result = await db.execute({
      sql: "DELETE FROM price_history WHERE updated_at < datetime('now', '-90 days')",
      args: []
    });
  } catch (err) {
    console.error('❌ Критическая ошибка при очистке:', err.message);
  }
}

export async function sendWeeklyStats() {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    
    const startStr = startDate.toISOString().split('T')[0];
    
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
        
        if (changePercent > 0.01) {
          increases++;
          totalIncreasePercent += changePercent;
          if (changePercent > maxIncrease.percent) {
            maxIncrease = {
              percent: changePercent,
              name: row.product_name,
              code: row.product_code
            };
          }
        } else if (changePercent < -0.01) {
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

    const totalProducts = await db.execute('SELECT COUNT(*) as count FROM product_codes');
    const totalCount = totalProducts.rows[0].count;

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

    const formatDate = (date) => {
      return date.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    };

    message += `🕐 Период: ${formatDate(startDate)} - ${formatDate(endDate)}`;

    await sendTelegramMessage(message);

  } catch (error) {
    console.error('❌ Критическая ошибка при формировании статистики:', error.message);
  }
}
