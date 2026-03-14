// update_name_lower.js
import db from './database.js';

async function updateNameLower() {
  console.log('🔄 Начинаем обновление name_lower для всех товаров...');
  console.log('⏰', new Date().toLocaleString());
  
  try {
    // 1. Сначала добавляем колонку name_lower, если её нет
    console.log('📦 Проверяем наличие колонки name_lower...');
    try {
      await db.execute(`
        ALTER TABLE products_info ADD COLUMN name_lower TEXT;
      `);
      console.log('✅ Колонка name_lower добавлена');
    } catch (err) {
      // Если колонка уже существует, просто продолжаем
      console.log('ℹ️ Колонка name_lower уже существует');
    }

    // 2. Получаем все товары
    console.log('📦 Загружаем список товаров...');
    const products = await db.execute('SELECT code, name FROM products_info');
    console.log(`📊 Найдено товаров: ${products.rows.length}`);
    
    let updated = 0;
    let errors = 0;
    let skipped = 0;
    
    // 3. Обновляем каждый товар
    for (const product of products.rows) {
      try {
        if (!product.name) {
          console.log(`⚠️ Товар ${product.code} не имеет названия, пропускаем`);
          skipped++;
          continue;
        }
        
        const nameLower = product.name.toLowerCase();
        
        await db.execute({
          sql: 'UPDATE products_info SET name_lower = ? WHERE code = ?',
          args: [nameLower, product.code]
        });
        
        updated++;
        
        // Показываем прогресс каждые 100 товаров
        if (updated % 100 === 0) {
          console.log(`✅ Обновлено ${updated} товаров...`);
        }
        
      } catch (err) {
        console.error(`❌ Ошибка для товара ${product.code}:`, err.message);
        errors++;
      }
    }
    
    // 4. Создаем индекс для ускорения поиска
    console.log('\n📊 Создаем индекс для name_lower...');
    try {
      await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_products_name_lower 
        ON products_info(name_lower);
      `);
      console.log('✅ Индекс создан');
    } catch (err) {
      console.error('❌ Ошибка при создании индекса:', err.message);
    }
    
    // 5. Итоги
    console.log('\n' + '='.repeat(50));
    console.log('🎉 ОБНОВЛЕНИЕ ЗАВЕРШЕНО!');
    console.log('='.repeat(50));
    console.log(`📊 Всего товаров: ${products.rows.length}`);
    console.log(`✅ Обновлено: ${updated}`);
    console.log(`⚠️ Пропущено (без названия): ${skipped}`);
    console.log(`❌ Ошибок: ${errors}`);
    console.log('='.repeat(50));
    
    // 6. Проверка результата
    console.log('\n🔍 Проверка результатов:');
    const test = await db.execute(`
      SELECT code, name, name_lower 
      FROM products_info 
      WHERE name_lower LIKE '%холодильник%'
      LIMIT 5
    `);
    
    if (test.rows.length > 0) {
      console.log('✅ Найдены товары по запросу "холодильник":');
      test.rows.forEach(row => {
        console.log(`   - ${row.name} (${row.code}) -> ${row.name_lower}`);
      });
    } else {
      console.log('ℹ️ Товары по запросу "холодильник" не найдены');
    }
    
  } catch (err) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА:', err);
  }
}

// Запускаем
updateNameLower().then(() => {
  console.log('\n🏁 Скрипт завершен');
  process.exit(0);
}).catch(err => {
  console.error('❌ Фатальная ошибка:', err);
  process.exit(1);
});
